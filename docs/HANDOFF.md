# Rivloom 当前交接状态

更新时间：2026-09-03。工作目录：`C:\project\rivloom-opencode`。

这份文件用于后续开启新会话或继续里程碑。当前顺序和双方共识以 [里程碑基线](MILESTONES.md) 为准；事实明细见 [实施进度](PROGRESS.md)，测试记录见 [验证报告](VERIFICATION.md)，长期范围见 [实施计划](plans/2026-08-31-mvp-delivery.md)。

## 当前产品决议

- M0、M1、M3.1、M3.2 已完成。
- 用户已经在 Rivloom 本机保存 DeepSeek Key，并用 `deepseek/deepseek-v4-flash` 完成官方真实连接和无 `.git` 普通文件夹固定编程任务。Key 不进入聊天或仓库。
- M2 的正式发行完善暂缓。现有安装包事实保留，但当前不投入签名、升级矩阵等工作。
- M3.3 的 MVP 范围已经人工验收完成；防火墙体验、停止/自动审批/撤销及两真人回归保留为后续优化，不阻塞产品推进。
- M3.4 按ADR-0004当前MVP范围结项：0.1.3物理升级、自动接入/双Brain共享目录、跨机执行、指定Project和正常Master离线恢复、真实单槽竞争及原队列续跑均有证据。用户收到结果和纯mDNS专项限制后回复“好，下一步吧”；未解决的mDNS92/93、未测故障边界和后续优化继续保留，不宣称全量绿色。

## 最新交接（2026-09-03）：保存 M3.4 基线，下一会话修改界面

用户最新明确要求：“下一个我要修改界面了，你先把目前的进度保存好，文档，git等等都处理好，之后我会开一个新会话”。这取代下方继续讨论任务编排的建议。**下一会话先听用户的界面改动要求；本轮不改界面，不启动新功能里程碑。** 单 Brain 目标拆解/任务编排未获采纳，不自动继续。

新会话先读 [界面改版交接](UI-HANDOFF.md)，再核对本文件、MILESTONES、PROGRESS、VERIFICATION 和 ADR-0004。M3.4 当前 MVP 已结项，纯 mDNS 专项 92/93 仍待查；不能把既有失败、未测故障边界或 M3.3 后续优化写成通过。

Git 保存：用户此次授权将此前从 f5ce9ed 累积的 M3.4 实现、修复、测试助手、验收文档及本次交接作为本地检查点保存。提交标题为「feat: complete M3.4 shared-worker MVP and save UI handoff」，具体提交号以当前 git log -1 --oneline 为准。保留当前 main，不推送远端，不创建分支/worktree、不改写历史；下文“HEAD 仍 f5ce9ed / 未提交”只描述历史检查点，不是下一会话的当前基线。

本次保存前重新通过构建、59 项定向测试和两个 PowerShell 脚本的语法解析；未重跑全量发现、物理双机、安装器或真实模型测试。测试仅新增独立隔离数据，不操作两正式客户端、原 Worker/A/B、配对或任务。运行 PID/端口/交互 session 均为上次观测值，新会话不能盲用或据此停止进程。.data 中报告/测试数据、安装包和凭据保留本机、继续被 Git 忽略；Git 保存不等于这些运行数据已备份。

## 前一结论（2026-09-03 07:10Z）：M3.4 当前 MVP 范围结项，下一阶段先讨论

在双Brain最终completed和核心物理验收通过、纯mDNS专项仍待查均已说明后，用户回复 **“好，下一步吧”**。按该上下文将M3.4当前MVP切片记为结项；引用原话，不扩大成所有测试通过或正式商业发布许可。已同步里程碑、ADR-0004实施状态、实施计划、进度和验收结论，保留所有历史失败和未验证边界。结项本身没有新运行测试或代码变更。

**下一步是产品范围讨论，不直接实现新阶段。** 当前有效路线没有已确认的M3.4之后实现切片；旧M4 ChatGPT登录/更多模型、M2发行完善和人员/HA均明确延后。建议先讨论“单个Brain如何把一个用户目标拆成多个Task并跟踪完成”，尚未获采纳、未编号为M3.5、未建立新领域对象。先确认方向，再逐项讨论自主程度、任务依赖、输出传递和完成判断；达成共识后先更新ADR/里程碑/最小闭环/验收，再实现。不得重新引入每Node一个Brain、跨BrainTask委派、Master管理模型额度或项目同步假设。

本轮只做文档结项和现有决策核对，没有修改/停止两正式桌面、Worker76974、A17068或远端B；没有重发任务、运行安装器、改网络/信任、修改OpenCode或提交Git。HEAD仍f5ce9ed、原有未提交改动保持。原Worker policy启用、fixture已release、5accepted/5session/7Execution及合法declined历史保持；若后续恢复隔离Worker须先核对助手预检限制，不删历史/默认新根。纯mDNS问题单列待查，不借结项声称已修复。以下为历史检查点。

## 前一结论（2026-09-03 07:05Z）：双物理 Brain 单槽竞争闭环通过

用户07:04:36.054Z最终B `RACE_STATUS` 已确认：原Ytmgnp/Brain024a07、同一Task **8fe868cc-9bf8-4843-a4b9-728bcfe3cb02** / Execution **be6b9f97-68d6-436e-9936-c26bc728dfa2**、**completed/seq4/attempt1**。ledger的phase=submitted只表示助手已投递，不是Task还未完成。本机07:05:25.922Z再次只读核对A原Task **44a77700-8d3a-4e65-9c42-a1dc660c5ddd** / 第二次Execution **de478490-8de8-4b4f-8d3d-b32608c7b125** 已completed/seq4/attempt2；两Worker业务Task accepted、无待控制/回传或错误，旧历史完全保持。

本轮UUID **2ebbcc36-c079-4c84-ad4e-a6d9cf6a579f** 已完整通过：两个既有独立Brain各提交一次 → B占单槽、A原Task排队 → B review仍占槽 → B所属Master验收 → A原Task自动第二尝试 → A所属Master验收 → 槽恢复1。最终 **5 accepted业务Task / 5官方session / 7 Execution / 5 Project / 2次本机夹具调用 / 0工具part**，五个测试普通文件夹为空；只新增两个业务会话，第一次被拒Execution仍无业务绑定，不修改历史或Task归属。证据报告 `m34-physical-prepared-race-2ebbcc36.json` 已标 **passed**，同时保留协调失败、观察字段错误及旧失败记录。

**本轮不再需要用户输入任何测试命令。** 不再要求race-status/accept/prepare，不继续重放本轮。M3.4核心物理闭环证据收齐，接下来汇总确认MVP结项；当前里程碑写为“核心物理验收通过、MVP结项待确认”，不擅自替用户接受整个里程碑。原纯mDNS专项全量92/93、单独复查仍失败的事实单列待查，不宣称全绿或根因已解决；M3.3后续优化仍不阻塞。

运行现场保持：Worker76974（helper/service996/26240，API58866/peer60127/engine51469）、A controller17068（原桌面API57350）、B原目录/peer62295及两正式桌面均未停止或改变。原Worker执行policy已恢复并启用，夹具已release。以后如需再次恢复测试Worker，先核对现有恢复预检对合法declined邀请的限制；不得删失败历史或默认新根。本轮仅只读收尾、更新验收文档和报告；不改产品/测试源码、OpenCode、网络/配对或安装，不提交Git（HEAD仍f5ce9ed、既有修改保持）。以下均为历史检查点。

## 前一停点（2026-09-03 07:01Z）：B 验收生效，A 原 Task 自动续跑并验收；等 B 最终只读状态

用户 B 的 06:57:59.421Z `RACE_STATUS` 是一次 race-accept 后的即时回执，仍 review/seq3。已独立核对 Worker 上 B **accepted/seq4**、业务 Task 更新时间 **06:57:59.983Z**，回传无 pending/error；没有让用户重复验收。A 原 Task **44a77700-8d3a-4e65-9c42-a1dc660c5ddd** 随后自动发起第二次尝试，不是新 Task 或手工重发：

- 新 Execution **de478490-8de8-4b4f-8d3d-b32608c7b125**，Worker 新业务 Task **167112f2-8d0d-4bd3-8fd9-75cdbc06babe**、session **ses_f99f077d4ffeNvFWSbNHUOFpw9**、Portable Project **81ece1b5-cdfc-4ae3-b0d1-84efdbc8d927**。本机业务 Task 创建于06:58:08.788Z，晚于同一 Worker 上 B 的 accepted；A/Brain/Worker 归属不变，原第一次 declined/failed Execution0808698e完整保留且无业务绑定。
- 07:00:25.167Z 完整结果核对通过：A review/seq3、B accepted/seq4，确定性文字、无工具/审批/问题/错误，5个普通测试文件夹直接列目录为空；原3accepted/3session/4Execution元数据完全不变。07:00:26.823Z仅经 **A controller17068** 对当前race输入一次race-accept；即时同样review，但07:01:03.531Z已权威A **completed/seq4/attempt2**，Worker两条新业务Task均accepted，回传/控制清空。
- 最终 **5 accepted Task / 5官方session / 7 Execution / 5 Project / 0工具part**。新增只有两个业务会话，另一次拒绝没有会话；夹具累计请求 **2**（07:01:36.603Z status）。原policy精确保持enabled/Project c4227a2e/model fixture/m34/ask/单槽。07:01:03.552–07:01:23.543Z再观察 **20,011ms/38次**，Worker及A看到槽1、running0、无新增执行、A completed全部稳定。

