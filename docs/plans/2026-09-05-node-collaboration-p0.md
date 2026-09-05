# Node Collaboration P0 Implementation Plan

**Milestone:** M3.5「会话式 Node 协作」的剩余 P0 工作；已有会话界面/备注/直发是基线，A–D 是本里程碑的实施检查点。总体状态和完成条件见 [里程碑基线](../MILESTONES.md)。

**Goal:** 完成 `@Node` 能力列表、准确的委派回执、可控制的 Node 队列和自动分配可靠性四项 P0，使指定目标、实际执行与界面状态保持一致。

**Architecture:** 指定 Node 复用直接 remote-task 路由；自动选择继续使用已有 BrainTask / Execution 路由。Node 通过持久队列和现有最终准入门闩管理本机及外来任务；队列回执独立于 Execution 状态，通过原加密连接按能力协商同步。

**Tech Stack:** 现有 TypeScript、React、Express、Node SQLite、Tauri 和未修改的 OpenCode 1.18.25；不新增云服务或消息中间件。

**Status:** 2026-09-05：A–D 工程交付完成，用户验收及本轮双物理机回归待进行。完整服务 12/12、真实 session 两崩溃窗口、Debug 原生 12 条/Release 原生 8 条记录、最终二进制闭环和前端/HTTP 23/23 通过；最终全量 154/155，唯一已有纯 mDNS 失败单列。伪 ACK、统计刷新和成员读取范围已修复并回归，新独立预览包已生成，NotSigned、未安装，全部自有夹具已清理。按用户追加授权保存本任务本地 Git、不推送，提交号以最终 Git 记录为准。继续入口为 [UI-HANDOFF](../UI-HANDOFF.md)，A–D 不从头重做；以下步骤保留为验收清单，历史“未实施”不覆盖本状态。

---

## 1. 结论与当前基线

四项均可实现，现有配对、加密连接、节点硬件/负载、任务状态、单槽准入和停止/审批接口可复用。队列控制需要持久化、调度和协议变更，是主要工作量；不能把四项当成一次小型 UI 改动。

Git 只读核对：`main`，HEAD `8badf8f`，会话式界面及 `@`/备注的改动仍未提交。以实际未提交源码为本计划起点，执行前再次核对 Git，不覆盖既有改动。

规划时已读 UI-HANDOFF、HANDOFF、MILESTONES、ADR-0002/0003/0004，并核对相关源码。历史测试以 VERIFICATION 为准；本轮仅分析及保存文档，不产生新的产品测试通过结论。

关键设计、备选方案、数据边界与恢复原则见已接受的 [ADR-0005](../adr/0005-directed-node-queues-and-receipts.md)。2026-09-05 用户回复“可以，这几个更改我打算新开一个会话，你将之前的记录到文档，并告诉我新会话该怎么开始”，据此同步里程碑和交接入口。设计已接受不代表当前源码已实现；后续超出本计划的架构或产品范围变化再讨论。

## 2. P0 范围及对原建议的修正

| P0               | 现有基础                                | 计划交付                                                                               | 相对工作量                 |
| ---------------- | --------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------- |
| `@Node` 能力列表 | 名称/备注、最近使用、在线、硬件和槽位   | 紧凑显示空闲/忙碌、真实等待数、CPU/GPU 概况和数据新鲜度；稳定指定目标                  | 小到中，依赖队列统计       |
| 委派状态回执     | 已有邀请/执行状态、审批、提问、验收摘要 | 区分本机已保存、发送、送达、目标已入队、当前排位、等待原因、执行/验收/终止             | 中                         |
| Node 队列控制    | 当前仅前端聚合列表，后端有单槽 gate     | Node 权威顺序、上移/下移、暂缓/恢复、拒绝未执行任务，原会话显示反馈                    | 较大，是主要风险与工期来源 |
| 自动分配可靠性   | Brain/Worker 评分和重试已有             | 统一各 Brain 的候选资格，修复错误选择 Master 自身造成的无执行 Worker，保留原 Task 重试 | 中                         |

