# 候选运行时与许可证校验

**2026-09-22 · 当前正式版 0.1.20。** 固定核心 `9b07cf4` 的 Windows/Linux x64 包已完成各自来源和发行验收；本次 Windows 候选还经独立静态解包，逐项核对完整 Runtime 树、实际引擎字节与构建记录。详见 [0.1.20 发行验收](releases/0.1.20-verification.md)。以下开发与旧候选记录保留为历史。

**2026-09-19 开发记录（当时未发布）：** Windows 使用自有 runtime 的固定源码构建，详见 [引擎构建与升级](ENGINE.md)。canonical pin 已迁移为 `shared/engine-source.json`；不再通过 npm 安装官方 Windows 引擎。gate 核对共享 source lock 字节、SDK/plugin、生产者 manifest、通过的 smoke、当次 EXE、许可与构建 receipt；保留原 Node、完整 npm/Rust 许可和包前后字节树门槛。发行报告新增 `engineSource` 提交/tree/lock/receipt 摘要，原8文件候选契约不变。已发布包和下方历史结果不因此改变。

更新：2026-09-05。入口为 `scripts/ci-verify-runtime.ts`，夹具测试为 `tests/ci-runtime.test.ts`。校验针对已准备的目录，生成清单本身不算通过。

## 历史真实候选验证（2026-09-05）

已对干净源码提交 `86463bf286c6d488fe25e77d9b1e897d58506658` 完成真实 Preview 准备、构建前 gate、Tauri Release/NSIS、构建后 gate 与候选记录。运行环境为本地 Windows x64，`environment: local`、`cloudRun: false`；Node 24.19.0、Rust/Cargo 1.98.1 已核对，新增工具链没有改变默认 stable。原生 Release 编译耗时 2m 53s，NSIS 退出 0，日志 `.data/verification/ci-local-native-build.log`。

前后 gate 都通过 Node/OpenCode 的固定哈希、PE x64、实际 `--version`、说明文件与许可原文校验，结果为 **88 个运行依赖、267 个 Rust 依赖、722 项 notice 文件**。`test-results/candidate/runtime-before.json` 与 `runtime-after.json` 是本次实际二进制证据；先前 `.data/verification/ci-runtime-precommit.json` 保留为提交前准备检查点。

相邻候选流程已另外确认完整 runtime 树在构建前后相同：6,682 文件、735 目录、325,954,687 字节，树摘要 `45710db57e91f85af8aee7b156b36cad9e11f6b81fa6ea2bd2397bfa7223b3c7`，manifest 摘要 `f9b66d75089bc627f80afa46dec6509c93666c1b70d05dab7207fca8837a08be`。最终 NSIS 为 71,115,790 字节、SHA256 `c776fd351d4ae7f3150cb2a4f47ff13af16402b4b549f92ecb099ac9ba6782e2`，见 `test-results/candidate/candidate-build.json` 与 `local-validation.json`。

该文件使用 `com.rivloom.conversationpreview`，Authenticode 为 NotSigned，未安装、未发布；独立 NSIS runtime 解包已通过，全部 runtime 文件与 prepared/manifest/候选树摘要一致，报告为 `test-results/candidate-extraction-1788592034424/verification.json`。外层 Rivloom.exe 与安装脚本语义不在该核对范围；SECURITY 与 Git blob 存在一个 CR 换行差异，规范化文本相同，未声称该文档与 Git blob 逐字节相等。本地 gate/构建不代表桌面云 CI、安装、更新或双物理机验收；M3.5 用户交付最新版仍为 `docs1`。详细证据及后续核对见维护者本地验证记录。

## 调用与输出

```sh
node scripts/ci-verify-runtime.ts --profile conversation-preview
node scripts/ci-verify-runtime.ts --root <checkout> --runtime <prepared-runtime> --profile desktop
node --test tests/ci-runtime.test.ts
```

`--root` 默认是脚本所在仓库；`--runtime` 默认是该 root 下的 `src-tauri/resources/runtime`。`--profile` 只接受 `desktop` 和 `conversation-preview`，默认 `desktop`。重复、未知、缺值参数以及跳过校验的参数均拒绝。

成功退出码为 0，stdout 输出 JSON，包含 `schemaVersion: 1`、`status: "passed"`、实际核对的 `product`、`target`、`inputs`、`binaries`、`documents`、包和许可文件数量。失败退出码为 1，stdout 为 `schemaVersion: 1`、`status: "failed"` 与 `errors`。调用方可把 stdout 保存为独立报告；校验器不覆盖候选目录、仓库记录或既有 `.data` 产物。

