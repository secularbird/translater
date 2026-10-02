# iOS 构建与安装确认

检查日期：2026-10-01。

## 当前结论

项目已有iOS工程、Swift原生录音、麦克风用途说明和横竖屏配置；当前机器不能完成整应用打包及安装，尚无本轮可安装的IPA或通过验收的模拟器App。

| 检查 | 结果 |
|---|---|
| Xcode | 26.6，17F113 |
| SDK列表 | 列出iphoneos26.5与iphonesimulator26.5 |
| 工程可用运行目标 | 无；Xcode提示iOS26.5平台未安装 |
| 本机模拟器运行时 | 有iOS18.5和26.0设备，均关闭；当前工程未获得可用构建目标 |
| 真机 | 已配对iPhone12及iPad，但devicectl均显示unavailable |
| 签名证书 | 检测到1个有效Apple Development身份；工程尚未确认开发团队及描述文件配置 |
| Rust真机目标检查 | `aarch64-apple-ios`通过 |
| Rust模拟器目标检查 | `aarch64-apple-ios-sim`通过 |
| 模拟器归档 | 失败：Xcode Simulator SDK 26.5 is not installed |
| 真机无签名归档 | 失败：Found no destinations for the scheme sonora_iOS and action archive，退出码70 |

SDK能被列出，不等于Xcode平台组件与构建目标处于可用状态。Rust `cargo check`也不等同于Swift插件、最终链接、签名及安装通过。

## 本次实际命令

```bash
xcodebuild -version
xcodebuild -showsdks
xcodebuild -project src-tauri/gen/apple/sonora.xcodeproj -scheme sonora_iOS -showdestinations
xcrun simctl list devices available
xcrun devicectl list devices
security find-identity -v -p codesigning
cargo check --manifest-path src-tauri/Cargo.toml --target aarch64-apple-ios
cargo check --manifest-path src-tauri/Cargo.toml --target aarch64-apple-ios-sim
npm run tauri -- ios build --debug --target aarch64-sim --no-sign --archive-only --ci
npm run tauri -- ios build --debug --target aarch64 --no-sign --archive-only --ci
```

## 继续安装所需条件

1. 在Xcode → Settings → Components补齐当前Xcode要求的iOS26.5平台组件，然后重新检查destinations。
2. 真机安装时连接并解锁目标iPhone/iPad、信任此电脑，在需要时启用开发者模式。
3. 在工程Signing & Capabilities中选择开发团队，确认应用标识对应的签名/描述文件可用。
4. 构建签名版本并安装，再实测麦克风权限、语音采集、VAD、离线模型下载/缓存、推理和内存。

设备离线模型当前在Android的常驻内存规模约3GiB；该数据不是iOS实测，不能据此承诺iPhone上的WebView内存及性能表现。模拟器通过也不能替代真机验证。
