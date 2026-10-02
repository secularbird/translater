# 自动构建与发布

当前使用 GitHub Actions，仓库：`secularbird/translater`。

## 工作流

- **CI**：推送main、Pull Request或手动触发。运行TypeScript、Rust、浏览器、真实Silero VAD及发布工具校验。
- **Release**：推送`v*`标签或手动触发。构建Windows、macOS、Android、iOS产物，全部必需任务成功后才允许发布。
- WASM运行时只准备一次并分发给构建任务；约880MB大模型权重不放进安装包，也不上传到Release。

先构建检查，再发布：

```bash
gh workflow run release.yml --ref main -f tag=v0.1.0 -F publish=false
gh run list --workflow release.yml
gh run watch <run-id> --exit-status

# 所有构建通过后执行发布；仍会重新验证构建，缓存会被复用
gh workflow run release.yml --ref main -f tag=v0.1.0 -F publish=true
```

也可以在GitHub Actions → Release → Run workflow中操作。版本标签必须与`package.json`、`src-tauri/Cargo.toml`和`src-tauri/tauri.conf.json`一致。

发布任务先建立草稿、上传完整产物和校验和，再公开Release。已有正式Release不会被自动覆盖，也不会移动已有版本标签。

## 产物

| 平台 | 架构 | 产物 | 当前签名方式 |
|---|---|---|---|
| Windows | x64 | NSIS `.exe`、`.msi` | 未做商业代码签名 |
| macOS | Apple Silicon / Intel | `.dmg`、`.app.zip` | 默认未做Developer ID签名/公证；可配置Apple凭据 |
| Android | ARM64 | `.apk`、`.aab` | 固定正式发布密钥 |
| iOS Simulator | Apple Silicon ARM64 | `ios-simulator-arm64.app.zip` | 模拟器专用，不是iPhone安装包 |
| iOS设备 | ARM64 | `.ipa` | 仅配置完整Apple签名资料后构建 |

`BUILD_INFO.json`记录构建提交和各平台签名类型，`SHA256SUMS.txt`记录文件校验值。

Windows需要WebView2；macOS未公证包首次打开可能需要在系统隐私与安全性设置中允许。iOS模拟器包可解压后用`xcrun simctl install booted Sonora.app`安装到已启动的Apple Silicon模拟器，不能安装到实体iPhone/iPad。

## Android正式签名

仓库需要以下Actions Secrets：

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

第一次创建固定签名并上传Secrets：

```bash
python3 scripts/ci/android_signing.py create --repo secularbird/translater
```

已有本项目本地密钥时复用，不重新生成：

```bash
python3 scripts/ci/android_signing.py upload --repo secularbird/translater
```

密钥及凭据保存在本地Git忽略目录`.release-keys/android/`。请单独安全备份该目录；CI不会生成临时签名替代它。私钥和密码不进入Git、发布产物或日志。

**正式签名与之前的调试版签名不同，不能直接覆盖当前调试安装。** 迁移时先备份会话，再卸载调试版；模型缓存也需要重新准备。后续正式版本持续复用相同发布密钥即可正常升级。

Android构建固定JDK17、API36、NDK28.2，支持16KB页打包。发布前执行`apksigner verify`。AAB用于商店上传，直接安装请选择APK。

## Apple签名（后续可补）

### macOS

配置完整的三项Secrets后启用Developer ID签名：

- `APPLE_CERTIFICATE`：p12证书的base64
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`

需要公证时再同时配置：

- `APPLE_ID`
- `APPLE_PASSWORD`：应用专用密码
- `APPLE_TEAM_ID`

### iOS设备

四项Secrets全部配置后，Release流程会额外导出IPA：

- `IOS_CERTIFICATE`：p12证书的base64
- `IOS_CERTIFICATE_PASSWORD`
- `IOS_MOBILE_PROVISION`：与`com.sonora.translate`匹配的描述文件base64
- `APPLE_DEVELOPMENT_TEAM`

可选仓库变量`IOS_EXPORT_METHOD`：`release-testing`（默认）、`debugging`或`app-store-connect`。描述文件必须匹配证书、应用标识和导出用途；release-testing/debugging的安装范围由描述文件中的设备决定。导出App Store包不等于已经上传App Store或TestFlight。

任何不完整的签名配置会使构建报错，不会悄悄改成未签名产物。目前Apple资料尚未配置，所以首版iOS仅提供模拟器构建及安装启动验证。

## 验证边界

CI验证编译、打包、现有自动化和iOS模拟器启动；并不代表四端所有设备的麦克风、模型准确率或长时间内存稳定性已经验收。现有实机问题与资源数据仍见README及`tests/`中的报告。
