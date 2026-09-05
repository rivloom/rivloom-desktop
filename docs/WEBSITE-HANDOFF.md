# Rivloom 官网项目交接

更新：2026-09-05。供官网新任务恢复产品背景和既有决策使用；这是内部交接资料，不直接作为公开网页发布。

## 目标与仓库边界

当前正在设计和上线 Rivloom 官网、建立 Git CI/CD，并为客户端安全更新准备发行基础。用户已创建官网仓库，本任务已将其克隆并开始首版实现；托管上线、正式下载和应用内更新按各自验证结果推进。

| 范围 | 位置与职责 |
| --- | --- |
| 桌面客户端 | 现有 `rivloom/rivloom-desktop`；`C:/project/rivloom-opencode`。负责桌面 UI、本地服务、Node 协作、安装包、客户端更新与桌面发布流水线。 |
| 官网 | 已建 `rivloom/rivloom-website`，已克隆到 `C:/project/rivloom-website`。独立 Git 仓库，负责产品介绍、下载、公开文档、更新日志和网站部署。 |
| 发行产物 | 独立下载存储/CDN，提供不可变安装包、签名、哈希和版本记录；不把安装包提交进官网源码。 |

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

官网暂不把任务自动拆解、企业人员治理、HA、全平台支持或应用内自动更新写成已交付能力。定价与商业模式尚未确定；官网已采用 Rivloom 现有图标和绿色视觉，域名已确认为 `rivloom.com`，首版不开放下载。不虚构客户、使用量、评价或性能指标。

## 当前交付与验证状态

M3.5 A–D 已完成工程交付，包括草稿稳定目标、创建幂等、自动分配候选修复、持久队列、统计/回执和会话界面。功能提交 `f946487`，安全说明与随包文档修订提交 `df2e77f`。用户验收及本轮双物理机回归仍待进行。

功能交付的隔离服务检查为 12/12，两处真实 session 创建崩溃窗口和 Debug/Release 原生操作有通过记录；全量测试为 154/155，唯一已有纯 mDNS 失败保留。确定性本机模型与同机多实例验证不能宣传为本轮双物理机、真实模型编程或全部网络环境通过。

当前供本机检查的文档修订预览为 `.data/distribution/Rivloom_M3.5_Node_P0_Preview_0.1.3_docs1_x64_setup.exe`，未签名、未安装；它是独立 Preview 身份，不直接作为正式 stable/beta 下载发布。精确大小、哈希和历史证据以 `docs/UI-HANDOFF.md`、`docs/VERIFICATION.md` 为准。

## 官网和发布计划

官网已采用 Astro + TypeScript 静态站。用户确认域名为 `rivloom.com`，Cloudflare 同时面向中国大陆与海外，暂不增加国内专用 CDN；R2 下载存储仍待配置。首期页面包括主页、工作方式、Windows 下载状态、快速开始、更新日志、安全与隐私、反馈入口。使用已检查的真实客户端预览图，并注明演示任务。

网站与桌面分别运行 CI/CD。下载页与客户端更新源共用已发布版本记录，不在两个仓库手工维护两份版本信息。当前 0.1.3 尚无 updater：计划先手动升级到首个带 updater 的正式版本，再验证后续应用内升级；实现仍在桌面仓库。

推进顺序：A 确认公开范围、账户和版本约定；B 桌面 CI 与 C 官网设计/网站 CI 可并行；D 完成下载与发行 CD；E 完成客户端退出、数据迁移和真实升级验证。首版官网提交 `f58049f` 已推送，9页静态构建、234个本地引用及13项发行目录测试通过。首次云 CI 因锁文件缺少跨平台依赖而失败；修复提交 `edd51ed` 已通过 Linux x64 的 `npm ci --dry-run`，推送及后续云验证进行中。用户已明确授权 Cloudflare 仅访问官网仓库并继续部署、绑定 `rivloom.com`；已完成 GitHub 二次验证并确认组织连接。正式签名与密钥保管仍待落实。官网当前实现和验证见其 `docs/IMPLEMENTATION.md`。

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
