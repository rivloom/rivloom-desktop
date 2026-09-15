# Rivloom 官网项目交接

## 2026-09-15 · 官网精简与当前 UI 配图（已部署）

用户明确官网不需要特别标明外部 PR 政策，产品形态调整期间减少介绍。官网已移除相关中英文说明及维护政策入口；源码与反馈入口保留。全站右上角为“中文 / EN”，链接同一页面，手机菜单紧邻其左侧。首页改为一句介绍、真实界面和设备协作/共享 Skills/渐进式 Wiki 简述，工作方式缩为三个步骤，具体操作留在指南。

新中英文截图由当前桌面生产 UI 构建生成，0.1.15 以来 src/shared/server 无变更；采用隔离合成任务与草稿，不读取用户数据或调用真实模型。完整 1440×900 视口按 2 倍像素截图，官网标注演示内容。今后随实际 UI 更新配图，不再沿用早期界面。

官网提交 `5acce94a84917040658d596b4ea42fbdc5b0227b` 已推送，[Cloudflare Pages 部署](https://dash.cloudflare.com/?to=/cd32cbd5ec257713adb47572ea24f771/pages/view/rivloom-website/f56203ee-455e-4049-9167-86ea6c29e8c5)成功。41 项测试、18 页构建、96 组全站布局，以及后续 12 组布局/12 组菜单和语言交互检查通过；正式域 26 项页面/图片/下载检查、32 组双语桌面/手机布局和 4 组交互通过，无页面或控制台错误。两张线上图片与已检视本地文件逐字节一致；下载继续为 0.1.15，安装包 HEAD 200、89,188,353 字节。官网 Actions 为 disabled_manually，本次没有运行；官网继续私有，由 Pages 构建和部署。

证据：两仓库忽略目录 `.data/verification/website-refresh-20260915/`，官网产品与实施约定已同步。桌面仓库只更新交接并使用 `[skip ci]` 提交，无新安装包或 R2 删除；三个公开仓库的 PR 设置未改。以下“官网明确暂不接受 PR”仅为被本次决定取代的历史记录。


**2026-09-15 · 阶段性暂停外部 PR：** 用户先自行开发到合适阶段，再接受外部 PR。官网与 README 统一说明“暂不接受，计划在后续开发阶段开放，具体时间另行公布”。源码继续采用 Apache-2.0，桌面 Issue 与私密漏洞报告继续开放，三个公开仓库继续仅允许协作者创建 PR。外部 PR 验收暂缓，重新开放前再执行；源码使用及自行 fork 的权利依许可证保持。

官网澄清提交 `1598c8bb2955fce9d8562fc9c713e948ae87aa2b` 已推送，Pages 部署 `2e65f4df-b3d9-40dc-bd07-21884b547ad1` 成功，官网 Actions 未新增运行。41 项测试、18 页构建及本地 8 组双语桌面/手机布局通过；此阶段性说明覆盖下方此前独立维护文案。正式域与线上布局证据见官网 `.data/verification/temporary-pr-pause-20260915/`。

官网提交 `f5d5f540eb64ea17fdf6a9d800571746890f9f4f` 已推送，Cloudflare Pages 部署 `3cee9b80-1224-49a3-8923-ce3cb4d95ff4` 成功，GitHub Actions 没有新增运行。41 项测试、18 页构建及本地 16 组双语桌面/手机布局、4 组导航交互通过；正式域 23 项检查通过，16 条业务路由和 3 份资源与构建一致，下载仍指向已发布的 0.1.15。新一轮线上布局及具体内容记录在官网 `.data/verification/maintainer-only-20260915/`。

**2026-09-15 · 官网 Actions 已按用户决定停用。** 官网提交 `c4b5b07391d34afd8dd507218ce1076d699b8b30` 已推送；工作流 `Website checks`（350740724）为 `disabled_manually`，源码移除 push/PR 自动触发。本提交没有产生 Actions 运行，唯一 Cloudflare Pages 检查成功（部署 `13f3dffe-9bce-44c0-ba57-c69c611e8f74`）。官网测试/构建/部署继续由 Pages 完成，不再把私有官网 Actions 的计费阻塞作为待办；桌面发布工作流保持原配置。本地 41 项测试与 18 页构建通过，详情见官网 IMPLEMENTATION 顶部和 `.data/verification/disable-website-actions-20260915/`。

## 2026-09-15 · 开源后的官网介绍已更新

**本节内容更新提交：`bf12e7e43d87f36582743b8850b9cb1b47097aec`（后续部署见顶部）。** [Pages 内容部署](https://dash.cloudflare.com/?to=/cd32cbd5ec257713adb47572ea24f771/pages/view/rivloom-website/1e168335-1819-4daf-9ac2-0551b802285c) 成功；正式域 23 项及最后 8 组英文桌面/手机复核通过。当时官网 Actions [34959210479](https://github.com/rivloom/rivloom-website/actions/runs/34959210479) 仍受计费阻塞，未启动测试。官网工作区已干净。

官网内容提交 `a0dca8e66de357b5c31e40bc422fa8779697ea73` 已推送并通过 [Cloudflare Pages 部署](https://dash.cloudflare.com/?to=/cd32cbd5ec257713adb47572ea24f771/pages/view/rivloom-website/c50db8af-f50d-4af0-a010-00cb9a93df0e)。新增中英文全站桌面源码与贡献入口、首页 Skills/Wiki 介绍、渐进读取/版本固定/手动分享指南及 GitHub Issue 和私密漏洞报告。修正首页手动验收暗示、安全页笼统技能限制和“暂无公开支持入口”；保持原设计与带早期标注的真实截图。桌面 Apache-2.0 公开、官网私有状态均经 GitHub API 复核。

41 项测试、18 页构建、674 个本地引用与 38 个片段链接通过；本地中英文 80 组布局、线上 32 组桌面/手机视口及各 4 组导航交互通过，代表截图已查看。正式域 23 项检查通过，3 份资源与已测试构建一致。使用隔离自动化浏览器，不是物理手机验收。

官网私有 Actions [34958071208](https://github.com/rivloom/rivloom-website/actions/runs/34958071208) 当时因账户付款/支出限额未启动，结果为 failure；Pages 独立成功，不能将 Actions 记为通过。后续已按用户决定停用重复 Actions，当前无需为官网构建处理此计费阻塞；部署渠道和可见性保持。

桌面版本保持 0.1.15；匿名完整下载 89,188,353 字节，SHA-256 `e4ae1776123b0f80a19d6e7c0d48fd9bec8c0823211c5e994c764e66c9e1b9f5`，公开校验文件、原公钥签名与当前下载/更新指向复核通过。本轮只更新官网，不重发桌面安装包或操作 R2；此前 0.1.15 保留审计（41 保留、0 暂缓、0 删除）继续有效。官网收尾提交 `bf12e7e43d87f36582743b8850b9cb1b47097aec` 补齐英文内联链接空格并记录验证结果，重新通过测试、构建与 8 组针对性布局检查。详细记录在官网 `docs/IMPLEMENTATION.md` 顶部，本机最终云端证据在官网 `.data/verification/open-source-20260915/`。本桌面交接记录纳入本次纯文档维护提交，以 `[skip ci]` 避免启动桌面自动发布。

**当前正式版本：0.1.15（2026-09-15，已发布并完成收尾）。** 共享 Skills 与渐进式 Wiki 记忆已发行。桌面安装包源码 `97ab7937b272278f876070de66ca3acc745dbe21`，官网源码 `29a8f27e1b6552976859346f0d522234b571f9f7`，构建 `v0.1.15-97ab7937b272-10387819109`。目标提交完整 CI、原生构建、隔离安装/启动/重启/卸载、Release、R2 与签名更新均通过；匿名完整下载、原更新公钥及官网实际部署核验通过。R2 41 个对象：保留 41、暂缓 0、删除 0，当前引用复核通过。下方“未提交/待重跑/发布准备/0.1.14”均为历史阶段，不覆盖本段。

**当前正式版本：0.1.14（2026-09-14，已发布并完成收尾）。** 桌面安装包源码 `0f8d8b5b68f8df6357a8deaec8ead7be29d39465`，官网源码 `269d9ead1e3e988f08a294f748ca9dd1514dd5b4`，构建 `v0.1.14-0f8d8b5b68f8-10337835771`。目标提交三组 Windows CI、原生构建、隔离安装/启动/重启/卸载、Release、R2 与签名更新全部通过；匿名完整下载及原更新公钥核验通过，中英文官网已实际部署。R2 38 个对象逐项核对：保留 38、暂缓 0、删除 0，当前引用复核通过。下方“发布准备/未发行/0.1.13”均为历史记录，不覆盖本段状态。

**2026-09-14 · 0.1.14 发布准备：** 用户已授权发布当前实现。本版包含会话内容搜索与定位、模型自由选择、厂商 OAuth/API Key、自定义 OpenAI 兼容 Provider（Chat Completions / Responses）。本地 403 项逻辑、3 项官方引擎、12 组模型服务、10 组模型 UI 和 14 组搜索回归通过。正式发布须完成目标提交完整 CI、隔离安装、公开下载与原密钥签名核验、官网实际部署和 R2 保留检查。真实 OAuth 登录与真实额度调用仍留待用户验收。下面“未提交/未发布/0.1.13”均为历史状态，以本页顶部为准。

**2026-09-11 · 0.1.13 发布准备：** 用户已授权提交、推送和发布更新。本版包含简洁输入框、失败步骤重试、结果分层、远端文件按需取回与紧凑排版；本地验证通过，正式发布待目标提交完整 CI、隔离安装、公开下载和签名核验。沿用既有更新密钥与发布流程。下面“未提交/未发布”的开发段落保留为当时记录，不能覆盖本段状态。

## 当前交接：2026-09-10

0.1.12 已公开发布并完成官网同步。桌面提交 c039c7b8a3d43898d48ccedb469cbd79b68005ad，官网提交 7daee76d1d560fcaafad1eb44557e373a01ec9c9；正式构建 v0.1.12-c039c7b8a3d4-10156362780。官网 CI、Cloudflare 部署和正式域 23 项检查通过，16 路由/3 份资源与已测试构建一致。中英文指南、更新日志、隐私与下载记录已同步连续会话队列、Markdown、草稿和附件体验。

官网仍在独立仓库 C:/project/rivloom-website。继续前读其 AGENTS.md、docs/PRODUCT.md、docs/IMPLEMENTATION.md 与 README.md；不把桌面 dist 当作官网发布。当前应用内更新签名已上线，Windows 发布者签名尚未具备。新会话总入口见 [NEXT-SESSION](NEXT-SESSION.md)，发行证据见 [VERIFICATION](VERIFICATION.md)。

## 以下为 2026-09-06 的历史接通记录

其中“当前 0.1.4”“没有 updater”等表述只说明当时状态，不代表最新产品能力。

更新：2026-09-06。供官网新任务恢复产品背景和既有决策使用；这是内部交接资料，不直接作为公开网页发布。

## 当前摘要（2026-09-06）

当前已发布版本为 **0.1.4**，安装包、GitHub Release 和官网下载文案统一使用 **Rivloom**。构建采用 `desktop` profile 和 `com.rivloom.desktop`，安装包名为 `Rivloom_0.1.4_x64-setup.exe`。旧 Preview 安装、数据、Release 和下载对象保持原状，本次没有自动迁移或合并旧 Preview 数据。

当前实现的发行顺序为：同一源码的三组 CI 通过 → Rivloom 候选构建 → 全新 GitHub 托管 Windows runner 的安装、启动、重启、卸载与受检数据保留检查 → 普通 GitHub Release。发布器要求 `prerelease:false`，标签绑定版本、源码和原始 artifact ID；`make_latest:false` 保留，官网通过独立清单选择新版。两个源码仓库保持私有，GitHub Release 下载仍需仓库访问权限。当前公开构建为 `v0.1.4-84dfc09fc756-9983464069`，对应运行 `34013763737` 第 2 次执行，原候选 artifact `9983464069`，完整云端验证通过。

专用 R2 桶 `rivloom-downloads` 与 `downloads.rivloom.com` 已接通，自定义域最低 TLS 版本为 1.2。用户已授权并配置限桶对象读写的 R2 凭据和官网 Pages `main` Hook；桌面 `RIVLOOM_PUBLIC_DOWNLOADS_ENABLED` 与官网 `publicDownloadsEnabled` 均为 true。替代 Hook 已实际调用通过，旧 Hook 已撤销；R2 请求显式禁用压缩以保留强 ETag，实际条件更新成功。同步报告 `9983479753` 确认原候选与 Release、公开下载字节一致。入口为 `releases/latest.json` 和 `releases/v<版本>-<源码前12位>-<artifactID>/Rivloom_<版本>_x64-setup.exe`，不沿用旧 `previews/` 记录。

当前安装包仍未签名，客户端没有 updater 插件、公钥或更新端点，需要手动安装更新。统一名称和普通 GitHub Release 标记不代表已完成签名、stable/beta 更新频道或旧版本升级验收。详细当前流程见 [CI](CI.md)、[RELEASING](RELEASING.md)、[名称变更计划](plans/2026-09-06-rivloom-release-name.md) 与 [ADR-0008](adr/0008-rivloom-release-name.md)。

官网 `eef01e1` 已通过 [CI 34013777856](https://github.com/rivloom/rivloom-website/actions/runs/34013777856)，新 Hook 触发的 Pages 生产部署 `c59fc2ed-abd5-4451-8dc7-6658e0562562` 成功，35 项测试、9 页及 238 个引用检查通过。正式域名和真实桌面浏览器已显示新 0.1.4 构建及正确链接。另行匿名完整下载的安装包为 72,693,201 字节，SHA-256 `db56e20eb5f3d6090ffc06eeacaa322e00baf9372bec2584daaaa49ef382e41c`，与原 Release 一致；本次布局未改，此前手机和 FAQ 结果保留。首次测试失败与重跑，以及此前构建历史见 [VERIFICATION](VERIFICATION.md)。

## 历史快照（2026-09-05，以下原文保留）

从下方“目标与仓库边界”至文末是 2026-09-05 的交接原文。其中“当前”“本轮”“R2 仍待配置”等措辞只描述当时检查点；旧版本、安装包和云端链接用于追溯历史，不覆盖上方当前摘要，也不证明 0.1.4 已完成云端发行或公开下载。

## 目标与仓库边界

Rivloom 官网首版已部署到 [rivloom.com](https://rivloom.com)，独立网站 CI、统计隐私说明与生产索引指令已完成本轮验证；桌面候选包已完成本地验证。正式下载和应用内更新仍按各自验证结果推进，不以网站上线替代发行或升级验收。

| 范围       | 位置与职责                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 桌面客户端 | 现有 `rivloom/rivloom-desktop`；`C:/project/rivloom-opencode`。负责桌面 UI、本地服务、Node 协作、安装包、客户端更新与桌面发布流水线。    |
| 官网       | 已建 `rivloom/rivloom-website`，已克隆到 `C:/project/rivloom-website`。独立 Git 仓库，负责产品介绍、下载、公开文档、更新日志和网站部署。 |
| 发行产物   | 独立下载存储/CDN，提供不可变安装包、签名、哈希和版本记录；不把安装包提交进官网源码。                                                     |

官网目录与桌面目录并列，不在桌面仓库里嵌套另一个 Git 仓库。桌面 `src/` 和 `dist/` 是 WebView 应用，不是可直接上线的官网。

## 产品事实与公开口径

Rivloom 是人与 AI 的任务工作区，目前产品交付和验证集中于 Windows x64 桌面客户端，使用 Tauri、本地 Node 服务和官方 OpenCode 执行引擎。当前版本为 0.1.3，官方 OpenCode/SDK 为 1.18.25；正式发布时重新核对版本，不能把本快照长期当作最新版本源。

- 主界面是会话：选择文件夹与模型，发送任务，查看消息、工具结果、审批、问题和验收；支持继续与停止。
- Project 可以是普通文件夹，不要求 Git 仓库或干净工作区。结果展示官方 OpenCode 会话差异；不以 Git diff、磁盘扫描或文件内容哈希兜底。
- 每台 Node 管理自己的文件夹、模型、凭据和执行准入。已配对设备通过认证加密通道协作；本地备注名仅保存在本机。
- 新会话可以 `@Node`，绑定稳定 Node ID。目标普通忙碌时仍在目标排队；离线或不可收件时明确提示，不静默改发本机或其他设备。
- 持久 Node 队列支持调序、暂缓、恢复、拒绝和暂停；排位与原因沿原任务路由回传。暂停阻止尚未准入的任务继续准入，不等于停止已执行的任务。
- 自动分配沿 Brain/Task/Execution 路由；多个 Brain 可以共享 Worker，每项 Task 只属于一个 Brain。当前 Master 固定，没有选主、HA 或跨 Brain Task 迁移。
- 审批有“请求批准 / 帮我批准 / 允许任何操作”三种模式。实际规则与风险说明以桌面 `SECURITY.md` 为准；不宣称所有修改都要人工审批或远程审批尚未实现。
- AI 工具以执行主机当前用户权限运行，不提供操作系统安全沙箱。模型请求可能把提示、代码和工具结果发给用户选择的模型提供方，不宣称所有数据都不出本机。

官网暂不把任务自动拆解、企业人员治理、HA、全平台支持或应用内自动更新写成已交付能力。定价与商业模式尚未确定；官网使用用户于 2026-09-05 提供的正式蓝色 Logo 和蓝色配色，素材与用法见 [BRAND](C:/project/rivloom-website/docs/BRAND.md)。真实桌面预览截图保留原貌。域名已确认为 `rivloom.com`，首版不开放下载。不虚构客户、使用量、评价或性能指标。

## 当前交付与验证状态

M3.5 A–D 已完成工程交付，包括草稿稳定目标、创建幂等、自动分配候选修复、持久队列、统计/回执和会话界面。功能提交 `f946487`，安全说明与随包文档修订提交 `df2e77f`。用户验收及本轮双物理机回归仍待进行。

功能交付的隔离服务检查为 12/12，两处真实 session 创建崩溃窗口和 Debug/Release 原生操作有通过记录；全量测试为 154/155，唯一已有纯 mDNS 失败保留。确定性本机模型与同机多实例验证不能宣传为本轮双物理机、真实模型编程或全部网络环境通过。

当前供本机检查的文档修订预览为 `.data/distribution/Rivloom_M3.5_Node_P0_Preview_0.1.3_docs1_x64_setup.exe`，未签名、未安装；它是独立 Preview 身份，不直接作为正式 stable/beta 下载发布。精确大小、哈希和历史证据以 `docs/UI-HANDOFF.md`、`docs/VERIFICATION.md` 为准。

候选验证记录已在 `d0ffd4c` 提交；基于源码 `86463bf` 的 CI Preview 候选包已完成本地运行时前后门禁、原生构建、候选记录和独立 NSIS 解包核对，仍未安装、签名或公开发行。候选包不自动替代上述功能交付预览。桌面仓库推送和云端 CI 运行已获本轮用户授权，云端结果按实际推送提交核对，不能把本地验证或官网 CI 通过写成桌面云端 CI 通过；证据见 [CI](C:/project/rivloom-opencode/docs/CI.md)、[VERIFICATION](C:/project/rivloom-opencode/docs/VERIFICATION.md)。

## 官网和发布计划

官网已采用 Astro + TypeScript 静态站。用户确认域名为 `rivloom.com`，Cloudflare 同时面向中国大陆与海外，暂不增加国内专用 CDN；R2 下载存储仍待配置。首期页面包括主页、工作方式、Windows 下载状态、快速开始、更新日志、安全与隐私、反馈入口。使用已检查的真实客户端预览图，并注明演示任务。

网站与桌面分别运行 CI/CD。下载页与客户端更新源共用已发布版本记录，不在两个仓库手工维护两份版本信息。当前 0.1.3 尚无 updater：计划先手动升级到首个带 updater 的正式版本，再验证后续应用内升级；实现仍在桌面仓库。

推进顺序：A 确认公开范围、账户和版本约定；B 桌面 CI 与 C 官网设计/网站 CI 可并行；D 完成下载与发行 CD；E 完成客户端退出、数据迁移和真实升级验证。官网仓库为 `rivloom/rivloom-website`，本机位于 `C:/project/rivloom-website`。Cloudflare Pages 项目 `rivloom-website` 已通过 Git 集成部署 `main`，构建命令为 `npm run build:cloudflare`，输出目录为 `dist`；正式域名 [rivloom.com](https://rivloom.com) 已部署，SSL 状态为活动。首次 Cloudflare 部署使用源码 `a1b571b`，对应的 [官网 GitHub CI 33951987521](https://github.com/rivloom/rivloom-website/actions/runs/33951987521) 已通过；更早的提交 `edd51ed` 已取得首次绿色 [CI 33950924916](https://github.com/rivloom/rivloom-website/actions/runs/33950924916)。锁文件导致的失败是此前历史记录。

正式域验收已通过：DNS/TLS、8 条页面路由返回 200、未知路径返回 404、响应头和 8 项静态资源抽样；浏览器检查覆盖桌面以及 390px 移动端的首页、菜单、下载页和 FAQ。DNS/TLS 结果来自当前 Windows 网络与系统、1.1.1.1、8.8.8.8 查询，不代表全球传播或中国大陆访问性能已经全面验证。

本轮官网发布源码 `9a7bd94` 已推送且与远端一致，[GitHub CI 33955696338](https://github.com/rivloom/rivloom-website/actions/runs/33955696338) 通过，Cloudflare Pages 部署 `e256a0f4-1c68-4d24-aa02-5c82ab4040b7` 成功。与统计实际行为相符的 CSP 和官网隐私说明已上线；浏览器检查显示隐私内容正常，本次捕获的警告和错误为空。

用户已明确授权保留 Cloudflare RUM 统计，实际设置已核实为“启用，排除欧盟的访问者数据”。自然浏览后，2026-09-05 08:39:22 UTC 的统计面板显示访问量 1、页面浏览量 1、页面加载 1105 毫秒，细分图表仍提示数据不足。这是一个已接收样本，不能用于证明流量规模、性能基准或地区排除效果；本轮没有提交模拟遥测。浏览器和面板证据见 [RUM 验证记录](C:/project/rivloom-opencode/.data/verification/website-rum-browser-20260905.json)。

`site.config.json` 的 `productionIndexing` 已设为 `true`，生产站已开放抓取与收录指令。最终 HTTP 检查确认 8 条业务页面均为 200、`index, follow`、各自正式域 canonical，且无阻断索引的响应头；未知路径返回 404 并保留 `noindex, nofollow`；robots 允许抓取，sitemap 恰好包含 8 条正式页面。这不代表搜索引擎已经实际收录。证据见 [生产索引验证](C:/project/rivloom-opencode/.data/verification/website-indexing-9a7bd94/run-1788597527096/verification.json)。下载存储、正式签名与密钥保管仍属于后续发行工作。官网实现与实测记录见 [IMPLEMENTATION](C:/project/rivloom-website/docs/IMPLEMENTATION.md)。

## 从哪里恢复详细背景

以下均位于桌面仓库当前工作区；部分官网规划尚未提交，因此只读取远端 Git 可能缺少最新内容。读取时优先看各文档顶部的当前状态，历史记录不覆盖当前结论。

1. 完整分阶段方案：[官网、CI/CD 与更新计划](C:/project/rivloom-opencode/docs/plans/2026-09-05-website-ci-cd-and-updates.md)。
2. 发布与安全升级边界：[RELEASING](C:/project/rivloom-opencode/docs/RELEASING.md)、[ADR-0006](C:/project/rivloom-opencode/docs/adr/0006-website-distribution-and-safe-updates.md)。
3. 产品和使用：[README](C:/project/rivloom-opencode/README.md)、[随包使用说明](C:/project/rivloom-opencode/DESKTOP-README.md)。
4. 当前界面、预览和范围：[UI-HANDOFF](C:/project/rivloom-opencode/docs/UI-HANDOFF.md)。
5. 安全与验证原始口径：[SECURITY](C:/project/rivloom-opencode/SECURITY.md)、[VERIFICATION](C:/project/rivloom-opencode/docs/VERIFICATION.md)。

在另一台电脑或云端任务中工作时，应带上这份交接和所需参考文件，不能假定能读取本机绝对路径。官网仓库建立后，把稳定的产品摘要与已确认决策保存到其 `docs/`；根 `AGENTS.md` 只保留简短的阅读入口、工作范围和更新规则。发生新决策时同步摘要并标注日期。

## Codex 工作方式与新任务起始提示

独立 Git 仓库不要求独立 Codex 项目。可以把两个并列目录加入同一个本地项目，沿用当前任务；也可以单独建立官网项目，以交接文档恢复背景。新的任务有自己的对话记录，不依赖整段旧对话自动传入。长期约定放在文档或 `AGENTS.md` 中。[项目与任务说明](https://learn.chatgpt.com/docs/projects)、[AGENTS.md 说明](https://learn.chatgpt.com/docs/agent-configuration/agents-md)

可用于官网新任务的第一条消息：

> 这是 Rivloom 官网项目，桌面仓库在 C:/project/rivloom-opencode。请先阅读该仓库 docs/WEBSITE-HANDOFF.md，再阅读其中的官网/CI/CD/更新计划、README、UI-HANDOFF 和 SECURITY，恢复产品背景、已定边界与待定事项。把与官网有关的摘要保存到当前官网仓库 docs/，并在 AGENTS.md 设置简短阅读入口。先承接官网信息结构与设计方案；把待确认的供应商和发布选择与已确定内容分开，依据当前授权推进，不把规划能力写成已实现。
