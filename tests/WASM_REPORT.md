# 真实 WASM 推理验证

日期：2026-09-27。模型为真实固定权重，结果不是测试服务生成的文本。

## 已实现

- SenseVoice Small INT8 → sherpa-onnx 1.12.15 WASM SIMD。
- Meta M2M100 418M Q8 → Transformers.js 3.8.1 / ONNX Runtime Web / WASM CPU。
- 两者均在 Web Worker 中运行，默认单线程以兼容移动 WebView。当前默认常驻优先，加载复用与冷/热耗时见 [RESIDENCY_REPORT.md](RESIDENCY_REPORT.md)。
- 模型通过 IndexedDB 分片持久化；下载/导入时检查大小并验证 ONNX SHA-256。
- 支持取消下载、断点续传、删除缓存、释放模型 Worker，以及降低同时驻留内存的交替加载模式。
- HTTP 本地服务 / 远程 API 与设备离线是三个独立模式，离线失败不会自动上传到服务端。

## 实测结果

| 平台 | 识别 | 翻译 | 缓存验证 |
|---|---|---|---|
| 本机 Chromium | 中英音频、自动语言检测通过 | 英→中、中→英通过 | 页面重载后成功，外部请求数为 0 |
| macOS 原生 WKWebView | 中文 WAV 通过 | 英→中通过 | `tauri://localhost` 下真实读取本地缓存，独立进程冷启动通过 |
| Android 17 ARM64 / 16 KB 页模拟器 | 中文 WAV 通过 | 英→中通过 | 静态模型下载服务关闭后推理成功 |

### 原始输出示例

- 中文测试音频 → `开放时间早上9点至下午5点。`，识别语言 `zh`。
- 英语测试音频 → `The tribal chieftain called for the boy and presented him with 50 pieces of code.`，识别语言 `en`。
- `Hello, how are you?` → `您好,您怎么样?`
- `今天天气很好。` → `The weather is good today.`

英语音频样例中模型将 gold 识别成了 code，说明功能打通不代表识别无误。这里没有把个别样例当作准确率评测。

耗时包含冷加载且受机器负载影响。首轮 Chromium 中文识别热加载约 0.9 秒，英译中冷加载约 1.9 秒；Android 模拟器中文识别约 3.5–3.7 秒，英译中约 5 秒。不能据此承诺实体手机的延迟或内存占用。

桌面诊断中有一次未显式聚焦窗口的运行出现约 93 秒翻译耗时。诊断改为显式聚焦并记录阶段后，前台复测为模型加载约 1.9 秒、整段翻译约 2.5 秒；该波动保留为已知观察，尚未做系统性能分析。

本轮常规回归最终为 **62 项通过**（前端 45、Rust 3、浏览器 9、Android 5），另有上表真实模型样例检查。Clippy 和 iOS 交叉编译检查通过。

## 验证方法

1. 浏览器通过真实文件导入入口写入全部固定权重，再重载页面；Playwright 阻断所有外部网络请求，只允许本地应用静态代码。
2. 浏览器分别执行真实中英 ASR、真实中英双向翻译；检查实际语言和输出，错误/截断不得标记为成功。
3. Android 通过临时静态镜像下载固定文件，随后关闭镜像；在生产打包的 Worker 上执行中文 ASR，并通过真实界面完成英译中。
4. macOS debug 应用使用仅测试环境变量启用的诊断入口，实际在 WKWebView 中加载缓存和打包的 Worker，执行中文识别与英译中。
5. 常规自动化测试另覆盖离线路由不调用 HTTP、缺模型不打开麦克风、校验失败、取消后的断点续传、超大响应拒绝及缓存删除。

## 集成时修复的问题

- Vite 首次发现 Worker 依赖时会刷新页面，导致加载中断：显式预构建依赖，并忽略模型下载目录和测试产物目录。
- Android 生成代码中的 Tauri 生命周期观察器未注册：录音插件直接观察 Activity 生命周期，补充录音状态查询，前端同步原生状态，避免回到前台仍显示“正在聆听”。
- 翻译生成达到 token 上限时显式报错并保留部分译文，不把截断输出标记为完成。

## 产物

- `test-results/automation/offline-real.json`：Chromium 的真实结果与计时。
- `test-results/automation/offline-android.json`、`offline-android.png`：Android 实际译文和截图。
- `test-results/automation/offline-desktop.json`、`offline-desktop.log`：原生桌面自检结果。
- `test-results/automation/offline-real.trace.zip`：浏览器追踪。

## 仍需区分

- 目前接入的是 SenseVoice 与 M2M100；OPUS-MT / NLLB 没有接入。
- 原生麦克风启停/权限通过 Android UI 自动化验证；真实识别样例采用已知 WAV，尚未做实体手机现场语音质量验收。
- iOS、Windows、Linux 未在本轮实机验证；iOS 完整打包仍受本机平台组件缺失限制。
- 模型文件约 880 MB，运行内存大于文件大小；可显式开启低内存模式，以重复加载换取较低的同时驻留内存。
