# 声桥 Sonora

一个基于 **Tauri 2 + React + TypeScript + Rust** 的实时语音翻译应用，面向 macOS、Windows、Linux、Android 和 iOS。

[![CI](https://github.com/secularbird/translater/actions/workflows/ci.yml/badge.svg)](https://github.com/secularbird/translater/actions/workflows/ci.yml)

[下载发布版本](https://github.com/secularbird/translater/releases) · [自动构建与签名说明](docs/RELEASING.md)

GitHub Actions提供Windows x64、macOS Apple Silicon/Intel、Android ARM64及iOS模拟器构建。iPhone可安装IPA需要额外Apple签名资料，不能用模拟器包替代。

自然说话 → Silero VAD 判断语音起止 → 语音识别 / 语言检测 → 完整句翻译 → 译文流式显示。

## 已实现

- 紧凑自适应单页：桌面使用完整窗口宽度、字幕左右双栏，手机竖屏上下排列；横屏低高度时语言选择合入顶栏，录音与状态横向排列。
- 保存/清空合入顶部工具区；原文与译文独立滚动，软键盘弹出后按实际可见视口缩排输入区域。
- 选择音频输入设备、源语言和目标语言，支持源语言自动检测。
- 12 种常用目标语言：中文、英语、日语、韩语、法语、德语、西班牙语、葡萄牙语、俄语、阿拉伯语、意大利语、印地语。
- 原文与译文在两个固定区域连续追加；显示识别语言，支持全文复制和独立滚动，不按处理片段增加卡片。
- **设备离线推理：SenseVoice Small INT8 + Meta M2M100 418M Q8，在 Web Worker 内通过 WASM CPU 运行。**
- 模型下载 / 断点续传 / 文件导入 / SHA-256 权重校验 / 本地缓存 / 内存释放。
- 识别和翻译可分别配置服务地址、模型名称及 API Key。
- 本地模型服务：**whisper.cpp + Ollama**；也支持其他 OpenAI 兼容服务。
- 远程模型：OpenAI 兼容的语音识别与聊天 API。
- Android `AudioRecord` / iOS `AVAudioEngine` 原生录音插件和麦克风权限。
- Silero VAD 停顿切分、整句翻译、独立 WAV 编码、顺序处理、积压自动暂停、错误重试、取消处理。
- 文字测试入口、复制译文、主动保存和删除本机会话记录。

**三种模式有明确区别：**「设备离线」直接在应用内进行 WASM 推理，下载权重后不需要电脑或服务器；「本地服务」调用本机 / 局域网 whisper.cpp、Ollama 等 HTTP 服务；「远程 API」调用你指定的云端接口。新安装默认选择设备离线，运行时已打包，约 880 MB 的模型权重单独下载。

**断句与实时性：** 所有语音模式使用随应用打包的 Silero VAD 判断语音起止；默认结束静音约 **0.8 秒**，设置可选 0.5 / 0.8 / 1.2 / 1.6 秒。不会按原来的 2/4/6/8 秒逐块翻译。普通发言在 VAD 结束后识别，再按识别文本的句末标点逐句翻译；无标点的短发言由 VAD 结束或用户停止收尾。VAD 判断的是声学停顿，不保证语法上的句子完整性。

长时间连续说话时，约 **25 秒的窗口仅用于保护 ASR 输入**：先识别并合并原文，界面显示「等待完整句」，同一次发言真正结束前不提交这些保护块翻译。点击结束录音会收尾并完成队列；收尾失败的不完整文本不能直接重试翻译。设备离线通过解码回调、服务模式通过 SSE 逐步显示译文。延迟包含端点等待、初始化和实际推理；服务模式还包含网络耗时。

## 快速启动

源码构建要求：Node.js 18+（建议当前 LTS）、npm、Rust stable、Python 3.12+（准备官方 WASM 发行包），以及相应平台的 [Tauri 开发依赖](https://v2.tauri.app/start/prerequisites/)。安装成品应用不需要 Python 或模型服务器。

```bash
npm ci

# 首次准备固定版本的 WASM 运行时，之后构建复用本地文件
npm run models:setup

# 桌面应用开发模式
npm run desktop

# 或仅预览前端：http://localhost:1420
npm run dev
```

浏览器录音需要 localhost 或 HTTPS。设备离线模式只在下载权重时访问网络；浏览器预览的模型服务模式需要服务允许 CORS，原生应用的 HTTP 推理请求由 Rust 发送。

首次使用：

1. 打开「模型设置 → 设备离线」。
2. 点击「下载离线模型」，等待两个模型均显示「已下载」，然后保存设置。也可导入固定版本模型文件。
3. 选择源语言、目标语言和麦克风。
4. 点击「开始翻译」，允许麦克风权限，然后自然说话。

应用不会生成假翻译结果。模型文件缺失、初始化失败或内存不足时会展示错误，不会自动把音频改发到远程服务。

## 设备离线模型（WASM）

| 功能 | 模型 / 引擎 | 文件体积 | 语言 |
|---|---|---:|---|
| 语音活动检测 | Silero VAD / sherpa-onnx WASM SIMD 1.12.15 | 随应用打包 | 判断语音起止，不负责语言识别 |
| 语音识别 | SenseVoice Small INT8 / sherpa-onnx WASM SIMD 1.12.15 | 约 240 MB | 普通话、粤语、英语、日语、韩语，支持检测 |
| 文本翻译 | Meta M2M100 418M Q8 / Transformers.js 3.8.1 + ONNX Runtime Web | 约 640 MB | 底层支持 100 种，界面开放 12 种常用目标语言 |

- WASM 和 JavaScript 运行时包含在安装包中，推理不依赖 CDN 或 HTTP 模型服务器。
- 模型分成 2 MB Blob 块保存在应用的 IndexedDB，断点可继续下载；ONNX 权重校验成功后才标记可用。
- 新配置默认关闭「低内存模式」，优先保持两个模型常驻。第一次开始录音前顺序加载模型，准备好后才打开麦克风；随后识别/翻译复用同一 Worker 和推理会话，停止录音也不卸载。
- 原生移动端先完成麦克风授权再加载模型；常驻预热先加载较大的翻译模型。4 GB 及以下（或未报告内存容量）的移动 WebView 关闭额外的权重预打包缓存，降低常驻初始化的内存压力。
- 设置中区分「已下载」（磁盘缓存）和「内存已加载」（运行时就绪），并显示本次模型初始化次数。已有安装保留其原设置，想要常驻时请关闭「低内存模式」。
- 显式开启「低内存模式」会交替释放/重载模型，用更高延迟换取更低的同时驻留内存。常驻模式占用更多 RAM；退出、手动释放、取消正在运行的推理或更改识别语言时，相关模型可能需要重新初始化。
- 「释放模型内存」终止推理 Worker，保留下载文件；「删除已下载模型」移除权重缓存。
- 文字和语音都支持源语言「自动检测」，也可手动指定。文字使用随应用打包的本地检测器，不调用网络服务、不加载ASR；每次输入独立判断，检测结果显示在会话中，不会把自动选项改成固定语言。短词、混合语言可能需要手动校正。
- 离线每句最多 500 字，生成达到长度上限时会明确提示。粤语识别结果按中文文本翻译。
- 除中英日韩粤语以外的源语言在界面标为「仅文字」，不会冒充 SenseVoice 支持的语音语言。
- 模型总下载量不等于运行内存，现代 WebView 需要支持 WASM SIMD。旧系统可选择服务模式。

### 下载较慢时：电脑下载后导入

```bash
npm run models:download
```

模型保存在 `.model-cache/offline-assets/`。在应用的「导入文件」入口选择其中的 9 个文件，可以分目录、分多次导入；文件名称、版本、大小必须与 `src/offline/assets.json` 一致，三个 ONNX 文件还会验证 SHA-256。模型目录和下载临时文件不会进入源码版本控制。

也可以用任意静态文件服务器提供 `.model-cache/offline-assets/`，在「下载与文件说明 → 静态模型镜像地址」填写基础地址。镜像只分发权重，**不接收音频或执行推理**。应用默认直接使用固定版本 Hugging Face URL。

### 已验证的真实推理

- Chromium：阻断外部 HTTP 请求后完成中英识别、中英双向翻译，以及真实语音测试麦克风 → Silero → SenseVoice → M2M100 完整链路；页面重载后缓存加载成功。
- macOS `.app` 的 **WKWebView / `tauri://localhost`**：打包 Silero → SenseVoice 音频链路与 M2M100 文本翻译通过。
- Android 17 ARM64 / 16 KB 页模拟器的 **原生 WebView**：模型下载服务关闭后，打包 Silero → SenseVoice 与英译中、连续追加通过。
- 小米MIX 2S实体手机（Android 10 / WebView 151）：APK及完整模型缓存已安装，真实VAD/语音样本识别、文字自动检测与连续翻译通过；实体麦克风已确认实际音频帧和识别内容。指定短句准确率尚未验证通过，详见[实机修复记录](tests/MIX2S_FIX_REPORT.md)。
- 当前桌面应用、模拟器及上述MIX 2S已写入模型缓存。iOS、Windows、Linux尚未做真实模型验收。

原始结果在 `test-results/automation/offline-real.json`、`offline-desktop.json`、`offline-android.json`，详细说明见 [tests/WASM_REPORT.md](tests/WASM_REPORT.md)。

## 本地服务配置（可选，HTTP）

选择「模型设置 → 本地服务」后使用以下配置。该模式仍需自己启动服务；「测试服务连接」只检查 HTTP 可访问性，不代表模型一定已加载。

### 1. 启动 whisper.cpp

安装并编译 [whisper.cpp](https://github.com/ggml-org/whisper.cpp)，下载**多语言**模型。在 whisper.cpp 目录运行，例如：

```bash
bash ./models/download-ggml-model.sh base
cmake -B build
cmake --build build --config Release -j
./build/bin/whisper-server -m ./models/ggml-base.bin --host 127.0.0.1 --port 8080
```

应用中配置：

| 项目 | 值 |
|---|---|
| 接口协议 | whisper.cpp · `/inference` |
| 服务基础地址 | `http://127.0.0.1:8080` |
| 模型名称 | `whisper-base`，或实际模型的标记名称 |
| API Key | 没有鉴权时留空 |

whisper.cpp 实际使用 **服务器启动时 `-m` 加载的模型**；界面的模型名称不会让服务器自动切换权重。可换用 `small`、`medium`、`large-v3-turbo` 等多语言模型，在速度和准确率之间取舍。`.en` 模型仅面向英语。

若使用 faster-whisper 等提供 OpenAI 兼容接口的服务，将协议改为 OpenAI，并填写服务实际的 `/v1` 基础地址。

### 2. 启动 Ollama

安装 [Ollama](https://ollama.com)，然后：

```bash
ollama serve
# 在另一个终端下载模型
ollama pull qwen2.5:7b
```

如果 Ollama 桌面程序已启动，无须再次执行 `ollama serve`。

| 项目 | 值 |
|---|---|
| 翻译基础地址 | `http://127.0.0.1:11434/v1` |
| 模型名称 | `qwen2.5:7b` |
| API Key | 留空 |

设备资源较少时可以使用 `qwen2.5:3b`，并在应用中同步修改模型名称。其他兼容 `/v1/chat/completions` 的本地服务也可接入。

### 3. 手机连接电脑上的模型

- 让手机和电脑连接同一局域网。
- whisper.cpp 使用 `--host 0.0.0.0` 启动。
- Ollama 使用 `OLLAMA_HOST=0.0.0.0:11434 ollama serve` 启动。
- 在手机应用中把两个 `127.0.0.1` 替换为电脑局域网 IP，例如 `192.168.1.20`。
- 确保电脑防火墙允许手机访问对应端口。Android 模拟器访问宿主机通常使用 `10.0.2.2`。

手机里的 `127.0.0.1` 始终指手机自身；选择「本地服务」也不会自动启动电脑上的服务。「设备离线」无需这些服务。

## 远程 API 配置

在「模型设置 → 远程 API」分别填写：

| 类型 | 基础地址示例 | 模型示例 |
|---|---|---|
| 语音识别 | `https://api.openai.com/v1` | `whisper-1` |
| 文本翻译 | `https://api.openai.com/v1` | `gpt-4o-mini` |

两个 API Key **分别填写**，可以使用相同密钥，也可以使用不同服务商。基础地址不包含 `/audio/transcriptions` 或 `/chat/completions` 后缀。

适配约定：

- ASR：multipart WAV 上传，标准响应包含 `text`；优先使用 `verbose_json` 读取 `language`。
- `gpt-4o` 系列转写模型使用 `json` 响应格式；若服务不返回语言，自动检测栏显示「待检测」，不会猜测语言。
- 翻译：OpenAI chat completions，`stream: true`，读取 `choices[0].delta.content`；也接受非流式 `choices[0].message.content` 响应。
- 服务需要支持相应协议。Azure 的特殊路径、原生 Gemini/Claude 协议、WebSocket Realtime API 未直接适配，可通过兼容网关接入。

## 跨端运行与打包

### 桌面

```bash
npm run tauri -- build

# macOS 开发测试应用包（不生成 DMG）
npm run tauri -- build --debug --bundles app
```

macOS 麦克风描述和音频输入 entitlement 已配置。Windows / Linux 需在相应平台安装 Tauri 依赖并构建；本次在 macOS 上验证了 `.app` 构建。

### Android

需要 Android Studio、SDK、NDK、JDK 17 和 Rust Android targets。Tauri 可在 macOS 上自动定位默认 Android Studio 安装；其他环境按 Tauri 文档设置 `JAVA_HOME`、`ANDROID_HOME`、`NDK_HOME`。

```bash
# 首次生成 Android 工程
npm run tauri -- android init

# 连接设备或启动模拟器后运行
npm run android

# ARM64 调试 APK
npm run tauri -- android build --debug --target aarch64 --apk
```

如果 Android Studio 自带的是更新的 JDK，建议明确切换到 JDK 17。本机最终验证命令为：

```bash
JAVA_HOME="$(/usr/libexec/java_home -v 17)" npm run tauri -- android build --debug --target aarch64 --apk --ci
```

APK 输出：`src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`。

录音权限由本地插件的 Android Manifest 合并进入应用，运行时请求 `RECORD_AUDIO`。使用 NDK 28+ 支持 16 KB 内存页；本次使用 NDK 30 完成 ARM64 APK 构建。已在 Android 17 ARM64 / 16 KB 内存页模拟器验证安装、权限、原生录音和真实 WASM 推理；小米MIX 2S实体机已验证安装、启动、缓存、真实语音样本识别与文字翻译，实体麦克风录音另待验收。

### iOS

需要 macOS、完整 Xcode、安装对应 iOS 平台组件；真机部署还需要 Apple 开发签名配置。

```bash
npm run tauri -- ios init
npm run ios

# 无签名归档（要求 Xcode 中已安装 iOS 平台）
npm run tauri -- ios build --debug --target aarch64 --no-sign --archive-only

# 或打开 Xcode 工程设置 Signing & Capabilities
open src-tauri/gen/apple/sonora.xcodeproj
```

已提供 Swift 原生录音、麦克风和局域网用途说明。`cargo check --target aarch64-apple-ios` 已通过。当前机器的 Xcode 报告 **“iOS 26.5 is not installed”**，未产生 iOS archive / IPA；需要在 **Xcode → Settings → Components** 安装匹配平台后继续打包与真机验证。

`src-tauri/gen/` 是可重新生成的平台工程，不作为源代码维护；自定义录音逻辑位于 `plugins/microphone/`，生成工程时自动接入。

## 数据与使用行为

- API Key 仅保存在内存中，**不写入 localStorage**；应用退出后需重新填写。
- 模型地址、模型名称、语言等偏好保存在本地。
- 设备离线权重保存在应用本地 IndexedDB，退出后仍保留；卸载应用或清除应用数据会移除模型。浏览器预览的缓存与原生应用各自独立。
- 会话不会自动持久化。点击保存后，原文和译文保存在本设备的 WebView 存储中，最多保留最近 20 场会话。
- 录音仅前台工作；进入后台、音频路由变化或设备断开时会停止或提示重新开始。
- 移动端采用系统当前麦克风 / 音频路由；桌面支持枚举、选择具体输入设备。部分设备名称需授权录音后才可读取。
- 最多积压 8 个待处理语音片段，超过时自动停止录音，避免无限增长。被积压保护拒绝的新片段不会上传；已有队列会继续处理。
- 停止录音会提交最后一段并继续完成队列；「取消处理」会中止当前请求并清空待处理队列。
- 再次开始录音会接着现有文本追加，点击「清空会话」才重置显示。内部按 VAD 发言汇总识别、按完整句翻译，界面与历史记录按完整原文/译文展示；重试在原位置更新，不重复追加已完成内容。
- 设备离线推理只读取本地缓存；本地服务 / 远程 API 模式的数据目的地由填写的地址决定。

## 项目结构

```text
src/
  App.tsx                       # 工作台、字幕、语言选择、历史记录
  components/SettingsDialog.tsx # 识别/翻译服务与偏好设置
  components/ContinuousTranscript.tsx # 固定原文/译文区域、流式追加、全文复制
  lib/transcript.ts              # 连续文本连接与整场会话复制
  hooks/useTranslator.ts        # 队列、录音生命周期、取消和失败恢复
  lib/audio.ts                  # 跨回调连续重采样、独立 WAV 编码
  lib/vad.ts                    # VAD Worker 生命周期、背压与异步收尾
  lib/vad.worker.ts             # Silero VAD WASM 推理
  lib/vad-endpoint.ts           # 发言 ID、真实结束与长音频保护块
  lib/sentences.ts              # 完整句切分、保护切点的续句处理
  lib/capture.ts                # 桌面 AudioWorklet / 移动原生录音
  lib/api.ts                    # HTTP 模型适配与原生调用
  lib/sse.ts                    # 浏览器 SSE 增量解析
  offline/client.ts             # Worker 生命周期、状态与取消
  offline/cache.ts              # IndexedDB 分片缓存、断点下载、校验
  offline/inference.worker.ts   # 真正的 SenseVoice / M2M100 WASM 推理
  offline/assets.json           # 固定版本模型清单及权重 SHA-256
scripts/prepare_sherpa.py        # 校验并准备官方 sherpa WASM 运行时
scripts/download_models.py      # 准备可导入/镜像的真实模型文件
public/audio-processor.js        # 音频线程采样
src-tauri/src/model.rs           # Rust HTTP、SSE、超时与取消
plugins/microphone/              # Kotlin / Swift Tauri 录音插件
tests/e2e.py                     # 独立浏览器场景（真实 HTTP/SSE + 模拟模型）
tests/android_smoke.py           # Android UI、权限、录音生命周期
tests/run_tests.py               # 一键执行，自动管理 Vite 服务
tests/model_fixture.py           # 可延迟/中断的本地模型接口测试服务
```

## 验证

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

首次准备浏览器测试环境：

```bash
python3 -m pip install -r tests/requirements.txt
python3 -m playwright install chromium
```

一键运行（自动选择空闲端口启动 Vite，结束后清理自己的服务，无须手工 `npm run dev`）：

```bash
# TypeScript 单元测试 + Rust 测试 + 生产构建 + 浏览器测试
npm run test:all

# 单独浏览器测试
npm run test:e2e

# 已安装当前 APK 的模拟器：包括首次授权和拒绝权限场景
npm run test:android -- --android emulator-5554 --permissions

# 一次执行全部套件，包括 Android
npm run test:all -- --android emulator-5554 --permissions

# 汇总最近各套件结果，不重复执行测试
npm run test:report
```

ADB 自动从 PATH 或 Android SDK 目录查找，也可追加 `--adb /path/to/adb`。Android 测试运行的是**已安装的 APK**；源码变化后先重新构建安装。测试会重启本应用，丢弃未保存的当前会话；`--permissions` 会重置、授权、拒绝本应用的麦克风权限，结束后恢复为允许。测试不清除已保存的会话和模型配置。

### 覆盖范围与报告

| 套件 | 用例数 | 主要覆盖 |
|---|---:|---|
| TypeScript / React Hook | 105 | WAV/VAD/重采样、整句、SSE、队列、权限、缓存/常驻、语言检测、取消、弱音量显示、短语气词、单句输出超限后继续录音 |
| Rust | 3 | URL 校验、请求取消状态清理、SSE UTF-8 边界 |
| 浏览器 Playwright | 15 | 配置校验、SSE/断流、历史、复制、取消、真实VAD、鉴权、8尺寸响应式、长文本、连续追加、整句请求、文字自动检测与失败后手动重试 |
| Android UI | 5 | 首页导航、设置、首次授权、录音停止、后台暂停、拒绝权限后的错误与控件恢复 |

产物在 `test-results/automation/`：
- `latest.html` / `latest.json`：执行 `npm run test:report` 后汇总各套件最近结果。
- `index.html` / `summary.json`：单次运行命令的步骤结果。
- `unit.xml`、`browser.xml`、`android.xml`：JUnit 格式，可用于 CI。
- `*.png`：浏览器与 Android 场景快照（失败时也保存）。
- `*.trace.zip`：浏览器操作、DOM、网络追踪，可通过 Playwright Trace Viewer 查看。
- `*.log`、Android `*.xml`：命令日志与设备 UI 树。

常规浏览器测试使用 **真实语音 WAV 驱动的 Chromium 测试麦克风、真实 Silero VAD 和本地 HTTP 模型 fixtures**，验证服务模式协议与状态；识别与译文由夹具提供。真实 WASM 测试另行加载 SenseVoice 和 M2M100 权重：

```bash
# 先准备固定权重，之后本地复用
npm run models:download

# 浏览器：真实权重、缓存重载、外网阻断
npm run test:offline

# 真实 Silero：静音、音调、短停顿合并、长发言保护块、停止收尾
npm run test:vad

# 先构建最新 debug .app，再测试原生 WKWebView
npm run test:offline:desktop

# 先安装最新 debug APK，再测试模拟器原生 WebView
npm run test:offline:android -- --serial emulator-5554

# 常驻性能测试：三轮交替识别/翻译，每模型只初始化一次
# 这两个命令也会将对应应用的低内存模式设为关闭
npm run test:offline:desktop -- --resident
npm run test:offline:android -- --resident
```

桌面自检入口只编译进 debug 构建，只有测试进程显式设置 `SONORA_WASM_SELFTEST` 时才执行；发布构建不包含该入口。Android 测试使用本地 ADB/WebView 调试连接。真实样例验证功能可用性，不能等同于模型准确率评测或所有设备性能保证。OPUS-MT、NLLB 尚未接入。

前期 HTTP 模式测试结果见 [tests/TEST_REPORT.md](tests/TEST_REPORT.md)；本轮 WASM 结果见 [tests/WASM_REPORT.md](tests/WASM_REPORT.md)。

常驻模式实测见 [tests/RESIDENCY_REPORT.md](tests/RESIDENCY_REPORT.md)。模型常驻消除了重复初始化开销，但仍有语音分段等待和实际推理耗时；首次开始需要预热。

本轮 VAD 验证、样例输出与启动耗时见 [tests/VAD_REPORT.md](tests/VAD_REPORT.md)。本轮 Android 启动耗时明显高于此前常驻基准；双模型加载次数检查通过，但尚未完成隔离负载的性能定位。

后续完整资源实测见 [tests/RESOURCE_REPORT.md](tests/RESOURCE_REPORT.md)：4GB模拟器常驻模式三轮声译通过，PSS+Swap采样峰值约2.97GiB，停录约2.75GiB；低内存模式峰值约2.59GiB，但每轮重载明显增加延迟。本次常驻首次/再次启动约7.20/0.93秒，未复现此前数十秒慢启动。VAD独立增量为几十MiB量级。

最新界面验收见 [tests/LAYOUT_REPORT.md](tests/LAYOUT_REPORT.md)：同机Android正文阅读区域占比由25.2%升至52.2%，真实软键盘提交与横屏验证通过。原生布局可运行 `npm run test:layout:android`。本轮常量折叠内存候选未产生实际收益，已撤回；4GB模拟器仍可能出现后台内存回收和启动耗时波动。

文字自动检测实测见 [tests/TEXT_LANGUAGE_REPORT.md](tests/TEXT_LANGUAGE_REPORT.md)。当前iOS构建/安装条件复核见 [tests/IOS_STATUS.md](tests/IOS_STATUS.md)。

### 本次构建产物

- macOS：`/Users/yaozhuang/.cargo/target/debug/bundle/macos/Sonora.app`（本机使用全局 Cargo target 目录）。
- Android：`src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`。
- iOS：尚无 archive / IPA，待安装上述 Xcode 平台组件。
