# Conversation Workspace Implementation Plan

状态：第一版及本地 Node 备注/`@Node` 直发已实现，构建、定向回归和隔离双节点闭环通过；自动分配夹具的既有 queued 缺陷与纯 mDNS 专项失败继续保留，详见 VERIFICATION。

**Goal:** 实现用户确认的会话式桌面：左上 Node 名称/图标、左侧历史会话、中间空白新会话与聊天、连接时才显示右侧本机队列和配对机器状态。

**Architecture:** 会话是现有 Task / BrainTask / Execution 的 UI 聚合，不新增任务归属或调度协议。节点显示资料独立持久化，通过现有认证目录的可选字段同步；保留身份、信任、审批和验收。取消三个旧栏目，文件夹选择内联到输入区，节点和模型设置置于左下角。

**Tech Stack:** React 19、TypeScript、CSS、Lucide、Express、现有官方 OpenCode / Tauri。

---

用户已授权本会话直接实施，在当前 main / 8badf8f 工作，不创建 worktree、不推送、不改正式节点或既有测试数据。

### Task 1: 会话聚合与节点显示资料

- 创建 `src/conversations.ts`：稳定会话键、Task/Execution 去重、来源判定、本机执行队列与已配对连接判断；不把 Brain 的其他 Worker 队列算成本机队列。
- 创建 `shared/node-profile.ts`、`server/node-profile.ts`，更新 `shared/types.ts`、`server/node-network.ts`、`server/index.ts`：验证名称和图标，独立文件原子保存，认证目录兼容扩展，配对机器离线缓存只用于显示。
- 创建定向测试：来源分类（包括本机发起又由本机 Worker 执行）、重试不重复、队列过滤、资料持久化/输入限制/旧节点兼容。
- 验证：`node --test tests/conversations.test.ts tests/node-profile.test.ts`。

### Task 2: 会话界面

- 重构 `src/main.tsx` 保留桌面鉴权和实时刷新；创建 `src/conversation-workspace.tsx`、`src/node-avatar.tsx`、`src/conversation-workspace.css`。
- 左侧历史会话支持新建、搜索、切换；自己的浅色、其他节点深色并标识来源。
- 中间默认空白；使用现有本机创建/接受/运行/继续/审批/问题/停止/差异/验收 API。远端展示实际返回的状态/摘要；只在现有协议具有控制权限时显示操作。
- 右侧显示本机真实待执行/执行中/待验收项和已配对机器实时状态；没有受信在线连接则完全收起。
- 节点资料可改名、选择图标/上传图片。设置页保留执行资源配置；旧任务、项目、成员栏目不再出现。
- 验证：`npm.cmd run build`。

### Task 3: 隔离验证与交接

- 检查现有进程，只新增独立 `.data/ui-conversation-*` 数据，使用本机确定性模型。服务调试用隔离 UDP 发现域；原生窗口沿用程序现有发现设置，只对本轮新建节点进行配对。
- 实际 UI 验证空白页、左右布局、历史切换、颜色/来源、输入发送和继续、资料保存、设置、断开后的右侧隐藏；截图检查桌面/窄窗口布局。
- 必要的节点目录回归检查兼容性、资料同步和身份保持；不重跑纯 mDNS 已知失败来冒充全绿。
- 更新 `docs/UI-HANDOFF.md`、`docs/PROGRESS.md`、`docs/VERIFICATION.md` 和当前交接入口；`git diff --check`。
- 仅清理本轮启动的隔离进程，保留证据。交付说明源码/构建/原生安装验证的实际范围。

实际完成情况：新增 7 项单测与 4 项网络定向回归通过；Tauri Debug 用独立 preview identifier 与原安装版并存，完成本机发送、来源色彩、历史切换和右侧显隐检查。新增 `preview:conversation:desktop` 可复现桌面夹具。原生双 Brain 自动分配 queued 失败与纯 mDNS 历史失败保留；本机 ready 队列沿用手动开始，没有加入新调度能力。交接、进度、里程碑和验证入口已更新，改动留在当前工作区。

### Task 4: 本地 Node 备注与 `@Node` 直发

- 配对 Node 的备注和最近使用时间保存在本机资料文件，网络快照只把它们返回本机 UI；资料交换继续只发送 Node 原名和图标。
- 新会话输入区识别光标所在的 `@` 查询，候选按最近使用、在线状态、最近出现排序，并支持原名或本地备注搜索。选中后显示 `Node 原名（本地备注名）`，会话正文只写入原名。
- 定向发送复用现有已认证加密远程任务邀请；目标离线、未信任、通道未就绪或没有共同 Brain 时返回明确错误，不回退到自动分配。
- 新增 `tests/node-mentions.test.ts` 并扩展资料测试；9/9 新单测、隔离双节点双向直发及备注不外传断言通过。节点网络 24/25，唯一失败仍是既有纯 mDNS 同机发现；UDP 后备发现通过。
- 独立预览 NSIS 已重建，未安装或覆盖正式客户端；修改仍留在 main / 8badf8f 工作区，未提交或推送。
