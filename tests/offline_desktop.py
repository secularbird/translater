"""Launch the debug .app with an opt-in native WebView WASM diagnostic."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import argparse
import json
import os
from pathlib import Path
import subprocess
import threading
from reporting import ROOT, OUTPUT


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--resident', action='store_true', help='Benchmark resident models and select resident mode for this app')
    args = parser.parse_args()
    report_name = 'residency-desktop' if args.resident else 'offline-desktop'
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(ROOT / '.model-cache'), **kwargs)
        def log_message(self, *_args):
            pass
        def end_headers(self):
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Headers', 'range')
            super().end_headers()
        def do_OPTIONS(self):
            self.send_response(204); self.end_headers()
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    metadata = json.loads(subprocess.check_output(['cargo', 'metadata', '--manifest-path', 'src-tauri/Cargo.toml', '--no-deps', '--format-version', '1'], cwd=ROOT, text=True))
    app = Path(metadata['target_directory']) / 'debug/bundle/macos/Sonora.app/Contents/MacOS/sonora'
    config = {
        'resident': args.resident,
        'baseUrl': f'http://127.0.0.1:{server.server_port}',
        'storage': '/assets/' + next((ROOT / 'dist/assets').glob('storage.worker-*.js')).name,
        'inference': '/assets/' + next((ROOT / 'dist/assets').glob('inference.worker-*.js')).name,
        'vad': '/assets/' + next((ROOT / 'dist/assets').glob('vad.worker-*.js')).name,
    }
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / f'{report_name}.json').write_text(json.dumps({'passed': False, 'status': 'running'}))
    try:
        try:
            process = subprocess.run([str(app)], env={**os.environ, 'SONORA_WASM_SELFTEST': json.dumps(config)}, capture_output=True, text=True, timeout=240)
        except subprocess.TimeoutExpired as error:
            output = (error.stdout or b'').decode(errors='replace') + (error.stderr or b'').decode(errors='replace')
            (OUTPUT / f'{report_name}.log').write_text(output)
            print(output, flush=True)
            raise
        (OUTPUT / f'{report_name}.log').write_text(process.stdout + process.stderr)
        print(process.stdout + process.stderr, flush=True)
        line = next((line for line in process.stdout.splitlines() if line.startswith('SONORA_WASM_RESULT=')), None)
        assert line, 'Desktop probe did not return a result; see offline-desktop.log'
        result = json.loads(line.split('=', 1)[1])
        (OUTPUT / f'{report_name}.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
        assert process.returncode == 0 and result['passed'], result
    finally:
        server.shutdown(); server.server_close()


if __name__ == '__main__':
    main()
