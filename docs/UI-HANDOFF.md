# 会话式桌面界面交接

更新：2026-09-05。项目：`C:\project\rivloom-opencode`。

## 用户最新决定

**2026-09-05 CI 修复与最新安装包交付：** 用户进一步要求处理 GitHub CI/CD 并形成可安装的 exe。`dd92730` 已修复 Windows 路径测试与测试子进程的 PowerShell 模块环境，云端三份工作流 10/10 jobs 全部通过，生产 DPAPI 与业务协议未改。正在建立的自动候选流程绑定完整源码 SHA、要求全部 CI 通过，并对独立 UI Preview 执行安装、启动和卸载检查；每份新包以其所附候选与安装报告为准，旧 docs1 不代表本轮新界面。细项见 [CI](CI.md) 和 [本轮交付计划](plans/2026-09-05-windows-ci-and-preview-installer.md)。

**2026-09-05 视觉修订与 Git 授权：** 用户明确要求官网和桌面端更美观，当前只调整审美、不调整功能，并要求两个仓库都提交推送。本轮完成浅冷灰蓝工作区、钴蓝主操作、深蓝外来会话/队列、文字与边框层级、输入器、设置页面及窄窗口布局；桌面接入用户原始蓝色 Logo，不更改其像素或比例。事件、状态、审批、API、队列/协作协议和数据格式未改。此项新授权取代下方历史记录中的“不推送”。

本轮前端构建和独立展示层审查通过。使用全新 `.data/ui-conversation-84313839-0af5-4fec-93dc-a308a6316f7d` 与确定性本机模型，在隔离浏览器预览中核对 1282×872 和 962×872 的空白/已有会话、长设备名、队列与机器状态、设置、模型、Node 和资料弹窗；键盘选择 Node、取消目标、隔离测试队列的暂缓/恢复均通过。962 宽文档无横向溢出，捕获错误日志为空。证据见 `.data/verification/visual-refinement-20260905.json`；该结果不代替原生安装器、真实模型或双物理机验收。构建产物与旧安装包分别保留，云端运行须按本轮提交在 GitHub Actions 中核对。

视觉实施范围见 [视觉修订记录](plans/2026-09-05-visual-refinement.md)。官网由独立 `rivloom-website` 仓库维护；本轮同步调整首页与阅读版式，不更改网站统计、隐私、安全头、收录或下载行为。

**2026-09-05 文档一致性修订：当前检查预览请使用 `docs1` 包。** `SECURITY.md` 已按当前普通文件夹、三种审批模式、远程控制、队列和官方差异实现重写；README 的旧成员/接受任务步骤及原生目录标题已同步。新增根 [DESKTOP-README.md](../DESKTOP-README.md) 作为随包使用说明，与 SECURITY 一起打入 `runtime/`，文档哈希记入运行时清单。修订包为 `.data/distribution/Rivloom_M3.5_Node_P0_Preview_0.1.3_docs1_x64_setup.exe`，**71,096,634 字节**，SHA-256 **`D04EEC8C460D14AB9615D291FF302205E67E672B53393D3DA5C60E95F39AF3D1`**，NotSigned、未安装。构建及实际 NSIS 只读解包核对通过，旧包与正式客户端保留。本次仅改说明、文档打包和目录标题，没有更改任务/审批逻辑，也没有重跑下方原生业务操作或双物理机；详情见 VERIFICATION 的文档修订记录。

**当前停点：M3.5 A–D 工程交付完成；用户验收及本轮双物理机回归待进行。** 本轮完成草稿稳定 Node ID、三处创建幂等、自动分配候选修复、持久 Node 队列/控制、协商统计/任务回执与界面。完整隔离服务 12/12、真实 session 两崩溃窗口、Debug 原生 12 条/Release 原生 8 条记录及最终二进制闭环通过；前端/HTTP 23/23、增量模型消失确认 7/7、typecheck/build 通过。最终全量 154/155，唯一已有纯 mDNS 失败保留；首轮 145/146 另作历史。伪 ACK、统计刷新和成员读取范围已修复并回归，细项见 [VERIFICATION](VERIFICATION.md)。

