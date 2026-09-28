# Rivloom Linux 0.1.27

正式发行、公开下载与官网同步核验已完成，详见[0.1.27 发行验收](0.1.27-verification.md)。

Linux x64 无界面节点已随桌面版本同步至 0.1.27。本版历史会话栏调整用于 Windows 桌面；Linux 的核心、Node.js 和 SDK/plugin 保持不变。

- 源码：[`3c0f4957ab3d0f62f95249bf8e318ace25a2c898`](https://github.com/rivloom/rivloom-desktop/commit/3c0f4957ab3d0f62f95249bf8e318ace25a2c898)。
- [原生 Linux CI](https://github.com/rivloom/rivloom-desktop/actions/runs/36399627043)及[独立发行](https://github.com/rivloom/rivloom-desktop/actions/runs/36400857325)均首轮通过，采用同一成功候选，未重复构建发行。
- [正式归档](https://downloads.rivloom.com/releases/linux/linux-v0.1.27-3c0f4957ab3d-36399627043/Rivloom_0.1.27_linux_x64.tar.gz)：157,179,348 字节；SHA-256 `d442490dde943aae24a877974ba638003573b7d71bdb684037a571f157aeebf2`。
- curl、wget 各自完整公开下载和校验通过，17,695 个运行时文件、隔离 HOME 启动/重启/SIGTERM、身份保持及 0700/0600 权限通过；实际生成的 3,617 个依赖文件也逐项核对长度与 SHA-256。
- 官网实际中英文下载页的四条 curl/wget 命令与本次完整下载命令一致，shell 语法检查通过。

Linux 沿用手动停止节点、更换程序、保留数据目录的升级方式，没有 Windows 桌面的应用内备份与安装流程。仅发行 x64 包；ARM64 未发布，本轮未执行真实模型任务、物理局域网或 systemd 安装验收。

安装与更新方式见 [Linux 使用说明](../LINUX.md)。校验和用于核对文件完整性，不等同于数字签名。
