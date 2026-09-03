# M3.4 Physical Race Helper Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 给两个现有 Master 增加一次性定时提交测试入口，用真实业务接口验证共享 Worker 单槽竞争，不改产品。

**Architecture:** 两端测试控制台接收同一 UUID 和明确 UTC 时刻，各自仅向本机 Master 提交一条固定的 Portable 文字任务。持久化一次性记录和独占提交标记防止重复；没有新的网络监听、远程控制服务、时钟设置或认证绕过。时刻一致只是触发方法，通过与否依据两个权威 Task、Worker 准入/拒绝、唯一业务 Task/session、排队及槽位证据，不依据命令时间猜测。

**Tech Stack:** 随包 Node 24、TypeScript、node:test、现有 ServiceClient 与官方未修改 OpenCode 1.18.25。

---

用户已要求继续完成测试工具和测试，按当前目录分批执行；不创建 worktree、不提交、不委派。使用已安装的 writing-plans / executing-plans / Code；不存在 superpowers 同名包时使用本地对应技能，不安装额外技能。

## 约束和现场

- Worker t9MUCF 继续运行原目录，fixture 已释放；review 本身占槽，足够观察竞争，不为测试重启 Worker或改变模型/资源报告。
- Master A 为 5.33 原桌面 tRCQ1_ / Brain 0ed79c；Master B 为 5.20 隔离助手 cS1v1p / Brain b1292e，均已完成任务且无活动执行。
- 新助手允许保存的 race Task 与原单条 B Task 共存，offline/online 必须保留所有旧身份/记录。原 submit/accept 仍仅作用于原单条任务。
- 5.20 更新的是测试助手文件而非产品：先正常 stop 旧助手，在原文件夹覆盖代码/说明文件但绝不包含/覆盖 `.data`，重新 start 原助手。需用户执行的步骤等本机验证成功后再给出。
- 本机 A 控制台只连接已核对的原桌面 API，不启动/停止桌面、不操作真实模型或业务任务。

### Task 1: 一次性竞争控制器与定向测试

**Files:** Create `scripts/m34-race.ts`; Create `tests/physical-race.test.ts`; Modify `package.json` test list.

1. 先写测试并运行，确认缺少模块失败：`node --test tests/physical-race.test.ts`。
2. 实现 `RaceController`：验证 UUID/规范 UTC/5 秒至 10 分钟窗口、准确 Node/Brain/唯一空闲 Worker；固定无工具文字 payload；新记录使用 wx，提交前独占 claim；record 状态 armed/dispatching/submitted/uncertain/cancelled/missed。
3. 仅 armed 且准时的记录可提交一次，迟到超过 2 秒不提交；超时/错误不自动重试，重启不重新 arm，status 仅查询原精确 title/归属；accept 只操作该记录的 review Task，序号从最新权威状态读取。
4. 覆盖重复/并发调用、取消、迟到、API 不确定、错误归属/Worker、持久化恢复不重放、只读查询及精确验收。运行定向测试、TypeScript 和格式检查。

### Task 2: 两侧控制台与完整服务验证

**Files:** Modify `scripts/m34-physical-master.ts`; Create `scripts/m34-physical-race-local.ts`; Modify `scripts/m34-fresh-brain-check.ts` (opt-in `--scheduled-race`).

1. Master B 增加 `arm <UUID> <UTC>`、`race-status`、`race-cancel <UUID>`、`race-accept <UUID>`；安排中阻止 offline，stop/退出取消未触发定时器并等待已经发出的请求结束，不重发。原任务命令按精确原 title 过滤。
2. Master A 测试控制台固定核对原 Node/Brain/Worker 和安装 0.1.3，使用相同控制器，退出只退出测试控制台，不停桌面。
3. opt-in 同机完整服务脚本通过同一控制器定时提交，沿用真实准入竞争、review 占槽、Project、Master 停止/恢复、原排队继续和唯一会话断言。保持默认模式不变；临时实例使用独立发现域，不触碰物理实例。
4. 运行 `node scripts/m34-fresh-brain-check.ts --runtime-directory=C:\Users\x\AppData\Local\Rivloom\runtime --scheduled-race`，明确只计本机助手验证。运行全量 `npm test`、`npm run typecheck`、定向 Prettier / diff 检查。

