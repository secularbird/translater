"""Create a persistent Android release identity or configure a CI Gradle build.

Passwords travel through environment/stdin, never command-line literals or logs.
Local key material lives only in the Git-ignored .release-keys directory.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import secrets
import subprocess

ROOT = Path(__file__).resolve().parents[2]
SECRET_NAMES = ('ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD')


def private_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as file:
        file.write(data)


def create_key(repository):
    folder = ROOT / '.release-keys/android'
    store, credentials = folder / 'sonora-release.jks', folder / 'credentials.json'
    if store.exists() or credentials.exists():
        raise RuntimeError('Release key material already exists; use upload to reuse it.')
    folder.mkdir(parents=True, mode=0o700)
    password = secrets.token_urlsafe(36)
    alias = 'sonora-release'
    subprocess.run(['keytool', '-genkeypair', '-storetype', 'JKS', '-keystore', str(store),
                    '-alias', alias, '-keyalg', 'RSA', '-keysize', '4096', '-validity', '10000',
                    '-dname', 'CN=Sonora Release, O=Sonora', '-storepass:env', 'SONORA_KEY_PASSWORD',
                    '-keypass:env', 'SONORA_KEY_PASSWORD'],
                   env={**os.environ, 'SONORA_KEY_PASSWORD': password}, check=True)
    store.chmod(0o600)
    private_write(credentials, json.dumps({'alias': alias, 'storePassword': password, 'keyPassword': password}).encode())
    print('Created persistent Android release identity in .release-keys/android; keep a secure backup.')
    if repository:
        upload_key(repository)


def upload_key(repository):
    folder = ROOT / '.release-keys/android'
    credentials = json.loads((folder / 'credentials.json').read_text())
    values = [base64.b64encode((folder / 'sonora-release.jks').read_bytes()).decode(),
              credentials['storePassword'], credentials['alias'], credentials['keyPassword']]
    for name, value in zip(SECRET_NAMES, values):
        subprocess.run(['gh', 'secret', 'set', name, '--repo', repository], input=value, text=True, check=True)
        print('Configured repository secret:', name)


def configure_ci():
    missing = [name for name in SECRET_NAMES if not os.environ.get(name)]
    if missing:
        raise RuntimeError('Missing Android release secrets: ' + ', '.join(missing))
    store = Path(os.environ['RUNNER_TEMP']) / 'sonora-signing/release.jks'
    private_write(store, base64.b64decode(os.environ['ANDROID_KEYSTORE_BASE64'], validate=True))
    with open(os.environ['GITHUB_ENV'], 'a') as file:
        file.write(f'ANDROID_KEYSTORE_PATH={store}\n')
    gradle = ROOT / 'src-tauri/gen/android/app/build.gradle.kts'
    content = gradle.read_text()
    marker = '    buildTypes {'
    if content.count(marker) != 1 or content.count('getByName("release") {') != 1:
        raise RuntimeError('Unexpected generated Android Gradle layout')
    signing = '''    signingConfigs {
        create("sonoraRelease") {
            storeFile = file(System.getenv("ANDROID_KEYSTORE_PATH"))
            storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("ANDROID_KEY_ALIAS")
            keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
        }
    }
'''
    content = content.replace(marker, signing + marker)
    content = content.replace('getByName("release") {', '''getByName("release") {
            signingConfig = signingConfigs.getByName("sonoraRelease")
            // Preserve explicitly configured LAN services and static model mirrors.
            manifestPlaceholders["usesCleartextTraffic"] = "true"''')
    gradle.write_text(content)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['create', 'upload', 'configure'])
    parser.add_argument('--repo')
    args = parser.parse_args()
    if args.action == 'create': create_key(args.repo)
    elif args.action == 'upload':
        if not args.repo: parser.error('upload requires --repo')
        upload_key(args.repo)
    else: configure_ci()