原建议中的“接受/拒绝”修正为：可信任务默认自动收件入队；接收方可暂停、恢复或拒绝继续执行，不增加逐条确认邀请。新队列控制不能改变 AI 文件/命令审批权限。

“暂停”指暂停排队项/后续启动。运行中继续用现有“停止执行”，不承诺操作系统进程挂起、文件回滚或任意时刻无损迁移。

普通满槽、正常长任务和短时高负载仍投递到指定 Node。严重拥堵、持续资源异常或疑似停滞需要目标端证据和明确原因，不能自动改派。发送端只看到旧报告时显示未知。

P1 上下文包、附件传送、离线首次投递信箱、结果凭证页和连接诊断本轮不扩入。也不增加多目标群发、自动拆任务、跨 Brain 迁移、Master 选主或 macOS 发行。

## 3. 实施顺序与可评审交付

| 阶段              | 工作     | 完成后用户可验证的结果                                                            |
| ----------------- | -------- | --------------------------------------------------------------------------------- |
| A：路由与调度基础 | Task 1–2 | `@` 草稿切换后仍发给原 Node，超时重试不重复建任务；自动分配不会选出不可执行的候选 |
| B：真实队列       | Task 3–4 | 自己和其他 Node 的任务按真实顺序等待，普通忙碌仍能入队，暂停/恢复/拒绝可持久保存  |
| C：回执与界面     | Task 5–6 | `@` 列表显示能力/队列，双方会话看到真实排位与等待原因，右栏操作影响真实队列       |
| D：验证与交付     | Task 7   | 隔离双/三节点和桌面验证、失败记录、更新预览安装包与交接                           |

阶段 A 可独立交付；B 是 C 中队位和控制的前置条件。底层契约稳定后，能力列表和回执界面可并行实施。每阶段保存可评审差异和验证证据。计划接受时未授权 Git 提交；本轮用户已追加授权收尾时保存本地 Git，只纳入本任务范围，不推送或安装到正式环境。

## 4. 分项实施任务

### Task 1：固定 `@` 目标和创建请求幂等

**Files**

- Create: `src/conversation-drafts.ts`
- Modify: `src/conversation-workspace.tsx`, `src/node-mentions.ts`, `src/api.ts`
- Modify: `server/index.ts`, `server/node-network.ts`, `server/remote-tasks.ts`
- Test: `tests/conversation-drafts.test.ts`, `tests/directed-node-tasks.test.ts`, `tests/node-mentions.test.ts`

**Steps**

1. 添加草稿切换/恢复、同名 Node、原名/备注变化、目录暂失、目标撤信和 HTTP 响应丢失的失败测试。
2. 草稿使用 `{ text, routing, requestID }`，routing 区分 local / node(nodeID) / automatic。选中 Node 后以 ID 为准，正文 `@原名` 不承担路由解析。
3. 草稿路由与正文一起保存/恢复；取消指定要有明确 UI，节点暂失时保留目标并提示，不能因 `peers.find()` 失败而落入本机分支。
4. 新建接口增加稳定请求 ID，持久化与邀请创建结果的映射；同一请求与相同规范化内容返回已有任务 ID，不重新提交。相同请求 ID 携带不同目标/内容返回冲突。创建成功后以返回的精确 ID 打开会话，避免用“列表里新出现的一条”猜测结果。
5. 丢失 HTTP 响应时重试同一逻辑创建；明确失败且未创建时保留草稿。编辑成另一项新工作才生成新请求 ID。网络层继续使用同一邀请 ID 和已有幂等机制。
6. 输入处理覆盖中文输入法 Enter、光标移动、名字含空格和鼠标/键盘选项；新会话每次只指定一个目标，多个 `@` 文本不扩展成群发。

**Validation**

`node --test tests/conversation-drafts.test.ts tests/directed-node-tasks.test.ts tests/node-mentions.test.ts`

预期：草稿恢复目标不变；请求重试只有一个邀请，接收端只有一个业务 Task/session；离线/撤信没有本机或其他 Node 的执行。

### Task 2：修复自动分配候选不一致

**Files**

