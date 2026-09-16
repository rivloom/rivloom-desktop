# Rivloom 客户端品牌资源

## 界面字体与许可

**2026-09-16 · 0.1.17 源码，发行准备中：** 主界面使用 `Segoe UI → Microsoft YaHei UI → Microsoft YaHei → system-ui → sans-serif` 系统字体栈。会话标题为 13px、中等字重，选中项加粗；输入区占位文字为 14px，目录与模型控件为 12px，快捷键提示为 11px。文字与次要文字色分别为 `#35445b`、`#53627a`，提高小字号阅读对比度。保留浏览器原生字形渲染，不强制灰度抗锯齿、描边或文本阴影。

品牌小标签继续使用随包 Manrope Latin 可变字体，来源为 `@fontsource-variable/manrope` **5.3.0**。该版本采用 **SIL OFL 1.1**，允许免费商用和随软件分发，须保留版权与许可，不得单独售卖字体；许可不改变应用自身的许可证。具体以随该字体文件附带的 [Manrope 许可原文](licenses/fonts/Manrope-OFL.txt) 为准，不能用同名字体其他版本的授权替代。

微软雅黑、Segoe UI 等仅引用用户设备已安装的系统资源，软件包不复制这些字体文件。微软允许应用使用 Windows 系统字体渲染界面，也允许 CSS 指定字体名称；这不等于取得字体文件的再分发许可。[微软字体使用与分发说明](https://learn.microsoft.com/en-us/typography/fonts/font-faq)

## 图形与字标

客户端沿用用户提供的 Rivloom 图形和字标，原始 PNG 保存在 `src/assets/brand/`。React 的 `Wordmark` 组件按原图透明留白取景，展示于侧栏、登录、加载和空会话；图形比例、品牌文字与蓝青渐变保持原样。暗色登录区域使用浅色底板承载原字标。

Windows 程序、快捷方式和安装器使用同一组 `src-tauri/icons/` 资源。图标以原始渐变符号为主体，按比例置于浅色圆角方形上，让深蓝主体在深浅任务栏背景中均可辨认；保留透明外角。PNG、ICO 和现有其他平台尺寸由已锁定的官方 Tauri CLI 导出。

重新生成：

```powershell
node scripts/brand-icons.mjs
```

导出脚本读取 `src/assets/brand/rivloom-symbol-gradient.png`，构造包含原图的 SVG 排版，再调用 Tauri `icon`。中间 SVG 和来源摘要放在忽略目录 `.data/brand/build/`；小尺寸 favicon 同步到 `src/assets/brand/rivloom-favicon.png`。不重绘、不改色、不覆写原始素材。原始图形 SHA-256 为 `fba48b1b50f9cf1606cd66861825931237bf54d6a4c07000d59097ab8178fa0e`，字标 SHA-256 为 `d95f7ac65b07aa86ec12daa0ee550937d78396800838b5f682361c2a4105135c`。

修改后检查 32/128 像素图标、浅色侧栏和暗色登录区域、960×640 最小客户端窗口及中英文布局，然后重新构建安装包。图标更新不改变 `com.rivloom.desktop` 身份、用户数据目录或业务行为。

Windows 主窗口在首次显示前，将 Tauri 已持有的新版图标同时设置到 `ICON_BIG`，供任务栏使用；Tao 0.35.3 默认只设置标题栏的 `ICON_SMALL`。安装器覆盖程序后还会发送仅针对 `Rivloom.exe` 的 shell 更新通知。验证时必须读取实际打包进程的两个 `WM_GETICON` 槽位并检查图像，不能仅凭 EXE 内嵌图标正确就判定任务栏已更新。已有固定项仍受 Windows 的快捷方式缓存影响，必要时由用户取消固定后重新固定。

桌面与开始菜单快捷方式使用独立的 `brand/rivloom-<ICO 内容摘要前 12 位>.ico`。`scripts/brand-icons.mjs` 同时维护 Tauri 的资源目标路径与 `src-tauri/brand-icon.nsh`，使未来换图时快捷方式也换用新的资源路径。安装钩子通过 IShellLink 只更新指向本次安装 EXE 的既有快捷方式图标，保留启动参数、工作目录与 AppUserModelID；更新成功后通知 shell 刷新该快捷方式。GUI 完成页之后还会补做一次，覆盖此时才创建的桌面快捷方式。缺失、不合法或指向其他程序的快捷方式保持原状。
