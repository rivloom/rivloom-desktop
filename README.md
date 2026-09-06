# Rivloom MVP

人与 AI 协作的任务工作台。React + TypeScript 界面、单个 Node.js 本地服务、SQLite、官方 OpenCode。任务有发起人、接受人、审批人和验收人；AI 执行结束只会进入「待验收」。

**已用真正的 Windows 桌面程序和真实模型跑通闭环，不包含模拟引擎。** 客户安装 Rivloom 后不需要另装 OpenCode 或 Node.js；两者由安装包携带并由客户端管理。没有把切换用户视角当作真人跨设备协作。详见 [桌面端说明](docs/DESKTOP.md)和[实际验证报告](docs/VERIFICATION.md)。

后续开发顺序以 [里程碑基线](docs/MILESTONES.md) 为准，长期计划见 [实施计划](docs/plans/2026-08-31-mvp-delivery.md)，继续前读 [交接状态](docs/HANDOFF.md)。M0、M1、M3.1–M3.4 当前 MVP 范围已完成。**M3.5 会话式 Node 协作 A–D 工程交付完成，用户验收及本轮双物理机回归待进行**：固定目标、创建幂等、队列/回执和自动候选修复已落地，原生界面、隔离服务与恢复检查已有工程证据。2026-09-06，Rivloom 0.1.4 普通发行、官网匿名下载及发行后自动刷新官网已通过验证；下一步建议用实际公开包完成真实使用验收。历史 docs1 预览、各轮测试数、本机纯 mDNS 失败与云端发现成功分别保留在 [UI-HANDOFF](docs/UI-HANDOFF.md) 和 [验证报告](docs/VERIFICATION.md)，不混成全量或双物理机通过。M4、P1、任务拆解、人员和 HA 仍未扩大实施。

## 在 Windows 启动

