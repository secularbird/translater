"""Collect only user-facing release artifacts, with unambiguous platform names."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'release-artifacts'


def version(tag):
    if not re.fullmatch(r'v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', tag):
        raise ValueError('Release tag must be vMAJOR.MINOR.PATCH (optional prerelease suffix)')
    expected = tag[1:]
    import tomllib
    versions = [json.loads((ROOT / 'package.json').read_text())['version'],
                json.loads((ROOT / 'src-tauri/tauri.conf.json').read_text())['version'],
                tomllib.loads((ROOT / 'src-tauri/Cargo.toml').read_text())['package']['version']]
    if any(value != expected for value in versions):
        raise ValueError(f'Tag {tag} does not match application versions {versions}')
    return expected


def one(paths, description):
    matches = list(paths)
    if len(matches) != 1:
        raise RuntimeError(f'Expected exactly one {description}, found {matches}')
    return matches[0]


def ios_app(platform):
    matches = []
    for app in (ROOT / 'src-tauri/gen/apple').rglob('Sonora.app'):
        if not (app / 'Info.plist').exists(): continue
        info = plistlib.loads((app / 'Info.plist').read_bytes())
        if info.get('DTPlatformName') == platform:
            matches.append(app)
    # Prefer the archived app over intermediate Xcode build products.
    archived = [app for app in matches if any(part.endswith('.xcarchive') for part in app.parts)]
    return one(archived or matches, platform + ' app')


def collect(platform, target, ver, signing='unsigned'):
    OUT.mkdir(exist_ok=True)
    before = {path.name for path in OUT.iterdir() if path.is_file()}
    if platform in ('windows', 'macos'):
        metadata = json.loads(subprocess.check_output(['cargo', 'metadata', '--manifest-path', str(ROOT / 'src-tauri/Cargo.toml'), '--no-deps', '--format-version', '1'], text=True))
        bundle = Path(metadata['target_directory']) / target / 'release/bundle'
        if platform == 'windows':
            for subdir, extension, name in [('nsis', 'exe', 'setup.exe'), ('msi', 'msi', 'installer.msi')]:
                shutil.copyfile(one((bundle / subdir).glob('*.'+extension), extension), OUT / f'Sonora-{ver}-windows-x64-{name}')
        else:
            arch = 'arm64' if target.startswith('aarch64') else 'x64'
            app = one((bundle / 'macos').glob('*.app'), 'macOS app')
            subprocess.run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(app), str(OUT / f'Sonora-{ver}-macos-{arch}.app.zip')], check=True)
            shutil.copyfile(one((bundle / 'dmg').glob('*.dmg'), 'DMG'), OUT / f'Sonora-{ver}-macos-{arch}.dmg')
    elif platform == 'android':
        outputs = ROOT / 'src-tauri/gen/android/app/build/outputs'
        apk = one((path for path in outputs.rglob('*.apk') if 'release' in str(path) and not path.name.endswith('-unsigned.apk')), 'signed release APK')
        aab = one(outputs.rglob('*.aab'), 'release AAB')
        shutil.copyfile(apk, OUT / f'Sonora-{ver}-android-arm64.apk')
        shutil.copyfile(aab, OUT / f'Sonora-{ver}-android-arm64.aab')
    elif platform == 'ios-simulator':
        app = ios_app('iphonesimulator')
        subprocess.run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(app), str(OUT / f'Sonora-{ver}-ios-simulator-arm64.app.zip')], check=True)
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a') as file: file.write(f'app={app}\n')
    elif platform == 'ios-device':
        ipa = one((ROOT / 'src-tauri/gen/apple').rglob('*.ipa'), 'signed iOS IPA')
        method = os.environ.get('IOS_EXPORT_METHOD', 'release-testing')
        if method not in ['release-testing', 'debugging', 'app-store-connect']: raise ValueError(method)
        shutil.copyfile(ipa, OUT / f'Sonora-{ver}-ios-{method}.ipa')
    elif platform == 'checksums':
        files = sorted(path for path in OUT.iterdir() if path.is_file() and path.name != 'SHA256SUMS.txt')
        if not files: raise RuntimeError('No release files to checksum')
        lines = []
        for path in files:
            with path.open('rb') as file: digest = hashlib.file_digest(file, 'sha256').hexdigest()
            lines.append(digest + '  ' + path.name + '\n')
        (OUT / 'SHA256SUMS.txt').write_text(''.join(lines))
    else:
        raise ValueError(platform)
    if platform != 'checksums':
        files = sorted(path.name for path in OUT.iterdir() if path.is_file() and path.name not in before)
        if not files: raise RuntimeError('No new artifacts were collected')
        commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        (OUT / f'BUILD-{platform}-{target or "arm64"}.json').write_text(json.dumps({
            'platform': platform, 'target': target or 'arm64', 'version': ver,
            'commit': commit, 'signing': signing, 'files': files,
        }, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('platform', choices=['version', 'windows', 'macos', 'android', 'ios-simulator', 'ios-device', 'checksums'])
    parser.add_argument('--tag', required=True)
    parser.add_argument('--target', default='')
    parser.add_argument('--signing', choices=['unsigned', 'signed', 'notarized', 'simulator-only'], default='unsigned')
    args = parser.parse_args()
    ver = version(args.tag)
    if args.platform == 'version':
        print(ver)
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a') as file: file.write(f'version={ver}\n')
    else: collect(args.platform, args.target, ver, args.signing)