Debug 原生根 `.data/ui-conversation-c9af0886-f701-4dbb-aa4d-746b24ee8345`：草稿/固定目标、忙碌排队、同一原任务执行、队列控制/回执、断线/重启与 1282×872、最窄 962×872 布局通过，6 张截图。Release 根 `.data/ui-conversation-6fddb6ac-44a5-47e5-922b-a49ce7c47234`：真实 Windows 拼音候选 Enter 不发送、空格长名/备注、键盘选目标、认证送达/排位、等待文案与 signed hello 统计通过，4 张截图。最终重新链接后的 exe 又在独立根 `.data/ui-conversation-f90b3dd1-f6b1-4ca8-987a-bc51c67f0945` 通过启动、加密配对和 1 remote Task → 1 业务 Task → 1 官方 session → review 的实际窗口闭环，模型请求 1/工具 0。全部本轮自有夹具已清理；同机确定性模型不算两物理机或真实模型编程验收。

`f946487` 初次功能交付为 `.data/distribution/Rivloom_M3.5_Node_P0_Preview_0.1.3_x64_setup.exe`：**71,107,766 字节**，SHA-256 **`206B80AD363FBAC90435E085333F8D61DFB5BF8A3251734AD459A6905ED2DECE`**，**NotSigned，未安装**；后续文档修订件见本节顶部。产品名 Rivloom UI Preview，identifier `com.rivloom.conversationpreview`；正式客户端、旧正式安装器与旧预览包均保留。初次 exe 哈希和首次封装文件占用失败/重试成功的日志见 VERIFICATION。按用户追加授权保存本任务的本地 Git，具体提交号以最终 Git 记录为准；不推送，另任务官网规划留在工作区。

当前界面：草稿正文与路由一起恢复，删除正文 `@` 不改变已选 Node，取消指定有明确按钮；网络失败保留原 requestID，精确结果 ID 决定会话。新本地发送明确入队后自动启动，旧 open/ready 保留旧授权；所有者通过真实队列快照调序、暂缓/恢复、拒绝或暂停后续启动。请求结果未知使用“重试确认”重放完整原操作。旧节点/过期统计显示未知，断线显示上次确认事实；review/interrupted 保留槽位。

下一步：用户检查本轮独立预览，并在现有设备空闲时安排 M3.5 双物理机回归，再确认阶段验收。读取本节、[MILESTONES](MILESTONES.md)、[VERIFICATION](VERIFICATION.md) 和计划的当前实施记录；A–D 不从头重做，不自动安装或恢复历史现场，不扩大到 P1、任务拆解、人员、HA、跨 Brain 迁移。旧 PID/端口和 Escape 暂停记录仅作历史。

### 以下为计划接受时的历史决定（已由上述实施停点更新）

整体路线已更新为 **M3.5：会话式 Node 协作**，承接已结项的 M3.4。现有界面/备注/直发为已实现基线，下面四项 P0 为剩余工作；A–D 均为本里程碑内部检查点，当前尚未结项。总体完成条件和后续阶段见 [MILESTONES](MILESTONES.md)。

用户已确认四项 Node 协作 P0，并明确要求新开会话实施，本会话先保存记录。**当前停点是“方案已接受、P0 尚未实施”**。下一会话按 [P0 实施计划](plans/2026-09-05-node-collaboration-p0.md) 和已接受的 [ADR-0005](adr/0005-directed-node-queues-and-receipts.md) 开始，无需再次询问是否实施这四项：

1. `@Node` 能力列表：显示真实在线/忙碌、槽位、等待数和简要 CPU/GPU 能力，缺失或过期显示未知。
2. 准确投递回执：区分本机保存、发送、对端送达、入队、排位、等待原因与实际执行。
3. Node 队列控制：服务端持久顺序，上移/下移、暂缓/恢复、拒绝尚未执行项，发送方从原会话收到反馈。
4. 自动分配可靠性：统一提交候选与对应 Brain 的实际可调度 Worker 规则，修复错误选择 Master 自身导致的 queued 问题。

实施顺序为 **A 路由与调度基础（Task 1–2）→ B 持久队列与控制（Task 3–4）→ C 回执与界面（Task 5–6）→ D 隔离验证与预览包（Task 7）**。先修复草稿切换丢失指定目标、HTTP 创建重试重复任务及自动分配候选不一致，再接入队列和界面。

### 已确认的行为边界

