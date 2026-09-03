# M3.4 Prepared Race Helper Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 消除物理竞争测试人工传递 UTC 时刻的过期问题，不改产品或 OpenCode。

**Architecture:** 两端 `prepare <UUID>` 先在测试 ledger 登记意图，不创建 Task；它们通过现有认证 API 等待原 Worker 从不接受任务变为有一个空闲槽。协调者在双方准备完成后，通过测试 Worker 的正常本机执行能力 API 恢复原授权 Project/model/ask/单槽配置。各助手自动提交一次固定 Portable 文字 Task，实际竞争仍以权威 Task、单槽准入、排队和唯一业务 session 为准，不声称绝对同时。

**Tech Stack:** 安装的 Node 24、TypeScript、node:test、ServiceClient、未修改的 Rivloom 0.1.3 / 官方 OpenCode 1.18.25。

---

使用 writing-plans、Code 和本地 executing-plans（superpowers 包不可用）。用户已授权继续测试，直接在当前目录执行，不建 worktree、不提交、不委派。Git HEAD f5ce9ed，保留全部已有修改。

## 事实与边界

- 第二轮 dbc4738a 的时间为 14:42:44.641Z，用户反馈校验失败时本机已 14:58Z；时间校验发生在 ledger / Task 创建之前，A 也未 arm。14:58:23.557Z 检查原 3 accepted Task/3 session/4 Execution、A 两条 completed、槽位 1、A/B 通道仍正常。不是执行失败，不重用 UUID。
- 现有 createScheduledTask 在无可用 placement 时返回 409，不能先在关闭 Worker 时创建排队 Task。准备阶段只记意图；不能为了测试更改产品此规则。
- Worker t9MUCF / 原数据根 / session 67853 保留，模型夹具未 release。正式客户端不动；B 使用现有 Ytmgnp/Brain 024a07 和 race-v1 文件夹，旧已删除身份只留历史证据。
- 门闩是测试 Worker 真实的执行能力，不伪造资源报告。关闭会按现有规则清空 policy 的 Project/model 引用，故必须先记录精确配置；恢复用同一 Project/model/ask，不修改 Project 本身。实际物理关闭与恢复要等代码和完整服务验证通过后进行。
- 资源过期/通道暂未就绪时继续等待；一旦开放但槽已被占满，记 missed，不追发。HTTP 结果不确定时记 uncertain，永久 claim 阻止重试。实际未产生重叠请求不能计竞争通过。

### Task 1: TDD 控制器准备/放行

**Files:** Modify `scripts/m34-race.ts`, `tests/physical-race.test.ts`.

1. 新增失败测试：准备无 POST、不依赖 UTC、必须先关闭原 Worker、资源新鲜/身份/通道校验、开放只提交一次、忙时不补发、关闭/取消期间正在读取不误提交、重启不恢复、HTTP uncertain 不重试、兼容 v1 ledger。
2. 运行 `node --test tests/physical-race.test.ts`，确认缺少 prepare 方法红灯。
3. 新增 version=2 / fireAt=null / prepared 状态；保留 v1 的读取/定时/验收。`prepare()` 校验并保存意图；`pollPrepared()` 单次只读检查、同步 claim 后提交；`watch()` 串行短轮询并跟踪 pending，退出取消意图并等请求结束。状态只读，精确验收沿用原逻辑。
4. 运行定向测试及 `npm.cmd run typecheck`、格式检查。测试失败先修测试工具，不触碰产品。

### Task 2: 控制台与完整服务回归

**Files:** Modify `scripts/m34-physical-master.ts`, `scripts/m34-physical-race-local.ts`, `scripts/m34-fresh-brain-check.ts`.

