# 自动化测试执行结果

> 本文记录 WASM 接入前的一轮 HTTP 模式测试。当前设备离线推理已实现，最新真实模型验证见 [WASM_REPORT.md](WASM_REPORT.md)，最近自动化结果以 `test-results/automation/latest.html` 为准。

执行日期：2026-09-26。测试对象：当前简洁版声桥 Sonora。

## 结果

| 套件 | 通过 | 失败 | 跳过 |
|---|---:|---:|---:|
| TypeScript 工具函数 / React Hook | 31 | 0 | 0 |
| Rust | 3 | 0 | 0 |
| Chromium 浏览器集成 | 9 | 0 | 0 |
| Android 17 ARM64 / 16 KB 页模拟器 | 5 | 0 | 0 |
| **合计** | **48** | **0** | **0** |

另外，TypeScript 检查、Vite 生产构建、Android ARM64 APK 构建通过。最新 APK 已覆盖安装到 emulator-5554，测试结束后重新打开应用。

## 新增覆盖

- 队列逐个执行、每个任务保持配置快照、停止录音提交尾段。
- 空识别结果不翻译、ASR 失败自动停录、八个待处理片段上限。
- 取消当前任务和待处理任务、拒绝迟到的流式 token。
- 重复点击开始、首次授权弹窗暂时隐藏页面、后台暂停、卸载后释放录音。
- 失败片段重试保留原始源语言与目标语言。
- 浏览器通过真正的本地 HTTP 服务接收延迟 SSE，确认完成前已经显示部分译文。
- 401 鉴权错误重试、503 ASR 失败、SSE 截断保留部分译文。
- 配置校验、密钥不落盘、历史刷新后仍存在、删除后不恢复、复制译文。
- 模拟器原生权限首次授权、拒绝、录音启动/停止、Home 键后台暂停、设置与历史入口。

## 发现与修复

1. **真实应用问题**：重试失败片段时使用当前 UI 选择的源语言，覆盖了原先检测的源语言。例如原文是英语，用户改成日语后点击重试，会把原文错误声明为日语。
   - 修复：`src/hooks/useTranslator.ts` 重试配置使用 `segment.language` 与 `segment.targetLanguage`。
   - 回归：`retries with the originally detected source and original target language` 测试先失败、修复后通过。
2. **测试服务问题**：新增 HTTP fixture 的方法名与 Python `BaseHTTPRequestHandler.headers` 属性冲突，导致首轮浏览器请求失败。
   - 修复：重命名为 `response_headers`；九个浏览器场景重跑全部通过。

## 验证边界

- 浏览器使用模拟模型 HTTP 响应及 Chromium 测试麦克风，验证应用接线、状态和网络协议。
- Android 使用实际原生插件和系统权限，但在模拟器上运行；没有验证实体手机录音质量。
- 未执行真实模型准确率/性能评测；Meta M2M100/NLLB、SenseVoice、OPUS-MT 的端侧集成尚未实现。
- iOS / Windows / Linux 未在本轮运行 UI 自动化。

## 复现

```bash
npm ci
python3 -m pip install -r tests/requirements.txt
python3 -m playwright install chromium
npm run test:all -- --android emulator-5554 --permissions
npm run test:report
```

Android 需要先安装最新 APK；没有模拟器时运行 `npm run test:all` 即可验证单元、Rust、构建和浏览器。

自动生成的报告、快照和浏览器 trace 位于 `test-results/automation/`，不会纳入源码版本控制。