**现在只等用户5.20当前B助手的 `race-status` → RACE_STATUS**，验证同一Task8fe868cc/Executionbe6b9f97已completed/seq4/attempt1。已发一次非阻塞请求；不再race-accept/submit/prepare。B已提供权威review及单次提交ledger，Worker完成回传已成功，但不能把这替代B本机最终completed回执。补齐后才将本轮物理竞争闭环标为通过；M3.4 MVP仍待汇总确认，mDNS92/93专项待查不变。

全部身份/进程保留：Worker76974（996/26240，API58866/peer60127/engine51469）、A17068（桌面API57350）、远端B原目录与peer62295。夹具已release，原能力已启用，不重复开关；两正式桌面不动。**后续若需再次恢复原测试Worker，先处理测试助手恢复预检只支持accepted邀请的限制：本轮新增合法declined记录，不得删除它或换新根来通过预检。当前不重启或改助手代码，此限制不等同于产品恢复失败。**

按executing-plans推进验证，无产品/测试源码、OpenCode、网络/配对或安装变更；仅运行验收控制和更新文档、报告 `.data/verification/m34-physical-prepared-race-2ebbcc36.json`。以下为历史停点。

## 前一停点（2026-09-03 06:54Z）：物理竞争已发生，B 待验收占槽，A 原任务排队

用户回传 B 的 `RACE_PREPARED`：06:49:12.600Z、UUID **2ebbcc36-c079-4c84-ad4e-a6d9cf6a579f**、原 Ytmgnp/024a07、v2/prepared/taskID=null，匹配 A 已准备意图。06:52:26.736Z 再核对双方通道、门闩关闭、无新 Task、原完整历史一致后，仅经正常 API 恢复报告 `preflight.restoreBody` **一次**。**当前 Worker 已启用原 Project c4227a2e / fixture/m34 / ask / maxConcurrent=1；不要重复开关或提交。**

- 06:52:29.845Z 实际观察到 B running、A queued。B 的 Task **8fe868cc-9bf8-4843-a4b9-728bcfe3cb02** / Execution **be6b9f97-68d6-436e-9936-c26bc728dfa2**，归属远端 Brain **024a0766-64db-4419-a4cc-7b0d53688927** / Master **YtmgnpZtwNcSWpdPvAWuhf3IREFuNfEt**。Worker 唯一新业务 Task **fb49d63f-4d07-4b5f-9a12-d11420f89ea6** / session **ses_f99f5a54dffe0iIbZ60F6OHsQY** / Portable Project **1cd4e8ad-0f62-45ad-9137-95211b818a6e**。
- A 的 Task **44a77700-8d3a-4e65-9c42-a1dc660c5ddd** 仍属于原 Brain **0ed79cba-4ed8-4373-ad3f-1dfc4a695800**，第一尝试 Execution **0808698e-2e74-4ce0-87a1-7486ed78873e** 在 Worker 最终准入被 declined，没有绑定本机 Task/session；权威 Task 回 queued，保留该失败尝试历史。这是正常单槽争用结果，不是需要用户重发的失败 Task。
- 放行后观察 20,121 ms / 86 次；06:53:48.950Z 完整绑定/旧历史/唯一新 session 断言通过。06:53:01Z helper 模型请求恰好 1。随后向原 Worker 76974 输入一次 release。06:54:15.632Z 已复核 **B review/序号3、deliveryPending=false/error=null，A 仍 queued，槽0**；确定性文字结果、工具 part 0、四个测试普通文件夹直接列目录为空，原三条 accepted / 三个旧官方会话 / 四条旧 Execution 完全保持。没有文件快照或哈希。
- Worker **session76974 / PID996、26240 / API58866 / peer60127 / engine51469** 与 A 控制台 **session17068** 保持。A 桌面 API57350/原身份不变，本机执行关闭、业务 Task0；B 远端仍使用 API62028/peer62295，不能从本机访问其 loopback。两正式桌面、身份、信任与产品/OpenCode/网络设置未动。**模型夹具已 release，后续请求会立即返回。**

**下一步给用户（5.20 当前 B 助手）**：`race-accept 2ebbcc36-c079-4c84-ad4e-a6d9cf6a579f`，只输入一次并回传 `RACE_STATUS`。助手会检查精确 owned Task/Worker/review/Execution 序号后发验收；若即时回执仍 review，只再读 race-status，不重复 accept。不使用旧 submit/arm/prepare，不停 Worker 或正式桌面。

收到回执后，从 Worker 与 A 检查 B accepted/seq4、A **原 Task** 自动继续（预期保留第一尝试并新增 Execution，不创建第二个 A Task），核对唯一会话后在 A 控制台精确验收，最后检查两任务 completed、总5个 accepted/5个session、原历史不变/槽1。当前尚未验收 B、未验证 A 续跑或最终双完成；B 本机权威状态尚待用户控制台回传，不能把 Worker 回传成功当作已直接读取 B API。

证据 **`.data/verification/m34-physical-prepared-race-2ebbcc36.json`** 含放行前元数据、状态变化、running/queued 与 review/queued 检查。初次临时观察误从 network 读取 executionPolicy，06:51:33Z 在恢复前退出；改正为 bootstrap 后才放行，无副作用，失败事实保留。按 executing-plans 检查点等待远端验收，不标记 M3.4 MVP 完成；原 mDNS 92/93 专项待查保持。以下为历史状态。

## 前一停点（2026-09-03 06:40Z）：B 同身份 v2 已确认，Worker 暂停接单，A 已 prepare，等 B

用户 06:37:19.642Z STATUS 确认：5.20 原 race-v1 数据根 `51024c87-7c0a-40fc-b316-ff87a2e37b73`、Node **YtmgnpZtwNcSWpdPvAWuhf3IREFuNfEt**、Brain **024a0766-64db-4419-a4cc-7b0d53688927** 都保持，raceHelperVersion=2/product0.1.3，Task/model 0、原 Worker 受信通道就绪/空闲槽 1。新 helper/service PID **14132/3044**，远端 loopback API **62028**、peer **62295**。06:38:56.912Z 本机认证 API 独立匹配新 peer/旧身份及互信；不能从 5.33 访问该远端 loopback API。

原完整历史和策略基线已保存至 **`.data/verification/m34-physical-prepared-race-2ebbcc36.json`**。本轮 UUID **`2ebbcc36-c079-4c84-ad4e-a6d9cf6a579f`**，没有 UTC 时刻：

- 06:39:48.809Z 仅经 Worker 正常本机 `/network/execution-policy` API 关闭执行能力，**程序保持在线**。现 policy enabled=false/ask/maxConcurrent=1、projectID/model=null（正常关闭语义，不是删 Project/模型）。原启用配置在报告 `preflight.restoreBody`：enabled=true、Project `c4227a2e-f93c-4514-ad67-f42c65fa749c`、model `fixture/m34`、approvalMode ask、confirmed true。06:39:52.993Z A 已看到 accepting=false/槽位0，原3 accepted Task/4 Execution及A两条completed均保持。
- 06:40:28.909Z A 控制台 **session 17068** 成功 `prepare`；version2/fireAt=null/phase=prepared/taskID=null，ledger 无 .claim，250ms 只读等待原 Worker 开放。Worker **session 76974**、PID **996/26240**、API **58866**、peer **60127**、engine **51469** 保持；夹具尚未 release。
- 06:40:30.859Z gate 仍关闭、B 原受信通道在线、无新 Worker Task。**B 尚未 prepare，物理竞争/执行尚未开始。** 原3条accepted和两正式桌面不动，无产品/OpenCode/网络设置修改。

**现在给用户的唯一命令（在 5.20 当前 v2 助手中输入）**：`prepare 2ebbcc36-c079-4c84-ad4e-a6d9cf6a579f`。请其发 RACE_PREPARED 整行并保持窗口打开；无时间限制，不能用旧 arm/submit，也不要重新配对或重装。

收到 B 精确 UUID/role B/Node Ytmgnp/Brain 024a07 的准备回执后，先核对 A 仍 prepared、门闩关闭、无新增 Task；启动只读实际争用观察，再通过 **报告中的 restoreBody** 恢复原配置一次，观察两方权威 Task、Worker 一执行一排队/唯一新 session，之后才 release 模型及按所属 Master 验收。

**不可提前重新启用 Worker**（会触发已准备的 A）；也不要在 gate 关闭时关闭/重启 Worker（现有恢复预检要求 enabled 配置）。如要放弃本轮，先核对/取消双方尚未提交意图，再恢复原配置；若任何一端已提交则先查实际 Task，不自动取消/重试。当前保留状态是有意暂停接单，不是掉线。M3.4 尚未验收，mDNS 专项92/93仍单列待查。

## 前一停点（2026-09-03 06:31Z）：原 Worker 已恢复，等 5.20 原助手目录覆盖 v2

用户指出正常客户端能够互相发现。复查 5.33 确实看到 5.20 且受信通道正常；此前 92/93 中失败项禁用 UDP fallback、只测 mDNS，不能把它说成正常产品发现失效。解释保留专项待查、继续物理单槽竞争后，用户明确“好的你继续”。**当前继续物理验收，mDNS 原失败仍未修复、全量不宣称全绿。** 不改正式客户端、产品或网络配置。

