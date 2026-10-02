"""Publish only a complete, same-commit artifact set; retain drafts on upload failure."""
import argparse
import json
import os
from pathlib import Path
import subprocess
from artifacts import ROOT, OUT, collect, version

parser = argparse.ArgumentParser()
parser.add_argument('--tag', required=True)
args = parser.parse_args()
ver = version(args.tag)
repository = os.environ['GITHUB_REPOSITORY']
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
manifests = [json.loads(path.read_text()) for path in sorted(OUT.glob('BUILD-*.json'))]
required = {('windows', 'x86_64-pc-windows-msvc'), ('macos', 'aarch64-apple-darwin'),
            ('macos', 'x86_64-apple-darwin'), ('android', 'arm64'), ('ios-simulator', 'arm64')}
actual = {(item['platform'], item['target']) for item in manifests}
if not required.issubset(actual) or len(actual) != len(manifests):
    raise RuntimeError(f'Incomplete or duplicate platform artifacts: {actual}')
files = set()
for item in manifests:
    if item['version'] != ver or item['commit'] != commit:
        raise RuntimeError('Artifact version/commit mismatch')
    if item['platform'] == 'android' and item['signing'] != 'signed':
        raise RuntimeError('Android release must use the persistent release signing key')
    for filename in item['files']:
        if Path(filename).name != filename or not (OUT / filename).is_file():
            raise RuntimeError('Missing or invalid artifact path')
        if filename in files: raise RuntimeError('Duplicate release filename')
        files.add(filename)
if not any(name.endswith('.apk') for name in files) or not any(name.endswith('.aab') for name in files):
    raise RuntimeError('Both signed Android APK and AAB are required')
(OUT / 'BUILD_INFO.json').write_text(json.dumps({'tag': args.tag, 'commit': commit, 'platforms': manifests}, indent=2))
for path in OUT.glob('BUILD-*.json'): path.unlink()
collect('checksums', '', ver)

# A tag may already exist when triggered by a tag push. Never move it.
tag_commit = subprocess.run(['git', 'rev-parse', '--verify', f'refs/tags/{args.tag}^{{commit}}'], capture_output=True, text=True)
if tag_commit.returncode == 0 and tag_commit.stdout.strip() != commit:
    raise RuntimeError('Existing version tag points to a different commit')

apple_status = '\n'.join(f"- macOS {item['target']}: {item['signing']}" for item in manifests if item['platform'] == 'macos')
ios = ('本版本包含签名 IPA；其可安装范围取决于描述文件及导出方式。' if any(name.endswith('.ipa') for name in files)
       else '**iOS 当前仅提供 ARM64 模拟器 App，不是可安装到 iPhone/iPad 的 IPA。Apple 签名资料尚未配置。**')
notes = f'''# Sonora {args.tag}

离线语音与文字翻译：Silero VAD、SenseVoice、M2M100，自适应界面与本地缓存。

## 安装包
- Windows x64：NSIS `.exe` / MSI，当前没有商业代码签名。
- macOS：Apple Silicon / Intel 的 `.dmg` 和 `.app.zip`。
{apple_status}
- Android ARM64：正式密钥签名的 `.apk`；`.aab` 用于应用商店分发，不能直接安装。
- {ios}

macOS `unsigned` 表示未做 Developer ID 签名/公证，首次打开可能需要在系统设置中允许。
Android 正式签名与此前调试版不同，不能直接覆盖调试版；请先备份会话，再卸载调试版安装。

## 离线资源与已知限制
- 首次使用需下载约880MB模型，安装包已包含WASM运行时；下载后本机推理。
- 当前双模型常驻约3GiB内存规模，4GB设备存在内存压力和启动耗时波动。
- 短句、混合语言和背景声音仍可能误识别；构建成功不等于所有设备准确率或性能验收。
- 查看README及tests目录的验证报告。`SHA256SUMS.txt`提供校验值，`BUILD_INFO.json`记录构建提交与签名类型。

构建提交：`{commit}`
'''
staging = ROOT / '.release-staging'
staging.mkdir(exist_ok=True)
notes_path = staging / 'release-notes.md'
notes_path.write_text(notes)
base = ['gh', 'release']
existing = subprocess.run(base + ['view', args.tag, '--repo', repository, '--json', 'isDraft,targetCommitish'], capture_output=True, text=True)
if existing.returncode == 0:
    release = json.loads(existing.stdout)
    if not release['isDraft'] or release['targetCommitish'] != commit:
        raise RuntimeError('Refusing to overwrite an existing published release or another draft commit')
else:
    subprocess.run(base + ['create', args.tag, '--repo', repository, '--target', commit, '--draft',
                          '--title', f'Sonora {args.tag}', '--notes-file', str(notes_path)], check=True)
subprocess.run(base + ['upload', args.tag, '--repo', repository, '--clobber', *[str(path) for path in sorted(OUT.iterdir()) if path.is_file()]], check=True)
subprocess.run(base + ['edit', args.tag, '--repo', repository, '--draft=false', '--latest', '--notes-file', str(notes_path)], check=True)
