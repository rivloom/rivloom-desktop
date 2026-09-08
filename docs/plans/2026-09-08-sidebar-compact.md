# 侧栏空间收紧

按用户要求，状态与来源筛选收进搜索框右侧的 34px 小按钮；点击后显示浮层，启用条件时显示数量，清除操作仍可同时重置搜索和筛选。历史列表保留独立滚动，浮层开关不改变其高度。

待办中心、连接诊断、节点与 Brain、模型与额度的行距与内边距收紧。左下角字标缩至 82×26px，与版本入口同行；仅缩小侧栏品牌区域，关于弹窗和登录页品牌样式保留。窄栏版本文案可省略，点击仍能查看完整版本。

## 已完成验证

- 类型检查、双语覆盖和生产构建通过；相关筛选、版本和国际化逻辑 20/20 通过。
- Edge 152.0.4191.66 无界面生产产物检查 45/45 通过。中英桌面和手机覆盖组合条件、筛选计数、搜索与重置、当前会话/草稿保留、方向键打开、Escape/Tab/外点/按钮关闭、关于弹窗。
- 8 组窗口尺寸与语言的浮层不越界，历史区高度稳定，侧栏外层无横向或纵向溢出。桌面、200px 英文窄栏和手机抽屉截图已目视核对。

| 窗口 | 中文历史区：前 → 后 | 英文历史区：前 → 后 |
| --- | --- | --- |
| 1280×840 | 183 → 384px | 184 → 385px |
| 960×640 | 76 → 184px | 76 → 175px |
| 860×640 | 76 → 184px | 76 → 156px |
| 390×700 | 76 → 202px | 76 → 203px |

品牌区域高度从 110.39px 降至 46px。较矮窗口原有 74–125px 的侧栏外层纵向溢出消除；历史列表内容仍独立滚动。

## 证据与范围

证据在 `.data/verification/sidebar-compact-20260908/`：`before/dist/` 为改动前冻结产物；`baseline/result.json` 与 `after-final/result.json` 含布局测量和交互结果，目录中保存完整及侧栏截图。`build.log` 与 `logic-test.log` 保存工程检查。初次 `after-pass1` 的失败是夹具定位器把同名消息区误选为输入框，修正定位器后完整检查通过；产品没有因此修改。

`sidebar-ui-check.mjs` 使用已有 Playwright，启动独立 loopback 服务与 headless Edge，60 个合成会话，拦截全部非夹具请求；未读取正式历史、调用真实模型或操作已安装客户端。复现时将 `RIVLOOM_PLAYWRIGHT_DIRECTORY` 指向已有 Playwright 包，然后运行：

```powershell
node .data/verification/sidebar-compact-20260908/sidebar-ui-check.mjs --dist dist --output .data/verification/sidebar-compact-20260908/recheck --label after
```

这次布局数据是指定尺寸的浏览器测量；已安装 WebView2 的显示缩放、真实桌面性能与其他实机项目继续按 [桌面待测记录](../DESKTOP-ACCEPTANCE.md) 执行。

## 安装包

包含本轮界面及前两轮性能优化的本地候选：`.data/verification/sidebar-candidate-20260908/delivery/Rivloom_0.1.4_sidebar_20260908_49b12819_x64-setup.exe`。大小 79,814,557 字节，SHA-256 `745e8c1e90d9cdd7d35415bfb1e94cb404363927f79e021278f8e2417329bd6f`，同目录有 `SHA256SUMS.txt`。

1,074 个文件的源码快照、构建前后 runtime 门禁、锁定离线 Release/NSIS 和独立解包校验均通过；7,639 个运行文件与 prepared 字节一致，EXE 仅有已验证的 Tauri NSIS 标记变化。版本仍为 0.1.4、`com.rivloom.desktop`、currentUser 安装模式。静态脚本对比确认安装/数据条件与通知品牌钩子保持；新包尚未执行安装或实机测试，用户自行安装。本地未提交候选，不是已签名或公开发行。
