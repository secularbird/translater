# 紧凑自适应布局验收

日期：2026-10-01。

## 改动

- 桌面取消1060px内容宽度上限，随窗口伸缩；左右内边距随宽度在12–32px间变化并尊重安全区。
- 保存、清空与历史、设置合入顶部，移除重复的“实时会话”可见工具栏，保留语义标题。
- 顶部与语言选择压缩留白；底部录音、状态、模型状态、设备选择改为横向紧凑布局。
- 竖屏手机两个固定文本区域上下排列；横屏/桌面左右排列；低高度宽屏把语言选择放入顶栏。
- 桌面最小窗口由360×640调整为320×420。
- 使用visualViewport实际高度及平移量适配软键盘；编辑时隐藏占空间的录音控件，输入和提交按钮保持可见。
- Android原生侧明确ADJUST_RESIZE，避免默认窗口平移干扰布局；改动位于维护的插件，不修改生成的Activity。

## 量化结果

“正文阅读区域”是原文、译文两个`.pane-scroll`矩形面积之和，占可见视口面积的比例，不包括标题、控件、边距，也不代表已有文字填满程度。

同一Android模拟器、相同竖屏411×923 CSS像素、原有离线配置：

| 项目 | 优化前 | 优化后 |
|---|---:|---:|
| 正文阅读区域占比 | **25.17%** | **52.23%** |
| 原文可滚动区域高度 | 132.52px | 261.62px |
| 译文可滚动区域高度 | 131.76px | 260.86px |
| 会话面板宽度 | 367.43px | 387.43px |

正文可用面积约为此前**2.08倍**。横屏923×411下使用左右双栏；把语言选择并入顶栏后，正文占比为33.68%。安全区、系统栏计入视口，因此不能和无系统栏的浏览器模拟尺寸直接比较。

## 验证

- 77项单元、3项Rust、13项浏览器、5项Android UI，最近汇总**98通过**。
- 浏览器8种尺寸：320×568、360×640、390×844、768×1024、1024×768、1440×900、1920×1080、844×390。
- 检查横向溢出、正文区域占比、底部按钮无遮挡、长文本独立滚动、输入框与提交按钮可用；桌面1920px会话面板宽1856px。
- 原生Gboard实际弹出后，可见视口约587px；不收起键盘，使用ADB物理点击提交`Thank you.`，真实M2M100输出`谢谢你。`。
- 原生旋转为横屏后仍保留文本、左右双栏及可点击录音控件；测试结束恢复系统旋转设置。
- Android APK已覆盖安装；macOS `.app`已重建并退出旧进程后重新打开。

### 原生测试中发现的问题

- Playwright字符串表达式轮询会触发原生CSP，改为函数形式，不放宽应用CSP。
- CDP截图在键盘显示时会改变WebView视口，使截图前的坐标失效。原生布局测试改用ADB屏幕截图，避免测量本身改变页面。
- 授权后还有模型预热，原测试18秒等待不足；统一为与已授权启动路径一致的60秒有界等待。
- 首轮后台场景遇到系统LOW_MEMORY回收，exit-info记录WebView约1.6GB。末轮五项Android场景通过，**不代表已解决4GB设备的后台内存压力**。
- 最终双模型常驻启停检查通过，加载次数仍为识别1/翻译1；此次首次53.44秒、再次2.36秒，启动耗时仍有明显波动。

## 内存优化候选结论

并行尝试过关闭M2M100的`ConstantFolding`。本地ORT1.24.1静态图诊断减少了两个解码分支中的重复常量，但生产WASM1.22实测：

| 指标 | 原常驻基准 | 候选三轮 |
|---|---:|---:|
| PSS+Swap采样峰值 | 3036.4MiB | 3034.8MiB |
| 停录PSS+Swap中位 | 2818.5MiB | 2843.8MiB |
| 三轮播放输入至翻译完成 | 11.79 / 9.97 / 9.91秒 | 30.82 / 22.94 / 15.47秒 |

内存没有实际改善，速度变慢，**候选已撤回**。最终模型权重、常驻策略和生产推理配置保持原方案；没有把静态诊断数据当作节省内存的交付结果。

## 文件与重现

```bash
npm run test:e2e
npm run test:layout:android -- --serial emulator-5554
npm run test:android -- --android emulator-5554 --permissions
```

原始数据与截图：

- `test-results/automation/layout-android-before.json`
- `test-results/automation/layout-android.json`
- `test-results/automation/layout-android-portrait.png`
- `test-results/automation/layout-android-keyboard.png`
- `test-results/automation/layout-android-landscape.png`
- `test-results/automation/responsive-metrics.json`、`responsive-*.png`、`composer-*.png`
- `test-results/automation/memory-constant-folding/resources-android-resident.json`

内存诊断脚本`scripts/inspect_model_memory.py`、`tests/onnx_memory_probe.py`需要额外的开发用Python ONNX/ORT依赖，普通构建与应用运行不需要它们。