- Modify: `server/worker-resources.ts`, `server/node-network.ts`
- Modify: `src/conversation-workspace.tsx`, `src/node-network.tsx`
- Test: `tests/node-network.test.ts`, `scripts/node-p0-check.ts`（Task 7 创建）

**Steps**

1. 添加复现：远端 Brain 的唯一空闲候选是其 Master 自身；当前提交选择成功但 Master 无候选。
2. 提取每个 Brain 的实际可调度 Worker 过滤规则，提交评分和 Master 调度共用。按对应 Brain 的 masterNodeID 过滤，不是按发起 Node 是否 hosted 判断。
3. 不直接删除 scheduler 的 self 排除；当前执行通道不支持 self dispatch。保留 Node 为其他 Brain 提供 Worker 的能力。
4. 统一基础资格后再按本地可验证的在线/信任/通道/版本判定；Master 最终准入仍必须重验。新 Task 无可用候选时在创建前解释原因。
5. 已有 queued Task 保留原 ID/Brain，暂时无候选显示原因，有合法 Worker 后沿原任务继续；不删历史或新建任务代替。
6. 首个修复切片可暂时隐藏自动分配新建入口；专用验证通过后恢复，现有自动分配会话一直可见。

**Validation**

`node --test --test-name-pattern="brain task placement|shared workers register|offline pending Execution" tests/node-network.test.ts`

并在隔离夹具中覆盖仅 Master 自身候选与真实第三 Worker 两种拓扑。预期：前者明确无候选，后者产生真实执行；同任务重试、review 占槽和未知执行不重派继续通过。该修复不等于增加 Master 对自身调度能力。

### Task 3：持久队列和统一取队列入口

**Files**

- Create: `server/node-queue.ts`, `shared/node-queue.ts`
- Modify: `server/store.ts`, `server/index.ts`, `server/worker-admission.ts`, `server/execution-policy.ts`
- Modify: `server/remote-tasks.ts`, `shared/types.ts`
- Test: `tests/node-queue.test.ts`, `tests/node-queue-recovery.test.ts`

**Steps**

1. 测试混合来源 FIFO、调序、暂缓、版本冲突、重复入队和重启保持。接收顺序使用 Node 本地递增顺序，不能用发送方时间或远端 updatedAt 排队。
2. 在现有 SQLite 中新增 node_queue 表，最少保存稳定本机键、来源引用、入队顺序、可调整顺序、waiting/held/admitted/ended、版本及终止原因。对 remote 引用设置唯一约束；避免重复保存任务正文和引擎状态。
3. 收到直接任务后，在 offer 已持久保存的基础上幂等入队，成功后才确认已入队。两个存储之间崩溃时通过稳定引用对账，不宣称跨 JSON/SQLite 的写入是一个事务。
4. 后台仅通过统一 dispatcher 按队列选择可执行项。暂停、模型/项目未就绪的项保留原因；UI 的排位按当前可执行顺序计算，暂缓项不伪造一个确定开始序号。
5. 最终取队列、重新检查信任/终态、准入和本地业务绑定共用 admission gate。未获槽的直接队列项不批量创建占槽的 remote ready Task。
6. 新本地执行请求可入队自动启动；旧 open/ready 数据迁移保留原授权状态。已启动但结果未知的记录保持 interrupted/占槽，不自动重新创建 session。
7. M3.4 未接受分配在同一 gate 内与本机队列竞争；已有可执行队列优先时对新 pending 分配明确拒绝。已经准入/保留的执行继续兑现，不允许拖动顺序释放其槽位。
8. 测试队列 intent → accepted → admission → Task 绑定 → session 创建每个关键崩溃窗口；已拒绝、取消、过期或撤信的项不能被重建并执行。

**Validation**

`node --test tests/node-queue.test.ts tests/node-queue-recovery.test.ts`

预期：单槽最多一个实际活动执行；入队顺序与 dispatcher 一致；重启不重复 Task/session；review/unknown 仍占槽；旧手动任务不因升级自动执行。

### Task 4：队列操作与异常判定