### Task 3: 安全交付与物理检查点

**Files:** Modify `support/m34-master-helper/README.md`; Create a reproducible helper-only packaging script; update HANDOFF/PROGRESS/VERIFICATION/MILESTONES and physical acceptance plan.

1. 新 zip 仅枚举所需代码和说明，不包含身份、`.data`、日志、DB、凭据或 OpenCode 二进制；保留旧包且不运行安装器。
2. 本机复用已停止的助手烟雾测试目录验证新入口及同身份启动/停止，不把该本机身份误认作 5.20；不自动配对或发 Task。
3. 用户更新后核对原 B READY；A 控制台只读核对，选未来数分钟的同一时刻，分别 arm 一次。若一边迟到、拒绝创建或身份不匹配，保留记录并停止，不宣称竞争通过、不自动重复。
4. 物理验收必须同时看到两个 Brain 各自的 Task、Worker 单槽只执行一个、另一方 queued/拒绝历史；review 仍占槽。验收胜者后，原排队 Task 继续而不换 Brain/不重复 session，最后两任务 completed、槽位 1、旧任务保留。
5. 若要补物理排队 Master 离线/恢复，先核对谁是 loser，只停止其隔离助手；如果 loser 为原桌面，不擅自停止用户桌面，先协调。与当前正常停止通过结果分开记录。

## 初始状态

计划已记录，尚未实现/验证新控制器，也未开始新的物理竞争。当前 68 项基线和此前物理通过项不被此计划扩大。

## 实施结果（截至 2026-09-02T12:58:49.652Z）

- Task 1 完成：14 项定向通过（先缺模块红灯），全量 82/82、0 跳过、55,189.3791 ms。控制器只创建测试 ledger/claim 与正常业务请求，没有写产品状态或暴露新网络接口。
- Task 2 本机完成：两端命令与原 B Task 并存，TypeScript/格式通过。`--scheduled-race` 同机完整服务 11 项通过，90,068 ms/166 次稳定、一次执行/一条排队、review 占槽、Master 恢复/原队列继续、3 最终会话且无工具，报告 `m34-fresh-brains-7c58b90b-0c8d-4302-95e8-9fe2d598cdd1.json`。临时服务全部停止。
- 环境例外保留：沙箱公开字符串 DPAPI 回环失败，对应 8 项身份/网络失败和完整服务 local=null；正常 Windows 用户上下文获准运行后同一检查通过，没有安全绕过。失败报告 `m34-fresh-brains-b821a673-459d-4b93-a757-601c1b19c41b.json` 模型 0。
- CMD 烟雾暴露启动阶段提前消费管道指令的问题，仅修助手输入读取时机。清理自有零任务烟雾进程后残留锁移为可恢复记录；没有改身份/Task。重试实际 CMD 的 status/race-status/stop 同身份通过（Node e8n8VI/Brain 3c0057，0 Task/model），退出 0；A 只读附着控制台通过且未停止桌面。
- Task 3 交付准备完成：`scripts/m34-master-helper-package.ps1` 枚举 8 文件；race-v1 zip 为 18,870 字节、不含数据，旧包保留。已要求用户仅 stop 5.20 旧助手、在原文件夹覆盖代码保留 .data、重开后发 STATUS。
- Task 3 **物理阶段未开始**：远端更新/arm/同时竞争尚待用户配合，不计完成。原 Worker 仍槽 1、3 accepted Task/session、模型累计 2；不重新启动它。后续先核对远端 cS1v1p/b1292e/raceHelperVersion=1，再给有效的未来 UTC；A 控制台用可交互 stdin 运行，当前无保留会话。

### 远端更新检查点（13:02–13:05Z）