- `@Node` 绑定稳定 Node ID。普通忙碌、满槽或短时高负载仍向该 Node 投递排队；离线、严重拥堵或持续异常需给出真实原因，绝不静默改派到本机/其他 Node。首次离线投递信箱留在 P1。
- 可信任务默认自动收件，沿用 ADR-0003，不增加逐条接受邀请。暂停针对等待项/后续启动；运行中使用现有停止操作，AI 工具审批和验收权限保持。
- Node 队列以接收端持久顺序为准，所有执行入口共用最终准入；review、interrupted 和未知执行不能假装释放槽位。重启和重试不能重复建 Task/session，拒绝项不能恢复成可运行项。
- 新本地发送可进入自动队列；升级前遗留的 ready 会话不自动启动。回执只共享统计和对方自己的任务信息，不泄露他人任务或本地备注、路径、模型、凭据。
- 指定 Node 继续使用直接 remote-task，自动分配沿用 BrainTask/Execution。当前不补做 Master 自身执行通道，不转移已有 Task 的 Brain 归属。
- P1 上下文包/附件、结果凭证页、连接诊断以及自动拆任务、人员/企业治理、HA、跨 Brain 迁移和 macOS 发行均不纳入这四项。

## 已实现的界面基线（2026-09-03 至 2026-09-04）

此前从 `8badf8f` 完成第一版会话式桌面及备注/直发，源码保存在未提交工作区。下列为已实现行为，不能等同于上述 P0：

- 左上是本机 Node 名片，可修改名称、选择图标或上传图片；名称和图标通过已配对加密连接同步。
- 已配对 Node 支持仅保存在本机的备注名；界面统一显示 `Node 原名（本地备注名）`，备注不会通过目录协议同步给对方，也不改变 Node 身份或信任。
- 左侧主要区域是可搜索、切换、新建的历史会话；自己发起的浅色，其他 Node 发来的深色并显示来源。
- 新会话输入 `@` 会按最近使用时间显示已配对 Node；选中后只把原名写入会话文本，并通过现有加密远程任务通道直接发给该 Node。目标离线或通道未就绪时明确拒绝，不静默改为本机或自动分配。
- 取消任务工作台、本地项目、协作成员栏目；节点与 Brain、模型与额度固定在左下角。文件夹在会话输入区或节点资源设置中选择/添加。
- 中间默认空白新会话，支持实际消息、工具结果、继续、停止、审批、问题和验收；Task/Execution 仍使用原领域对象。
- 右侧是本机执行队列和配对机器实时状态；没有在线且加密通道就绪的配对机器时整栏隐藏。Brain 中尚未分配给本机的任务不冒充本机执行队列。

仍是 Windows Tauri 桌面产品。本轮内部本机 Web 调试之外，已构建并操作隔离 Tauri 原生窗口；没有安装覆盖正式客户端。单 Brain 目标拆解、人员、HA、跨 Brain 任务仍不在范围内。实现计划见 [会话界面计划](plans/2026-09-03-conversation-workspace.md)。

## 实施前保存的产品基线（历史）

- 产品版本 0.1.3，官方 OpenCode/SDK 1.18.25；M3.3 和 M3.4 当前 MVP 范围已结项。
- 多个独立 Brain 通过共享 Worker 使用资源，每个 Task 只属于一个 Brain，Task 与每次 Execution 分离。当前 Master Host 固定，不存在已实现的选主/HA。
- Node 管理本地普通文件夹 Project、模型、凭据、额度和最终准入。Brain 不是每台 Node 上必有一个的对象，不持有统一模型池。
- 两物理设备单槽竞争、review 占槽、原 Task 排队续跑和分别验收通过。最终 5 accepted 业务任务、5 官方 session、7 Execution、0 工具调用；测试模型是确定性本机夹具，不冒称新增真实 AI 编程验证。
- 纯 mDNS 专项仍失败：最近完整回归为 92/93，单独复查也失败；正常 mDNS + UDP 物理路径通过不能代替它。M3.3 后续优化、人员/企业治理、HA/脑裂和跨 Brain Task 不自动纳入改版。

下一会话先读本文件、[P0 实施计划](plans/2026-09-05-node-collaboration-p0.md) 和 [ADR-0005](adr/0005-directed-node-queues-and-receipts.md)，再读 [HANDOFF](HANDOFF.md)、[MILESTONES](MILESTONES.md)、[PROGRESS](PROGRESS.md)、[VERIFICATION](VERIFICATION.md)、[ADR-0004](adr/0004-automatic-brain-masters-and-shared-workers.md)。涉及旧信任和审批交互时再核对 ADR-0001/0002/0003。旧“待配对/待验收”、PID、端口和会话号只作历史，不照抄执行。

## 实施前 Git 与验证（历史）

