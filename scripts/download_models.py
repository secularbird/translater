"""Download exactly the pinned files that the app accepts for offline import/mirroring."""
from pathlib import Path
import hashlib
import json
import re
import urllib.request
import argparse
import concurrent.futures
import subprocess
import sys
import time


def download_ranges(url, temporary, total):
    offset = temporary.stat().st_size if temporary.exists() else 0
    ranges = [(start, min(total, start + 16 * 1024 * 1024)) for start in range(offset, total, 16 * 1024 * 1024)]
    def fetch_piece(bounds):
        start, end = bounds
        piece = temporary.with_name(temporary.name + f'.range-{start}')
        for attempt in range(12):
            downloaded = piece.stat().st_size if piece.exists() else 0
            if downloaded == end - start:
                return piece
            position = start + downloaded
            request = urllib.request.Request(url + f'&range={position}-{end-1}', headers={'Range': f'bytes={position}-{end-1}'})
            try:
                with urllib.request.urlopen(request, timeout=25) as response:
                    if response.status != 206 or not response.headers.get('Content-Range', '').startswith(f'bytes {position}-'):
                        raise RuntimeError('Server did not honor byte range')
                    with piece.open('ab') as file:
                        while downloaded < end - start:
                            data = response.read(min(256 * 1024, end - start - downloaded))
                            if not data:
                                break
                            file.write(data)
                            downloaded += len(data)
                if downloaded == end - start:
                    print(f'  Range {start / 1e6:.0f}–{end / 1e6:.0f} MB complete', flush=True)
                    return piece
            except OSError as error:
                print(f'  Retrying range {position}: {error}', flush=True)
                time.sleep(1)
        raise RuntimeError(f'Unable to complete range {start}–{end}; partial data retained')
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        pieces = list(pool.map(fetch_piece, ranges))
    with temporary.open('ab') as output:
        for piece in pieces:
            with piece.open('rb') as source:
                while data := source.read(1024 * 1024):
                    output.write(data)
            piece.unlink()

ROOT = Path(__file__).resolve().parents[1]
DESTINATION = ROOT / ".model-cache" / "offline-assets"


def digest(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def main(samples_only=False):
    assets = json.loads((ROOT / "src/offline/assets.json").read_text())
    for asset in ([] if samples_only else assets):
        path = DESTINATION / asset["id"]
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.stat().st_size == asset["size"] and (not asset["sha256"] or digest(path) == asset["sha256"]):
            print(f"Verified existing {asset['id']}", flush=True)
            continue
        # The verified sherpa distribution already contains these exact files.
        # Reuse them rather than downloading SenseVoice a second time.
        if asset['engine'] == 'asr':
            for source in (ROOT / '.model-cache').glob('sherpa-onnx-wasm-simd-1.12.15-*'):
                js = source / 'sherpa-onnx-wasm-main-vad-asr.js'
                if not js.is_file():
                    continue
                match = re.search(r'loadPackage\((\{.*?\})\)', js.read_text())
                if not match:
                    continue
                metadata = json.loads(match.group(1))
                name = '/sense-voice.onnx' if asset['file'].endswith('.onnx') else '/tokens.txt'
                entry = next((f for f in metadata['files'] if f['filename'] == name), None)
                if entry and entry['end'] - entry['start'] == asset['size']:
                    with (source / 'sherpa-onnx-wasm-main-vad-asr.data').open('rb') as original, path.open('wb') as output:
                        original.seek(entry['start'])
                        remaining = asset['size']
                        while remaining:
                            data = original.read(min(remaining, 1024 * 1024))
                            output.write(data)
                            remaining -= len(data)
                    if not asset['sha256'] or digest(path) == asset['sha256']:
                        print(f"Extracted verified {asset['id']} from sherpa archive", flush=True)
                        break
            if path.exists() and path.stat().st_size == asset['size'] and (not asset['sha256'] or digest(path) == asset['sha256']):
                continue
        url = f"https://huggingface.co/{asset['repo']}/resolve/{asset['revision']}/{asset['file']}?download=true"
        print(f"Downloading {asset['id']} ({asset['size'] / 1e6:.1f} MB)", flush=True)
        temporary = path.with_suffix(path.suffix + ".part")
        if asset['size'] > 16 * 1024 * 1024:
            download_ranges(url, temporary, asset['size'])
        offset = temporary.stat().st_size if temporary.exists() else 0
        for attempt in range(20):
            if offset == asset['size']:
                break
            request = urllib.request.Request(url + f'&offset={offset}', headers={'Range': f'bytes={offset}-'} if offset else {})
            with urllib.request.urlopen(request, timeout=90) as response:
                print(f"  HTTP {response.status}; range={response.headers.get('Content-Range')}; length={response.headers.get('Content-Length')}", flush=True)
                if response.status == 206:
                    if not response.headers.get('Content-Range', '').startswith(f'bytes {offset}-'):
                        raise RuntimeError('Server returned the wrong resume range')
                else:
                    offset = 0
                file = temporary.open('ab' if offset else 'wb')
                last = offset
                try:
                    while chunk := response.read(1024 * 1024):
                        file.write(chunk)
                        offset += len(chunk)
                        if offset - last >= 32 * 1024 * 1024:
                            print(f"  {offset / 1e6:.0f} / {asset['size'] / 1e6:.0f} MB", flush=True)
                            last = offset
                finally:
                    file.close()
        if temporary.stat().st_size != asset["size"] or (asset["sha256"] and digest(temporary) != asset["sha256"]):
            raise RuntimeError(f"Checksum/size mismatch: {asset['id']}; actual size={temporary.stat().st_size}, expected={asset['size']}; sha256={digest(temporary)}")
        temporary.replace(path)
    samples = ROOT / ".model-cache" / "samples"
    samples.mkdir(exist_ok=True)
    asr = assets[0]
    for language in ["en", "zh"]:
        path = samples / f"{language}.wav"
        if not path.exists():
            urllib.request.urlretrieve(f"https://huggingface.co/{asr['repo']}/resolve/{asr['revision']}/test_wavs/{language}.wav", path)
    print(f"Model files ready for import or static hosting: {DESTINATION}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--background', action='store_true')
    parser.add_argument('--samples-only', action='store_true')
    args = parser.parse_args()
    if args.background:
        log = ROOT / '.model-cache' / 'download.log'
        log.parent.mkdir(exist_ok=True)
        with log.open('w') as output:
            child = subprocess.Popen([sys.executable, __file__], stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        print(f'Download PID {child.pid}; log: {log}')
    else:
        main(args.samples_only)