- 06:21–06:24Z 原 Worker helper/service **11212/39764** 均不存在（ESRCH），旧 API 64758 拒绝连接；app.lock 仍指向 39764，退出原因未知。复核原 3 Project/3 accepted Task/3 官方 session/4 Execution/6 信任完整，再次检查 PID 不存在后，仅把原锁改名为 `worker/app.lock.stale-20260903-1423`，保留可恢复证据，未删数据。
- 06:24:34.007Z 既有完整恢复预检通过。06:24:49.505Z 同根同 Node **t9MUCFG44Q3nM4txwjG3UPI7mbwePMsM** 启动：**Worker 交互 session 76974，helper/service PID 996/26240，API http://127.0.0.1:58866，peer 60127，engine 51469**。目录仍 `.data/m34-physical/a4530002-0690-40f6-a232-b632fefc5148`，不要默认新建或使用旧 session 67853/PID/端口。
- 恢复后第一段检查在 `assert(ready(n))` 失败、观察进程 77439 退出 1；该临时脚本未在异常前输出具体 peer/时间，不能定位哪条连接，也不能宣称第一段 90 秒通过。06:28:40.932Z 即时复查三条连接/两个 Master 都就绪。没有重启、改变阈值或产品规避。
- 随后进行带状态变化记录的只读观察 **06:29:28.575Z–06:30:58.650Z：90,074 ms、333 次、未就绪 0 次、API 错误 0、最大资源年龄 5,013 ms**。Worker 到 A、新 B、原 5.20 桌面三条通道，两个独立 Brain 在线，A 所见原 Worker/单槽全部正常。不能据此声称初次短暂变化或原 mDNS 专项根因已修复。
- **06:31:40.081Z** 全量原历史/会话/6 信任/执行策略再检一致，A 原任务保留；Worker 模型请求 **0**、槽位 **1**，夹具未 release。policy 仍原 enabled=true/Project c4227a2e/model fixture/m34/ask/maxConcurrent=1，**尚未关闭门闩、prepare 或创建新物理 Task**。
- A 测试控制台已只读附着原桌面：**session 17068**。06:28:04.920Z race-status 只有昨日 cancelled 的 2b08e84d、task=null，无定时/prepare；桌面未停止。Worker session 76974 和 A 控制台保持运行，其余本轮观察进程已退出。

**下一步只需用户更新 5.20 测试助手，不重装 Rivloom、不重新配对：** 当前助手输入 `stop`，等 CLEANUP；将 `.data/distribution/Rivloom_M3.4_Master_Helper_0.1.3_race-v2.zip`（复核 20,017 字节、严格 8 文件、无 .data）复制过去，解压覆盖 **`C:\Users\x\Desktop\Rivloom_M3.4_Master_Helper_0.1.3_race-v1`** 的代码，保留原 `.data`，不另建 race-v2 文件夹；双击该原目录 start-master.cmd，发 STATUS。预期仍 Node Ytmgnp/Brain 024a07、raceHelperVersion=2。未收到更新回执前，不发 prepare/submit/旧 arm。

收到 B STATUS 后再核对同一身份、通道和无遗留 Task，才通过 Worker 正常 API 关闭执行能力、两端 prepare 相同新 UUID、恢复精确原配置放行，验证真实单槽竞争与原队列继续。证据 `.data/verification/m34-physical-worker-resume-20260903.json`；M3.4 仍未完成。下方均为历史停点。

## 历史停点：免人工时刻助手 v2 已验证，mDNS 回归重复失败处暂停

**15:16Z：第二次 arm 因人工回复延迟而过期，未创建 Task。** dbc4738a 目标 14:42:44.641Z，错误反馈后本机已 14:58Z；时间校验在 ledger/POST 前，A 从未 arm。14:58:23.557Z 旧历史无变化。不得重用旧 UUID/时刻，不再用固定 UTC 人工协调。

[v2 方案](plans/2026-09-02-m34-prepared-race-helper.md)：协调者先通过正常本机 API 关闭隔离 Worker 执行能力；两端 `prepare <同一新 UUID>` 只持久化意图并监听真实资源，无 Task/model/时间窗口；双方确认后恢复 Worker 原 Project/model/ask/单槽配置，两边自动提交一次。无空闲 Worker 时产品创建接口返回 409，不能把准备说成“先建排队 Task”。忙槽记 missed，HTTP 不确定记 uncertain，不追发，不伪造资源/业务状态，不改产品或 OpenCode。

- **25 项定向通过**，TypeScript/格式/diff 检查通过。两次同机完整服务各 **12 项通过**：f36827cf（90,407 ms/168 样本），最终源码 56791fbf（90,382 ms/168 样本、最大报告年龄 5,028 ms）；准备无 Task/session/model，开放后各一次提交、单槽 running/queued、review 占槽、正常 Master 恢复/原队列继续，最终 3 accepted/3 session/0 tool。不是物理双机验收。
- **本轮全量不是通过：92/93，0 跳过，72,384.0957 ms。** 原有 `two isolated Rivloom instances discover and cryptographically verify each other`（只开 mDNS，禁用 UDP fallback）20 秒内没有双方 verified；单独复查同样失败（21,578.4743 ms）。原因未定位，不能称由同时运行测试导致或已经修复，不能以历史 82/82 覆盖。未改测试阈值/网络/防火墙/产品。按 executing-plans 重复失败停点暂停新的物理操作，向用户报告并请求是否先排查发现问题，不循环重试。
- 新包 `.data/distribution/Rivloom_M3.4_Master_Helper_0.1.3_race-v2.zip`，**20,017 字节 / 严格 8 文件**，无 `.data`/身份/凭据/DB/二进制，旧包保留。**尚未更新远端**。后续更新时 B 输入 stop 等 CLEANUP，解压覆盖 **`C:\Users\x\Desktop\Rivloom_M3.4_Master_Helper_0.1.3_race-v1`** 的代码，保留 .data，不另建 race-v2 文件夹，再开原 start-master.cmd；应仍 Ytmgnp/024a07 且 raceHelperVersion=2，先发 STATUS，不 prepare。
- 本机原烟雾目录覆盖代码后，15:13:44.318Z 仍 e8n8VI/Brain 3c0057、v2、0 Task/model，race-status=[]，正常 CLEANUP/CMD 退出 0。旧 A 测试控制台 session 97010 正常停止，**现在没有 A 控制台**，正式桌面未停止。两轮完整服务、全量/单测、烟雾自有进程均已结束。
- **原物理现场保留**：15:15:49.478Z API/官方 session 检查原 3 Project/3 accepted Task/3 session/4 Execution 与归属完全一致，A 两条 completed，A/B 到 Worker 都 online/trusted/channelReady，A 见 Worker 通道就绪。policy 仍 enabled=true/Project c4227a2e/model fixture/m34/ask/maxConcurrent=1，更新时间仍 03:29:10.891Z；本轮未改物理 gate。15:16:33.363Z Worker session **67853**、helper/service **11212/39764**、API **64758**、peer **54356**、engine **51071**，槽位 1、模型 **0**、夹具未 release。B 最后确认仍 v1/原 race-v1 数据根，不新建身份、不重新配对。

汇总 `.data/verification/m34-prepared-race-helper-preparation.json`。M3.4 未标记 MVP 完成；ADR/产品边界未改。

### 以下为历史检查点（已被上方取代；勿重复旧 arm、配对、安装指令）

**最新停点（14:34Z）：B 已确认无旧安排，新一轮改为先等 B arm 回执。** 用户 14:32:46.504Z `RACE_STATUS role=B, races=[]`，上一轮 `2b08e84d` 可结为未执行的协调取消，不能记为竞争通过。14:33:44.475Z 两本机 API/官方会话再检通过：原 3 accepted Task/3 session/4 Execution、A 两条 completed、槽位 1、两 Master 通道均正常；14:34:42.563Z A 控制台确认旧 ledger cancelled/task=null。

新 UUID **dbc4738a-9b02-4292-ba22-202078d97ce7**，目标 UTC **2026-09-02T14:42:44.641Z**。最终回复直接给用户 5.20 B 的 arm 命令，让其立即执行并发 RACE_ARMED。**A 尚未 arm**；收到 B 精确 UUID/身份/时刻的回执且时间仍有效后，再通过 A 控制台 session 97010 安排同一时刻。若到时已触发或过期，先检查实际 Task，不补发或复用旧 UUID。报告 `m34-physical-race-dbc4738a.json`；原 Worker session 67853/夹具未 release，数据和正式客户端都保持。

**当前最终停点（14:21:48.573Z）：本轮 A 定时已取消，需用户读取 B 的 race-status；不得复用本轮 UUID/旧时刻。** 至触发前未收到 B 的 RACE_ARMED，A 已在 14:21:02.983Z（目标 14:21:18.535Z 前）执行 race-cancel，ledger phase=cancelled/dispatchedAt=null/taskID=null。已告知用户若 B 曾 arm 就取消未触发定时，若已触发则只回传状态、不重试。实际 B ledger 尚未读取，不能断言它未 arm 或没有 queued Task。