用户从新的 race-v1 文件夹启动，形成 Node YtmgnpZtwNcSWpdPvAWuhf3IREFuNfEt / Brain 024a0766-64db-4419-a4cc-7b0d53688927；不能将其视为原 cS1v1p/b1292e 恢复。新 Node 未信任/无配对/0 Task，原 B 离线，Worker 历史保持。已要求停止新助手、将同一 zip 代码覆盖原 0.1.3 助手文件夹并保留旧 .data，不复制新 .data；从旧目录重开后再核对。旧数据未被远程读取，缺失时需用户核对，不制造替代身份。物理 arm 仍未开始。

用户随后确认旧目录误删。下一步先让用户核对回收站是否可恢复原目录和 .data，不默认永久丢失。不能恢复时需用户确认新身份续测；保留旧证据，不迁移 Task，不将新 Brain 计作同身份升级恢复。此处暂停物理操作，工具开发和本机验证已经完成。

### 用户确认新身份续测（13:14Z 检查点）

用户反馈回收站没有旧目录，并授权“用新的来吧”。计划中的 Master B 后续改用现有 YtmgnpZtwNcSWpdPvAWuhf3IREFuNfEt / Brain 024a0766-64db-4419-a4cc-7b0d53688927；旧 cS1v1p/b1292e 只保留历史证据，不重建、不迁移 Task。无需改助手代码或打新包。

新 B 在线但未配对，已请用户 pair 回传短码；原 Worker 3 accepted Task/session、槽位 1、模型累计 2 不变。只读检查另发现本机 A↔Worker 当前互不可见，双方各自与 5.20 原桌面通道正常。先确认新配对并诊断本机互联，全部前提满足后才 arm。此项未通过、不以旧稳定报告替代当前检查，也不自动重启用户桌面/Worker。

### 用户授权测试 Worker 正常重启检查

新 B 已完成配对，但本机 A↔Worker 互不可见；端口/互信记录正常，mDNS 只读检查未确定根因。解释目标仅为隔离 Worker t9MUCF 后，用户明确“你按你要测试的来”，授权按测试需要处理该实例。

1. 正常 stop 前读取 API，确认精确原身份、3 个 accepted 业务 Task/3 个官方 session/4 条历史 Execution、0 活动任务和槽位 1；保留元数据证据，不扫描或哈希项目内容。
2. 仅向原 Worker 控制台发送 stop，等待 CLEANUP/退出；不终止正式桌面进程。确认原目录锁已正常释放，运行既有只读恢复预检。
3. 使用已安装 0.1.3 runtime、同一原根和 expect-node 参数恢复 Worker，绝不用默认新建模式。对照原身份/信任/Task/Execution/session，确认无重跑；fixture 进程重启后请求计数从 0 开始，旧累计 2 单独保留。
4. 有界等待并检查 A、B 两个 Master 通道。恢复成功后重做资源/通道稳定检查，再协调物理争用。失败保留现场与原数据，仅继续安全诊断；不循环重启或擅自改变正式客户端/网络配置。即使恢复也不称发现故障已经修复。

### 时刻协调调整：先 B 回执，再安排 A

原 Worker 重启及新 90 秒稳定检查通过。第一轮 `2b08e84d` 因未收到 B arm 回执，A 在触发前取消、未 dispatch；用户随后 14:32:46.504Z `RACE_STATUS role=B, races=[]` 确认 B 无旧定时或 race Task。14:33:44.475Z API/官方会话检查仍为 3 accepted Task/3 session/4 Execution，A 两条 completed，槽位 1、两 Master 通道正常。

下轮使用新 UUID，在最终回复直接提供未来约 8 分钟的 B arm 命令，让用户立即执行并回传 RACE_ARMED。收到回执且核对身份、UUID、时刻仍有效后，才通过原 A 控制台 arm；在此之前 A 不安排计时器。两端依旧使用同一 UTC，不修改时钟或产品。若回传时刻已过期或单边先触发，保留现场并检查实际任务，不追发或冒称同步竞争。此调整只改变人工协调顺序，不修改助手代码。