实际二进制校验需要 Windows。仅在两个二进制都已通过受控路径、PE x64 格式和固定 SHA256 检查后，才各运行一次 `--version`。探测使用新建的临时工作目录、独立 HOME/XDG/AppData 和环境白名单，不继承模型凭据、代理、Node 注入参数或个人引擎配置；临时目录结束后清理。它不启动模型服务、不安装客户端，也不发起模型调用。OpenCode 的 PE 资源版本不作为 CLI 版本证据。

Rust 对照使用 `cargo metadata --locked --offline --filter-platform x86_64-pc-windows-msvc`，只解析当前锁定且已缓存的依赖，不编译或下载。`RUSTUP_TOOLCHAIN` 显式固定为 1.98.1；外部选择其他版本会失败。环境保留 Cargo/Rustup 缓存位置和必要系统路径，不继承注册表访问令牌、RUSTFLAGS 或 RUSTC_WRAPPER。缓存或固定工具链不完整就失败，不能把缺失依赖当作未使用。

## 准备顺序与身份

`scripts/desktop-prepare.ts` 新增相同的 `--profile` 参数。预览 Tauri 配置的 `beforeDevCommand`、`beforeBuildCommand` 显式传入 `conversation-preview`；正式配置沿用默认 `desktop`。准备脚本读取正式 Tauri 配置，并在预览情况下合并预览覆盖配置，从实际配置记录 identifier 与 version。

候选流水线先完成依赖与许可准备，再执行指定 profile 的 `desktop:prepare`，随后独立执行本校验。若流水线已经准备并校验了 runtime，Tauri 打包阶段应关闭重复的准备钩子，打包后再次校验。清单哈希前后相同只能证明清单文件相同；完整运行时是否被打包步骤改写，要用候选流程独立的整个目录内容摘要证明。

校验只承认 `com.rivloom.desktop` 和 `com.rivloom.conversationpreview` 各自对应的 profile。独立预览不会因为版本号与正式客户端相同而获得正式身份；此校验也不授予签名、安装、升级或公开发布资格。

## 清单 v1 的必需证据

旧版无 schema/身份清单拒绝，不能降级兼容为合格候选。准备脚本必须生成：

- `schemaVersion: 1`、`builtAt`、`product: { kind, identifier, version }`、Windows x64 的 `target`。
- `inputs.packageLockSha256` 与 `inputs.cargoLockSha256`，绑定此次使用的实际锁文件。
- `node`、`opencode` 的固定版本、SHA256、来源。
- `documents` 中唯一的 `README.md` 和 `SECURITY.md` 路径及 SHA256。
- `packages` 中每个随包 npm 路径、版本、完整性字段。
- `notices` 中第三方声明、Node 许可、npm/Rust 许可清单，以及 `docs/licenses` 全部原文与保留源码归档的路径和 SHA256。Rust 清单不再可选。

清单路径必须是受控的相对路径。路径穿越、重复清单路径、符号链接和解析到候选目录外的文件均失败。

## 独立交叉核对

1. **身份和依赖**：对照 source package、npm 锁根、Cargo package/lock、实际 profile Tauri 配置与随包 `package.json` 的版本；对照声明依赖。清单和真实 `node_modules` 包目录须精确等于锁文件的 Windows x64 生产依赖集合，逐包核对实际 name/version、锁定版本及 integrity。缺包、额外包、漏清单或版本漂移均失败。
2. **说明文件**：重新读取实际随包 README/SECURITY，计算摘要，同时与仓库 `DESKTOP-README.md`、`SECURITY.md` 比较。只修改清单中的摘要不能掩盖与源文档不一致。
3. **许可证与清单**：重新计算每份实际随包文件摘要，与 manifest 和仓库原文分别比较；Node 许可与准备使用的 `.data/desktop-downloads/Node-LICENSE.txt` 比较。当前步骤不联网重新确认原文来源，也不把缓存摘要当作上游签名。
4. **npm 许可**：每个随包生产依赖必须有对应版本、完整性记录和明确的 `licenseFile`，引用的原文必须存在。依赖内提供了 LICENSE 时，再把随包声明原文与实际依赖的原文比较，避免生成器按包名覆盖不同版本的声明。完全一致的重复 name/version 行允许，冲突重复行失败。开发工具的空许可项不会当作随包运行依赖，仍应在发行人工审查中处理。
5. **Rust 许可**：清单集合须与当前 Cargo 独立解析的 Windows 依赖集合一致，包含该解析集的构建期依赖；名称、版本、SPDX 与 Cargo 对照。每个原文必须存在并与 Cargo 缓存内提供的原文一致。包内缺少原文时须保留明确的上游来源记录，并与已审查的仓库原文一致。MPL 项必须随包保留对应 `.crate` 源码归档，重新计算摘要并核对 Cargo.lock 的 registry checksum。
6. **运行二进制**：Node 的 SHA256 匹配 `desktop-prepare.ts` 固定值；Windows OpenCode 匹配固定源代码的构建记录或已批准导入摘要，详见上方当前契约。随后核对两个真实 CLI 的 `--version` 输出，拒绝失效源码 pin、未通过 smoke、脏源及不一致产物。