**Files**

- Modify: `server/node-queue.ts`, `shared/node-queue.ts`, `server/index.ts`, `server/task-service.ts`
- Create: `server/node-health.ts`
- Modify: `server/worker-resources.ts`
- Test: `tests/node-queue-controls.test.ts`, `tests/node-health.test.ts`

**Steps**

1. 新增 owner-only 本机队列查询/操作接口，变更带预期版本和唯一操作 ID。普通成员沿现有任务权限查看自身任务，不获得全 Node 队列详情或排序权。
2. 实现等待项上移/下移、暂缓/恢复和“拒绝执行并说明原因”；所有变更与取队列在同一 gate 下重验，开始后的陈旧操作返回冲突。
3. 暂停队列只阻止后续自动开始。运行任务保留“停止执行”，先确认 OpenCode 停止；无法确认仍标 interrupted，不能直接释放槽。
4. 已 accepted 但尚未执行的项使用独立队列终止标记和回执，不能调用仅允许 pending 的 invitation decline。终止标记同时阻止后续自动扫描、旧控制消息或迟到回执重新激活任务。
5. 拥堵使用目标端实际等待数量/等待年龄；停滞使用应可运行的等待项长期未被取出，排除明确暂停、长任务、人工等待、模型/项目故障。在线心跳不能当作业务进展。
6. 连续资源异常与短时尖峰分开，缺失/过期指标显示未知。正常忙碌允许 `@` 入队；达到明确接收上限或不可接收状态时返回结构化原因，其他异常保守告警，保持目标不变。
7. 阈值可配置、时钟可注入测试；正式初值依据隔离验证确定。暂不宣称能从 CPU/GPU 使用率预测 LLM 响应速度，也不输出无依据的排队分钟数。

**Validation**

`node --test tests/node-queue-controls.test.ts tests/node-health.test.ts`

预期：暂停/拒绝与启动并发时只有一个合法结果；重放操作幂等；普通满槽/单点尖峰仍入目标队列；严重异常有原因但不会在其他 Node 执行。

### Task 5：队列统计与单任务回执协议

**Files**

- Create: `server/task-queue-receipts.ts`
- Modify: `server/node-network.ts`, `server/remote-tasks.ts`, `server/brain-tasks.ts`, `shared/types.ts`
- Modify: `server/index.ts`, `src/api.ts`
- Test: `tests/task-queue-receipts.test.ts`, `tests/node-network.test.ts`, `tests/security.test.ts`

**Steps**

1. 定义 capability 协商及有界的新队列消息。保持旧 WorkerRegistration 严格字段集；目录外层或独立消息返回队列统计，不用 Brain queueDepth 冒充 Node 队列长度。
2. Node 公共统计只含 waitingCount、暂停状态、采样/更新时间及最小健康信息；per-task 回执附原路由、独立 queueSequence、状态、当前候选排位、阻塞/终止原因和更新时间。
3. 回执至少区分 sending、delivered、queued、held、admitted、rejected，以及 transmission_unknown；实际执行阶段继续使用原 executionState/Sequence。已确认收件后也可以等待 execution policy/model/slot，UI 需要解释。
4. 只向对应任务来源发送队位；M3.4 沿原 Worker → Master → submitter 链路转发，不共享其他来源的标题/正文或本地模型/路径/备注。
5. 网络重连同步最新快照，验证路由、消息上限、独立序号和终态守卫；回执可跳过中间状态追上最新事实，不依赖两台机器毫秒级时钟排序。
6. 新旧混合版本继续基本执行，缺失排位显示未提供。新协议操作若不能在旧方得到确认，必须明确显示兼容限制；不得当作已同步成功。

**Validation**

`node --test tests/task-queue-receipts.test.ts tests/remote-task-clock.test.ts tests/security.test.ts`

预期：丢包、乱序、重复、错误路由和重连都不能复活终止项或重复执行；其他 Node 的任务信息不出现在本任务回执中；旧消息格式仍可处理。

### Task 6：能力列表、回执和队列 UI

**Files**

