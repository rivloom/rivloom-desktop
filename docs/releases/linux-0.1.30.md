# Rivloom Linux x64 0.1.30

正式源码 [4a359ea99380678db66688732fb82672979ff036](https://github.com/rivloom/rivloom-desktop/commit/4a359ea99380678db66688732fb82672979ff036)，核心 `1.18.33-rivloom.655285f835f8`，SDK/plugin 1.18.33，Node.js 24.19.0。同步停止续聊、Brain 回执、更新维护、远程元数据配额与 Git 兼容修复；无 GUI 节点继续按[Linux 使用说明](../LINUX.md)手动升级。

[同源 Linux CI](https://github.com/rivloom/rivloom-desktop/actions/runs/37792285176)和[独立发行](https://github.com/rivloom/rivloom-desktop/actions/runs/37793806390)均在 attempt 1 成功。artifact `11556789261`；[Rivloom_0.1.30_linux_x64.tar.gz](https://downloads.rivloom.com/releases/linux/linux-v0.1.30-4a359ea99380-37792285176/Rivloom_0.1.30_linux_x64.tar.gz)：157260273 字节，SHA-256 `27042b2f708f2f46ef464624483d0b87e30c8d7301402183bdcfc8480fd1ad0d`。

独立 GitHub-hosted Ubuntu 24.04 x64 消费 job `113424182840` 完成 curl/wget 各自完整下载、17696 文件完整树、固定源码/Node/核心/依赖/许可及隔离启动、重启、SIGTERM、身份和权限检查。其 [消费 workflow](https://github.com/rivloom/rivloom-desktop/actions/runs/37810029245) 整体仍为 failure（Windows 工具获取失败），只记录 Linux job 成功；未重跑已通过的 Linux。本机 WSL、Node 和 PowerShell 的大包 GET 均失败或中断；本版独立完整下载、静态核验与 Linux 原生运行在 GitHub 托管 runner 完成。本机仅验证小报告 artifact 的 API 来源、ZIP 完整摘要/CRC 和报告原字节，没有本机完整包、安装或原生运行通过声明。

运行基线仍为内核至少 4.18、glibc 2.30、libstdc++ 6.0.25。Alpine/musl、32 位与 ARM64 不在交付范围；最低发行版、真实模型、实体多机和完整升级矩阵未新增验收，校验和不等于数字签名。官网 CLI 命令是否匹配以最终实际 live 报告为准。整版证据与限制见[发行验收](0.1.30-verification.md)，R2 结果见[逐对象审计](0.1.30-r2-retention.md)。
