# Rivloom Linux 0.1.25

2026-09-28：Linux x64 0.1.25 已正式发布，与 Windows 使用同一源码 [c73fb8ae30837a0a3d770e67b73da624e59e69b2](https://github.com/rivloom/rivloom-desktop/commit/c73fb8ae30837a0a3d770e67b73da624e59e69b2)。

| 文件 | 字节数 | SHA256 |
| --- | ---: | --- |
| [Rivloom_0.1.25_linux_x64.tar.gz](https://downloads.rivloom.com/releases/linux/linux-v0.1.25-c73fb8ae3083-36367080695/Rivloom_0.1.25_linux_x64.tar.gz) | 157179378 | `bdf1bec070d4a8c8ab35386c4c262a4be6672673cd0f9f306baf67e9c5303281` |
| [SHA256SUMS.txt](https://downloads.rivloom.com/releases/linux/linux-v0.1.25-c73fb8ae3083-36367080695/SHA256SUMS.txt) | 98 | `6d7d2bf4eb2019694d213db249ed319f5bfd8219dee09e0ec623f20b941dee60` |

[GitHub Release](https://github.com/rivloom/rivloom-desktop/releases/tag/linux-v0.1.25-c73fb8ae3083-36367080695) · [下载记录](https://downloads.rivloom.com/releases/linux/latest.json) · [整版验收](0.1.25-verification.md)

本版带入知识失败提示清除竞态和终态任务迟到有效用量的修复，保持原有收集范围与保留窗口。模型连接界面、文件预览和编辑交互修补属于 Windows 桌面。固定核心、SDK/plugin 与 Node.js 版本保持不变。

原生 x64 CI、独立 curl/wget 完整下载与解包、WSL 隔离启动/重启/SIGTERM、身份保持和 0700/0600 权限通过。没有配置真实模型、修改日常用户安装或安装 systemd 服务。官网双语命令核对通过；R2 保留 96、暂缓 0、可删除 0、删除 0 个。**检查完成，删除 0 个。**

Linux 继续手动升级：先停止节点、保留数据目录，再按[节点说明](../LINUX.md)安装并核对校验值。SHA256 用于检查文件一致性，不等同于发行签名。ARM64、实体多机、最低系统和完整跨版本升级矩阵不在本轮新增覆盖范围。