官网 [rivloom.com](https://rivloom.com) 已通过独立私有仓库 `rivloom/rivloom-website` 和 Cloudflare Pages 上线。桌面 main 的 CI、候选构建、安装验收、GitHub Release、R2 文件同步及官网刷新已完成真实验证；从 0.1.4 起使用 Rivloom 正式名称与 `com.rivloom.desktop` 身份，发布普通 Release。用户可以从[官网下载页](https://rivloom.com/download/)匿名下载安装包及校验文件；源码仓库仍私有。签名和应用内自动更新尚未实现。当前流程与云端证据见 [CI](docs/CI.md)、[发布方案](docs/RELEASING.md) 和 [验证报告](docs/VERIFICATION.md)。

客户使用当前 Windows 包只需准备项目自身需要的工具链，以及可访问模型提供方的网络。Rivloom 项目可以是任何本机可访问的普通文件夹，不要求 Git。Node.js 24.19.0 和 OpenCode 1.18.25 由桌面程序随包提供。

历史正式版内测安装器为 `Rivloom_0.1.3_x64-setup.exe`（71,083,411 字节）；原 M3.5 交付使用独立的 Rivloom UI Preview，证据见 [UI-HANDOFF](docs/UI-HANDOFF.md)。新版普通安装包为 `Rivloom_0.1.4_x64-setup.exe`，旧 Preview 安装与数据继续保留，尚不自动迁移到正式身份；历史双物理机和升级记录不能作为新版验收。代码签名和完整安装升级矩阵仍待完成。

开发环境需要 Node.js **24+**、Rust 和 Visual Studio C++ Build Tools：

```powershell
cd C:\project\rivloom-opencode
npm.cmd ci
npm.cmd start
```

`npm start` 会构建随包资源并打开独立的 Tauri 窗口。桌面首次启动会自动建立当前 Windows 用户的本机操作者身份，直接进入会话界面并开始发现附近节点；不要求先创建“工作区”，也不询问显示名称、用户名或密码。内部 Web 调试仍保留显式初始化和登录，不提供公开注册。

`npm run dev` 与 `npm start` 都启动桌面开发版本。内部 Web 调试必须显式使用 `npm run server:dev`；不要和桌面端共用数据目录。同一数据目录有进程锁。关闭桌面窗口时会提示并停止执行，异常退出也由父子进程监控清理。

M3.5 验证使用 `npm.cmd run test:node-p0` 创建本轮独立数据/多服务夹具；原生预览使用 `npm.cmd run preview:conversation:desktop`。普通 `npm start` 不代替数据隔离，不复用旧物理验收根。

新增的会话操作交接、云端配置盘点和本机临时验收材料保存在被 Git 忽略的 `.data/`，不纳入提交；仓库文档维护使用/开发说明、设计决策和简明项目状态。已有历史记录不因这项约定自动删除或改写。

### 第一个真实任务

```powershell
npm.cmd run example
```

该命令在 `.data/workspaces/slugify` 创建独立的普通测试文件夹（已存在时不会覆盖），不会初始化 Git。添加项目时填入命令输出的绝对路径。

建议任务：

> 修复 slugify.mjs，使已有测试通过。只修改 slugify.mjs，不修改测试。使用编辑工具修改，执行 node --test slugify.test.mjs，并报告结果。不要提交、推送或部署。

验收标准：处理大写、连续空白和首尾标点；现有测试通过；测试文件不变。

1. 在侧栏「模型与额度」配置可用模型。点击「新会话」，在输入区下方选择或添加可信的普通工作文件夹，并选择执行模型。
2. 打开「会话设置」，选择 AI 审批模式并填写可选的完成要求。「请求批准」逐项询问修改、命令和联网操作；「帮我批准」自动批准项目内修改和命令；「允许任何操作」还自动批准联网和项目外目录。工具限制与可信环境边界见 [SECURITY.md](SECURITY.md)。
3. 输入任务要求并发送。本机会话由当前操作者负责，自动保存到执行队列，条件就绪后开始；普通忙碌时等待槽位。升级前未申请执行的本机遗留 open/ready 会话仍按原授权手动「开始执行」。
4. 如需指定远端，先在「节点与 Brain」完成配对，再在新会话输入 `@` 并选中目标 Node。接收端使用自己的项目、模型和审批设置；发送后在原会话查看认证送达、排位及等待原因。普通忙碌仍排在该 Node，离线会明确报错，不自动改派。
5. 在会话中处理 AI 审批或提问，需要时点击「停止」。已开始的会话可发送补充要求，运行中会先停止再继续同一会话；本机等待/暂缓项的补充只保存，远端尚未准备执行会话时暂不能补充。
6. AI 完成后仍是待验收。查看会话消息和官方差异，核对实际文件与测试结果，再点击「确认完成」，填写核对结果并确认；需要修改时在原会话补充要求。

修改直接留在所选文件夹；Rivloom 不建立 Git 基线、文件快照或内容哈希，也不自动提交、推送、回滚或部署。会话详情只展示 OpenCode 明确返回的官方差异；验收人应直接检查本地文件和测试结果。

### 模型与独立凭据

可用模型和默认模型以本机「模型与额度」当前显示为准，不固定为某个免费模型。免费模型可能限流、停用或改变数据处理政策。仅用无敏感信息的测试代码；应用不是离线 AI。

本机操作者在桌面侧栏进入「模型与额度」，可以：

1. 在密码输入框中保存、替换或移除 DeepSeek 官方 API Key，并确认可信成员的任务会消耗此账号额度。
2. 选择 OpenCode 返回的 DeepSeek 模型，另行确认后执行一次真实、可能计费且不会自动重试的连接测试。
3. 设置新任务默认模型。已有任务继续锁定创建时选择的模型。

完整 Key 由 OpenCode 官方认证接口写入 Rivloom 独立的本机引擎目录。业务数据库、模型操作记录和应用接口都不保存或返回 Key；界面提交后立即清空输入。连接测试使用无项目文件、禁止全部工具的独立会话，10 分钟最多 3 次。同一 Node 的任务使用该 Node 配置的提供方凭据，不代表每个任务或成员拥有独立计费账号。

可在创建任务时选择已连接提供方的模型。以下命令只保留给开发调试，不是客户配置模型的必要步骤：

```powershell
npm.cmd run engine:login
```

通过官方登录流程写入 Rivloom 独立的 OpenCode 数据目录。登录后重启应用以刷新模型列表。也可以显式导入你已有的 OpenCode 凭据（只应导入你有权使用的账号；目标已存在时拒绝覆盖）：

```powershell
npm.cmd run engine:import-auth -- C:\Users\你的用户名\.local\share\opencode\auth.json
```

不会复制原 OpenCode 数据库、会话、插件或旧项目。只有这个显式导入命令读取原凭据文件。服务不会自动扫描个人凭据。不要导入无权使用的账号，也不要把 Key 发到聊天、仓库、截图或验证报告。

开发调试可通过启动终端的环境变量选择隔离数据目录：

```powershell
$env:RIVLOOM_MODEL = '提供方ID/模型ID'
$env:RIVLOOM_DATA_DIR = 'C:\rivloom-test-data'
npm.cmd start
```

没有自动加载 `.env`，避免把工作区秘密继承给 AI 进程。更换 `RIVLOOM_DATA_DIR` 会使用另一个工作区。

## 当前协作基线与 Brain 网络

桌面已移除「协作成员」入口。邀请码和独立账号接口仅保留为旧 HTTP 协议兼容与权限回归，不是当前桌面操作步骤。桌面安装实例自动形成本机操作者和 Node 身份；网络没有可接入 Brain 时自动形成 Brain，否则接入既有 Brain，不是每个 Node 永久创建一个 Brain。人员/企业身份与权限模型尚未定义，设备配对不等同于人员授权。

旧 HTTP 兼容协议共享本节点数据库，但使用独立账号/会话和服务端鉴权；角色不由前端切换决定，非参与者看不到任务或事件。该协议仍保留接受人启动、审批人决策、验收人确认的检查；当前桌面本机会话把这些角色绑定为当前操作者，发送即请求入队执行。

M3.1 已使每个安装实例成为自发现节点：稳定节点身份由 Windows DPAPI 保护，实例通过 mDNS/DNS-SD 发现同网段 Rivloom，并用 LAN UDP 查询/单播回复处理 Windows 单向 mDNS；两条路径都必须再通过随机挑战和 Ed25519 签名验证对方身份。桌面“节点与 Brain”页会显示本机 Brain 和附近节点。标准 mDNS 与 UDP 回退的早期验证有通过记录，物理设备也已确认正常路径双向发现；禁用 UDP 回退的纯 mDNS 专项在历史全量 92/93 和单独复查中失败，M3.5 最新全量 154/155 仍只有该项失败，根因仍待查，不能据早期记录宣称专项通过。正常关闭会广播签名离线通知；异常断电或断网时，每 5 秒一次的签名心跳用于兜底，约 15 秒显示离线、约 30 秒移除，恢复心跳会自动上线。

自动发现不等于自动信任。M3.2 已增加两端短码/指纹核对、双方分别确认、持久信任、取消和撤销；旧配对请求重放、单方确认和已撤销关系都不能建立信任。真实同机双实例、Release WebView2 及用户的 Win10/Win11 物理双机均已验证配对闭环。受信节点会用签名的临时 X25519 密钥建立双向认证通道，经 HKDF 派生方向密钥，以 AES-256-GCM、严格消息序号和时间窗保护消息。

M3.3 当前把设备信任、本机执行能力和 AI 操作审批分开：受信设备发来的任务立即接收；执行能力关闭时任务等待，开启后使用本机预设项目和模型。每个任务锁定「请求批准 / 帮我批准 / 允许任何操作」之一，并通过 OpenCode 官方会话权限规则执行。归属 Brain 能通过认证加密任务通道批准或拒绝一项 OpenCode 操作、回答 AI 提问、停止执行、补充要求并继续同一会话，还能查看经过脱敏和限长的 OpenCode 官方会话差异并完成远程验收。所有操作绑定任务路由、唯一控制 ID 和执行序号；同一任务一次只处理一个远程操作。审批内容会移除 metadata，执行机项目根目录若出现则替换为 `<project>`。任务只绑定一个本机业务任务和官方 OpenCode 会话，本机绝对路径、项目 ID、模型标识、本机任务 ID 和凭据不进入节点消息。若 OpenCode 不返回差异，Rivloom 明确提示执行机参与者本地核对，不扫描或哈希文件夹补齐。React 业务服务、OpenCode、项目和模型接口仍只监听 `127.0.0.1`。用户已在 `192.168.5.20` 与 `192.168.5.33` 用真实 DeepSeek 完成单人双机的文件生成、远程一次性批准、补充要求同会话续跑、本地核对和最终验收，**M3.3 的 MVP 范围据此验收完成**。停止、另外两种审批、撤销信任、两真人角色回归和防火墙安装体验保留在后续优化清单，不阻塞已结项的 M3.4 当前 MVP。详见 [ADR-0001](docs/adr/0001-self-discovering-brain-network.md)、[ADR-0002](docs/adr/0002-configurable-node-invocation-policy.md) 和 [ADR-0003](docs/adr/0003-trust-and-ai-approval.md)。

## 验证命令

```powershell
npm.cmd test                  # 密码、脱敏、普通文件夹与网络协议等本地检查
npm.cmd run typecheck
npm.cmd run build
npm.cmd run test:model-settings  # 官方 OpenCode 凭据/模型接口；测试字符串，不调用模型
npm.cmd run test:permission-policy # 官方 OpenCode 会话权限接口；不调用模型
npm.cmd run test:node-network-ui # Release 桌面节点页和真实双实例局域网发现/签名验证
npm.cmd run engine:probe      # 真实官方引擎探针，会调用模型
npm.cmd run test:integration  # 真实应用、独立账号、审批、验收、重启、停止
npm.cmd run test:installer    # 历史 NSIS 的隔离安装、随包引擎启动和卸载
```

真实测试使用独立临时文件夹，不修改你的项目。引擎探针仅自动批准固定测试文件 `slugify.mjs` 和固定命令 `node --test slugify.test.mjs`；集成测试另允许固定的只读目录列举 `ls -la` / `Get-ChildItem`。出现其他请求会失败。测试仍要求真实发生编辑和 Node 测试命令审批，目录列举不能替代它们。它是测试操作者，不代表真实用户已经完成可用性测试，也不会启用产品的自动批准。

报告保存在 `.data/verification`。2026-09-01 已用 `deepseek/deepseek-v4-flash` 在没有 `.git` 的普通文件夹完成真实编程任务：编辑审批、指定测试命令审批、1 项测试通过和人工验收均成功。OpenCode 的 `session.diff` 返回空数组，所以产物页按实际情况提示直接检查本地文件；Rivloom 没有用文件快照或哈希补齐。测试目录可能包含源码和输出，不要公开上传。模型执行时间不固定，测试超时/限流不会被当成成功。

## 架构和边界

```text
Windows 桌面窗口 / 后续伙伴客户端
         │ 同源 HTTP + SSE / HttpOnly cookie
         ▼
React + Node 本地任务服务 ── SQLite（账号、任务、活动、执行记录）
         │ 官方 SDK + 私有 Basic Auth / 127.0.0.1
         ▼
官方 OpenCode 1.18.25 ── 模型提供方 / 工具执行
         │
         ▼
已授权普通项目文件夹
```

`server/engine.ts` 管理官方二进制生命周期和配置；`server/task-service.ts` 将公开事件/会话结果映射到业务状态。没有引擎源码、fork、自研 Agent 循环、上下文管理、模型调用实现或工具执行器。Node 24 内置 SQLite 避免原生数据库依赖；M3.4 已增加 Brain 任务调度与多 Node 共享 Worker，本机项目仍串行并由 Node 最终准入，详见 [ADR-0004](docs/adr/0004-automatic-brain-masters-and-shared-workers.md)。多个 Brain 不互相传递或共同管理 Task。

桌面壳只处理窗口、随包运行时、目录选择和进程生命周期；不会实现 Agent 循环或模型调用。详细打包、测试和发行边界见 [Windows 桌面端说明](docs/DESKTOP.md)。

详细限制、敏感信息与可信环境约束见 [SECURITY.md](SECURITY.md)。锁定版本与官方接口映射见 [引擎接入说明](docs/ENGINE.md)。开源声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