只读观察 14:20:13.808Z–14:21:48.573Z 共 178 次：A 无新 Task，Worker 无新邀请/业务 Task/官方 session，保持原 3 Task/3 session、槽位 1，两条 Master 通道始终正常。观察进程 session 78889 已退出 0；完整报告 `m34-physical-race-2b08e84d.json`，本轮不计竞争通过、不自动重发。下一步请用户在 5.20 当前助手只输入 `race-status` 并发输出；核对无遗留安排/任务后再用新 UUID 约新时刻。Worker session 67853、新模型计数 0/未 release；A 控制台 session 97010 仍开但无活动计时器，两正式客户端不动。

**最新待触发检查点：A 已 arm，等 B 的 RACE_ARMED。** 原 Worker 重启后的 90 秒检查 **14:14:13.505Z–14:15:43.516Z，90,011 ms / 87 次 / 18 次资源刷新，最大资源年龄 4,957 ms，全部通过**：A、新 B、原 5.20 桌面三条 Worker 通道、A 所见 Worker、两个正式 Brain 共享原 Worker、槽位 1、原身份/6 条信任/3 Project/3 accepted Task/3 session/4 Execution 均保持。14:16:33.371Z Worker 新夹具请求仍 0，尚未 release。

物理争用 UUID `2b08e84d-1a63-4f1c-953a-8ace7aa55c81`，目标 UTC **2026-09-02T14:21:18.535Z**。A 控制台 session 97010 已于 14:16:32.241Z arm；已请用户在 5.20 当前新 B 助手输入同一 arm 命令并回传 RACE_ARMED。尚未收到 B arm 回报、尚未创建新 Task。若 B 来不及/失败须在触发前取消 A 定时器并保留记录，不自动重试。Worker session 67853 新夹具暂缓响应，便于记录重叠需求和单槽准入；只在核对两端实际 Task/唯一业务 Task/session 后 release。后续必须继续核对原 Brain/Execution 归属，不根据同一时刻推断竞争通过。

**最新执行（14:12–14:13Z）：用户授权后原测试 Worker 正常停止并同身份恢复，A↔Worker 已重新连接，正在新一轮稳定检查。** 重启前 3 Project/3 accepted Task/3 官方 session/4 Execution/6 条信任元数据已记录；原 session 38378 正常 CLEANUP、退出 0、锁自然释放，14:12:32.380Z 只读预检全量一致。14:13:06.419Z 原数据根和 t9MUCF 恢复：**新 Worker session 67853、helper/service PID 11212/39764，API 64758、peer 54356、engine 51071**。A 和新 B 通道就绪，两正式客户端未停止，原记录不变。新夹具生命周期模型请求 0、尚未 release；旧生命周期累计 2 单列保留。不能继续使用旧 session 38378/PID/API，也不能以连接恢复宣称根因修复。

90 秒真实通道/资源/历史不变检查运行中（检查进程 session 71642），尚未报告结果。A 端附着控制台 **session 97010** 已只读启动并确认原 tRCQ1_/Brain 0ed79c，未提交任务。证据 `.data/verification/m34-physical-worker-discovery-restart.json`；继续先等稳定检查，通过后才安排同 UUID/UTC，当前未 arm。

**最新停点（14:04–14:08Z）：新 B 配对完成，待确认是否重启本机测试 Worker。** 用户新码与 pairing `85af9af3-589b-4999-a1f6-24d364665b09` 匹配，精确新 Node/Brain 在线、对端已确认且未过期后，14:04:51.380Z 仅确认 Worker 一侧。14:04:54.157Z 新 B trusted/channelReady、Brain 024a07 established/online，Worker 已注册到该 Brain、槽位 1、无待配对；旧 3 accepted Task/session 保留。14:08:01.852Z 原 Worker status 模型累计仍 2、无新 Task，session 38378 仍运行。

本机 A↔Worker 仍互不可见。获准正常上下文 6 秒只读 mDNS 查询（不发布服务）只收到 5.20 的 Ytmgnp/As64SU，未收到本机两实例；临时查询 socket 已关闭。端口/路由/网卡元数据已读取，不能据共享 UDP 端口枚举或网卡优先级断言根因。未改网络/防火墙/服务代码。已向用户申请正常停止并从原数据目录恢复一次 **5.33 测试 Worker t9MUCF**，不动正式桌面、身份/信任/已验收记录；用户回复“测试 Worke”含义不明确，已解释它是隔离验收节点，**尚未取得明确重启确认，也没有重启**。等待确认，不 arm/发 Task。原目录仍 `.data/m34-physical/a4530002-0690-40f6-a232-b632fefc5148`，恢复必须带原 Node ID，不能运行默认新建模式。

**最新停点（13:51Z）：新 B 同身份重新启动成功，等待新的配对短码。** 用户 STATUS `13:51:12.699Z` 为 0.1.3/raceHelperVersion=1，仍是 Ytmgnp/Brain 024a07、原 race-v1 数据根 `51024c87-7c0a-40fc-b316-ff87a2e37b73`，helper/service PID 更新为 3852/2628、5.20 本机 API 58225、peer 56585；Task 0、本机模型请求 0，Worker 在线未信任。13:51:35.700Z Worker 认证 API 确认该新端口/原 Node 在线，旧配对已清空；原 Worker 3 accepted Task/原官方 session、槽位 1，A 两条旧权威 Task completed。A↔Worker 仍互不可见。已请用户在当前助手窗口输入 pair 回传新短码，并保持窗口打开；不重复启动，不 submit/arm。仅据 STATUS 确认新身份恢复，没有独立核对远端锁备份文件；旧 cS1v1p/b1292e 仍只保留历史证据。以下为历史恢复步骤，勿再次移动锁。

**最新用户确认（13:48Z）：后台助手已由用户关闭，无需再要求进程检查。** 依据用户确认和此前原 peer 拒绝连接，下一步仅指导在 5.20 新 race-v1 数据根 `51024c87-7c0a-40fc-b316-ff87a2e37b73` 内将 `app.lock` 重命名为 `app.lock.stale-20260902-2148`，保留该文件及所有身份/任务数据，再从同一 race-v1 根目录启动 `start-master.cmd` 并回传 STATUS。这是给用户的待执行步骤，本机未移动远端文件，尚未确认恢复。旧配对 306914 已超过 13:33:53.564Z 有效期，不复用；恢复后先核对 Ytmgnp/Brain 024a07，再重新核对配对。未改产品或助手代码，A↔Worker 可见性问题仍待处理，不 arm/发 Task。

用户随后确认原先输入 pair 的助手窗口已经不在。下一步请用户在 **5.20** 用 PowerShell 只读读取新 race-v1 数据根 `51024c87-7c0a-40fc-b316-ff87a2e37b73/app.lock` 的 pid，并查询该 PID 和上一 helper PID 6848；查询出错不能当作进程不存在。未取得进程证据前不删除/移动锁、不再次启动或配对。源码确认 helper 第 61 行仅检查 app.lock 是否存在，尚未进入服务端锁恢复逻辑，因此报错本身不证明活进程。当前没有产品/助手代码修复。

**最新停点（13:30–13:31Z）：新助手启动报 app.lock 已存在，配对尚未确认。** 用户先发来新 B 的配对码，随后报告 `This helper is already running`。13:30:04.868Z Worker 上匹配该码的 incoming pairing 为 `63e6d1ec-0d50-4a16-bfb7-98851360750d`、对端已确认/本端未确认、到期 13:33:53.564Z，但新 B 已不在 nearby。13:31:15.784Z 获准正常用户上下文只读探测：5.20 原 helper peer 63344 为 ECONNREFUSED，原正式桌面 peer 59725 为 HTTP 200/As64SU 原身份，后者通道正常。初次受限进程 EACCES 不作为远端故障依据。尚未知道远端旧 helper/service 进程是否存在；该断言只证明有锁文件，不能直接认定重复进程或擅自删锁。先问用户原来能输入 pair 的助手窗口是否仍在，存在则读 status，否则先核对精确进程/锁所有者再恢复。未确认配对、未 arm/发 Task/重启/删数据；配对过期后不得复用旧请求。证据 `m34-physical-new-brain-checkpoint.json`。

用户确认旧助手目录无法从回收站找回，并明确授权“用新的来吧”。余下物理竞争改用已自动形成的 5.20 Node `YtmgnpZtwNcSWpdPvAWuhf3IREFuNfEt` / Brain `024a0766-64db-4419-a4cc-7b0d53688927`，保留 race-v1 目录现有 .data，不再要求恢复旧助手或重装正式客户端。旧 cS1v1p/b1292e 的历史验收证据和 Worker 记录保留，不迁移 Task，不将新身份续测写成旧身份恢复。

13:14:19.080Z / 13:14:38.923Z 只读核对：新 B 在 5.20:63344 在线、未信任、无待配对；原 Worker 仍 3 accepted Task/原 session、槽位 1、模型请求累计 2，A 的两条权威 Task 均 completed。但本机 A 与 Worker 此时互不在 nearby 列表，二者与 5.20 原桌面的通道仍正常；不能继续沿用之前 A↔Worker 通道就绪的判断。已让用户在新助手输入 pair 并回传短码，同时只读检查 A↔Worker。未确认新配对、未 arm 或创建新 Task；双 Brain 竞争须等通道恢复后再进行。

