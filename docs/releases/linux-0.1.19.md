# Rivloom Linux 0.1.19：x64 命令行执行节点

**发行完成：** 仅提供 x86_64（x64）压缩包，ARM64 暂不发布。Linux 与 Windows 使用独立下载记录；Windows 同版发行见[桌面说明](0.1.19.md)。

## 功能与运行环境

沿用 SSH 初始化、可信节点配对、显式项目/模型授权及加密任务执行。会话状态与历史按需读取、队列取消和模型配置改进见[0.1.19 功能说明](0.1.19.md)。本版使用 Rivloom 固定源码构建的 OpenCode **1.18.31-rivloom.9b07cf442a7e**，核心固定 **9b07cf4**，随包 Node.js **24.19.0**，无需预装 Node/npm。

使用方法与系统要求见[Linux CLI](../LINUX.md)。支持 x86_64 glibc Linux：内核至少 4.18、glibc 至少 **2.30**、libstdc++ 至少 6.0.25；嵌入的 libfff_c.so 决定 glibc 下限，不能沿用旧版的 2.28 门槛。不支持 Alpine/musl。仍使用手动升级；SHA256 校验不属于发布者数字签名或 Windows 自动更新。

## 发行来源与验证

- 源码：`c6d273d1f4bc6f9b510ebf649587f05373a88640`。
- [原生 Linux x64 CI](https://github.com/rivloom/rivloom-desktop/actions/runs/35629694382)；[Linux 独立发布](https://github.com/rivloom/rivloom-desktop/actions/runs/35632415575)。
- [GitHub Release](https://github.com/rivloom/rivloom-desktop/releases/tag/linux-v0.1.19-c6d273d1f4bc-35629694382)。
- 文件：`Rivloom_0.1.19_linux_x64.tar.gz`，126086237 字节。
- [官方下载](https://downloads.rivloom.com/releases/linux/linux-v0.1.19-c6d273d1f4bc-35629694382/Rivloom_0.1.19_linux_x64.tar.gz)。
- SHA256：`c54ab57b4ce5dae79575da22f2f2c6e4156f81d6f807b35e14ee18b867bb38fb`。

公开 Linux 包在隔离 x64 Linux 环境完成下载、完整运行文件摘要、默认用户目录初始化、启动/重启及 SIGTERM 退出核验，身份保持。官网中英文下载页的地址、SHA256、curl/wget 文案及 x64 跳转已核对。

这些结果不代表 ARM64、所有 Linux 发行版、实体多机或真实厂商模型已通过；未操作用户项目或配置 systemd。长期记忆/Wiki 的进一步联通、专用上下文编辑界面及新增存储维护不属于本版。

[本次 R2 保留审计](0.1.19-r2-retention.md)完成：保留 62、暂缓 0、删除 0 个；检查完成，删除 0 个。没有启用自动清理。
