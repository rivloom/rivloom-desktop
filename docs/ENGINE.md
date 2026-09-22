# OpenCode 接入与范围决策

**2026-09-22 · 0.1.20 Windows/Linux x64 已发行。** 两平台源码 [`ef9e4e75ef0d587c137eedfb0fcc4cda106f52b3`](https://github.com/rivloom/rivloom-desktop/commit/ef9e4e75ef0d587c137eedfb0fcc4cda106f52b3)，核心仍固定 `9b07cf442a7eba60a6fe690f630251d23d24194a`，SDK/plugin 为 1.18.31。正式包的来源、云端安装、公开下载及签名核验见 [0.1.20 发行验收](releases/0.1.20-verification.md)。Windows 进程检查继续共享原有 5800 ms 总截止时间，并保留归属与实际退出证明；ARM64 暂不发布。

**2026-09-22 · 0.1.19 Windows/Linux x64 自有 runtime 已发行。** 两平台发行源码 `c6d273d1f4bc6f9b510ebf649587f05373a88640`，核心仍固定 `9b07cf442a7eba60a6fe690f630251d23d24194a`，引擎为 `1.18.31-rivloom.9b07cf442a7e`。[Windows 构建与发布](https://github.com/rivloom/rivloom-desktop/actions/runs/35629926540)与[Linux 独立发布](https://github.com/rivloom/rivloom-desktop/actions/runs/35632415575)、同提交 CI、Windows 隔离安装和原公钥更新签名、Linux 公开完整下载及隔离运行核验通过；ARM64 暂不发布。Windows 停止修复只限定辅助 PowerShell 的系统模块搜索，未放宽归属证明或超时门槛。Linux glibc 下限为 **2.30**。见[Windows 发行说明](releases/0.1.19.md)和[Linux 发行说明](releases/linux-0.1.19.md)。下方早期开发状态保留为历史。


## 2026-09-21：Windows 固定核心与独立验证脚本

Windows 核心仍为 `9b07cf4`，生产者构建脚本和 schema 1 manifest 不变。消费端先按固定 URL 和 SHA256 获取 Bun，传输失败最多重试两次；随后调用生产者构建，再强制运行本仓库 `scripts/runtime-windows/smoke.mjs`。原有 10 项实际引擎检查全部保留，任一失败均拒绝产物。验证脚本及 Windows 停止模块由 `engine-source.json` 单独固定摘要，执行前后核对；smoke 与 receipt 同时绑定这些摘要及当次 producer manifest。

停止检查记录关闭前的归属进程身份；`taskkill` 非零时必须重新证明所有已记录进程及其后代退出，并等待根进程退出。查询失败、超时或残留子进程均失败，不把 `taskkill` 的普通非零码直接视为成功。插件初始化检查等待完整 JSON 写入，仍要求确切插件版本。停机失败只报告有界的阶段、耗时、返回码、进程数量及证明类别，不记录命令行、路径或凭据。旧缓存不满足新锁时显式失败，需在新的输出目录重新构建；已有外部产物批准摘要不因此自动扩展。

Windows 停止辅助进程的 PowerShell 模块搜索仅使用系统 `WindowsPowerShell/v1.0/Modules`，不向模型引擎传入用户模块路径。0.1.20 将原有三条命令合计 5.8 秒的预算改为共享绝对截止时间：首次 CIM 查询可使用总截止前的剩余时间，终止命令最多 2.2 秒，必要的退出后查询最多 1.8 秒，后续各步也受剩余总预算限制。迟到结果不能成为退出证明，预算耗尽不再启动命令，也不重复按 PID 终止进程；若首次查询耗尽预算，仍报告无法证明退出，由宿主按已有子进程句柄尽力收尾，不能声称整棵进程树已停止。宿主 7 秒和父进程 8 秒的外层期限不变。CI 在真实生命周期测试结束后才进行缺省/系统/继承模块路径的只读计时对照，避免诊断预热实际停机路径；诊断观察不替代测试结果。

## 2026-09-19 来源说明：Windows 与 Linux x64 自有 runtime（已随 0.1.19 发行）

两端固定同一份干净的 Rivloom runtime 源码 `9b07cf442a7eba60a6fe690f630251d23d24194a`，引擎版本 `1.18.31-rivloom.9b07cf442a7e`，SDK/plugin 为 1.18.31。Linux 使用 glibc x64 baseline ELF，可执行文件名为 `opencode`；ARM64 暂不提供自有产物，也不回退到旧官方包。开发期间未替换 0.1.18 下载；当前 0.1.19 发行状态以本页顶部为准。

Windows 锁为 [engine-source.json](../shared/engine-source.json)，Linux 锁为 [engine-source-linux.json](../shared/engine-source-linux.json)。Linux canonical recipe 位于独立 runtime 仓库的 `rivloom/linux/`，本仓库 `scripts/runtime-linux/` 保存四个文件的精确快照，由 Linux 锁逐项固定摘要。recipe 在干净的固定源码 checkout 外运行；源码提交和外置构建脚本分别记录，不把新增脚本冒称为已存在于旧提交。它不会修改业务源码或提示词。

在原生 Linux x64、Node 24.19.0 上执行：

```sh
npm ci
npm run engine:prepare
# 可选：从本地 runtime 对象库克隆同一个固定提交，不复制未提交文件
npm run engine:prepare -- --source /path/to/rivloom-opencode-runtime
npm run linux:build
npm run linux:smoke
```

Linux 构建需要 Git、Python 3、make、C/C++ 编译器、libc 开发头文件、归档工具及公开依赖网络；固定 Bun 1.3.14 baseline 归档下载后校验 SHA256。冻结依赖中的 tree-sitter 原生模块需要编译，不能关闭安装脚本跳过。recipe 执行冻结依赖安装、baseline 编译和隔离模型 smoke；引擎位于 `vendor/rivloom-opencode/linux-x64/<commit12>/`，打包进 `app/` 下相同路径。源码完整快照包含 Git 文件模式和符号链接本身的内容，不跟随链接读取外部文件。

Linux schema 2 manifest 绑定干净源码、完整源清单、recipe 摘要、工具链、ELF、许可及 11 项 smoke；consumer receipt 再绑定 source lock、产物和构建前后源码证明。CLI 启动、打包、解包与发行门禁检查同一来源，不从 npm 下载官方 Linux 引擎。Linux 默认不允许导入未列入锁文件批准摘要的外部产物；不靠手工替换二进制更新。

运行兼容性检查必须包含内嵌原生库，不能只查看主 ELF。当前固定引擎内嵌的 `libfff_c.so` 要求 `GLIBC_2.30`，整包Linux运行门槛随之提高到glibc2.30；Node.js仍要求内核至少4.18与 `GLIBCXX_3.4.25`。详细范围见 [Linux说明](LINUX.md)。后续上游升级应重新检查实际编译产物及内嵌库的ABI。

客户端为每个隔离 engine root 显式设置会话数据库路径，避免 `rivloom` channel 默认改名而遗漏旧会话。新建工作区及已发行版的现有数据继续使用 `data/opencode/opencode.db`；若只有早期自有引擎候选创建的 `opencode-rivloom.db`，则原地继续使用它。两者同时存在时停止启动并提示备份与恢复，不按时间或文件大小猜测、不搬动WAL、不自动合并或覆盖数据库。该规则同样覆盖Windows、Linux、独立模型账号及OAuth暂存目录。

Linux CI 在服务检查前从固定源构建，然后测试 CLI、协议、两节点合成任务和完整包。工作流变更须经提交后才能在云端运行；本地 WSL 验收不能冒称为云 CI 或物理设备验收。正式发行继续要求同一提交的原生包验收和下载核验。官方升级时一起更新两个 source lock、recipe 快照和 SDK/plugin，分别验证 Windows 与 Linux；Windows 仍消费已有 schema 1 producer，不因 Linux schema 2 接入暗中改换 Windows 产物。

以下 Windows 实现记录保留，其中“Linux 仍为官方”的描述仅代表该阶段。

## 2026-09-19 当前源码：自有 Windows runtime（未发布）

Windows 从 [Rivloom runtime](https://github.com/rivloom/rivloom-opencode-runtime) 的固定提交 `9b07cf442a7eba60a6fe690f630251d23d24194a` 编译 `opencode.exe`，版本 `1.18.31-rivloom.9b07cf442a7e`，上游基线 v1.18.31。SDK/plugin 精确锁定 1.18.31。Linux 引擎仍为官方 1.18.25；正式下载仍以已发布版本为准。

唯一源码配置为 [shared/engine-source.json](../shared/engine-source.json)，固定仓库、提交/tree、上游、Node/Bun、锁文件/模型目录/构建脚本/许可证摘要。Windows 不再安装或回退到官方 npm 二进制。引擎代码留在独立 runtime 仓库，desktop 只维护协议适配及产物契约。

### 构建与接入

需要 Git、Node 24.19.0、PowerShell 7（`pwsh`）；Bun 1.3.14 由固定源码的构建脚本下载并校验。

```powershell
npm.cmd ci
# 缺产物时，克隆固定源码，在隔离目录编译并运行合成模型 smoke。
npm.cmd run engine:prepare
# 本机已有 runtime Git 仓库时，从其对象库克隆固定提交；不复制未提交文件。
npm.cmd run engine:prepare -- --source C:\project\rivloom-opencode-runtime
# 仅导入 source lock 已明确批准 binary/manifest/smoke 三项摘要的产物。
npm.cmd run engine:prepare -- --artifact C:\path\to\verified-runtime
npm.cmd run desktop:build
```

产物位于 `vendor/rivloom-opencode/windows-x64/<commit12>/`，该目录被 Git 忽略。`desktop:prepare` 自动准备或重新核验它，再复制到安装包相同相对路径。缓存无效会明确失败，不覆盖已有产物、不回退。每次源码构建核对前后干净源码、完整源文件摘要和固定输入，保留生产者 manifest、10项 smoke、许可及 `engine-build.json`；源构建另含 `source-proof.json`。

不同机器编译出的字节不承诺相同。固定源码构建的当次 EXE SHA256 从准备、启动、打包、解包到发行证据一路绑定；外部产物导入则必须匹配已批准的三项精确摘要。receipt 是构建记录，不是独立数字签名。全部报告和二进制必须一起保存，不能手工替换 EXE 后只改一个清单。

### 跟进官方更新

runtime 的 [UPSTREAM.md](https://github.com/rivloom/rivloom-opencode-runtime/blob/codex/runtime-v1/rivloom/UPSTREAM.md) 说明只读稳定版检查和人工升级流程。检查比较正式版本及 commit，不将 dev 分支提交直接当作稳定升级。新稳定版先在 runtime 合并和运行类型、工具/会话/审批/取消/插件测试，再提交通过的源码，更新 desktop 的固定源码信息与 SDK/plugin，运行本仓库真实隔离服务、打包/安装/更新验证，最后按正式发布流程发行。客户端引擎自动更新保持关闭。

runtime 构建工具的 schema 2 改进与 desktop 的固定引擎源码分别维护。Windows 默认仍消费上述 `9b07cf4` 的 schema 1 基线；Linux 使用固定核心源码和独立 schema 2 配方。提交新的构建工具不会自动改变两端的 source lock。升级 Windows producer schema 必须显式审查并同步消费端契约，不把 dirty 开发产物伪装为可从远端重建的源码。

## 2026-08-31 历史官方二进制接入

当时 CLI/SDK 均锁定 1.18.25，使用官方 Windows 平台包。下列为该次验证历史，不代表当前源码已正式发布。

官方来源：

- [发布版 v1.18.25](https://github.com/anomalyco/opencode/releases/tag/v1.18.25)
- [服务与 HTTP API](https://opencode.ai/docs/server/)
- [官方 TypeScript SDK](https://opencode.ai/docs/sdk/)
- [权限配置](https://opencode.ai/docs/permissions/)
- [配置文件与优先级](https://opencode.ai/docs/config/)
- [该发布版 MIT 许可证](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.25/LICENSE)

`opencode-ai` npm 包的安装包装器在本机未找到平台二进制并失败；按其错误提示，直接安装官方 Windows 平台包。没有修改 postinstall、绕过许可证或重编译上游。运行方式仍是官方 `opencode.exe serve`。

## 公开接口映射

### 执行上下文连续性

桌面的上下文插件适配固定 V1 Runtime 的 `experimental.chat.messages.transform` 和 `chat.params` 接口：只为引擎标记的自动压缩继续消息恢复本次执行的 Rivloom system，并在业务请求准备时校验内容指纹。原始新消息不被覆盖；内部 compaction 请求单独记录，标题/简要摘要等辅助调用不参与执行规则校验。该适配依赖固定核心的消息引用及 `compaction_continue` 标记，升级核心时必须重新运行兼容性验证。

每次启动/显式续聊在 Rivloom SQLite 保存上下文版本，绑定任务、引擎账号、项目目录、session 和执行时间；旧执行的规则不会用于新执行。回环桥接为不同账号引擎分配独立上下文凭据，凭据不作为工具参数或模型输入。无法核对已管理执行的上下文时中止请求准备。

`GET /api/tasks/:id/context` 沿用任务参与者权限，返回来源类别、注入方式、内容指纹、字节数和准备阶段观察。附件只记录引用，不宣称已读取；记录不是完整 provider 请求副本、Token 占用或模型理解证明。接口最多返回最近 20 次执行，每次最多 50 条观察，并提供总数；不公开提示词原文。新执行清除同任务旧版本的恢复正文，保留元数据；任务永久删除级联删除这些记录。

验证命令：`npm run test:context` 使用实际固定可执行文件与隔离的回环模拟模型，覆盖重复压缩、超限恢复、规则更新和会话隔离；`npm run test:context-service` 验证实际桌面服务的记录权限、重启续聊及流式消息兼容。升级 Runtime 时同时执行原有服务与权限验收，不因插件测试通过而跳过发布验收。

### 会话状态、交接与历史读取

工作流会话使用 Rivloom SQLite 中按轮、步骤和内容版本组织的历史索引。当前目标保留用户原文，进度与阻塞来自工作流状态；约束和决定条目记录来源引用、原文摘录、版本及替代关系。模型通过 `rivloom_context_note` 整理的条目标记为推断，不能覆盖用户已确认条目，也不会自动写入长期 Wiki 记忆。新用户请求优先于冲突的旧历史。条目修订影响后续执行准备和主动查询，不修改已接纳执行的摘要身份。

`rivloom_history` 支持状态读取、按轮/步骤/关键词检索及固定版本分页回读；搜索每页最多 10 条预览，正文页整体最多 32 KiB 的 UTF-8 JSON，包含元数据和转义，分页偏移继续使用 UTF-16 单位。默认交接携带当前需求、有效条目、当前步骤与直接依赖的进度/文件来源；缩短的检查点明确标记，保留取回引用。完整原始需求与有效条目放不下时拒绝准备，不静默裁掉关键约束。

兼容节点通过 `workflow-history-v1` 协商按需读取。远端仅能读取自己已接受、仍在执行的当前会话，校验已配对的可信身份、执行 ID 和上下文摘要；结束、停止、授权撤销及回收站状态拒绝后续读取，已送达内容无法撤回。旧节点沿用完整历史 JSON 附件，新本地/兼容远端执行不再默认生成累计附件。现有会话记录和导出保留。0.1.20 永久删除会话时，通过固定 Runtime 接口清理已记录归属、空闲且未被其他保留任务共享的会话及子会话，并核对删除结果；失败保留进度供重试。不扫描孤儿、项目原文件或远端副本，不自动 VACUUM。

会话创建者可调用 `GET /api/workflows/:id/context` 查看状态，`POST /api/workflows/:id/history` 检索/读取，`POST /api/workflows/:id/context/notes` 确认或替代带来源的条目，`GET /api/workflows/:id/context/notes?offset=…` 分页查看修订记录。写入要求 `expectedVersion` 和可重复提交的 `requestID`；模型整理只允许当前规划执行。0.1.20 已提供上下文查看与编辑界面，支持确认、修订、撤回、来源及修改历史查看，并可显式保存已确认条目为项目记忆。历史读取设计见 [ADR 0015](adr/0015-workflow-context-and-history.md)，项目记忆与维护边界见 [ADR 0016](adr/0016-context-memory-and-runtime-retention.md)。

验证命令：`npm run test:workflow-history` 和 `npm run test:workflow-history:remote` 使用实际固定 Runtime 与隔离模拟模型，分别验证本地及同机双服务跨节点读取、修订、权限和重启。仍须执行现有工作流与发布验收。

SDK 使用公开导出 `@opencode-ai/sdk/v2`（这里的 v2 是 SDK 导出入口，不代表调用所有实验性 `/v2` 路由）。

| 产品能力         | 官方接口 / SDK                                                             |
| ---------------- | -------------------------------------------------------------------------- |
| 启动与版本核对   | `serve --hostname 127.0.0.1 --port …`、`global.health`                     |
| 列出可用模型     | `provider.list`                                                            |
| 创建任务内的会话 | `session.create`                                                           |
| 发送任务 / 继续  | `session.promptAsync`                                                      |
| 流式输出         | `event.subscribe`、`message.part.delta`                                    |
| 断线状态恢复     | `session.status`、`session.messages`、`permission.list`、`question.list`   |
| 操作审批         | `permission.reply`，仅 once/reject                                         |
| AI 主动提问      | `question.reply` / `question.reject`（本机等待补充与续聊已验收；远端普通任务分支未完成三机覆盖） |
| 停止             | `session.abort`，然后拒绝残留权限请求和问题                                |
| 结果             | `session.messages`，业务层保存可显示的执行记录                             |
| 引擎差异         | `session.diff`；有返回则展示，本机实测可能为空                             |
| 产品产物         | 仅映射 OpenCode 明确返回的会话差异；不扫描、快照或哈希项目文件夹           |

没有调用 OpenCode 内部模块，没有自写 Agent 循环。业务层的定时同步只查询状态和保存 UI 执行记录，不生成提示循环或执行工具。

## 真实验证发现

1. 现有 OpenCode Go 账号返回余额不足；没有充值。使用官方免费提供方 `opencode/mimo-v2.5-free` 完成同一个真实测试。
2. `session.diff` 多次返回空数组，但真实文件修改与测试均正常。MVP 不修改引擎，也不自行扫描、快照或哈希文件夹；界面明确提示验收人直接检查本地文件和测试记录。
3. `session.abort` 后可残留等待审批条目。薄适配层先 abort，再通过公开权限接口 reject，避免停止后的陈旧批准入口。
4. 任务验收是应用业务状态，不等于引擎 idle。结果、测试说明、角色和验收意见均保存在本地 SQLite。

升级引擎前必须重新跑 `engine:probe` 与 `test:integration`，核对权限行为、输出事件、结果格式和许可证，再更新两个包版本和锁文件。不使用宽范围版本或自动升级。
