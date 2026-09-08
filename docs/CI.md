# Windows 基础 CI、测试分层与候选包门槛

更新日期：2026-09-08。流水线使用 Rivloom 0.1.4 正式身份并发布普通 GitHub Release，实施范围见 [发行计划](plans/2026-09-06-rivloom-release-name.md)。官网文件同步已启用并完成真实发布验证，签名与 updater 尚未实施。此前 Preview 构建与发布结果保留为历史，不能用本地构建或官网 CI 代替桌面云端结果。

## 编译到官网的复核（2026-09-08）

当前顺序为：main 同提交三份 Windows 检查 → 固定工具链与锁文件 → 准备并校验 runtime → Rust 单元测试 → NSIS 编译与再次校验 runtime → 云 runner 全新安装、启动、卸载验证 → GitHub 普通 Release → R2 不可变文件与完整公开下载校验 → 条件更新 `releases/latest.json` → Pages main Hook → 官网自行同步清单、测试和构建。

本次补齐 `collaboration-files` 服务矩阵入口，并让 `ci:coverage` 对照注册清单拒绝漏项、重复和未知检查。候选工作流增加固定 Rust 工具链的 Release 单元测试，置于 NSIS 编译之前；失败会阻止后续发布。相关本地验证为 CI 自检 56/56、Rust 10/10、隔离服务中的协作文件检查 6/6，覆盖映射、版本一致性和 TypeScript 通过。这些修改尚未推送，不将本地结果记为新提交的云端通过。

