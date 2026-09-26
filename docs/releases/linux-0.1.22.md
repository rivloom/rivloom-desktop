# Rivloom Linux 0.1.22

2026-09-26 已发布 x86_64（x64）命令行执行节点，源码 [9b3f07f759b278bbed8dbcd910ea12889188bb0a](https://github.com/rivloom/rivloom-desktop/commit/9b3f07f759b278bbed8dbcd910ea12889188bb0a)。[GitHub Release](https://github.com/rivloom/rivloom-desktop/releases/tag/linux-v0.1.22-9b3f07f759b2-36217814357)。

| 文件 | 字节数 | SHA256 |
| --- | ---: | --- |
| [Rivloom_0.1.22_linux_x64.tar.gz](https://downloads.rivloom.com/releases/linux/linux-v0.1.22-9b3f07f759b2-36217814357/Rivloom_0.1.22_linux_x64.tar.gz) | 126104903 | `e3d5595972c7472ffb858b8c206be26ad89f2932dad8cef8ec417a22db4142b8` |
| [SHA256SUMS.txt](https://downloads.rivloom.com/releases/linux/linux-v0.1.22-9b3f07f759b2-36217814357/SHA256SUMS.txt) | 98 | `494381539f1603322afb2956bc6b33af1807584e3d56fbbd85a1690287d65346` |

与 Windows 正式包使用同一源码，核心保持 1.18.31-rivloom.9b07cf442a7e，SDK/plugin 1.18.31，Node.js 24.19.0。0.1.22 的聊天、菜单、侧栏与版本显示调整由 Windows 桌面提供；Linux 延续 SSH 初始化、可信配对、项目/模型授权及执行节点能力。

[原生构建](https://github.com/rivloom/rivloom-desktop/actions/runs/36217814357)和[独立发布](https://github.com/rivloom/rivloom-desktop/actions/runs/36229729384)通过，x64 artifact 10897978844 绑定精确源码。公开 curl/wget 分别完整下载、SHA256 与校验文件、13688 个 Runtime 文件、WSL 隔离启动/重启/SIGTERM、身份及权限保持、官网双语命令和 R2 保留检查通过。首次本机下载连接重置后，使用已有代理完成两种客户端的完整下载；应用进程使用独立 HOME，不继承用户凭据或代理。

Linux 采用手动升级，SHA256 不等于数字签名；ARM64 未发布。没有把 WSL 验收当作实体 Linux 多机或真实模型测试，详情见[整版验收及未覆盖范围](0.1.22-verification.md)。系统要求与升级步骤见[Linux 使用说明](../LINUX.md)。
