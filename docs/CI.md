# Windows 基础 CI、测试分层与候选包门槛

更新日期：2026-09-05。本文记录桌面工作流与本地验证；**本轮本地 Preview 候选构建与前后 runtime 门槛已通过，桌面四份工作流尚未推送或在 GitHub Actions 云 runner 执行**。原生安装、签名、公开上传和 updater 仍按 [实施计划](plans/2026-09-05-website-ci-cd-and-updates.md) 与 [RELEASING](RELEASING.md) 分别验收。

## 最新本地候选验证（2026-09-05）

源码为本地 `main` 的干净提交 `86463bf286c6d488fe25e77d9b1e897d58506658`，配置和最终记录均核对同一源码与工具链。`local-validation.json` 明确记录 `environment: local`、`cloudRun: false`。Node 24.19.0、Rust/Cargo 1.98.1 均已实际核对；新增固定 Rust 工具链没有改变默认 stable。配置、构建前 runtime gate、Tauri Release/NSIS、构建后 gate 和候选记录全部通过；Release 编译耗时 2m 53s，NSIS 构建退出 0，日志 `.data/verification/ci-local-native-build.log`。

候选为 `test-results/candidate/Rivloom UI Preview_0.1.3_x64-setup.exe`，**71,115,790 字节**，SHA256 **`c776fd351d4ae7f3150cb2a4f47ff13af16402b4b549f92ecb099ac9ba6782e2`**，独立 identifier `com.rivloom.conversationpreview`。实际 Authenticode 状态为 **NotSigned**，未安装、未发布，无更新频道或下载 URL；M3.5 用户交付最新版仍为 `docs1`，本候选不自动替代它。

前后 gate 均核对 88 个运行依赖、267 个 Rust 依赖和 722 项 notice 文件，以及 Node/OpenCode 的实际哈希、架构和版本。runtime manifest SHA256 为 `f9b66d75089bc627f80afa46dec6509c93666c1b70d05dab7207fca8837a08be`；完整 runtime 树在构建前后相等：6,682 文件、735 目录、325,954,687 字节，摘要 `45710db57e91f85af8aee7b156b36cad9e11f6b81fa6ea2bd2397bfa7223b3c7`。证据位于 `test-results/candidate/` 的 `runtime-before.json`、`runtime-after.json`、`candidate-build.json` 与 `local-validation.json`。独立 NSIS runtime 解包现已通过，全部提取文件与 prepared runtime 逐字节一致；报告为 `test-results/candidate-extraction-1788592034424/verification.json`。该复核没有提取或运行外层 Rivloom.exe，也没有验证安装脚本语义；SECURITY 与 Git blob 的单个 CR 换行差异另行披露，详见 [实际验证记录](VERIFICATION.md)。

该检查点桌面远端仍为 `f5ce9ed3fdf4ad69cfad2acfc13d9a04e7cf51c2`，本地领先 4 个提交；桌面推送等待明确授权。官网仓库的推送/云 CI/Cloudflare 进度另见 [官网交接](WEBSITE-HANDOFF.md)，不能代替桌面云验证，亦不与纯 mDNS 的已知失败混算。

## 工作流与权限

| 文件                                     | 检查                                                                        | 触发                |
| ---------------------------------------- | --------------------------------------------------------------------------- | ------------------- |
| `.github/workflows/ci.yml`               | 应用版本一致性、CI 自检、覆盖映射、TypeScript/Vite、逻辑和 Windows 协议测试 | PR、main push、手动 |
| `.github/workflows/windows-services.yml` | 官方 OpenCode 端口/生命周期，以及模型设置、权限、M3.5 P0、session 崩溃窗口  | PR、main push、手动 |
| `.github/workflows/lan-regression.yml`   | 同机纯 mDNS、同机 UDP fallback，两个独立 job                                | PR、main push、手动 |

另有 `.github/workflows/windows-candidate.yml`：手动或 `ci-preview-v<应用版本>` tag 触发，只构建独立 UI Preview 候选，不发布。

使用明确的 `windows-2022` x64 runner 与 Node **24.19.0**；`npm ci` 使用锁文件，`npm run build` 已包括 typecheck，不重复执行同一检查。基础 PR 的构建指 TypeScript/Vite；候选工作流另行安装并验证 Rust/Cargo **1.98.1** 与 `x86_64-pc-windows-msvc` 目标，不把预装 Rust 版本或前端构建当作原生/NSIS 证明。