线上现有 [构建与发行 34013763737](https://github.com/rivloom/rivloom-desktop/actions/runs/34013763737) 的构建、发布和官网同步均成功。[官网下载页](https://rivloom.com/download/) 与公开清单均指向 `v0.1.4-84dfc09fc756-9983464069`；本次匿名完整下载为 72,693,201 字节，SHA-256 `db56e20eb5f3d6090ffc06eeacaa322e00baf9372bec2584daaaa49ef382e41c`，与 GitHub Release 资产摘要、校验文件及网页一致。它仍是既有线上版本，不能代表本地新增界面功能已经发布。

Pages Hook 返回成功只证明构建请求被接受；桌面同步 job 当前没有等待 Pages 部署完成，最终须另查构建结果及正式下载页。该边界本次通过已部署页面复核。云安装检查使用新 runner，不覆盖旧用户数据迁移或跨版本节点组合；后续修改底层存储或协议时，按 [发行兼容性要求](RELEASING.md) 补充对应迁移与混合版本验证。

## 本轮 Windows CI 修复结果

`dd92730d337a5bcdab934bbcc936cd78f171e009` 的三份云端工作流、10 个 jobs 已全部成功：[Windows CI](https://github.com/rivloom/rivloom-desktop/actions/runs/33965432661)、[官方引擎服务](https://github.com/rivloom/rivloom-desktop/actions/runs/33965432663)、[mDNS / UDP](https://github.com/rivloom/rivloom-desktop/actions/runs/33965432674)。协议 11/11，mDNS 与 UDP 各 1/1、零跳过；这仍是同机云 runner 检查，不替代双物理机验收。

路径失败来自测试将规范长路径与 Windows 8.3 输入别名直接比较；修正测试预期并补目录别名、普通文件和缺失目录回归，产品目录校验未改。其余云端失败来自测试环境过滤掉 `PSModulePath`，使 Windows PowerShell 卡在 `Add-Type -AssemblyName System.Security`，尚未进入加密。四个独立 runner 的非敏感对照均显示：继承环境成功、修复后白名单成功、仅删去该变量又在 Add-Type 阶段 15 秒超时。修复只保留该系统变量，签名、加密和测试通过条件未变，凭据仍被过滤。

原始 `7c5a3f4`（5/10）、诊断 `32bdc10`（6/10）和修复 `dd92730`（10/10）的摘要分别保留在 `.data/verification/desktop-visual-ci-7c5a3f4/`、`ci-dpapi-32bdc10/`、`ci-dpapi-dd92730/`。临时负对照已从常规诊断移除；保留两组有限观察。后续新增候选打包逻辑须按它自己的源码和云端结果验收，不能直接沿用本段通过结论。

## 首轮本地候选验证（2026-09-05，历史检查点）

源码为本地 `main` 的干净提交 `86463bf286c6d488fe25e77d9b1e897d58506658`，配置和最终记录均核对同一源码与工具链。`local-validation.json` 明确记录 `environment: local`、`cloudRun: false`。Node 24.19.0、Rust/Cargo 1.98.1 均已实际核对；新增固定 Rust 工具链没有改变默认 stable。配置、构建前 runtime gate、Tauri Release/NSIS、构建后 gate 和候选记录全部通过；Release 编译耗时 2m 53s，NSIS 构建退出 0，日志 `.data/verification/ci-local-native-build.log`。

候选为 `test-results/candidate/Rivloom UI Preview_0.1.3_x64-setup.exe`，**71,115,790 字节**，SHA256 **`c776fd351d4ae7f3150cb2a4f47ff13af16402b4b549f92ecb099ac9ba6782e2`**，独立 identifier `com.rivloom.conversationpreview`。实际 Authenticode 状态为 **NotSigned**，未安装、未发布，无更新频道或下载 URL；M3.5 用户交付最新版仍为 `docs1`，本候选不自动替代它。

前后 gate 均核对 88 个运行依赖、267 个 Rust 依赖和 722 项 notice 文件，以及 Node/OpenCode 的实际哈希、架构和版本。runtime manifest SHA256 为 `f9b66d75089bc627f80afa46dec6509c93666c1b70d05dab7207fca8837a08be`；完整 runtime 树在构建前后相等：6,682 文件、735 目录、325,954,687 字节，摘要 `45710db57e91f85af8aee7b156b36cad9e11f6b81fa6ea2bd2397bfa7223b3c7`。证据位于 `test-results/candidate/` 的 `runtime-before.json`、`runtime-after.json`、`candidate-build.json` 与 `local-validation.json`。独立 NSIS runtime 解包现已通过，全部提取文件与 prepared runtime 逐字节一致；报告为 `test-results/candidate-extraction-1788592034424/verification.json`。该复核没有提取或运行外层 Rivloom.exe，也没有验证安装脚本语义；SECURITY 与 Git blob 的单个 CR 换行差异另行披露，详见 [实际验证记录](VERIFICATION.md)。

该检查点桌面远端仍为 `f5ce9ed3fdf4ad69cfad2acfc13d9a04e7cf51c2`，本地领先 4 个提交；桌面推送等待明确授权。官网仓库的推送/云 CI/Cloudflare 进度另见 [官网交接](WEBSITE-HANDOFF.md)，不能代替桌面云验证，亦不与纯 mDNS 的已知失败混算。

## 工作流与权限

| 文件                                     | 检查                                                                        | 触发                |
| ---------------------------------------- | --------------------------------------------------------------------------- | ------------------- |
| `.github/workflows/ci.yml`               | 应用版本一致性、CI 自检、覆盖映射、TypeScript/Vite、逻辑和 Windows 协议测试 | PR、main push、手动 |
| `.github/workflows/windows-services.yml` | 官方 OpenCode 端口/生命周期，以及模型设置、权限、M3.5 P0、协作文件、session 崩溃窗口 | PR、main push、手动 |
| `.github/workflows/lan-regression.yml`   | 同机纯 mDNS、同机 UDP fallback，两个独立 job                                | PR、main push、手动 |

另有 `.github/workflows/windows-candidate.yml`（Windows build and release）：同仓库 main push 的 Windows CI 成功结束后自动触发，也保留手动或 `ci-v<应用版本>` tag 入口。构建前须核对三份 Windows CI 工作流在同一源码提交上的最新运行均成功；候选与安装验收通过后，独立 job 自动创建普通 Rivloom Release。官网同步还要求 `RIVLOOM_PUBLIC_DOWNLOADS_ENABLED=true`，当前已启用；见[下文](#同步-rivloom-到官网公开下载)。

使用明确的 `windows-2022` x64 runner 与 Node **24.19.0**；`npm ci` 使用锁文件，`npm run build` 已包括 typecheck，不重复执行同一检查。基础 PR 的构建指 TypeScript/Vite；候选工作流另行安装并验证 Rust/Cargo **1.98.1** 与 `x86_64-pc-windows-msvc` 目标，不把预装 Rust 版本或前端构建当作原生/NSIS 证明。

Rust pin 已包含 2026-09-03 官方补丁对 1.98.0 vtable 误编译的修复；随该工具链发布的 Cargo CLI 版本由 bootstrap 的 `CFG_RELEASE` 决定，不能拿 Cargo crate 的 `0.99.0` 版本推算。最初选型检查点只核对官方发布与源码；随后已完成固定工具链安装、真实版本检查和上方本地原生构建，默认 stable 未改变。[Rust 1.98.1 公告](https://blog.rust-lang.org/2026/09/03/Rust-1.98.1/)、[Cargo 版本逻辑](https://github.com/rust-lang/cargo/blob/797e8a9bca276c1c9f9f738d2a20f484fa4eea9d/src/cargo/version.rs)、[Rust bootstrap](https://github.com/rust-lang/rust/blob/1.98.1/src/bootstrap/src/core/build_steps/tool.rs)

测试工作流只有 `contents: read`；候选构建额外使用 `actions: read` 查询同提交检查，读取 token 仅提供给门禁步骤。只有依赖候选成功的 `publish` job 获得 `contents: write` 和 `actions: read`，写 token 仅显式提供给发布脚本步骤。`website-download` 依赖候选与发布均成功，GitHub 权限只有 `contents: read`、`actions: read`；R2 对象读写凭据与 Pages Hook 只提供给该 job 的同步步骤。两个后续 job 均不安装 npm 依赖或运行安装器，所有 checkout 不持久保存 Git 凭据。测试和候选构建不获得公开存储写凭据；本流程不配置签名密钥或模型账号。候选的 `workflow_run` 严格限于本仓库 main push，不通过它或 `pull_request_target` 执行 PR 代码。矩阵失败不取消同组其他检查；没有 `continue-on-error`、自动重跑直至成功或隐式测试排除。每个 job 的结果须分别查看，不能只引用基础构建的绿勾。

GitHub 托管 runner 镜像会更新；报告记录 Node、平台、架构、commit、镜像名称与版本。固定 runner 标签与锁文件能改善可追溯性，不承诺不同机器的输出天然逐字节一致。[GitHub runner 说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

协议 job 的 checkout 使用完整历史：原有旧版 capability 回归需要 `git show 8badf8f:server/node-network.ts` 读取固定 M3.4 基线。不能因浅克隆缺少该基线而删掉兼容性断言。

## 测试覆盖映射

`npm test` 包含当前全部 32 个测试文件。`ci:coverage` 对照 `tests/**/*.test.ts`、全量入口和分层清单，发现新文件未归组、遗漏、重复归组或失效映射即失败；同时核对官方引擎服务矩阵与 `serviceChecks` 注册表完全一致。

| 入口                       | 源文件/用例                                                                          | 范围                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `npm run test:ci:logic`    | `logicFiles` 中 30 个完整文件 + `node-network.test.ts` 中明确列名的 20 项             | 业务状态、协议数据结构、逻辑和本机适配；部分用例使用临时文件、子进程或 loopback 监听，并非全部纯函数 |
| `npm run test:ci:protocol` | `node-network.test.ts` 明确列名的 11 项                                              | Windows DPAPI、真实节点通道、队列回执、Brain/Worker、配对与重连；同机隔离实例                        |
| `npm run test:ci:engine`   | 完整 `engine-ports.test.ts`，2 项                                                    | 未修改的官方引擎、真实端口冲突与生命周期；不调用模型                                                 |
| `npm run test:ci:mdns`     | 原 `two isolated Rivloom instances discover and cryptographically verify each other` | 保持原用例禁用 UDP fallback 的条件及 verified 断言                                                   |
| `npm run test:ci:udp`      | 原 `UDP broadcast fallback discovers and verifies two nodes without mDNS`            | 保持原用例禁用 mDNS 的条件，独立验证 UDP 后备路径                                                    |

逻辑层完整文件以 [ci-test-suites.ts](../scripts/ci-test-suites.ts) 的 `logicFiles` 为准，覆盖任务、会话、队列、文件、界面偏好、资源采样、安全与发行校验。`physical-*` 是控制器/状态逻辑回归，不是实际双物理机验收。

共享网络文件的 33 个用例在 [ci-test-suites.ts](../scripts/ci-test-suites.ts) 逐名归组。运行器把名字转成已转义且前后锚定的精确匹配，并核对实际执行名称与预期完全一致。任何缺项、多项、零用例、skip、todo、失败或失败的总结果都会返回非零；更改测试声明形式时要求显式复核，不能动态猜测后漏测。源测试及其断言未移动或改写。

纯 mDNS 的历史最新全量基线是 **154/155**，本批专项再次失败，UDP 路径通过。两者始终分开展示。这里的网络 job 在一台 Windows 主机上的真实网络栈运行；它不能证明两台真实设备、防火墙安装体验或目标 LAN 都已通过。云环境测试失败应保留真实失败；无法提供双机条件时，双机验收仍为未覆盖。发行说明必须列出未解决问题，不能用其他 job 通过替代。[既有验证记录](VERIFICATION.md)

## 官方引擎服务检查

`npm run test:ci:services -- <检查名>` 使用下列原始脚本，不新增模型调用实现：

| 检查名           | 现有脚本                             | 验证内容                                                                     |
| ---------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| `model-settings` | `scripts/model-settings-check.ts`    | 真实应用与官方 auth/provider 接口，合成测试凭据，6 项断言；不发模型请求      |
| `permissions`    | `scripts/permission-policy-check.ts` | 官方引擎创建并读回三种 session 权限；不发模型请求                            |
| `node-p0`        | `scripts/node-p0-check.ts`           | M3.5 全服务、官方 OpenCode、确定性 loopback 模型，12 项业务检查              |
| `collaboration-files` | `scripts/collaboration-files-check.ts` | 附件权限、断点续传、Worker 成果、Brain 转发与撤销；三个隔离服务及确定性 loopback 模型，6 项检查 |
| `session-crash`  | `scripts/node-queue-crash-check.ts`  | 真实 session 创建前/后两个崩溃窗口；重启不重复创建 session，未知执行保留槽位 |

包装器先在 `test-results/ci-workspaces/` 建立唯一工作副本，只复制当前源码与已构建的 `dist`，依赖从包含它的仓库解析。它不复制已有 `.data`、随包 runtime、身份或凭据，也不覆盖旧验证报告。现有测试需要的 `.data/verification` 父目录只在新副本中创建。

子进程环境仅保留系统运行所需变量（包括 PowerShell 模块发现所需的 PSModulePath），重新设置隔离数据根；不继承 `RIVLOOM_MODEL`、`NODE_OPTIONS`、GitHub token 或提供方 API Key。测试进程正常退出前按原夹具关闭自有服务；超时只按本包装器拥有的 PID 停止进程树，结果为失败。若本机受限环境拒绝树级停止，包装器停止自己的子进程并明确记录 `child-only`，不能声称完成整个进程树清理。

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

## Rivloom 候选包工作流

候选 job 只接受 `desktop`，identifier 固定为 `com.rivloom.desktop`，产品名固定为 Rivloom。它检查 package、npm lock、Cargo、Cargo lock、Tauri 的版本一致性，要求干净源码、完整 commit 与 GitHub 请求的 commit 相符；tag 必须为精确的 `ci-v<应用版本>`。旧 Preview 候选及安装证明不能通过新版身份门禁。开发用 Preview 配置继续保持独立身份，不进入普通发行。

自动触发取 `workflow_run.head_sha`，checkout、候选预期 commit、ref 与产物名称统一绑定该 SHA。不能把该事件中的默认分支最新 `github.sha` 当作触发源码。只接受同仓库 main 的 push 成功事件；手动/tag 构建同样必须通过精确源码 CI 门禁。`ci-candidate-gate.ts` 查询三份工作流的最新 run/attempt，不筛选旧成功结果，不接受其他分支、PR、其他仓库、取消、跳过或缺失检查。最多等待 22 分钟，将检查时间、运行链接与结果写入 `ci-gate.json`；失败时停止打包。构建前通过是该时间点的检查快照。仅重跑另外两份工作流不会再自动触发候选，可在修复检查后重跑 Windows CI 或手动运行候选。[GitHub workflow_run 语义](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)

流水线按以下顺序执行：精确源码的全 CI 门禁；锁定安装依赖与 Cargo 源码缓存；执行一次 `desktop:prepare -- --profile desktop`；运行 `ci-verify-runtime.ts --profile desktop`；记录已验证 manifest 哈希与整个 runtime 文件树摘要；执行固定工具链的 `cargo test --release --locked`（Windows x64，异步工作线程限制为 1）；执行正式身份的 Tauri NSIS 构建；再次执行只读 runtime 验证；生成 `candidate-build.json` 并核对 manifest 与 runtime 文件树在构建前后未改变。

文件树摘要包含每个相对路径、文件/目录类型、文件字节数和 SHA256，覆盖 server、shared、dist 与依赖文件，也包含空文件和空目录。测量拒绝链接、junction、非普通文件、超过 50,000 个条目或 8 GiB 的树，并检查读取期间的文件身份、大小与修改时间；只输出聚合摘要、文件/目录数和总字节数，不上传文件列表或 runtime 内容。这里比较的是构建前后状态，未声称观测了构建期间每个瞬间。

Tauri 仅在本次 CLI 合并生成的配置，把已执行的 `beforeBuildCommand` 和 `beforeBundleCommand` 置空，防止门槛之后再次准备/改动 runtime。构建显式使用固定目标、`--locked`、`--no-sign`，并关闭 updater artifacts；源配置、正式 app 版本和原安装数据不被这份临时配置修改。参数先对照锁定的 Tauri CLI help/schema 与[官方 CLI 文档](https://v2.tauri.app/reference/cli/)检查，随后已按上方本地记录完成一次真实 NSIS 构建；初始静态检查不再是当前验证停点。

构建完成后运行 `ci-desktop-install-smoke.ps1`，验证候选与已安装资源、实际桌面启动、随包官方引擎以及卸载后的隔离数据保留。只在 GitHub 托管 runner 的新 test-results 子目录执行；已有 Rivloom 进程或正式安装元数据时拒绝执行，旧 Preview 元数据受保护。本机不执行该安装器检查。结果单列于 `desktop-install.json`；成功后只上传最终 NSIS、候选清单、runtime manifest、前后 runtime 报告、ci-gate.json、desktop-install.json 与 WebView2 检查，共八份文件。失败时只保留有限报告。Actions artifact 仍是候选证据，不是签名产品或更新频道。

候选 job 不把基础测试或发现测试的失败改写成通过。源码/版本、runtime/许可、候选字节与隔离安装分别核对；每次是否完成以该候选所附报告为准。上方本地历史解包报告仅覆盖其对应旧文件，不能替代新包验证。当前流程不声明自动更新或双物理机验收完成。候选 helper 的本地测试使用合成 PE 头验证拒绝逻辑和字节记录，不把该测试文件当作安装器。

## 自动发布到 GitHub Releases

用户已要求 main 更新后自动发布，并从 0.1.4 去掉 Preview。流程为：推送 main → 三组 CI 全部通过 → 原生构建与安装验收 → 上传精确候选 artifact → `ci-release.ts` → 普通 GitHub Release。本地 commit 不触发云端任务；PR 不发布。被取消、失败或未完成验收的运行不发布安装包。

`publish` 依赖 `candidate` 成功，按上传步骤输出的唯一 artifact ID 下载当前运行的产物，并在新 checkout 中再次校验八份候选文件、实际源码 SHA、CI/安装报告、runtime 和安装器哈希。下载使用固定的官方 action，并把 artifact 摘要不匹配视为失败。发布脚本只使用 Node 原生模块。

每个已验证构建有独立标签 `v<应用版本>-<源码前12位>-<artifactID>`，标签指向完整源码 SHA；标题为 Rivloom 加版本和构建标识。仅发布两个附件：`Rivloom_<版本>_x64-setup.exe` 和 `SHA256SUMS.txt`。安装器名称与字节均保持为安装验收通过的那一份。

发布先创建 `prerelease: false` 的草稿，上传完成并复核两个附件的名称、大小和 SHA256 后才公开为仓库内可见的普通 Release。`make_latest` 保持 false，避免晚完成的旧构建抢占 GitHub Latest；官网用自己的受保护记录选择新版。说明如实披露未签名、手动更新与验收范围，普通 Release 标记不代表签名或完整升级矩阵通过。发布结果另存 `test-results/release/release.json`，链接写入 job summary。

重跑失败的发布 job 使用原候选 artifact ID 复用同一草稿/Release；只有缺失附件可补传，已有附件必须与待发布字节一致。重新构建产生新的 artifact ID 和独立标签。相同名称不同字节、错误标签或异常上传状态均停止，不删除或覆盖原附件。GitHub 遗留的空 `starter` 附件不能算上传成功。

按 tag 的 REST 查询只返回已发布 Release，草稿重试需额外查询精确标签。已存在 tag 时 GitHub 会忽略 `target_commitish`，因此必须独立核验标签指向。若 main 前进且修改了工作流，GitHub 可能拒绝普通 Actions token 为含不同工作流的历史提交创建标签；此时发布失败并保留记录，不改用最新 main 冒充候选源码。[GitHub Releases API](https://docs.github.com/en/rest/releases/releases)

仓库当前为私有仓库，Release 下载仍要求有仓库访问权限。自动发布不改变仓库可见性，不配置 Windows 签名或客户端自动更新。此前手工发布的 [Preview 0.1.3 / 2ac60df](https://github.com/rivloom/rivloom-desktop/releases/tag/preview-v0.1.3-2ac60df) 保留原有文件。

## 同步 Rivloom 到官网公开下载

`website-download` 要求 `RIVLOOM_PUBLIC_DOWNLOADS_ENABLED` 严格为 `true`，并依赖 candidate 与 publish 成功；未接通时显式跳过同步，构建和普通 Release 仍运行。启用后运行 `ci-website-download.ts`，按两个上游 artifact ID 下载原候选与发布报告；再次核对干净源码、CI/安装/runtime 证据和实际普通 Release、附件大小/SHA-256、标签与源码。旧 Preview、草稿和失败产物不进入公开入口，不重新构建安装器。

桌面仓库 Actions 配置使用以下名称，值只由工作流注入同步步骤：

| 类型 | 名称 | 用途与范围 |
| --- | --- | --- |
| Variable | `RIVLOOM_PUBLIC_DOWNLOADS_ENABLED` | 凭据和 Hook 接通后设为精确 `true`，启用公开文件同步 |
| Variable | `RIVLOOM_R2_ACCOUNT_ID` | 下载桶所属 Cloudflare 账户 ID |
| Variable | `RIVLOOM_R2_BUCKET` | 专属桶名 `rivloom-downloads` |
| Secret | `RIVLOOM_R2_ACCESS_KEY_ID` | 限该桶对象读写的 R2 S3 Access Key ID |
| Secret | `RIVLOOM_R2_SECRET_ACCESS_KEY` | 对应的 R2 S3 Secret Access Key |
| Secret | `RIVLOOM_PAGES_DEPLOY_HOOK` | 为 `rivloom-website` 项目的 `main` 分支创建的 Deploy Hook URL |

`GITHUB_TOKEN` 使用该 job 的只读临时 token；`RIVLOOM_CANDIDATE_ARTIFACT_ID` 来自候选上传输出，不手工挑选其他运行的产物。Hook 完整 URL 是秘密，不写入文档、报告、源码或官网。官网构建只读取公开 JSON，不持有 GitHub 或 R2 凭据。两个源码仓库继续保持私有。

公开文件固定放在 `https://downloads.rivloom.com/releases/<完整标签>/`，仅包含 `Rivloom_<版本>_x64-setup.exe` 和 `SHA256SUMS.txt`。首次上传使用 `If-None-Match: *`，已有对象必须具有相同长度和摘要元数据，随后匿名完整 GET 两个公开文件并核对实际字节数与 SHA-256。文件按一年 immutable 缓存交付；安装包、内部验证报告和桌面源码不进入官网 Git 或 Pages dist。

两个公开文件验证通过后才推进 `releases/latest.json`。新 `rivloom-download` 记录严格绑定 desktop/com.rivloom.desktop、版本、源码、构建、普通 Release、不可变 URL、长度/摘要与验收状态，明确未签名和未配置 updater。旧 Preview 契约及 previews 路径不可接受；既有 stable/beta 签名契约保持原要求，此记录不是 updater 清单。

全仓库 `public-rivloom-download` 并发组不取消正在执行的同步；latest 首次创建要求不存在，替换要求 If-Match 匹配刚读取的强 ETag。409/412 后最多四次重新读取和判断。不同源码只允许被 GitHub compare 证明为原源码后代的构建前进；同源码按 artifact ID 判断，相同 artifact 必须完整绑定一致才可复用。防回退不依赖完成时间或版本字符串。

latest 使用 no-store；公开 latest 复核成功后才 POST Pages main Hook。官网另有源码开关 `publicDownloadsEnabled`，已在首次真实公开文件验证后设为 true。生产 main 构建严格读取新固定 JSON，404、超时、重定向或无效记录均阻止新部署；新快照路径不会读取旧 Preview 缓存。Hook 成功仅表示已触发，仍须核对实际 Pages 与线上卡片。

同步结果保存为 `test-results/website-download/result.json`，`if: always()` 上传有限报告并保留 14 天。上传或公开文件校验失败时不推进 latest；旧构建记录为 `superseded`，不改指针、不触发 Hook。latest 已推进后若公开 latest 核对或 Hook 失败，报告保留失败阶段，不自动回退对象；重跑同一同步可复用相同文件和记录并重新核验、触发部署，无需重发 GitHub Release。公开 URL 中只有发行标识和文件信息，不携带仓库凭据或私有报告。

**当前接通状态（2026-09-06）：** 用户已授权并配置专属桶 R2 密钥与 Pages main Hook，桌面同步和官网展示开关均为 true。旧 Hook 已撤销，替代 Hook 在运行 `34013763737` 第 2 次执行中通过真实调用。源码 `84dfc09` 修复压缩响应的弱 ETag 问题后，原候选 `9983464069`、Release `383477988` 和同步报告 `9983479753` 完成完整字节校验、latest 条件推进与官网刷新。官网 `eef01e1` 的自动部署 `c59fc2ed` 成功，正式域已显示同一 0.1.4 构建。完整哈希、首次失败与重跑、安装和浏览器证据见 [VERIFICATION](VERIFICATION.md)。

## Actions 与工作流验证来源

2026-09-05 通过各官方仓库的 GitHub release/ref API 核对标签到 commit，并读取该 commit 的 `action.yml`；下列 Actions 均使用 Node 24 runtime。工作流固定完整 SHA，不依赖可变标签。以后升级需重新核对官方来源和输入兼容性。[GitHub 固定 SHA 建议](https://docs.github.com/en/actions/reference/security/secure-use)

| 官方 Action                                                                               | 已核对版本 | 工作流锁定 commit                          |
| ----------------------------------------------------------------------------------------- | ---------- | ------------------------------------------ |
| [actions/checkout](https://github.com/actions/checkout/releases/tag/v7.0.1)               | v7.0.1     | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| [actions/setup-node](https://github.com/actions/setup-node/releases/tag/v7.0.0)           | v7.0.0     | `820762786026740c76f36085b0efc47a31fe5020` |
| [actions/upload-artifact](https://github.com/actions/upload-artifact/releases/tag/v7.0.1) | v7.0.1     | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |
| [actions/download-artifact](https://github.com/actions/download-artifact/releases/tag/v8.0.1) | v8.0.1 | `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c` |

四份 YAML 已用官方 [actionlint 1.7.12](https://github.com/rhysd/actionlint/releases/tag/v1.7.12) 本地校验通过。Windows amd64 ZIP 的官方 SHA256 为 `6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9`，下载后核对一致才运行；工具保存在被忽略的 `test-results/ci-tools/`，不成为产品依赖。该结果只证明本地工作流检查，不代表云运行、分支保护或远端发布环境已经配置。