13:17–13:18Z 补查：双方 trusted-nodes 仍包含对方；原 peer 53946/64916 在 LAN/loopback 均 TCP 可达，LAN /v1/hello 返回 200 和原 Node ID。故当前不是服务退出或已证实的信任删除，根因仍未确认。受限诊断进程的 3 秒 UDP 广播无回复、单播只见 A，不能直接等同安装进程的网络行为；系统网络 cmdlet 在受限上下文拒绝访问，未修改系统设置或重启服务。证据 `.data/verification/m34-physical-new-brain-checkpoint.json`。等待用户新助手 PAIRING 短码；A↔Worker 不重新配对，不 arm。

以下为此前检查点，恢复旧目录的要求已由上述用户选择取代。

**最新用户反馈：旧 5.20 测试助手文件夹被误删。** 原 cS1v1p/b1292e 的身份和权威 Task 数据在该文件夹的 .data；不能仅靠既有 Node/Brain ID 或 Worker 的结果记录重建同一 Master。暂停新身份配对和 arm，先让用户检查 5.20 回收站是否能恢复原 `Rivloom_M3.4_Master_Helper_0.1.3` 及其 .data。未实际检查回收站，不能断言永久丢失；也不要求重装正式客户端。若不能恢复，需用户确认是否保留旧验收证据、用新独立 Brain 继续余下竞争测试，不能迁移/伪造原 Brain 的 Task 或声称保留身份更新成功。之前已经完成的同身份恢复事实仍是历史有效证据。

**最新远端检查（13:02–13:05Z）**：用户已运行 raceHelperVersion=1，但将 zip 解压到新的 `Desktop\Rivloom_M3.4_Master_Helper_0.1.3_race-v1`，生成 Node `YtmgnpZtwNcSWpdPvAWuhf3IREFuNfEt` / Brain `024a0766-64db-4419-a4cc-7b0d53688927`，不是原 cS1v1p/b1292e。Worker 实查新 Node 在 peer 63344 在线但未信任/未配对，原 Brain B 离线，原 3 accepted Task/session 和槽位 1 保留。没有接纳新身份、没有 arm 或提交。已明确让用户 stop 新助手，把**同一个新版 zip 解压覆盖原 `Desktop\Rivloom_M3.4_Master_Helper_0.1.3` 目录的代码**，保留旧 .data，禁止用新目录的 .data 覆盖旧数据，再从旧目录启动并回传 STATUS。若旧目录/数据不存在应停下核对，不能默认创建替代身份；当前未独立读取远端旧目录，不能宣称旧数据被删除。

用户已要求继续准备并测试同步竞争。新增仅测试用 `scripts/m34-race.ts`（一次性 UUID + UTC 定时提交、持久化 claim、防重复/迟到/不确定结果不重试、精确验收），接入 B 助手和 `scripts/m34-physical-race-local.ts` 的 A 端只读附着控制台。没有产品/runtime/OpenCode 变更，也不增加监听端口、改时钟/信任/资源报告。**14 项定向、全量 82/82、TypeScript/格式通过**；opt-in 同机完整服务 11 项通过（90,068 ms / 166 次稳定采样、实际定时竞争、排队 Master 恢复和原队列继续）。完整证据 `.data/verification/m34-physical-race-helper-preparation.json`，方案 [物理竞争助手](plans/2026-09-02-m34-physical-race-helper.md)。

新包 `.data/distribution/Rivloom_M3.4_Master_Helper_0.1.3_race-v1.zip`，18,870 字节，严格 8 个代码/说明文件，无 `.data`/身份/凭据/数据库。正确更新后应仍为 cS1v1p / Brain b1292e、原 B Task 8923109f completed，新增 raceHelperVersion=1；不要让原客户端停机或重装。已收到的远端 STATUS 是上节的新目录/新身份，尚不能确认保留原身份的更新，不先给过期的 arm 时刻。旧 package 保留。

A 端可使用安装 Node 运行 `scripts/m34-physical-race-local.ts`，必须用可交互 stdin（工具 tty=true），只连接原 tRCQ1_/Brain 0ed79c；其只读启动/race-status/stop 已通过，当前没有保留 A 控制台会话。B 助手 v1 原 submit/accept 仍只处理原单条任务；race 命令为 `arm <UUID> <规范 UTC>`、`race-status`、`race-cancel <UUID>`、`race-accept <UUID>`，不要重复 submit 当作新竞争 Task。约定未来 5 秒至 10 分钟，只触发一次；首次应留数分钟让用户 arm。必须检查真实竞争状态，时间一致不代表通过；missed/uncertain 保留证据不自动补发。

12:58:49.652Z 原 Worker session 38378 / PID 39992、25020 仍为 3 accepted Task/原 session、3 Project/4 Execution、空闲槽 1、夹具已释放/本次请求 2，无新物理竞争 Task。所有本轮同机临时服务和烟雾控制台已停止。最初沙箱不能用 DPAPI，74/82 和完整服务失败报告保留；获准在正常用户上下文运行后 82/82 和完整服务通过，未绕过身份保护。CMD 烟雾发现启动前消费管道输入的问题已仅在助手修复；曾只停止空白本机烟雾 PID 29704，确认子服务不在后把其残留锁移动为可恢复证据，原身份无变化，随后实际 CMD 正常退出通过。该烟雾 e8n8VI/Brain 3c0057 不是 5.20 身份。

**物理同时竞争尚未执行，M3.4 未标记 MVP 完成。** 当前先核对误删目录是否可恢复；恢复后取得原 B STATUS，或由用户明确同意新身份续测后再安排两端 UUID/UTC。不要停止或重新创建原 Worker。

### 前一检查点：Master B 同身份恢复与 Project 任务验收通过

用户 12:22:11.852Z 在 5.20 原测试助手执行 offline（online=false、apiURL=null）；其 tasks=[] 是服务关闭后不查询任务的占位值，不是任务删除。12:24:00.678Z 原 Worker/API 确认 Brain B 离线、原 Master cS1v1p 不变，Brain A 与两个原客户端在线可信，Worker 无自有 Brain、槽位 1。没有接管 B 的 Task，也没有选举或新建 Brain。

12:25:20.041Z 经 5.33 Brain A 提交一次限定原授权 Project `c4227a2e-f93c-4514-ad67-f42c65fa749c` 的纯文字 Task `0119d3eb-3cc1-47cc-9a3d-224943ae7316` / Execution `478658f7-04b7-4ed6-9e1d-540121885bb9`。12:25:23.171Z Master/Worker 均 review/序号 3、槽位 0，业务 Task `455eefc8-44bf-4bc3-8f6e-ba44d8c4d875` / session `ses_f9deb4729ffejtK9Y451ujwmL7`，实际目录精确为原 Worker 的 `worker/authorized-folder`，未新建 Project；0 工具调用、目录仍空、只有一份新业务 Task/session。Brain B 持续离线，旧 Task/Execution 归属和状态保留。报告 `.data/verification/m34-physical-master-offline-project-0119d3eb.json`。

用户 12:31:12.566Z 已在原助手 online：Node cS1v1p、Brain b1292e、原数据根、B Task 8923109f / Execution 818ffb44 completed/序号 4 全保留，本机模型调用 0；helper PID 7412、**新 service PID 9824、5.20 loopback API 61533、peer 59845**。启动即时 channelReady=false，12:31:46.700Z Worker 已见同一受信 peer 通道恢复，无需重新配对；不据两个不同机器的采样计算精确恢复耗时。

12:32:43.641Z–12:33:04.292Z，20,651 ms / 21 次 / 6 次资源更新（Master A 所见报告最大年龄 4,913 ms）全部通过：B 正式在线、Master 归属不变，原通道均就绪，Project Task 始终 review/序号 3、槽位 0，旧记录及 3 个官方 session 未变。随后仅通过 owning Master A 验收 Project Task，12:33:59.470Z Master completed、Worker accepted/序号 4，槽位恢复 1，无待回传/控制/错误；工具调用仍 0、原文件夹仍空。12:34:19.497Z Worker helper 请求仍为 2。

当前原 Worker session 38378 / PID 39992、25020 与两个 Master/原桌面均继续运行，夹具已 release、累计请求 2；3 Project、3 accepted 业务 Task/官方 session、4 Execution（含原失败未绑定记录）。本项正常停止/同身份恢复及原 Project 执行闭环通过；**物理双 Brain 重叠分配/单槽竞争仍待验证**，不能用顺序提交或旧同机报告替代。后续先准备可控协调方式；现有远端助手 submit 只保留一条旧 Task，不支持直接再次创建竞争任务。此项 A/Worker 均在 5.33，不冒称另一条跨机任务、异常断网或已排队任务恢复通过。只更新验收记录，没有改产品/测试源码、不需重装。

### 前一检查点：Brain B 跨机 Task 完整闭环通过

