"""Install and launch the actual simulator app; does not claim real-device inference."""
import argparse
import json
from pathlib import Path
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('app', type=Path)
args = parser.parse_args()
devices = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', 'available', '--json'], text=True))['devices']
phones = [device for runtime, rows in devices.items() if '.iOS-' in runtime for device in rows if device['name'].startswith('iPhone')]
if not phones: raise RuntimeError('No available iOS simulator runtime')
device = phones[-1]
udid = device['udid']
if device['state'] != 'Booted': subprocess.run(['xcrun', 'simctl', 'boot', udid], check=True)
subprocess.run(['xcrun', 'simctl', 'bootstatus', udid, '-b'], check=True, timeout=180)
subprocess.run(['xcrun', 'simctl', 'install', udid, str(args.app)], check=True)
subprocess.run(['xcrun', 'simctl', 'launch', udid, 'com.sonora.translate'], check=True)
time.sleep(5)
processes = subprocess.check_output(['xcrun', 'simctl', 'spawn', udid, 'launchctl', 'list'], text=True)
if 'com.sonora.translate' not in processes: raise RuntimeError('App exited after simulator launch')
print('PASS: installed and launched on', device['name'])
