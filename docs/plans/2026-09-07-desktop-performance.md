# Desktop Performance Implementation Plan

> **执行方式：** 使用 writing-plans 的分项计划，在用户已要求开始的当前任务直接实施；沿用现有未提交工作区和统一整理 Git 的约定。正式桌面操作已暂停，不创建额外任务或子代理。

**Goal:** 减少桌面端空闲刷新、长会话重新渲染及原生线程阻塞，为窗口拖动、输入和滚动保留处理时间，并提供可复现的前后对比。

**Architecture:** 先用合成工作区测量当前生产前端。根据结果减少相同数据引起的 React 更新、隔离消息区域与网络状态刷新；让等待 Windows 的通知调用在异步命令线程完成。保留通知频率、审批/队列语义、原生来源校验和所有数据字段。

**Tech Stack:** React 19、TypeScript、Vite、Tauri 2/Rust、Node.js 24、独立 Chromium 性能验证。

---

### Task 1：固定待测清单与性能基线

**Files:** `docs/DESKTOP-ACCEPTANCE.md`、`scripts/desktop-performance-check.mjs`、`.data/verification/desktop-performance-20260907/`。

1. 记录本机通知三场景通过，以及真正断网、崩溃、传输中断、另一台通知和性能实机待测项。
2. 构建当前前端到独立 before 目录，生成固定合成历史、长消息和在线节点变化，不接触正式数据/模型。
3. 在无界面浏览器记录空闲、网络更新、打字、长会话滚动/缩放的请求数、传输量、脚本/布局耗时和交互响应，保存原始结果。

### Task 2：缩小前端刷新和布局范围

**Files:** `src/main.tsx`、`src/conversation-workspace.tsx`、`src/task-attention-view.tsx`、`src/task-files.tsx`；按证据新增数据复用/刷新辅助模块及对应 `tests/`。

1. 为相同快照和局部变化增加保留旧引用的行为验证，覆盖消息/权限/队列/身份改变不得漏更新，以及输入参数不可变。
2. 减少无变化轮询造成的父组件更新；保持会话派生数据稳定，让网络/队列刷新不重算整段聊天。
3. 避免新数组引用触发消息区强制滚动与同步布局。保留读旧消息不跳动、实际新消息追随和语言切换。
4. 只实施基线能够支持的优化，不随意调低通知/状态刷新频率或更改执行策略。
5. 相同快照跳过渲染后，免打扰、Worker 报告有效期和冷却提示必须由当前显示页面独立计时；补充到期回归。

### Task 3：原生通知避免阻塞窗口线程

**Files:** `src-tauri/src/main.rs`、受影响 Rust 测试。

1. 将同步等待通知服务结果的命令调度到后台命令线程；保留来源、路由和类型校验及限流。
2. Rust 编译/既有通知与原生测试通过。正式安装版三种通知场景仍加入性能候选回归，不在用户使用电脑时操作。

### Task 4：比较结果与交付

**Files:** 上述性能脚本、`docs/PROGRESS.md`、`docs/HANDOFF.md`、`docs/VERIFICATION.md`、`docs/MILESTONES.md`。

1. 对相同合成数据运行 before/after，无界面检查输入、滚动、消息追加、通知路由和中英文显示正确。
2. 执行受影响逻辑测试、TypeScript、双语检查和生产构建；必要时补充原生编译。
3. 给出可重复的数值、场景边界与未通过项。窗口实际拖动和显示合成器表现保留实机验收，不用浏览器指标冒充原生拖动结果。
4. 更新待测记录；不修改正式安装，不提交/推送/发布。

依据：[React memo](https://react.dev/reference/react/memo)、[React useMemo](https://react.dev/reference/react/useMemo)、[Tauri 命令线程说明](https://v2.tauri.app/develop/calling-rust/)。

## 执行结果

四项工程工作已完成，实机范围继续按用户要求暂停。300 会话 / 120 当前消息的三组最终前后对比中，网络传输减少 90.4%，输入脚本时间减少 79.9%；逻辑 236/236、Rust 7/7、每次 UI 11/11、类型、双语和构建通过。新增刷新辅助、显示时钟及性能验证脚本已落地；没有生成/安装性能候选、提交、推送或发布。缩放布局/样式未改善，真实窗口拖动留待实机测量。详细数值、复现方法与证据见 [桌面端性能优化记录](../DESKTOP-PERFORMANCE.md)。