1. B/A 接入 `prepare <UUID>`，B 输出 raceHelperVersion=2。保留旧命令和 ledger，说明准备后不需要赶时间，但不能提前打开 Worker。
2. 完整服务 opt-in `--prepared-race`：独立发现域内先稳定 90 秒；关闭测试 Worker，等待两边真实报告不 accepting；通过同一命令入口准备双方，确认 0 Task/model；恢复精确原配置并观察各一次提交。
3. 沿用真实单槽 running/queued、review 占槽、正常 Master 重启、原排队继续、三个 accepted Task/session、0 tool/普通空文件夹断言。不把同机通过当物理通过。
4. 运行 `node scripts/m34-fresh-brain-check.ts --runtime-directory=C:\Users\x\AppData\Local\Rivloom\runtime --prepared-race` 及全量 `npm.cmd test`。DPAPI/网络测试用获准正常用户上下文，不绕过保护。

### Task 3: 打包和交接

**Files:** Modify `support/m34-master-helper/README.md`, `scripts/m34-master-helper-package.ps1`, HANDOFF/PROGRESS/VERIFICATION/MILESTONES 和物理验收记录。

1. race-v2 zip 严格同一 8 文件白名单、没有 `.data`/身份/凭据/DB/二进制；旧包保留，产品仍 0.1.3。
2. 已停止的本机烟雾助手原文件夹仅覆盖代码；检查 v2、原身份、0 Task/model 和正常退出。关闭旧 A 测试控制台，更新后只读附着同一桌面，不停止桌面。
3. 更新文档：两次人工时刻协调均未执行竞争；新版本机验证与物理待验收分开。给用户最少的 helper-only 更新步骤：stop 等 CLEANUP、覆盖当前 race-v1 文件夹的代码保留 .data、原 start-master.cmd、发 STATUS。不再发固定 UTC 命令，不让用户新建目录或重装产品。
4. 后续物理验证：原 Worker 历史/模型/配置基线 -> 关闭执行能力 -> 两端 prepare 同一新 UUID -> 核对 PREPARED 无 Task -> 恢复原能力 -> 实际 one running / one queued -> release/验收 -> 原队列继续 -> 两任务 completed/槽位释放/旧历史不变。需要远端操作时明确暂停等待，不冒称已通过。

## 状态

**结项补充（2026-09-03）**：收到完整物理通过和纯mDNS待查说明后，用户回复“好，下一步吧”；M3.4按当前MVP切片结项，本prepared助手任务不再需要操作。旧92/93不是绿色，不把结项扩成该专项已解决或未测边界已通过；后续产品方向待确认，节点/数据保留，未清理或改代码。下文07:05及更早的“结项待确认”是历史状态。

**最新完成记录（2026-09-03 07:05Z）**：用户B最终RACE_STATUS确认原Task8fe868cc/Executionbe6b9f97 completed/seq4/attempt1；本机只读复核A原Task44a77700 completed/seq4/attempt2，两Worker任务accepted、5session/7Execution/5Project/夹具2/0工具/五空目录/原历史保持/槽1。v2物理prepared竞争闭环证据收齐，报告2ebbcc36标passed，Task3的远端更新与物理验证部分完成。本轮不再需要用户输入命令，也未增加源码/产品/网络/安装或进程变更。M3.4 MVP结项待确认；原纯mDNS92/93专项未解决，整个项目回归仍不是全绿。已有正常离线/恢复与Project历史证据继续有效，不声称本轮测试了异常断网或Master故障切换。以下检查点均为历史。

**最新物理检查点（2026-09-03 07:01Z）**：真实竞争B胜/Aqueued后，B一次验收在Worker生效，A原Task自动第二尝试并完成验收。总5accepted/5session/7Execution/0工具/五空目录、模型请求2，最终槽1连续20,011ms/38次保持；旧历史不变。只等用户B的只读race-status最终completed回执，未收齐前不标整轮/MVP完成。未改源码或再次提交/重启。Worker76974/原policy启用/夹具release、A17068保持；既有恢复预检不支持本轮合法declined邀请，未来需恢复时先核对，不能删记录或换根绕过。精确证据见HANDOFF及 `m34-physical-prepared-race-2ebbcc36.json`，旧mDNS92/93待查保持。以下状态为历史开发/验证记录。

Task 1 完成：25 定向/TypeScript/格式通过；先缺少 prepare 红灯，后实现和补并发/关闭守卫。Task 2 完成：两次 prepared 完整服务各 12 项通过，最终源码报告 56791fbf（90,382 ms/168 次），所有隔离服务退出。

