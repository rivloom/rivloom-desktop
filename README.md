# Rivloom MVP

人与 AI 协作的任务工作台。React + TypeScript 界面、单个 Node.js 本地服务、SQLite、官方 OpenCode。任务有发起人、接受人、审批人和验收人；AI 执行结束只会进入「待验收」。

**已用真正的 Windows 桌面程序和真实模型跑通闭环，不包含模拟引擎。** 客户安装 Rivloom 后不需要另装 OpenCode 或 Node.js；两者由安装包携带并由客户端管理。没有把切换用户视角当作真人跨设备协作。详见 [桌面端说明](docs/DESKTOP.md)和[实际验证报告](docs/VERIFICATION.md)。

后续开发按 [实施计划](docs/plans/2026-08-31-mvp-delivery.md) 推进，当前停点见 [实施进度](docs/PROGRESS.md)，继续开发或开启新会话前读 [交接状态](docs/HANDOFF.md)。桌面、官方 OpenCode 接入和模型设置产品功能已验证；由于尚未提供有效 Key，DeepSeek 成功调用仍明确标为待验证。

## 在 Windows 启动

客户使用当前内测包需要 Git for Windows、项目所需工具链，以及可访问模型提供方的网络。Node.js 24.19.0 和 OpenCode 1.18.25 已随包提供。

安装包：`src-tauri\target\release\bundle\nsis\Rivloom_0.1.0_x64-setup.exe`。双击安装后从开始菜单启动，不需要命令行。

开发环境需要 Node.js **24+**、Rust 和 Visual Studio C++ Build Tools：

```powershell
cd C:\project\rivloom-opencode
npm.cmd ci
npm.cmd start
```

`npm start` 会构建随包资源并打开独立的 Tauri 窗口。桌面首次启动会自动建立当前 Windows 用户的本机操作者身份，直接进入任务工作台并开始发现附近节点；不要求先创建“工作区”，也不询问显示名称、用户名或密码。内部 Web 调试仍保留显式初始化和登录，不提供公开注册。

`npm run dev` 与 `npm start` 都启动桌面开发版本。内部 Web 调试必须显式使用 `npm run server:dev`；不要和桌面端共用数据目录。同一数据目录有进程锁。关闭桌面窗口时会提示并停止执行，异常退出也由父子进程监控清理。

### 第一个真实任务

```powershell
npm.cmd run example
```

该命令在 `.data/workspaces/slugify` 创建独立的小型 Git 测试仓库（已存在时不会覆盖）。添加项目时填入命令输出的绝对路径。

建议任务：

> 修复 slugify.mjs，使已有测试通过。只修改 slugify.mjs，不修改测试。使用编辑工具修改，执行 node --test slugify.test.mjs，并报告结果。不要提交、推送或部署。

验收标准：处理大写、连续空白和首尾标点；现有测试通过；测试文件不变。

1. 添加可信项目，创建任务并指定三个责任人；发起人是当前登录者。
2. 接受人点击「接受任务」，再确认开始执行。
3. 审批人核对修改或命令，选择「仅本次允许」或「拒绝」。不提供全局自动批准。
4. 任一任务参与者可以停止。发起人或接受人补充要求时，运行中的任务先停止，由接受人确认继续。
5. AI 完成后，查看「执行记录」「产物与差异」；指定验收人填写意见并验收，或退回修改。

首次执行要求仓库有初始提交且工作区干净。后续修改直接留在这个仓库；不自动创建分支、提交、推送、回滚或部署。完成一个任务后，请自行检查并提交/处理修改，再开始下一个任务。

### 模型与独立凭据

默认模型是本次实际验证通过的 `opencode/mimo-v2.5-free`。免费模型由官方提供，可能限流、停用或改变数据处理政策。仅用无敏感信息的测试代码；应用不是离线 AI。

工作区创建者在桌面侧栏进入“模型与额度”，可以：

1. 在密码输入框中保存、替换或移除 DeepSeek 官方 API Key，并确认可信成员的任务会消耗此账号额度。
2. 选择 OpenCode 返回的 DeepSeek 模型，另行确认后执行一次真实、可能计费且不会自动重试的连接测试。
3. 设置新任务默认模型。已有任务继续锁定创建时选择的模型。

完整 Key 由 OpenCode 官方认证接口写入 Rivloom 独立的本机引擎目录。业务数据库、模型操作记录和应用接口都不保存或返回 Key；界面提交后立即清空输入。连接测试使用无项目文件、禁止全部工具的独立会话，10 分钟最多 3 次。当前工作区共用一份提供方凭据，不代表每个成员拥有独立计费账号。

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

当前「协作成员」中的邀请码是早期单 Brain 独立账号协议，仍用于权限回归，但不再作为桌面首次启动步骤。桌面安装实例先自动形成自己的本机操作者与 Brain；后续跨设备成员关系将通过节点配对建立。