- 2026-09-05 本次只保存已确认计划和交接，未实现 P0、未重跑产品测试、未重建安装包，也未提交或推送 Git。以下构建和测试均是之前界面阶段的证据。
- 开始时 `main` / `8badf8f6f31e0016a1e1a100dd70c9b43cfe6671`，工作区干净，领先 origin/main 1 个提交。界面修改留在当前工作区，未提交、未推送、未创建分支/worktree、未改写历史。新会话仍须核对实际 Git。
- 本轮 `npm.cmd run build`、9 项会话/资料/`@` 单测、11 项远程时钟回归和隔离双节点直发闭环通过；节点网络回归 24/25，唯一失败仍是既有纯 mDNS 同机发现断言，UDP 后备发现通过。隔离 Tauri Debug 和 Release NSIS 构建通过。之前基线测试只作历史证据。
- 原生双 Brain 夹具出现一次自动分配停在 queued 的失败：候选视图允许远端 Master 自身作为 Worker，但该 Master 调度时排除自身；相关代码与 8badf8f 一致。本轮记录并保留原任务，未修改调度规则、重发或掩盖失败。详细证据及适用范围见 [VERIFICATION](VERIFICATION.md)。
- `.data`、`dist`、安装包、运行身份/任务数据库和凭据被 Git 忽略，原地保留，不在提交中。Git 记录保存源码和文字证据，不是运行数据备份。

## 界面代码入口

| 文件                                                | 当前职责                                                   |
| --------------------------------------------------- | ---------------------------------------------------------- |
| `src/main.tsx`                                      | 桌面鉴权、Bootstrap、实时刷新和会话工作区入口              |
| `src/conversation-workspace.tsx` / `.css`           | 会话侧栏、聊天输入/消息/操作、队列与机器状态、设置入口     |
| `src/conversations.ts`                              | Task/Execution 聚合、来源、去重与本机队列过滤              |
| `src/conversation-drafts.ts`                        | 结构化草稿、固定路由、创建签名/requestID 与精确结果会话键 |
| `src/task-receipts.ts`                              | 真实执行、队列、传输状态的显示优先级；旧节点/断线不伪造排位 |
| `src/node-avatar.tsx`                               | Node 名片、名称/预设图标/图片和本地备注编辑                |
| `src/node-mentions.ts`                              | 活动 `@` 查询识别、原名/备注显示和最近使用排序             |
| `server/node-profile.ts` / `shared/node-profile.ts` | 独立显示资料文件、备注/最近使用时间、验证和对端资料缓存    |
| `src/node-network.tsx`                              | 节点与 Brain 页、资源/执行能力、发现配对与 Brain 任务      |
| `src/model-settings.tsx`                            | 模型与额度设置                                             |
| `src/styles.css`                                    | 全局视觉、布局和组件样式                                   |
| `src/api.ts` / `src/desktop.ts`                     | 业务接口、桌面鉴权和目录选择；改视觉时不要顺带改变协议     |
| `server/creation-requests.ts`                       | SQLite 创建请求账本，稳定 actor/requestID 对应同一任务    |
| `server/node-queue.ts` / `shared/node-queue.ts`      | 本机持久等待顺序、版本化操作、准入/绑定/启动与终止元数据  |
| `server/node-health.ts`                            | 可注入时钟的容量、拥堵、资源连续异常与停滞判断             |
| `server/task-queue-receipts.ts` / `shared/task-queue-receipts.ts` | 最小公共统计和原路由单任务回执；独立序号与兼容协商 |
| `scripts/node-p0-check.ts` / `scripts/node-queue-crash-check.ts` | 独立数据完整服务闭环与真实 session 崩溃窗口验证 |
| `shared/types.ts`                                   | 前后端业务类型与状态，不能为界面方便改变任务归属或审批语义 |

仍交付 Windows Tauri 桌面产品；浏览器只用于内部调试。已确认 P0 的业务变化按 ADR-0005 与计划实施，超出范围的架构变化再讨论并更新决策和验收。有必要启动预览时先核对既有进程和数据目录，使用隔离开发数据，不重用正式或物理验收目录。

## 历史预览、边界和原现场

以下安装包和现场仅覆盖此前界面/备注/直发功能，不包含待实施的 P0。旧夹具的 CLEANUP 已完成，历史 PID、端口和控制台命令不能作为当前运行状态使用。

