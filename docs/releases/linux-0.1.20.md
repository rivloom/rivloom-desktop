# Rivloom Linux 0.1.20：x64 命令行执行节点

**2026-09-22 已正式发布。** 源码 [`ef9e4e75ef0d587c137eedfb0fcc4cda106f52b3`](https://github.com/rivloom/rivloom-desktop/commit/ef9e4e75ef0d587c137eedfb0fcc4cda106f52b3)；[原生构建](https://github.com/rivloom/rivloom-desktop/actions/runs/35712264986)与[Linux 独立发布](https://github.com/rivloom/rivloom-desktop/actions/runs/35713081497)通过，[GitHub Release](https://github.com/rivloom/rivloom-desktop/releases/tag/linux-v0.1.20-ef9e4e75ef0d-35712264986)。公开完整下载及 WSL x64 启动/重启/SIGTERM、官网双语命令和 R2 检查已完成；范围与限制见 [0.1.20 发行验收](0.1.20-verification.md)。

| 文件 | 字节数 | SHA256 |
| --- | ---: | --- |
| [Rivloom_0.1.20_linux_x64.tar.gz](https://downloads.rivloom.com/releases/linux/linux-v0.1.20-ef9e4e75ef0d-35712264986/Rivloom_0.1.20_linux_x64.tar.gz) | 126095020 | `9aff7ff6386a2be45f88ad505d09765a116556f7afdd9fc97d4fb0ab9a98d69f` |
| [SHA256SUMS.txt](https://downloads.rivloom.com/releases/linux/linux-v0.1.20-ef9e4e75ef0d-35712264986/SHA256SUMS.txt) | 98 | `a275d32130812e10b7dfd812975b763d63e9ddd69cfe338acddbe758a7b8b9c9` |

## 功能与运行环境

沿用 SSH 初始化、可信节点配对、显式项目/模型授权和加密任务执行。本版接入项目记忆、Wiki/Skill 的固定版本分页读取与历史维护，并修复知识工具完成后的交接检查；功能和权限边界见[0.1.20 说明](0.1.20.md)。上下文查看和编辑界面由 Windows 桌面提供。

仅提供 x86_64（x64）压缩包，ARM64 暂不发布。核心继续固定为 **9b07cf4**，OpenCode **1.18.31-rivloom.9b07cf442a7e**，SDK/plugin **1.18.31**，随包 Node.js **24.19.0**；无需预装 Node/npm。

使用方法与系统要求见[Linux CLI](../LINUX.md)。支持 x86_64 glibc Linux：内核至少 4.18、glibc 至少 **2.30**、libstdc++ 至少 6.0.25；不支持 Alpine/musl。

## 升级与验证边界

Linux 与 Windows 使用独立下载记录。Linux 仍需手动停止节点、更换程序并保留数据目录；SHA256 校验不属于发布者数字签名或 Windows 自动更新。参与执行的旧节点应一起升级，以使用新版长 Wiki 分页能力。

Linux 发行要求同一源码提交的原生构建、完整文件摘要、解包启动/重启/退出、认证边界和身份保持验收。三台 Windows 设备的功能验收不能替代 Linux 原生门槛，也不证明所有 Linux 发行版、ARM64 或实体 Linux 多机环境均已通过。操作系统重启、断电及压缩生成中崩溃未纳入本轮验收。

官方下载、校验值和实际发行状态见[官网下载页](https://rivloom.com/download/)。
