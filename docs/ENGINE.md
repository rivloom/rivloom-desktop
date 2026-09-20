# OpenCode 接入与范围决策

## 2026-09-19 当前源码：Windows 与 Linux x64 使用自有 runtime（未发布）

两端固定同一份干净的 Rivloom runtime 源码 `9b07cf442a7eba60a6fe690f630251d23d24194a`，引擎版本 `1.18.31-rivloom.9b07cf442a7e`，SDK/plugin 为 1.18.31。Linux 使用 glibc x64 baseline ELF，可执行文件名为 `opencode`；ARM64 暂不提供自有产物，也不回退到旧官方包。现有官网下载和已发布 0.1.18 包不受本地源码变化影响。

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
| AI 主动提问      | `question.reply` / `question.reject`（实现完成，真实提问分支尚未专项验证） |
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