Task 3 包与本机覆盖烟雾完成：20,017 字节/8 文件，无私有数据，原烟雾身份保持、0 Task/model、正常退出。旧 A 控制台已停止，不需在远端准备完成前留空控制台。远端未更新，物理 Worker policy 未改，无新物理 Task。

**验证停点：全量 92/93，原有纯 mDNS 同机发现测试失败，单独复查同样失败。** 根因未定位，不改测试阈值/网络/产品，不标记全绿。按 executing-plans 在重复失败处暂停新的物理步骤，收尾文档、向用户报告并请求是否先排查发现问题。实际物理通道/旧历史保持正常，但不能用它掩盖失败。finishing-a-development-branch 技能不可用，不安装替代、不创建分支或提交。

### 2026-09-03 用户确认继续物理验收

用户指出正式客户端可以互相发现。复核确认 5.33 看到 5.20 且受信通道正常；此前失败项是禁用 UDP fallback 的纯 mDNS 专项，不能等同于正常产品发现失效。说明专项待查、不阻塞后续单槽竞争，以及先恢复隔离 Worker、更新 B 助手、再双 Brain 争用后，用户明确“好的你继续”。据此恢复物理步骤，原 92/93 及根因未知保留，不写成全绿或已修复。

06:21–06:24Z 原 Worker 旧 helper/service 11212/39764 均 ESRCH、旧 API 拒绝连接，app.lock 仍为 39764；退出原因未知。只读核对原身份、3 Project/3 accepted Task/3 session/4 Execution、6 信任完整。再次核对 PID 不存在后，仅将原目录 app.lock 改名为 app.lock.stale-20260903-1423，保留可恢复证据，不删数据。06:24:34.007Z 既有完整恢复预检通过；06:24:49.505Z 同根同 Node 启动为 Worker session 76974、helper/service 996/26240，API/peer/engine 58866/60127/51469，模型 0。

后续先完成正常发现路径的有界稳定检查，再请用户仅覆盖当前 race-v1 文件夹中的 v2 代码并回传 STATUS。两台正式桌面不动，物理执行 policy 尚不关闭，不 prepare/创建任务；等两侧身份和 v2 状态确认后才准备同一新 UUID。证据 m34-physical-worker-resume-20260903.json。

06:31Z 结果：首段 `ready(n)` 断言失败且未导出具体 peer/时间，不计通过；即时复查全就绪。后续变化观察 90,074 ms/333 次，无未就绪/API 错误，最大资源年龄 5,013 ms。最终历史/策略/信任完全一致，模型 0；不声称初次变化根因已修复。A 控制台 17068 已只读附着，Worker 76974 保留。现在等待用户仅更新原 B 助手文件夹并发 STATUS，未关闭物理 gate 或创建 Task。

06:40Z：B同身份v2更新已确认，port62295可信通道匹配。已保存原完整历史与restoreBody，06:39:48Z正常API关闭Worker执行能力；06:40:28.909Z A在17068准备新UUID2ebbcc36-c079-4c84-ad4e-a6d9cf6a579f，无Task/claim。该检查点等B回执，物理竞争尚未开始。

06:54Z最新：B06:49:12.600Z prepared回执匹配，放行前重新核对历史与关闭状态。临时观察首轮因误从network读取executionPolicy在变更前退出，改为bootstrap后预检通过；06:52:26Z仅正常恢复原配置一次。86次/20,121ms真实观察B running、A queued、唯一新businessTask/session；完整身份/归属/旧历史/0工具/空目录检查通过。release夹具后，B review/seq3回传成功仍占槽、A原Task仍queued。下一检查点需要用户B精确race-accept一次及RACE_STATUS；再验证A原Task继续、两Task完成和最终槽1。助手v2协调已实际生效，但尚不能把整个物理验收写为完成；B本机权威状态尚待回传。Worker76974保持原启用配置，模型已release，A17068保留，不重复prepare/submit或停止节点。无新测试/产品源码修改，证据 `m34-physical-prepared-race-2ebbcc36.json`，mDNS92/93待查不变。
