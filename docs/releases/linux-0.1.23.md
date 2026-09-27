# Rivloom Linux 0.1.23

2026-09-27：Linux x64 0.1.23 已正式发布，与 Windows 使用同一源码 [e51726a6b19e3c701c0094b0f336387fb17e455d](https://github.com/rivloom/rivloom-desktop/commit/e51726a6b19e3c701c0094b0f336387fb17e455d)。原生 CI、公开 curl/wget 各自完整下载、校验及 WSL 隔离启动/重启/SIGTERM 已通过。官网本版内容已实际部署，双语下载命令与入口核对通过，R2 保留检查完成，删除 0 个。

## 正式文件

| 文件 | 字节数 | SHA256 |
| --- | ---: | --- |
| [Rivloom_0.1.23_linux_x64.tar.gz](https://downloads.rivloom.com/releases/linux/linux-v0.1.23-e51726a6b19e-36310611708/Rivloom_0.1.23_linux_x64.tar.gz) | 157167762 | `9eaba45b15361aa39e8125b44e9b9469a6512da2c76364207fd3eb2d009e8bc2` |
| [SHA256SUMS.txt](https://downloads.rivloom.com/releases/linux/linux-v0.1.23-e51726a6b19e-36310611708/SHA256SUMS.txt) | 98 | `c8274642a5f8d5dbb40828b8f6d9a2295017cb388f1204d37d35ec178b71b18c` |

[GitHub Release](https://github.com/rivloom/rivloom-desktop/releases/tag/linux-v0.1.23-e51726a6b19e-36310611708) · [Linux 下载记录](https://downloads.rivloom.com/releases/linux/latest.json)。发行标签为 `linux-v0.1.23-e51726a6b19e-36310611708`，候选 artifact 为 `10929167094`。

## 本次变化

- 与 Windows 0.1.23 使用同一版本源码，带入服务端的办公文件解析及有范围限制的文件读取能力，供授权项目和输入材料中的 PDF、DOCX、XLSX 等格式使用。实际格式支持与限制见[办公文件与模型连接](../OFFICE-WORKSPACE.md)。
- 保持 Linux 常驻节点的 SSH、信任、项目与模型工作流。桌面文件预览、侧栏及原生文件打开等交互属于 Windows 客户端；Linux 发行物仍是无桌面界面的 x64 节点。
- 固定核心保持 `1.18.31-rivloom.9b07cf442a7e`，SDK/plugin 保持 `1.18.31`，内置 Node.js 保持 `24.19.0`。

## 安装与验证状态

[Linux 原生 CI 36310611708](https://github.com/rivloom/rivloom-desktop/actions/runs/36310611708) 与[独立发行 36311026496](https://github.com/rivloom/rivloom-desktop/actions/runs/36311026496) 均在 attempt 1 通过，绑定上述源码；发行的来源核对、发布和公开下载三个 job 全部成功。

本版 CI 新增 Linux 原生办公解析与项目文件边界单测，以及固定引擎连接本机合成模型的办公服务验收：读取 DOCX、XLSX、PDF，拒绝越界路径后继续任务，保存报告，并在重启后保持配置。既有 CLI、节点协议、双节点合成任务、归档全树与包内启动验收继续执行。它们是 Linux 本轮实际结果，不使用 Windows 开发结果代替。

独立公开验收使用 WSL Ubuntu x64 和 Node.js 24.19.0：curl 与 wget 各自完整下载、核对 SHA256 后解包，逐一核对 17689 个 Runtime 文件、源码及 CLI 版本。新建隔离 HOME，核对数据目录 `0700`、控制文件 `0600`、默认禁止执行；启动、重启、两次 SIGTERM 正常退出和节点身份保持通过。下载进程沿用既有代理，应用进程使用隔离环境，不继承代理或真实凭据。未安装到用户环境，也未修改 systemd。

上述办公任务使用合成材料和确定性回环模型；真实内网模型可靠性、长材料完整性和复杂版式仍需实际业务验收。本轮未新增实体 Linux 多机、最低系统版本或完整跨版本升级矩阵验收。Linux 包没有 GUI，不包含 Windows 桌面文件预览或原生窗口视觉验收。

## 官网与发行收尾

官网源码 [495826125b08d47d702264f6275051fd86a494f0](https://github.com/rivloom/rivloom-website/commit/495826125b08d47d702264f6275051fd86a494f0) 已由 Cloudflare Pages 实际部署。中英文下载页的 curl/wget 命令逐字匹配本版公开记录，并通过 shell 语法检查；x64 入口返回 302 指向本版归档，ARM64 入口保持 404。页面核对复用已完成的下载证据，没有再次下载安装包。

[R2 只读清单](https://github.com/rivloom/rivloom-desktop/actions/runs/36312856390)及逐项保留审计完成：保留 86、暂缓 0、可删除 0、删除 0 个。**检查完成，删除 0 个。** 两平台分别保护最近三版 0.1.23、0.1.22、0.1.21，再与近 30 天和实际当前引用取并集；没有启用自动清理。详见[整版验收](0.1.23-verification.md)和[逐对象审计](0.1.23-r2-retention.md)。

Linux 继续采用手动升级：先停止节点、保留数据目录，再按 [Linux 节点说明](../LINUX.md)安装并核对归档校验值。校验值用于检查文件一致性，不等同于发行签名。ARM64 本版不提供正式下载。