- `npm.cmd run preview:conversation:desktop` 会用 `src-tauri/tauri.preview.conf.json` 的独立应用标识构建 Debug Tauri，再创建本轮独立数据目录和本机确定性模型。正式 identifier/config 不改。不要直接把普通 `npm run dev` 当作数据隔离；不要安装旧安装器来查看新界面。
- `npm.cmd run preview:conversation:installer` 构建独立产品名/identifier 的 Windows x64 NSIS 预览包。2026-09-04 本轮重建件复制到 `.data/distribution/Rivloom_UI_Preview_0.1.3_x64_setup.exe`，71,063,972 字节，SHA-256 `76302232ACEC71F35D6854B30F507AEFC703612C0D8A3FBCD9F567EEBE6B0CAA`。这是未签名的内测包，不作为正式 0.1.3 发布；旧 `Rivloom_0.1.3_x64-setup.exe` 保持 71,083,411 字节和原修改时间。
- 夹具控制台接受 `status`、`connect`、`mention`、`disconnect`、`restart`、`stop`；`connect` 创建一次测试来访会话，`mention` 保存本地备注并从本机向对端直发一次任务，同时断言对端没有收到备注。已连接时再 connect 会拒绝重复启动。`restart/stop` 只终止夹具仍持有的测试进程及子进程。
- 本机已有任务占槽时，新本地会话保留为 ready，空闲后点击“开始执行”；本轮没有新增本地自动调度。accepted 会话保留只读；跨机器仅显示协议实际返回的消息摘要和现有授权操作，没有伪造完整远端流式消息。
- 资料保存在各 Node 数据根的 `node-profiles.json`，不替换 node-identity 或 trusted-nodes；头像限制为短的 PNG/JPEG/WebP 数据或预设图标。备注和 `lastUsedAt` 只写本机文件；旧节点没有 profile 字段仍兼容。
- 本轮 `@` 服务闭环证据在 `.data/ui-conversation-5c2a037a-13c8-4f0c-8973-2f814ea85bf9`，原生双节点证据在 `.data/ui-conversation-b3402955-e79b-4b75-b769-e7ee1c584897`。测试数据和失败记录均保留，不作为用户运行数据使用。

- 本轮没有停止/重启两台正式客户端或原测试 Worker/A/B；仅在新建隔离目录中操作测试任务、策略和配对。以下为原现场历史值，当前状态必须重新只读核对。
- 原 Worker 根：`.data/m34-physical/a4530002-0690-40f6-a232-b632fefc5148/worker`，Node `t9MUCFG44Q3nM4txwjG3UPI7mbwePMsM`。合法 declined 历史会触及助手恢复预检限制；不能删历史或新建身份绕过。
- 最终物理报告：`.data/verification/m34-physical-prepared-race-2ebbcc36.json`；其中 next 保留当时待确认结项的历史语境，当前下一步以本交接为准。不再 prepare/accept/submit。
- 内测安装器：`src-tauri/target/release/bundle/nsis/Rivloom_0.1.3_x64-setup.exe`（71,083,411 字节）；助手包：`.data/distribution/Rivloom_M3.4_Master_Helper_0.1.3_race-v2.zip`（20,017 字节）。本轮未重建/安装，保存不等于签名发行。
- 不修改或 fork OpenCode；不要求 Project 有 Git；不建立文件快照或内容哈希；不读取或提交用户凭据，不自动清理数据或关闭正式程序。

## 历史：实施前使用的新会话开场（当前应按上方 D 停点继续）

```text
继续 C:\project\rivloom-opencode，推进 M3.5「会话式 Node 协作」，实施我已确认的四项 P0：@Node 能力列表、准确投递回执、Node 队列控制、自动分配可靠性。

先读 docs/UI-HANDOFF.md、docs/plans/2026-09-05-node-collaboration-p0.md、docs/adr/0005-directed-node-queues-and-receipts.md，再核对 HANDOFF、MILESTONES、PROGRESS、VERIFICATION 和实际 Git。当前基线为 main / 8badf8f 加现有未提交的界面、备注和 @Node 改动；保留这些改动，不重置或覆盖。

四项范围已确认，无需重新询问是否开始。按 A → B → C → D 推进，先做阶段 A 的草稿目标绑定、创建幂等和自动分配候选修复。@Node 普通忙碌仍固定目标排队，不静默改派；可信自动收件、AI 审批和 Task/Execution/Brain 归属按 ADR 保持。

使用独立数据和自有测试进程完成验证，保存失败证据；正式客户端、原物理验收数据和凭据保持安全。纯 mDNS 的既有失败单列，不把旧测试或旧预览包当作 P0 验收。按计划交付新预览包及文档，超出 P0 的功能另行讨论；不要自动提交/推送 Git 或安装正式环境。
```
