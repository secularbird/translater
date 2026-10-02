"""Use Tauri's signing support when credentials are complete; otherwise be explicit."""
import argparse
import os
import subprocess

MAC = ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY']
NOTARY = ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID']
IOS = ['IOS_CERTIFICATE', 'IOS_CERTIFICATE_PASSWORD', 'IOS_MOBILE_PROVISION', 'APPLE_DEVELOPMENT_TEAM']


def complete_group(keys):
    present = [key for key in keys if os.environ.get(key)]
    if present and len(present) != len(keys):
        raise RuntimeError('Incomplete signing configuration; missing ' + ', '.join(key for key in keys if key not in present))
    return bool(present)


def output(key, value):
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as file: file.write(f'{key}={value}\n')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('platform', choices=['macos', 'ios-simulator', 'ios-device'])
    parser.add_argument('--target', default='aarch64-apple-darwin')
    args = parser.parse_args()
    env = {key: value for key, value in os.environ.items() if value or key not in MAC + NOTARY + IOS}
    if args.platform == 'macos':
        signed, notarized = complete_group(MAC), complete_group(NOTARY)
        if notarized and not signed: raise RuntimeError('Notarization requires a Developer ID signing certificate')
        output('signing', 'notarized' if notarized else 'signed' if signed else 'unsigned')
        command = ['npm', 'run', 'tauri', '--', 'build', '--ci', '--target', args.target, '--bundles', 'app,dmg']
    elif args.platform == 'ios-simulator':
        env = {key: value for key, value in env.items() if key not in MAC + NOTARY + IOS}
        output('signing', 'simulator-only')
        command = ['npm', 'run', 'tauri', '--', 'ios', 'build', '--target', 'aarch64-sim', '--no-sign', '--archive-only', '--ci']
    else:
        if not complete_group(IOS):
            print('iOS signing is not configured. This release contains the simulator app only, not an installable iPhone IPA.')
            output('built', 'false')
            return
        method = os.environ.get('IOS_EXPORT_METHOD', 'release-testing')
        if method not in ['release-testing', 'debugging', 'app-store-connect']:
            raise RuntimeError('Invalid IOS_EXPORT_METHOD')
        command = ['npm', 'run', 'tauri', '--', 'ios', 'build', '--target', 'aarch64', '--export-method', method, '--ci']
        output('signing', 'signed')
    subprocess.run(command, env=env, check=True)
    output('built', 'true')


if __name__ == '__main__':
    main()