12:06–12:17Z，5.20 Brain B 实际提交 Task `8923109f-6064-42fc-8276-72ba20821b3e` / Execution `818ffb44-163d-4161-92d8-9267c0a85192`，由 5.33 原 Worker t9MUCF 执行。仅新增业务 Task `73a95c90-3053-4dcf-8e39-706bdf99768c`、官方 session `ses_f9dfc2d61ffeHD55NRsJsKCiyb` 和一次本机夹具模型请求；没有工具调用，Portable 目录为空。释放回复后进入 review/序号 3，槽位仍为 0；用户按指引输入 `accept`，12:13:48.766Z Worker 已 accepted/序号 4、无待回传或错误，Worker 与 Master A 目录槽位均恢复 1。Master A 不持有该 B Task，原已验收 Task/session 保留。远端用户 12:16:56.146Z 的最终 STATUS 已确认同一 Brain/Task/Execution 为 completed/序号 4、模型调用 0；跨机文字任务闭环通过，不再重复 accept/submit。报告 `.data/verification/m34-physical-brain-b-task-8923109f.json`。

该检查点之后已执行 offline、Project 任务和同身份 online，进展以上节为准。只覆盖正常停止边界，不冒称异常断网或带副作用执行中故障通过。

该检查点 Worker 为下述 session 38378 / PID 39992、25020，夹具已 release、当时本次请求 1；之后的新模型请求会立即回复，不能继续假设暂停。当时为 3 个 Project、2 个 accepted 业务 Task/官方 session、3 条远端 Execution（包括原失败未绑定记录），当前计数以上节为准。没有改产品或测试代码、不需重装。此轮只验证一条真正跨物理机的 Brain B Task，不是两个 Brain 同时竞争，不标记 M3.4 MVP 完成。

### 前一检查点：配对与目录稳定（11:22–11:25Z）

5.20 新 Master 为 Node `cS1v1puDjyxtdOvAjPeWZdLZljoapnCF` / Brain `b1292ebb-990a-48c0-8e6b-88b9adbe24b8`，peer `192.168.5.20:59263`。用户短码与原 Worker 上的 incoming 配对一致，11:22:18.740Z 仅确认该 Worker 侧，受信/加密通道建立。用户 11:23:32.864Z 的 STATUS 证实新 Master 运行 0.1.3、Worker 可信就绪、Task 0、模型请求 0；远端助手 PID 7412、服务 PID 476、本机 API 56092（这是 5.20 的 loopback，不能在 5.33 上直接调用）。

11:23:42.574Z–11:25:13.570Z 两物理 Master 的 Worker 侧认证目录和 Master A API 稳定检查通过：90,993 ms / 88 次采样 / 19 次资源更新，最大 Master A 报告年龄 4,990 ms。Worker 同时登记两个正式 Brain，无自有 Brain；两个 Master 未直接配对，原 completed Task/accepted 业务 Task/一个官方 session 保持，槽位 1；11:25:38.946Z Worker 模型调用仍 0。报告 `.data/verification/m34-physical-dual-brain-directory.json`。当时尚未提交新 Brain 的 Task；此后执行见上节，不把目录稳定当作竞争/MVP 验收。

用户报告两台升级后已打开；10:56:22Z 验证 5.33 实际安装为 0.1.3，原 Node tRCQ1_ / Brain 0ed79c、Task 45b70f73 completed 均保留，5.20 的原 Node As64SU 仍受信且通道就绪（远端版本依用户安装反馈，未读取其 EXE）。只修改测试助手的恢复预检与验证脚本：13 项新增/全量 **68 项通过**，TypeScript 和格式检查通过，不改产品、不重打安装器。

原 Worker t9MUCF 已于 11:03:53Z 使用安装 0.1.3 同目录恢复；**当前 session 38378、助手 PID 39992、Worker PID 25020**，API `http://127.0.0.1:62388`，peer 53946、官方引擎 61627。恢复时两 Project、accepted 业务 Task/原官方 session、两条新旧 Execution 均保持，无重配对/重发；当时夹具未 release、调用 0，当前已经变化，以上节为准。90,090 ms / 87 次采样 / 19 次资源更新通过，最大报告年龄 4,928 ms；证据 `.data/verification/m34-physical-upgrade-0.1.3.json`。后续使用前重新读取 `.data/verification/m34-physical-worker.json` 核对身份和端口，不向旧 session 77892 发命令。

原两个桌面继续共用 Brain A，新增的 5.20 独立助手承载 Brain B。免安装包 `.data/distribution/Rivloom_M3.4_Master_Helper_0.1.3.zip`（13,488 字节）已由用户启动并完成上述配对；无需再运行一份。包内只有 7 个代码/说明文件，无身份或数据库。本机烟雾测试 e8n8VI / Brain 3c0057 已停止，不是远端身份。5.20 真实助手数据根为 `C:\Users\x\Desktop\Rivloom_M3.4_Master_Helper_0.1.3\.data\independent-master\361d6264-a313-471d-88e7-b8099341fddb`；后续从原文件夹启动保持身份。仍未标记物理双 Brain/M3.4 MVP 完成。

## 历史：升级前停止 5.33 测试 Worker

2026-09-02T10:49–10:51Z，用户明确授权后，原助手 session 77892 经 `stop` 返回 `CLEANUP stopped=true` 并以 0 退出，PID 41256/19256 已退出，旧安装目录关联进程为 0；保留原隔离根目录及 Node t9MUCF、两个 Project（授权文件夹与 Portable）、一个 accepted 业务 Task/官方 session、两条 Execution。累计模型请求仍为 1，无新任务、重发或删除。用户可继续安装 0.1.3，卸载旧程序时不勾选“删除应用程序数据”。**尚未重启原 Worker；其原“零 Task / 单 Project”预检不能直接用于已有完成任务，恢复时必须使用原目录且核对完整历史，不默认新建身份。** 后文运行中的原 session/PID 是历史检查点，不再发送命令到它。详细证据见 [物理验收记录](plans/m34-physical-acceptance.md) 末节及 `.data/verification/m34-physical-stop-before-0.1.3.json`。

## 仓库状态

- 本轮开始和最终核对的 `HEAD`、`origin/main` 都是 `f5ce9ed3fdf4ad69cfad2acfc13d9a04e7cf51c2`，分支 `main`。M3.4 核心实现目前是工作区变更，尚未创建提交；不要把基线提交误写成已包含本轮代码。
- 当前目录已初始化 Git；`main` 跟踪私有远程仓库 `https://github.com/rivloom/rivloom_desktop.git`。
- 远程原有的 Apache 2.0 `LICENSE` 初始提交和 `22eaa3c`（`feat: establish Rivloom desktop MVP`）均已保留；当前里程碑继续提交到 `main`，以 `git log` 的最新提交为准。
- 旧项目 `C:\project\opencohive` 只读参考过产品文档，没有复制其 Codex monorepo，也没有修改旧项目。
- `.gitignore` 已排除依赖、构建产物、运行数据、凭据和测试输出：`node_modules/`、`dist/`、`.data/`、`src-tauri/target/`、`src-tauri/resources/runtime/`、`.env*` 等。

后续提交应继续包含应用源代码、文档、锁文件和许可证资料；不要强制加入上述忽略目录。尤其不能提交 `.data`，其中包含本地账号、SQLite、引擎状态、测试仓库和运行证据。安装包属于可重建产物，也位于被忽略的 `src-tauri/target`。

## 已完成产品范围

1. **M0 真实任务闭环：完成。** 创建任务、接受、真实 AI 执行、SSE 流输出、编辑/命令逐次审批、补充要求、停止、OpenCode 会话差异、验收及重启恢复均已实现。
2. **M1 模型设置：完成。** 桌面端已有“模型与额度”页；用户已在本机保存 DeepSeek 官方 Key，并用 `deepseek/deepseek-v4-flash` 完成真实连接测试及无 `.git` 普通文件夹固定编程任务。编辑和指定测试命令经人工批准，独立测试为 1 通过、0 失败，测试文件未变，任务最终验收。操作审计和验证报告不保存 Key 或完整模型回复。
3. **M2 Windows 桌面交付：已有开发机内测包，发行完善暂缓。** Tauri 原生窗口、原生文件夹选择、随包 Node/OpenCode、随机 loopback 服务、进程生命周期、单实例和 NSIS 安装包已经验证；这不代表签名、干净机和升级矩阵已经完成。
4. **M3.1 节点身份与自发现：双向发现和正常退出通过。** 每个实例有 DPAPI 保护的稳定 Ed25519 身份；标准 `_rivloom._tcp.local` 与 LAN UDP 回退只产生候选地址，随后执行随机挑战签名校验。原包在 Win10 `192.168.5.18` 与 Win11 `192.168.5.20` 出现单向 mDNS，UDP 回退包已确认双向发现；签名退出通知的快速离线也由用户在原设备确认。异常结束进程或断网的 15/30 秒兜底仍待专项复测。
5. **M3.2 配对与加密 Brain 目录：自动化/Release 完成。** 配对闭环已通过用户的 Win10/Win11 物理双机。受信节点用签名临时 X25519、HKDF 和 AES-256-GCM 自动建立双向认证会话；伪造/重放握手、篡改/重放消息、过期、重启重建和撤销断链均已自动化验证，实际 Release WebView2 也已通过。
6. **M3.3 策略化跨节点执行：MVP 验收完成。** 设备信任、本机执行能力和 AI 操作审批已分层。受信任务自动接收，能力关闭时等待；开启后复用本机项目和模型。任务锁定“请求批准 / 帮我批准 / 允许任何操作”，经官方 OpenCode 会话权限接口执行。归属 Brain 收到单调状态和最小人工介入快照，并能通过认证加密通道批准/拒绝具体操作、回答 AI、停止、补充要求后继续同一会话、查看 OpenCode 官方差异并验收。控制绑定任务、唯一控制 ID 和执行序号并持久化去重，同一任务一次只处理一个控制；本机项目、模型、任务 ID、审批 metadata 或凭据不回传。用户已在 `192.168.5.20` 与 `192.168.5.33` 用真实 DeepSeek 完成文件生成、远程一次性批准、补充要求同会话续跑、本地核对和最终验收。停止、另外两种审批、撤销信任、两真人角色回归和防火墙体验延后优化，不阻塞 M3.4 讨论。
7. **桌面直接启动：已实现。** 首次打开不再创建“工作区”或询问显示名称、用户名、密码；Tauri 启动期随机令牌自动建立/恢复本机操作者，直接进入任务界面并开始发现。内部 Web 调试仍保留显式登录。
8. 独立账号、一次性邀请、发起/接受/审批/验收角色已由服务端协议测试验证。它是后续跨节点角色映射与业务权限基础。

