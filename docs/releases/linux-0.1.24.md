# Rivloom Linux 0.1.24

2026-09-27：Linux x64 0.1.24 已正式发布，与 Windows 使用同一源码 [1993acc56a12f2900c717b852f828b6184b149b5](https://github.com/rivloom/rivloom-desktop/commit/1993acc56a12f2900c717b852f828b6184b149b5)。原生 CI、公开文件完整性、WSL 隔离运行和官网双语命令核对通过；R2 检查完成，删除 0 个。正式页面及资源已匹配核验构建；GitHub 上的 Cloudflare Pages check 仍为 in_progress，尚无最终结论。

## 正式文件

| 文件 | 字节数 | SHA256 |
| --- | ---: | --- |
| [Rivloom_0.1.24_linux_x64.tar.gz](https://downloads.rivloom.com/releases/linux/linux-v0.1.24-1993acc56a12-36325882655/Rivloom_0.1.24_linux_x64.tar.gz) | 157181505 | `f17c1883d6b661395b35166be211972a84b99b45fef617987c724826742c3acf` |
| [SHA256SUMS.txt](https://downloads.rivloom.com/releases/linux/linux-v0.1.24-1993acc56a12-36325882655/SHA256SUMS.txt) | 98 | `39a5bd8b20de704551b2568faad8699cc41cb990fabca768c618fbd16fb28e28` |

[GitHub Release](https://github.com/rivloom/rivloom-desktop/releases/tag/linux-v0.1.24-1993acc56a12-36325882655) · [Linux 下载记录](https://downloads.rivloom.com/releases/linux/latest.json)。候选 artifact 为 `10933789708`。

## 本次变化

- 与 Windows 0.1.24 使用同一源码，带入当前 Node 的模型用量和输出速率活动收集、知识操作状态与 owner 权限接口。输入按近 60 秒新确认用量计算，最近 3 秒输出为估算值；不产生额外模型请求，也不汇总其他 Node。
- 桌面侧栏动效、弹出面板、文件和待办反馈属于 Windows 客户端；Linux 继续提供无 GUI 的 x64 节点，保留 SSH、信任、项目与模型工作流。Linux 包本身不包含 Windows 桌面视觉交互。
- 固定核心为 `1.18.31-rivloom.9b07cf442a7e`，SDK/plugin 1.18.31，随包 Node.js 24.19.0。

## 安装与验证状态

[Linux 原生 CI 36325882655](https://github.com/rivloom/rivloom-desktop/actions/runs/36325882655) 最终 attempt 1 与[独立发行 36326928797](https://github.com/rivloom/rivloom-desktop/actions/runs/36326928797) 最终 attempt 1 均通过并绑定上述源码。本轮 Node 活动、owner 权限和合成任务遥测检查在 Linux 原生 CI 执行，既有协议、固定引擎及包内启动门槛继续执行。

公开 tar.gz 使用 curl 和 wget 各自完整下载、核对 SHA256 并分别解包。 WSL x64 使用 v24.19.0 验收，核对 17695 个 Runtime 文件、发行源码及 CLI 0.1.24。隔离 HOME 下数据目录权限为 0700、控制文件为 0600，默认禁止执行；启动、重启、两次 SIGTERM 正常退出及节点身份保持通过。未在该公开包验收中配置模型或运行真实任务，未修改用户安装、项目或 systemd。

官网源码 [4ef822c1ee99ea1971f94a7e12a6c2e138b34bd1](https://github.com/rivloom/rivloom-website/commit/4ef822c1ee99ea1971f94a7e12a6c2e138b34bd1)。正式站点 16 个页面正文与 6 份 CSS、JS、图片资源均匹配核验构建，资源逐字节一致。GitHub 上的 [Cloudflare Pages check 108647004718](https://github.com/rivloom/rivloom-website/runs/108647004718) 仍为 in_progress，尚无最终结论；本次只将正式内容核验记为通过，未将该检查记为成功。 中英文 curl/wget 命令逐字匹配公开记录并通过 shell 语法检查；x64 入口 302 指向本版归档，ARM64 入口保持 404。命令文本核对不扩大实际下载方式的覆盖范围。

本轮本地浏览器记录 18 项布局检查：中英文指南与更新日志在 1440/390/320 宽度共 12 项，以及最终首页同样宽度共 6 项；新截图已目视检查。生产端仅取得中文首页可访问性树，确认本版下载与新截图图注；之后响应式检查因浏览器桥接连续超时而未完成。生产视觉覆盖记为 partial，本地布局和正式 HTML/CSS/图片匹配不作为新一次完整生产浏览器视觉验收。

首次功能源码 [fe3abd8c723a20361d6e41759f99244f561dc6cc](https://github.com/rivloom/rivloom-desktop/commit/fe3abd8c723a20361d6e41759f99244f561dc6cc) 的 [Linux CI](https://github.com/rivloom/rivloom-desktop/actions/runs/36325536868) 在 Node 活动相关组中通过 46/47 项；唯一失败是全新工作目录缺少临时目录父级，导致 task telemetry fixture 创建时报 ENOENT。修复提交 [1993acc56a12f2900c717b852f828b6184b149b5](https://github.com/rivloom/rivloom-desktop/commit/1993acc56a12f2900c717b852f828b6184b149b5) 显式创建该父级，全新 cwd 的单项回归 1/1 通过。旧源码的 [Windows official engine checks 36325536845](https://github.com/rivloom/rivloom-desktop/actions/runs/36325536845)、[Windows build and release 36325676370](https://github.com/rivloom/rivloom-desktop/actions/runs/36325676370) 已取消，未作为本版发行。当前正式包重新绑定修复后的源码；最终同提交 CI 结果以[整版验收](0.1.24-verification.md)中的 CI 表格为准。

修复源码的 Windows 服务矩阵首轮 20/21 成功，context-continuity 在最终停机证明阶段等待 6131 ms 后超时失败；原停止门槛和源码未改，仅重跑失败项。Windows 候选首轮也被同源码门槛阻止，三个发布 job 跳过；服务重跑通过后再重跑候选。保留的早期 attempt：[Windows official engine checks 36325882700](https://github.com/rivloom/rivloom-desktop/actions/runs/36325882700) attempt 1 为 failure（失败 job：Official engine / context-continuity）；[Windows build and release 36326021693](https://github.com/rivloom/rivloom-desktop/actions/runs/36326021693) attempt 1 为 failure（失败 job：Build and verify Rivloom candidate）。后续成功只代表表格所列最终 attempt，不改写此前失败或取消的记录。

## 范围与发行收尾

本轮未新增真实内网模型业务任务、实体 Linux 多机、最低系统版本或完整跨版本升级矩阵验收；不以 Windows 开发结果代替 Linux 的实际门槛。没有新增原生窗口视觉验收。

R2 保留 91、暂缓 0、可删除 0、删除 0 个。**检查完成，删除 0 个。** 两平台各自最近三版、近 30 天与当前引用取并集，未启用自动清理。见[整版验收](0.1.24-verification.md)和[逐对象审计](0.1.24-r2-retention.md)。

Linux 继续手动升级：先停止节点、保留数据目录，再按 [Linux 节点说明](../LINUX.md)安装并核对校验值。SHA256 用于检查文件一致性，不等同于发行签名。ARM64 本版不提供正式下载。