- Modify: `src/node-mentions.ts`, `src/conversation-workspace.tsx`, `src/conversation-workspace.css`
- Modify: `src/conversations.ts`, `src/node-network.tsx`
- Create: `src/task-receipts.ts`
- Test: `tests/node-mentions.test.ts`, `tests/task-receipts.test.ts`, `tests/conversations.test.ts`

**Steps**

1. `@` 首行保持 `原名（本地备注）`，第二行紧凑显示在线/执行暂停/忙碌、空闲槽、等待数和简要能力；详细 CPU/GPU 放在展开或悬停信息，列表仍按最近使用排序。
2. 缺失 GPU/队列/旧报告显示未知或更新中，不当作零负载；忙碌选项仍可选择。目标 chip 始终显示实际固定的 Node。
3. 会话顶部/消息内增加单条可更新的投递状态，展示真实等待原因和本任务排位；重连标识“正在确认状态”，不把通信失败写成执行失败。
4. 右侧队列从服务端权威快照显示，等待项支持上移/下移、暂缓、恢复和拒绝。运行中、待验收、状态未知分别展示原有可用操作，不参与等待顺序拖动。
5. 各状态保留自己的浅色/其他 Node 深色来源提示，发送方从原会话看到结果。右栏无在线连接时仍按既定布局收起，本机队列从会话页轻量入口可打开，不恢复旧任务工作台栏目。
6. 窄窗口、长名字/备注、无节点、全部繁忙、旧节点、离线和中文输入法检查；能力列表及队列操作使用键盘可访问控件。

**Validation**

`node --test tests/node-mentions.test.ts tests/task-receipts.test.ts tests/conversations.test.ts`

`npm.cmd run build`

预期：显示状态与真实 API/回执一致，源颜色/会话去重不回归；输入和队列视觉另在 Task 7 原生窗口核验。构建通过不等于原生交互已通过。

### Task 7：隔离验证、桌面与交付

**Files**

- Create: `scripts/node-p0-check.ts`
- Modify: `scripts/conversation-ui-fixture.ts`, `package.json`
- Modify after implementation: `docs/UI-HANDOFF.md`, `docs/PROGRESS.md`, `docs/VERIFICATION.md`, `docs/MILESTONES.md`, `docs/adr/0005-directed-node-queues-and-receipts.md`

**Steps**

1. 复用 `scripts/m34-fixtures.ts`，新增独立 `.data` 和确定性模型夹具，控制执行释放以稳定产生混合排队/待验收；使用独立发现域，只操作本轮自有进程。
2. 验证两 Node 指定投递：普通满槽仍入队、不同来源排位、调序/暂停/拒绝、原任务自动继续、发送方回执一致、0 重复 Task/session。
3. 验证本地队列与第三 Node/M3.4 的同槽竞争；已保留、review/unknown 不被插队释放，原 Brain 归属和 Execution 历史不变。
4. 注入创建响应丢失、回执乱序/重复、接收端重启、队列持久化与绑定中断、撤信、目标离线和旧节点兼容；每次核对唯一身份和执行。
5. 用 `npm.cmd run preview:conversation:desktop` 验证 Tauri 实际窗口：`@` 候选、原名/备注、切换草稿、发送、真实排位、操作按钮、回执、断开和窄布局。无法操作窗口时明确记录未覆盖，不以服务测试代替 UI 验收。
6. `npm.cmd run typecheck`、`npm.cmd run build`、新增测试和现有相关网络/时钟/安全/单槽回归；Windows DPAPI 和 UDP 用正常授权用户上下文。完整回归若仍有纯 mDNS 已知失败单独列出，不把其余通过称为全量绿色。
7. 功能验收通过后用 `npm.cmd run preview:conversation:installer` 生成新独立预览包，核对大小、SHA-256、未签名状态和与旧正式包的区分；不自动安装到用户机器。
8. 更新已验证事实和残留风险；`git diff --check`，只结束本轮测试进程并保留证据。两台物理设备验收另约用户现有设备空闲时进行，不复用旧 PID 或改动原验收数据。

## 5. 最小验收场景