Rust pin 已包含 2026-09-03 官方补丁对 1.98.0 vtable 误编译的修复；随该工具链发布的 Cargo CLI 版本由 bootstrap 的 `CFG_RELEASE` 决定，不能拿 Cargo crate 的 `0.99.0` 版本推算。最初选型检查点只核对官方发布与源码；随后已完成固定工具链安装、真实版本检查和上方本地原生构建，默认 stable 未改变。[Rust 1.98.1 公告](https://blog.rust-lang.org/2026/09/03/Rust-1.98.1/)、[Cargo 版本逻辑](https://github.com/rust-lang/cargo/blob/797e8a9bca276c1c9f9f738d2a20f484fa4eea9d/src/cargo/version.rs)、[Rust bootstrap](https://github.com/rust-lang/rust/blob/1.98.1/src/bootstrap/src/core/build_steps/tool.rs)

工作流只有 `contents: read`，checkout 不持久保存 Git 凭据，无签名密钥、模型账号或公开存储写凭据。不使用 `pull_request_target` 或有权限的 `workflow_run` 执行 PR 代码。矩阵失败不取消同组其他检查；没有 `continue-on-error`、自动重跑直至成功或隐式测试排除。每个 job 的结果须分别查看，不能只引用基础构建的绿勾。

GitHub 托管 runner 镜像会更新；报告记录 Node、平台、架构、commit、镜像名称与版本。固定 runner 标签与锁文件能改善可追溯性，不承诺不同机器的输出天然逐字节一致。[GitHub runner 说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

协议 job 的 checkout 使用完整历史：原有旧版 capability 回归需要 `git show 8badf8f:server/node-network.ts` 读取固定 M3.4 基线。不能因浅克隆缺少该基线而删掉兼容性断言。

## 测试覆盖映射

`npm test` 保留原来全部 19 个文件和测试断言，并加入发行记录和 runtime 审计测试。`ci:coverage` 对照 `tests/**/*.test.ts`、全量入口和分层清单，发现新文件未归组、遗漏、重复归组或失效映射即失败。

| 入口                       | 源文件/用例                                                                          | 范围                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `npm run test:ci:logic`    | 下列 19 个完整文件 + `node-network.test.ts` 中明确列名的 20 项                       | 业务状态、协议数据结构、逻辑和本机适配；部分用例使用临时文件、子进程或 loopback 监听，并非全部纯函数 |
| `npm run test:ci:protocol` | `node-network.test.ts` 明确列名的 11 项                                              | Windows DPAPI、真实节点通道、队列回执、Brain/Worker、配对与重连；同机隔离实例                        |
| `npm run test:ci:engine`   | 完整 `engine-ports.test.ts`，2 项                                                    | 未修改的官方引擎、真实端口冲突与生命周期；不调用模型                                                 |
| `npm run test:ci:mdns`     | 原 `two isolated Rivloom instances discover and cryptographically verify each other` | 保持原用例禁用 UDP fallback 的条件及 verified 断言                                                   |
| `npm run test:ci:udp`      | 原 `UDP broadcast fallback discovers and verifies two nodes without mDNS`            | 保持原用例禁用 mDNS 的条件，独立验证 UDP 后备路径                                                    |

逻辑层完整文件位于 `tests/`：`security`、`remote-task-clock`、`http-ports`、`physical-resume`、`physical-race`、`conversations`、`node-profile`、`node-mentions`、`conversation-drafts`、`directed-node-tasks`、`node-queue`、`node-queue-recovery`、`node-queue-controls`、`node-health`、`task-queue-receipts`、`task-receipts`、`api`、`release-record`、`ci-runtime`，文件名均以 `.test.ts` 结尾。`physical-*` 是控制器/状态逻辑回归，不是实际双物理机验收。

共享网络文件的 33 个用例在 [ci-test-suites.ts](../scripts/ci-test-suites.ts) 逐名归组。运行器把名字转成已转义且前后锚定的精确匹配，并核对实际执行名称与预期完全一致。任何缺项、多项、零用例、skip、todo、失败或失败的总结果都会返回非零；更改测试声明形式时要求显式复核，不能动态猜测后漏测。源测试及其断言未移动或改写。

纯 mDNS 的历史最新全量基线是 **154/155**，本批专项再次失败，UDP 路径通过。两者始终分开展示。这里的网络 job 在一台 Windows 主机上的真实网络栈运行；它不能证明两台真实设备、防火墙安装体验或目标 LAN 都已通过。云环境测试失败应保留真实失败；无法提供双机条件时，双机验收仍为未覆盖。发行说明必须列出未解决问题，不能用其他 job 通过替代。[既有验证记录](VERIFICATION.md)

## 官方引擎服务检查

`npm run test:ci:services -- <检查名>` 使用下列原始脚本，不新增模型调用实现：

| 检查名           | 现有脚本                             | 验证内容                                                                     |
| ---------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| `model-settings` | `scripts/model-settings-check.ts`    | 真实应用与官方 auth/provider 接口，合成测试凭据，6 项断言；不发模型请求      |
| `permissions`    | `scripts/permission-policy-check.ts` | 官方引擎创建并读回三种 session 权限；不发模型请求                            |
| `node-p0`        | `scripts/node-p0-check.ts`           | M3.5 全服务、官方 OpenCode、确定性 loopback 模型，12 项业务检查              |
| `session-crash`  | `scripts/node-queue-crash-check.ts`  | 真实 session 创建前/后两个崩溃窗口；重启不重复创建 session，未知执行保留槽位 |

包装器先在 `test-results/ci-workspaces/` 建立唯一工作副本，只复制当前源码与已构建的 `dist`，依赖从包含它的仓库解析。它不复制已有 `.data`、随包 runtime、身份或凭据，也不覆盖旧验证报告。现有测试需要的 `.data/verification` 父目录只在新副本中创建。

子进程环境仅保留系统运行所需变量，重新设置隔离数据根；不继承 `RIVLOOM_MODEL`、`NODE_OPTIONS`、GitHub token 或提供方 API Key。测试进程正常退出前按原夹具关闭自有服务；超时只按本包装器拥有的 PID 停止进程树，结果为失败。若本机受限环境拒绝树级停止，包装器停止自己的子进程并明确记录 `child-only`，不能声称完成整个进程树清理。

`test:integration`、`engine:probe`、原生 WebView/UI、安装器与双物理机验收不在这些自动 PR job 中：它们的真实模型、桌面和安装前置条件单独管理，不能冒用历史报告作为新包证明。

## 报告与本地复查

简化报告写入 `test-results/ci/<检查名>-<时间>-<随机值>.json`，每次运行独立保存。上传范围严格限定为 `test-results/ci/*.json`；内容只包含版本/环境、已知测试名称、结果与计数等有限字段。不上传 `.data`、SQLite、引擎 auth、工作副本、原始快照或项目内容。完整失败现场留在本机独立工作副本，不覆盖已有运行数据。

常用复查：

```powershell
npm.cmd run ci:versions
npm.cmd run ci:coverage
npm.cmd run ci:selftest
npm.cmd run build
npm.cmd run test:ci:logic
npm.cmd run test:ci:protocol
npm.cmd run test:ci:engine
npm.cmd run test:ci:mdns
npm.cmd run test:ci:udp
npm.cmd run test:ci:services -- model-settings
npm.cmd run test:ci:services -- permissions
npm.cmd run test:ci:services -- node-p0
npm.cmd run test:ci:services -- session-crash
```

Windows DPAPI、监听和进程树测试需要正常 Windows 用户环境；受限沙箱拒绝访问与产品断言失败应分别记录。纯 mDNS 的已知断言失败不会因为更换运行权限而被标记通过。

前一轮本地已验证：版本与覆盖审计、TypeScript/Vite、CI 自检 9/9；逻辑层 168/168（当时包括 13 个 runtime 审计测试）、协议 11/11、官方引擎端口 2/2、UDP 1/1、上述四组服务检查通过；纯 mDNS **0/1，0 跳过，退出码 1**。该轮各分层累计为 182/183，不代表重新执行了一次全量 `npm test`，也不是新增测试后的同轮总数。逻辑报告为 `tests-logic-1788588983733-ec9e36a3.json`。

随后 `ci-runtime.test.ts` 新增生成器版本隔离、重复身份冲突和未知来源拒绝 3 项，已单独验证该文件 **16/16**；详见 [runtime 门槛记录](CI-RUNTIME.md)。该文件原本就按完整文件纳入逻辑层与 `npm test`，因此新增项自动执行，无需逐项映射。覆盖审计再次通过，报告为 `coverage-1788590114116-1e213465.json`；没有重跑完整逻辑层，不报告同轮 171/171。

CI 自检包含真实故意失败/skip/空选择的子测试，以及非零退出、超时、环境过滤和候选身份/门槛反例；这些反例被正确拒绝才表示自检通过，不被算作产品测试通过。唯一报告文件均位于 `test-results/ci/`，各轮结果分别追溯。

## Preview 候选包工作流

候选 job 只接受 `conversation-preview`，identifier 固定为 `com.rivloom.conversationpreview`。它检查 package、npm lock、Cargo、Cargo lock、Tauri 的版本一致性，要求干净源码、完整 commit 与 GitHub 请求的 commit 相符；tag 必须为精确的 `ci-preview-v<应用版本>`。不存在把 Preview 改名为 formal/stable 的输入选项。

流水线按以下顺序执行：锁定安装依赖与 Cargo 源码缓存；执行一次 `desktop:prepare -- --profile conversation-preview`；运行 `ci-verify-runtime.ts --profile conversation-preview`；记录已验证 manifest 哈希与整个 runtime 文件树摘要；执行 Tauri NSIS 构建；再次执行只读 runtime 验证；生成 `candidate-build.json` 并核对 manifest 与 runtime 文件树在构建前后未改变。

文件树摘要包含每个相对路径、文件/目录类型、文件字节数和 SHA256，覆盖 server、shared、dist 与依赖文件，也包含空文件和空目录。测量拒绝链接、junction、非普通文件、超过 50,000 个条目或 8 GiB 的树，并检查读取期间的文件身份、大小与修改时间；只输出聚合摘要、文件/目录数和总字节数，不上传文件列表或 runtime 内容。这里比较的是构建前后状态，未声称观测了构建期间每个瞬间。

Tauri 仅在本次 CLI 合并生成的配置，把已执行的 `beforeBuildCommand` 和 `beforeBundleCommand` 置空，防止门槛之后再次准备/改动 runtime。构建显式使用固定目标、`--locked`、`--no-sign`，并关闭 updater artifacts；源配置、正式 app 版本和原安装数据不被这份临时配置修改。参数先对照锁定的 Tauri CLI help/schema 与[官方 CLI 文档](https://v2.tauri.app/reference/cli/)检查，随后已按上方本地记录完成一次真实 NSIS 构建；初始静态检查不再是当前验证停点。

成功后只上传最终 NSIS、候选构建清单、runtime manifest 与前后两份只读检查报告；失败时只保留 gate 报告，不上传候选安装器。该 Actions artifact 是内部待验收候选，不是 GitHub Release、公开下载、签名产品或更新频道。清单明确记录签名未请求/未验证、未发布、无频道和 URL；它也不是公开发行记录或 Tauri updater 清单。

候选 job 不把基础测试或纯 mDNS 的已知失败改写成通过。它检查的是源码/版本、runtime/许可和候选字节的构建门槛；NSIS 内容独立解包由额外验证执行，本轮本地结果已记在上方，原生安装、更新与物理机验收仍未完成。候选 helper 的本地测试使用合成 PE 头验证拒绝逻辑和字节记录，不把该测试文件当作安装器。

## Actions 与工作流验证来源

2026-09-05 通过各官方仓库的 GitHub release/ref API 核对标签到 commit，并读取该 commit 的 `action.yml`；三个 Actions 均使用 Node 24 runtime。工作流固定完整 SHA，不依赖可变标签。以后升级需重新核对官方来源和输入兼容性。[GitHub 固定 SHA 建议](https://docs.github.com/en/actions/reference/security/secure-use)

| 官方 Action                                                                               | 已核对版本 | 工作流锁定 commit                          |
| ----------------------------------------------------------------------------------------- | ---------- | ------------------------------------------ |
| [actions/checkout](https://github.com/actions/checkout/releases/tag/v7.0.1)               | v7.0.1     | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| [actions/setup-node](https://github.com/actions/setup-node/releases/tag/v7.0.0)           | v7.0.0     | `820762786026740c76f36085b0efc47a31fe5020` |
| [actions/upload-artifact](https://github.com/actions/upload-artifact/releases/tag/v7.0.1) | v7.0.1     | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |

四份 YAML 已用官方 [actionlint 1.7.12](https://github.com/rhysd/actionlint/releases/tag/v1.7.12) 本地校验通过。Windows amd64 ZIP 的官方 SHA256 为 `6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9`，下载后核对一致才运行；工具保存在被忽略的 `test-results/ci-tools/`，不成为产品依赖。该结果只证明本地工作流检查，不代表云运行、分支保护或远端发布环境已经配置。
