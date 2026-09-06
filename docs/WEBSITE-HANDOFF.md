# Rivloom 官网项目交接

更新：2026-09-06。供官网新任务恢复产品背景和既有决策使用；这是内部交接资料，不直接作为公开网页发布。

## 当前摘要（2026-09-06）

下一版源码版本为 **0.1.4**，安装包、GitHub Release 和官网下载文案统一使用 **Rivloom**。构建采用 `desktop` profile 和 `com.rivloom.desktop`，安装包名为 `Rivloom_0.1.4_x64-setup.exe`。旧 Preview 安装、数据、Release 和下载对象保持原状，本次没有自动迁移或合并旧 Preview 数据。

当前实现的发行顺序为：同一源码的三组 CI 通过 → Rivloom 候选构建 → 全新 GitHub 托管 Windows runner 的安装、启动、重启、卸载与受检数据保留检查 → 普通 GitHub Release。发布器要求 `prerelease:false`，标签绑定版本、源码和原始 artifact ID；`make_latest:false` 保留，官网通过独立清单选择新版。两个源码仓库保持私有，GitHub Release 下载仍需仓库访问权限。本次 0.1.4 的云端构建、安装验收与普通 Release 尚待新提交的实际运行结果，不能沿用下方旧 Preview 或官网部署的通过记录。

专用 R2 桶 `rivloom-downloads` 与 `downloads.rivloom.com` 已创建，自定义域名已激活，最低 TLS 版本为 1.2。长期 R2 访问凭据和官网 Pages `main` 部署 Hook 尚未获授权，尚未创建或接通；桌面 `RIVLOOM_PUBLIC_DOWNLOADS_ENABLED` 与官网 `publicDownloadsEnabled` 均未启用，公开下载仍关闭。新链路使用 `releases/latest.json` 和 `releases/v<版本>-<源码前12位>-<artifactID>/Rivloom_<版本>_x64-setup.exe`，不沿用旧 `previews/` 记录。接通后才按原始候选和发布 artifact ID 同步，匿名完整下载核对大小与 SHA-256，通过条件写入防止清单回退，再调用官网部署 Hook。

当前安装包仍未签名，客户端没有 updater 插件、公钥或更新端点，需要手动安装更新。统一名称和普通 GitHub Release 标记不代表已完成签名、stable/beta 更新频道或旧版本升级验收。详细当前流程见 [CI](CI.md)、[RELEASING](RELEASING.md)、[名称变更计划](plans/2026-09-06-rivloom-release-name.md) 与 [ADR-0008](adr/0008-rivloom-release-name.md)。

名称变更的官网源码 `62fa469` 已通过 [CI 34004790825](https://github.com/rivloom/rivloom-website/actions/runs/34004790825)，Cloudflare Pages 生产部署 `d5698ea1-5550-46bb-bc15-ff63c3ea8610` 已成功；正式域名下载页和更新日志返回 200，桌面与手机布局已核对，公开下载仍关闭。桌面首轮 `db23b54` 的基础 CI 全部通过，但安装验收发生 PowerShell 查询超时，发布被阻止；失败与修复验证见 [VERIFICATION](VERIFICATION.md)。

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