这是当前单节点内已经验证的权限协议：共享本节点数据库，但使用独立账号/会话和服务端鉴权。角色不由前端切换决定。非参与者看不到任务或事件；接受人负责启动，审批人负责权限决策，验收人负责交付确认。

M3.1 已使每个安装实例成为自发现节点：稳定节点身份由 Windows DPAPI 保护，实例通过 mDNS/DNS-SD 发现同网段 Rivloom，并用 LAN UDP 查询/单播回复处理 Windows 单向 mDNS；两条路径都必须再通过随机挑战和 Ed25519 签名验证对方身份。桌面“节点与 Brain”页会显示本机 Brain 和附近节点。标准 mDNS 与 UDP 回退已分别通过同机隔离测试，Win10/Win11 物理设备也已确认双向发现。正常关闭会广播签名离线通知；异常断电或断网时，每 5 秒一次的签名心跳用于兜底，约 15 秒显示离线、约 30 秒移除，恢复心跳会自动上线。

自动发现不等于自动信任。M3.2 已增加两端短码/指纹核对、双方分别确认、持久信任、取消和撤销；旧配对请求重放、单方确认和已撤销关系都不能建立信任。真实同机双实例、Release WebView2 及用户的 Win10/Win11 物理双机均已验证配对闭环。受信节点会用签名的临时 X25519 密钥建立双向认证通道，经 HKDF 派生方向密钥，以 AES-256-GCM、严格消息序号和时间窗保护消息；Brain 目录以及任务邀请/接受/拒绝/取消已在通道内通过自动化和实际 Release WebView2。邀请绑定唯一归属 Brain、目标 Brain、全局任务 ID、幂等键和 24 小时期限，双方持久化；接受仍不会绑定项目、选择模型或启动 AI。React 业务服务、OpenCode、项目和模型接口仍只监听 `127.0.0.1`，没有直接暴露到局域网。**尚未由两个真人完成跨设备执行、审批和验收，也尚未实现项目授权、角色映射及远端 AI 执行**。详见 [ADR-0001](docs/adr/0001-self-discovering-brain-network.md)。

## 验证命令

```powershell
npm.cmd test                  # 密码、脱敏、产物完整性等本地检查
npm.cmd run typecheck
npm.cmd run build
npm.cmd run test:model-settings  # 官方 OpenCode 凭据/模型接口；测试字符串，不调用模型
npm.cmd run test:node-network-ui # Release 桌面节点页和真实双实例局域网发现/签名验证
npm.cmd run engine:probe      # 真实官方引擎探针，会调用模型
npm.cmd run test:integration  # 真实应用、独立账号、审批、验收、重启、停止
npm.cmd run test:installer    # 当前 NSIS 的隔离安装、随包引擎启动和卸载
```

真实测试使用独立临时仓库，不修改你的项目。引擎探针仅自动批准固定测试文件 `slugify.mjs` 和固定命令 `node --test slugify.test.mjs`；集成测试另允许固定的只读目录列举 `ls -la` / `Get-ChildItem`。出现其他请求会失败。测试仍要求真实发生编辑和 Node 测试命令审批，目录列举不能替代它们。它是测试操作者，不代表真实用户已经完成可用性测试，也不会启用产品的自动批准。

报告保存在 `.data/verification`。模型设置报告会明确区分“官方接口验证”和“真实提供方回复”；测试字符串通过不能写成 DeepSeek 已连接。测试目录可能包含源码和输出，不要公开上传。模型执行时间不固定，测试超时/限流不会被当成成功。

## 架构和边界

```text
Windows 桌面窗口 / 后续伙伴客户端
         │ 同源 HTTP + SSE / HttpOnly cookie
         ▼
React + Node 本地任务服务 ── SQLite（账号、任务、活动、产物快照）
         │ 官方 SDK + 私有 Basic Auth / 127.0.0.1
         ▼
官方 OpenCode 1.18.25 ── 模型提供方 / 工具执行
         │
         ▼
已授权 Git 测试仓库
```

`server/engine.ts` 管理官方二进制生命周期和配置；`server/task-service.ts` 将公开事件/会话结果映射到业务状态。没有引擎源码、fork、自研 Agent 循环、上下文管理、模型调用实现或工具执行器。Node 24 内置 SQLite 避免原生数据库依赖；当前仅一台执行主机，同项目串行，不做调度平台。

桌面壳只处理窗口、随包运行时、目录选择和进程生命周期；不会实现 Agent 循环或模型调用。详细打包、测试和发行边界见 [Windows 桌面端说明](docs/DESKTOP.md)。

详细限制、敏感信息与可信环境约束见 [SECURITY.md](SECURITY.md)。锁定版本与官方接口映射见 [引擎接入说明](docs/ENGINE.md)。开源声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