架构仍保持单一执行引擎：官方、未修改的 OpenCode 1.18.25 和匹配 SDK。没有 fork OpenCode，没有自研 Agent 循环、上下文管理、模型调用或工具执行器，也没有提前建设多引擎框架。

M3.4 产品定义已于 2026-09-02 重新确认：Brain 是网络自动形成的逻辑 master/调度域；开启执行能力的 Node 自动成为所有受信可达 Brain 的共享 Worker。每个 Task 只属于一个 Brain，多个 Brain 当前不互相委派或共同管理 Task。Brain 选择候选 Worker，Node 根据本机 Project、模型、额度和全局并发最终准入。详细决策见 [ADR-0004](adr/0004-automatic-brain-masters-and-shared-workers.md)；ADR-0001 的旧默认 Brain 和跨 Brain 委派语义已经被取代。

M3.4 已实现独立 Brain 拓扑、旧 Brain 迁移、自动形成/撤回临时 Brain、正式 Brain 不合并、共享 Worker 加密目录、真实硬件/动态负载、Project/硬件/队列/槽位排序、Worker → Master → Worker 两跳 Task、独立 Execution 历史、全局原子准入与 Portable 普通目录。32 项回归通过；完整业务服务确认双 Brain 竞争只产生一个业务任务和一个官方 OpenCode 会话。pending 离线可安全重派，迟到接受会被拒绝；accepted 但结果未知保持等待，不允许按未启动任务取消。M3.4 尚未完成物理多机验收。

M3.3 又于 2026-09-01 修正：完成设备配对即建立任务发送信任，不再叠加逐任务接受或节点白名单；本机执行开关决定是否开始，AI 审批模式决定 OpenCode 工具是否询问。旧版 30 分钟准备记录和自动/有限/每项确认调用策略只作为迁移历史保留。实现边界见 [ADR-0002](adr/0002-configurable-node-invocation-policy.md) 和 [ADR-0003](adr/0003-trust-and-ai-approval.md)。

## 锁定运行时与安装产物

| 组件                   | 版本/状态                                        |
| ---------------------- | ------------------------------------------------ |
| Node.js                | 24.19.0，随桌面包提供                            |
| OpenCode Windows + SDK | 1.18.25，官方未修改版本                          |
| Tauri                  | Rust 依赖锁定为 2.11.5 系列，`Cargo.lock` 已保留 |
| npm                    | `package-lock.json` 已保留                       |

当前 M3.4 时差修复内测产物已于 2026-09-02 重建：

- 路径：`src-tauri/target/release/bundle/nsis/Rivloom_0.1.2_x64-setup.exe`
- 大小：71,051,274 字节；Release `Rivloom.exe` 为 10,266,624 字节，产品版本 0.1.2。
- 状态：未签名内测包；TypeScript、Vite、43/43 回归、Cargo fmt/clippy 和 NSIS 构建通过，随包代码含时差修复。用户已自行安装，本机实测运行 0.1.2；用户确认卸载时删除应用数据，因此不作为身份保持升级测试。本轮未另跑安装/卸载脚本。
- 旧 0.1.1 安装器仍保留（71,075,905 字节）；其 7 项全新安装/覆盖升级和安装元数据恢复结果只属历史基线。报告 `.data/verification/desktop-install.json` 不代表 0.1.2 安装通过。

旧 0.1.0 仅作 M3.3 升级基线，0.1.1 含本次发现的时差问题。下一次两台使用同一份 0.1.2，无需手动复制 `runtime/`。先确认正式桌面退出，再停止本轮测试助手释放旧 runtime，按 [升级与物理验收步骤](plans/m34-physical-acceptance.md) 安装到原目录、保留数据。开发机目录为原 `%LOCALAPPDATA%\Rivloom`；正式发行仍需代码签名和干净机矩阵。

客户安装 Rivloom 后不需要另装 OpenCode 或本产品所需的 Node。Rivloom 项目不要求 Git；项目自身需要的语言工具链和 WebView2 仍是环境前提。

## 最终验证基线

- 最终 Release 桌面程序真实闭环：11 项通过；模型 `opencode/mimo-v2.5-free`；任务 `46dd767c-ae19-401d-890a-e65ba5bfef59`；OpenCode 会话 `ses_fa4bf8155ffe1Iq2eD7Uzu9sz2`。新增项验证桌面本机令牌与无表单自动身份。
- 官方 OpenCode 模型设置接口：6 项通过。测试字符串经 `auth.set/remove` 和 `provider.list` 完成保存、刷新、重启恢复与移除；看到 3 个 DeepSeek 模型；没有发送模型请求。
- DeepSeek 普通文件夹真实任务：`deepseek/deepseek-v4-flash`，任务 `RV-001`，OpenCode 会话 `ses_fa2e2a5f4ffeFyQrlJVwILugr4`；目录无 `.git`，1 项测试通过、测试文件未变并完成验收。官方 `session.diff` 返回空数组，Rivloom 没有用文件快照或哈希兜底。
- Release Tauri WebView2 模型页面：5 项通过；验证无 Key 状态、密码输入、额度确认、默认模型与审计界面。
- 0.1.1 NSIS：7 项开发机隔离安装/覆盖升级检查通过，另确认原安装元数据完整恢复；测试没有使用用户 Key 或真实模型额度，不能替代物理多机验收。
- 0.1.2 时差修复：43/43 回归通过；Master 正负 5 秒、Worker 与其官方引擎保持同一本机时钟的两组随包完整服务测试各 8 项通过。一次错误注入导致的失败报告保留并已解释，详见 VERIFICATION。用户清空数据后本机新安装运行确认；身份保持覆盖升级和物理闭环尚未复验。
- M3 Release WebView2：上一完整报告 23 项通过；真实第二节点完成发现/配对、可信任务自动接收、能力关闭时不启动、发起方界面回答/拒绝/停止、真实 OpenCode 远程停止与一次性批准后继续、文件生成、有序状态、远端隐私边界、同项目并发拒绝及设备撤销。M3.3 上一阶段的 Release 又完成新增官方差异卡片、补充要求和验收的加密往返，随后免费模型 10 分钟无响应，未生成新的全组通过报告。
- 物理 M3.3：Win11 `192.168.5.20` 与当前开发机 `192.168.5.33` 的真实 DeepSeek 文件生成、请求批准、补充要求同一会话续跑、本地核对和远程验收由用户确认通过。
- 官方 OpenCode 权限接口：1.18.25 成功创建并读回三种会话权限规则，没有发送模型请求或读取凭据。
- 本地：TypeScript、Vite、32/32 项测试、Cargo fmt/clippy 通过。完整服务测试使用真实官方 OpenCode + 本机确定性模型，不消耗用户额度、不冒充真实 AI 编程。上一阶段生产依赖离线 audit 为 0 个已知漏洞，本轮未重新执行 audit。
- M3.4 最终 Release：三节点全互信拓扑 90 秒稳定检查通过；原生表单提交经自动选择的远端 Master 到共享 Worker，只产生一次 Execution/官方会话，状态回传并显示等待验收。两跳 Task `36e1b99b-6fcb-41a7-896c-697ea0072ac4`，详细 ID 与边界见 VERIFICATION。

机器报告位于被 Git 忽略的 `.data/verification`。它们用于本机核对，不应直接提交或公开：

- `desktop-integration.json`
- `desktop-ui.json` 与 `desktop-direct-start.png`
- `model-settings.json`
- `desktop-model-settings.json` 与 `desktop-model-settings.png`
- `deepseek-plain-folder.json`
- `desktop-install.json`
- `desktop-node-network.json`、`desktop-node-network.png` 与 `desktop-node-pairing.png`
- `m34-service.json` 与 `m34-desktop.json`（本轮本机模型夹具；原生 UI 操作另在 VERIFICATION 记录）

## 明确未完成

- 后续优化仍包括物理远程停止、“帮我批准 / 允许任何操作”、执行中撤销信任、异常进程结束/断网兜底和两位真人角色映射；这些不阻塞当前 MVP。
- 安装器没有可靠管理防火墙：`5.33` 的随包 `node.exe` 曾存在启用但 Action=Block 的 Private TCP/UDP 规则，手工改为 Allow 后发现恢复。后续优化需处理安装、升级、诊断和卸载，但当前先推进 M3.4 产品讨论。
- ChatGPT 登录。
- 干净 Windows 虚拟机的安装/升级/卸载矩阵、代码签名、自动更新和正式商业发行审查。
- 完整多租户权限、自研沙箱、陌生参与者安全边界、压力/灾难恢复和 DLP。

