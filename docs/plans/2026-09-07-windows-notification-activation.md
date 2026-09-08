# Windows 通知中心定位任务 Implementation Plan

> **执行方式：** 按 writing-plans / executing-plans 的分项检查流程，在用户已要求继续的当前会话完成修复和验证；沿用整体测试后统一提交的安排。

**Goal:** 用户从 Windows 通知中心点击 Rivloom 通知时，打开对应的原任务；应用处于后台或已关闭也保留正确路由。

**Architecture:** 使用 Windows 桌面通知的 COM 激活入口和 ToastGeneric `launch` 参数，替换仅适合临时弹窗的内存回调。安装器注册本应用的 CLSID 与已安装 EXE，运行中的独立 MTA 线程持有激活服务。通知只允许已有 local / remote / brain UUID 或待办路由；不会执行任务、批准操作或打开外部地址。

**Tech Stack:** Rust、Tauri 2、已锁定版本的 windows 0.62.2、NSIS。

**2026-09-07 验证进展：** Task 1 的 7 项 Rust 测试通过；Task 2 的 5 项安装宏隔离检查通过，但真实通知中心点击尚未取得回调证据。Task 3 已完成 34 项受影响逻辑检查、类型/双语/前端构建、275 项 Rust 许可清单核对、本地候选和解包一致性检查。完整候选的隔离全新安装、旧候选覆盖升级、重复安装/重启、卸载与注册清理通过，原隔离任务和身份保持，零模型请求。正式安装由用户操作；自动审批已拒绝代理覆盖安装，不得绕行重试。完整安装版的通知点击及双机故障复测仍待用户安装后继续，不将安装或 COM 单元测试当成真实点击验收。

---

**安装版追加复测：** 用户已安装新候选，本机正式 EXE 哈希与包内一致；新增一个真实 MiMo 任务、一个官方 session、零工具调用，模型结果已验收。通知注册匹配检查失败，但活跃 COM class factory 可用，原因未确定；系统点击待用户观察反馈。本轮只新增只读诊断 example，不修改正式注册。后台/最小化、冷启动及双机故障边界尚未完成，见 VERIFICATION 顶部。

## 已有实机证据

`.data/verification/physical-closeout-20260907/`：5.29 发起的唯一任务在本机暂停队列中等待；本机正常退出后另一台显示离线，重启后自动恢复原身份、连接、Task 和队列。恢复队列只创建一个官方 session，零工具调用，验收前后正文一致，旧历史保持，原执行设置已恢复。该断线来自客户端退出，不等同于切断网卡或路由器。

同一任务的 Windows 通知已送达；从通知中心点击 16:32 的最新通知后，通知条目消失，但工作区仍停在连接诊断页，重新聚焦后仍未跳转。这是待修复项，不计为验收通过。

## Task 1：实现可验证的原生激活服务

**Files:** `src-tauri/src/windows_notifications.rs`、`src-tauri/src/notification_target.rs`、`src-tauri/src/main.rs`、`src-tauri/Cargo.toml`。

1. 将已有通知目标校验复用到激活入口；补充错误 app ID、无效/超长参数、XML 字符转义和 COM 回调的测试。
2. 注册 COM class factory，明确初始化、存续与退出撤销；通过共享待处理路由支持窗口尚未建立时的激活。
3. 发出包含经过校验路由的 ToastGeneric。独立预览或非安装路径不注册正式激活服务。
4. 运行 Rust 原生测试和编译检查；通知失败保留现有可见反馈，不影响正常工作区启动。

## Task 2：安装注册与系统点击验证

**Files:** `src-tauri/notification-activation.nsh`、`src-tauri/installer-hooks.nsh`、`src-tauri/examples/notification-check.rs`。

1. 当前用户安装时注册带引号的固定 EXE 路径及 CLSID、AppUserModelId；卸载仅移除仍属于本安装的注册值。
2. 使用独立测试 AppUserModelId、CLSID 和测试目录，验证真实系统通知中心点击与 COM 冷启动，不占用正式身份。
3. 核对非法目标不触发操作、窗口聚焦和对应会话选择；保留失败记录，测试结束撤销自有注册和进程。

## Task 3：构建与交付收尾

**Files:** `docs/PROGRESS.md`、`docs/HANDOFF.md`、`docs/VERIFICATION.md`、`docs/MILESTONES.md`、依赖许可记录。

运行受影响的通知/会话检查、类型和构建验证，更新运行时许可，构建新的本地候选并核对源码、包内文件和安装注册。安装版与独立原生测试分别记录；不以调用成功替代系统点击通过。修复完成前不发布。

依据：[Microsoft 桌面通知与 COM 激活说明](https://learn.microsoft.com/en-us/windows/apps/design/shell/tiles-and-notifications/send-local-toast-desktop-cpp-wrl)、[Microsoft Toolkit 的 CustomActivator 与 LocalServer32 注册实现](https://github.com/CommunityToolkit/WindowsCommunityToolkit/blob/main/Microsoft.Toolkit.Uwp.Notifications/Toasts/Compat/ToastNotificationManagerCompat.cs)。