此校验不重新验证 npm tarball 内每个 JavaScript 文件，也不计算 server/shared/dist 的完整内容基线。npm integrity 字段比较不等同于重新计算安装后目录的 tarball integrity；许可证清单也不是完整二进制 SBOM。源码来源、干净构建、目录摘要和最终安装包证据属于相邻的候选流程，不能从此报告推断。

## 前置检查点与已修复缺口

- 初查时的旧 `src-tauri/resources/runtime/runtime-manifest.json` 没有 `schemaVersion/product/target/inputs/notices`，只读校验按预期退出 1；此为修复前记录。
- 初查 npm 清单有三个运行依赖和三个开发依赖缺少原文映射。本轮已修复 `scripts/notices.ts` 并实际重新生成：121 个唯一依赖版本、126 份原文，所有条目均明确关联原文。新目录使用 `licenses/npm/<包名>/<版本>/<原文文件名>`；完全相同的重复身份合并，原文或 metadata 冲突拒绝；既有旧文件名未删除。
- 缺少包内许可的版本仅使用经过核对的上游映射，保存 `licenseSources` 的来源、版本证据、源码 revision、Git blob 与 SHA256。下载内容还须匹配固定的已核对 Git blob。未知版本缺原文直接失败，不使用笼统的当前主分支文本。Tauri 同时保留 MIT 和 Apache 两份原文。
- 新增准备字段、预览钩子与校验器先完成小夹具验证。提交前随后执行一次 `desktop:prepare -- --profile conversation-preview`，以固定 Rust/Cargo 1.98.1 完成实际只读 gate：两个官方二进制的哈希、PE 架构和版本均匹配，88 个 runtime 依赖、267 个 Rust 依赖与 722 个声明文件通过。记录为 `.data/verification/ci-desktop-prepare.log` 和 `.data/verification/ci-runtime-precommit.json`。当时尚未执行 NSIS；提交后的实际构建与前后 gate 已记在上方最新验证中，安装及桌面云运行仍未完成。
- `.gitattributes` 对版本化 npm/Rust 原文指定 `-text`，避免 Git 把上游 CRLF 改为 LF。原文完整性按字节验证；不能靠重新计算改写后的摘要放宽该检查。

16 个小夹具测试覆盖旧清单、身份误标、哈希漂移、清单重算掩盖文档漂移、缺许可/缺 Rust 清单、npm 原文覆盖、Rust 漏依赖/错误源码归档、实际包版本/额外包、二进制哈希/架构/版本及失败退出码，以及生成器的版本隔离、重复身份冲突和未知来源拒绝。夹具 PE 和版本探测替身均明确为测试数据，不是正式二进制验证证据。

## 缺失原文的版本来源

- OpenCode SDK 与 Windows 二进制 1.18.25 使用官方 [v1.18.25 MIT 原文](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.25/LICENSE)；SDK 版本通过同一 tag 的 [package.json](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.25/packages/sdk/js/package.json) 核对。
- Tauri API 2.11.1 的 [npm provenance](https://registry.npmjs.org/-/npm/v1/attestations/@tauri-apps%2fapi@2.11.1) subject SHA512 与当前 npm 锁定 integrity 一致，声明的官方源码提交为 `6f6ab1207bb3923c2721fbc67d2fdb1c8deb0c7a`。原文取自该提交的 [MIT](https://api.github.com/repos/tauri-apps/tauri/contents/LICENSE_MIT?ref=6f6ab1207bb3923c2721fbc67d2fdb1c8deb0c7a) 和 [Apache](https://api.github.com/repos/tauri-apps/tauri/contents/LICENSE_APACHE-2.0?ref=6f6ab1207bb3923c2721fbc67d2fdb1c8deb0c7a)。这是 HTTPS 注册表负载、内容与来源绑定核对，没有宣称完成 Sigstore 签名验签。
- Tauri CLI 与其 Windows 绑定 2.11.4 使用 [npm 版本元信息](https://registry.npmjs.org/%40tauri-apps%2Fcli/2.11.4) 中 `gitHead` 对应的 `59585e1aac2d2e3503aa1caececf3568dce51a47` 提交，两份许可均保存原文。
- Rolldown Windows 绑定 1.2.6 通过官方 [v1.2.6 package.json](https://raw.githubusercontent.com/rolldown/rolldown/v1.2.6/packages/rolldown/package.json) 与 npm 包信息核对，使用同一 tag 的 [LICENSE](https://api.github.com/repos/rolldown/rolldown/contents/LICENSE?ref=v1.2.6)。