项目目录已经改为普通文件夹语义：不要求 Git、不自动初始化 Git、不建立文件快照或内容哈希。产物页仅展示 OpenCode 官方接口明确返回的会话差异；验收直接依据本地文件、执行记录和测试结果。

M3.4 核心、完整服务竞争和网络故障验证已完成。下一步按 [物理核心验收清单](plans/m34-physical-acceptance.md) 在至少两台真实 Windows 设备核对共享 Worker、硬件报告、单槽仲裁和 Master 停止边界，再由用户确认 MVP。人员身份、Master 高可用/脑裂和跨 Brain 共同任务继续延后；M3.3 后续优化不重新变成阻塞项。

## 运行状态与禁止事项

当前停点（2026-09-02，0.1.3，以本段为准）：用户授权“修复，端口肯定要大一点的”后，高位 HTTP 端口修复已完成。应用/节点/官方引擎包装器自动选择 49152–65535，最多 64 次处理绑定占用或系统保留，显式固定端口不悄悄更换、禁用端口被拒绝；原生 URL 也限制高位 loopback HTTP。UDP 发现、系统设置、Brain 规则和 OpenCode 二进制未变。**55 项 Node 测试、1 项原生测试、完整服务 11 项、TypeScript/Vite/Cargo 检查通过**；报告 `m34-fresh-brains-bd24ebd5-73b6-423c-860a-12a73b41ffa3.json` 包含 90.3 秒、18 个高端口、Master 同身份重启及原排队任务继续，3 个已验收 Task/官方会话、0 工具调用。新测试进程全部退出，旧失败报告保留。安装包 `src-tauri/target/release/bundle/nsis/Rivloom_0.1.3_x64-setup.exe` 已生成（71,083,411 字节；EXE 10,266,624 字节），未安装或运行新原生 UI 回归。详情见 [端口修复计划](plans/2026-09-02-m34-high-http-ports.md)。全部新完整服务验证在 5.33，物理双 Brain/MVP 验收仍未完成。07:53:35Z 原两桌面及原 Worker 仍运行 0.1.2，三条通道正常，Task 45b70f73 completed、原 Worker Task accepted/槽位 1；无需重发或重问已验收结果。原助手 session 77892、PID 41256/19256 此前保留，模型已 release、已有完成任务，原零任务恢复预检不可直接重用。升级由用户操作；先协调退出桌面和安全停止占用旧 runtime 的原测试 Worker，再保留身份/数据恢复，不能直接覆盖或默认新建身份。旧失败 Task 不改归属、不迁移。5.20 的额外隔离实例尚未启动，双 Brain 初始环境仍须按原本独立形成再相遇准备。

以下为历史检查点，配对、进程和下一步操作均以上段为准；完整过程保留在物理验收记录中。

当前停点（2026-09-02T06:35:41Z）：截图核对后两条配对均已完成，Worker 与新 5.20/5.33 均 trusted/channelReady，保留现有配对。新拓扑 90 秒检查在首轮失败：5.20 Brain `fb03a2d7-2aa6-482b-8668-c17ce30af08f` 持续 provisional，不能入调度候选；5.33 Brain established。安装代码将任意发现的 established 广告用于阻止自动正式化，未区分受信实际 Master 与 Worker 的历史登记；纯内存已复现该阻塞路径。本轮未改产品、真实拓扑或任务，没有提交新 Task。先处理自动形成边界，再继续执行验收；不要重复配对/重装，也不要将旧 90 秒或刚才配对成功扩大为新拓扑通过。下方配对等待均是历史状态，详见物理记录末节。

当前配对停点（2026-09-02T06:31:03Z）：用户反馈号码/状态不符。只读检查两台都已更换新请求 ID、客户端一侧确认而 Worker 未确认；5.33 两端信任记录在 `06:29:27Z` 已撤销，当前也未受信。具体原因尚不确认，助手本轮未做配对写操作。暂停确认/重发，等待用户提供 5.20 配对卡片截图；下方“5.33 已成功”仅为此前时刻，不代表当前状态。

配对最新更新（2026-09-02T06:29:09Z）：上轮请求过期后，用户已从两台正式客户端重新发起并确认自身一侧。5.33 的配对 ID/两侧验证码经本机认证接口核对一致，已补确认 Worker 一侧，加密通道就绪；5.20 仍等用户比较新验证码后再补确认 Worker。不要重新配对 5.33、不重复新建请求、暂不发任务。下方为本轮恢复检查点，运行助手及数据目录未变。

最新停点（2026-09-02T06:21:41Z 后）：用户确认卸载时勾选“删除应用数据”，两个正式客户端按新身份重新验收，不算覆盖升级丢数据。5.33 为 `tRCQ1_OopLOZTbZpU-vnFboWPwj69ob7` / Brain `0ed79cba-4ed8-4373-ad3f-1dfc4a695800`，5.20 为 `As64SUH5wlu5deeBDPuHLsE47DWempcQ`。测试助手已增加有边界的同目录恢复并通过检查；原 Worker `t9MUCFG44Q3nM4txwjG3UPI7mbwePMsM` 使用安装的 0.1.2 运行，原 Project/旧 Execution 保留，业务 Task 0、模型调用 0、空闲槽位 1。助手 PID 41256、Worker PID 19256（后续须重新核对），交互 session 77892。已分别发起新配对并仅确认 Worker 一侧，等待用户在两台真实客户端比较验证码后确认；先不发任务。旧 Task A 不迁移或续测，两个旧 Brain 离线记录和信任保留。详情见物理验收记录末节。

历史停点（2026-09-02T05:00:47Z 后）：两个 Master 离线后，仅对物理助手发送 `stop`，原 PID 37244/23780 退出，原隔离数据保留。下方旧身份及运行状态均为此前检查点；当前进程与配对状态以上方最新停点为准，不应再次尝试停止旧 PID。

- 用户要求关闭的内部 Web 调试服务 `127.0.0.1:4310` 保持关闭。用户两台客户端和隔离 Worker `Rivloom t9MUCF`（Node `t9MUCFG44Q3nM4txwjG3UPI7mbwePMsM`）仍保留现场；Worker 已与真实 5.20/5.33 配对并注册给两个 Brain，92.7 秒、91 次目录/通道/共享空闲槽位采样通过。用户随后提交的物理 Task A（Task `7f0da3b1`、Execution `44b41f60`）到达 Worker，但 Master 拒绝接受回执，卡片仍为第 1 次尝试/序号 0。没有本机业务 Task/执行会话，模型请求 0 次、空闲槽位 1。暂停后续执行验收，不取消、重发、修改真实记录或释放模型回复。详见 [物理验收运行记录](plans/m34-physical-acceptance.md)。不要按此前“测试进程已停止”的历史说明关闭这些实例；只对测试助手发送 `stop` 清理其自有进程。
- 本机 OpenCode Go 已过期，不再使用或自动导入。
- 时差修复：0.1.1 严格拒绝 `decidedAt < createdAt`，实测 5.20 至少领先约 43–47 ms。原始回执未保留，故只记为高度吻合的原因。0.1.2 已为回执/准备/执行状态补 60 秒下界容差、首次接受的 Master 本机到期校验，取消/过期/Execution 隔离保持。不要调系统时间、改记录或重发规避；新包不会自动补发旧失败 Execution。
- 最新运行观察（2026-09-02T04:43:42Z）：本机 5.33 桌面及运行描述文件已不存在，Worker 看到其 Brain 离线；5.20 仍在线。助手未关闭用户桌面，不推测退出原因或计为 Master 停止验收。物理 Worker 的原 Task A 仍未启动、模型请求 0 次。升级前仍应让用户确认 5.20 已退出，再停止自有助手；若重启原 Worker，需使用同一隔离目录，不能直接运行默认新建目录脚本并冒称身份保留。
- 不修改或 fork OpenCode；若需求必须改引擎，先说明并建议缩减范围。
- 不把工作目录限制、人工审批或可信成员当作安全沙箱。
- 不把独立测试客户端冒充两个真人协作，不把未签名包宣传成商业发行完成。

## Git 日常建议检查

重要提交前先审阅待提交文件和忽略规则，再运行：

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

`npm run test:model-settings` 会启动真实 OpenCode 但不调用模型；`npm run test:integration` 和 `npm run engine:probe` 会实际调用模型。不要在没有明确需要时把收费或联网测试放进每次提交钩子。

给新会话的最小开场信息可以是：

> 继续 `C:\project\rivloom-opencode`，这次修改界面。先读 `docs/UI-HANDOFF.md`、`docs/HANDOFF.md`、`docs/MILESTONES.md`、`docs/PROGRESS.md`、`docs/VERIFICATION.md` 和 ADR-0004，再核对 Git 当前 HEAD 与工作区。M3.4 当前 MVP 已结项，0.1.3 实现与物理验收已保存，纯 mDNS 专项仍待查。先听我说明界面改动要求，不自动实现任务编排、人员、HA 或跨 Brain 委派。不修改或 fork OpenCode，不要求 Project 使用 Git，不用文件快照或内容哈希，不重放旧测试、不动原节点/数据。