1. A 明确 `@B`，B 正在执行其他工作但正常响应：任务留在 B，A 看到 B 入队和原因，不会去 A/C。
2. B 队列混合本机任务与 A/C 来访任务：显示顺序等于实际取队列顺序；普通来源按本机接收顺序，不默认偏向自己或某个 Brain。
3. B 暂缓/恢复/调整等待项/拒绝未执行项：变化持久，A 只收到自己任务的正确回执。
4. B 完成后 review 仍占槽；验收释放后原队列继续。长任务/人工等待不被误判为停滞。
5. A 丢失创建响应后重试，或 B 在收件/绑定阶段重启：一条逻辑任务最多一个实际活动 session，无自动改派。
6. 原名/备注变化、同名 Node、切换草稿、旧节点缺少统计、目标离线：目标 ID 不变，状态未知时不伪造排位/空闲。
7. 自动分配只有不受支持的 Master 自身候选：不产生无理由的永久 queued；加入合法 Worker 后同一合法队列任务可继续。
8. 严重异常被报告时解释原因并保留指定目标；阈值之外的正常忙碌仍投递。不因单点 CPU 高、报告缺失或正常等待审批而阻止指定任务。

## 6. 当前工程交付与验收边界

A 已实现结构草稿、稳定 requestID 与精确创建结果、每个 Brain 的共用 Worker 资格；B 已实现持久 Node 队列、所有者控制、准入与保守恢复；C 已实现 capability 协商统计、独立任务回执、真实队列/能力界面。创建重试及请求期间切换/设置竞态、队列未知结果保持原操作 UUID 均已纳入前端处理。可信自动收件、AI 审批和 Task/Execution/Brain 归属不变。

D 最终完整服务 `.data/verification/m35-p0-1788581065722-2746e0ac` **12/12**：7 Task/7 官方 session/0 工具，6 accepted 和 1 注入 interrupted，追加成员读取范围、owner 队列权限与脱敏通过；此前 10/10 根和失败根保留。真实 session 创建前/创建后未绑定两崩溃窗口另根通过。Debug 原生 12 条记录/6 张截图，覆盖固定草稿、忙碌排队、原任务执行、队列控制/回执、断线/重启和最窄 962×872；Release 原生 8 条记录/4 张截图，覆盖真实 Windows IME 候选 Enter 不发送、键盘选固定 Node、认证送达/排位、统计刷新与等待文案。最终全量 154/155，唯一已有纯 mDNS 失败保留。

最终独立包 `.data/distribution/Rivloom_M3.5_Node_P0_Preview_0.1.3_x64_setup.exe` 为 **71,107,766 字节**，SHA-256 **`206B80AD363FBAC90435E085333F8D61DFB5BF8A3251734AD459A6905ED2DECE`**，NotSigned、未安装。最终重新链接后的 exe 又在 `.data/ui-conversation-f90b3dd1-f6b1-4ca8-987a-bc51c67f0945` 完成启动、加密配对、1 remote Task → 1 业务 Task → 1 官方 session → review 和实际窗口结果检查，模型请求 1/工具 0；全部自有夹具 CLEANUP。用户验收和本轮双物理机回归待进行，正式客户端及旧包/原验收数据保留。详细事实、原生根、包/EXE 哈希及失败日志见 [VERIFICATION](../VERIFICATION.md)。

## 7. 历史：计划接受时的实际产出

完成现有代码/文档分析，保存本计划与 ADR-0005，并在用户确认后同步 UI-HANDOFF、HANDOFF、PROGRESS、MILESTONES 和验证入口。四项 P0 均尚未实施，产品代码、测试源码、现有运行节点和安装包均未在本轮修改或运行；没有 Git 提交或推送。

下一会话先读 [UI-HANDOFF](../UI-HANDOFF.md)、本计划和 ADR-0005，核对实际 Git 与既有未提交改动，再实施阶段 A（Task 1–2）。其余阶段按 A → B → C → D 的依赖推进；保存阶段性证据，不能用旧 UI 测试或现有预览包证明 P0 已完成。
