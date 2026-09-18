# Rivloom Linux 0.1.18：x64 命令行执行节点

首次 Linux 发行仅提供 x86_64（x64）压缩包，ARM64 暂不发布。Linux 与 Windows 使用独立下载记录；Windows 正式版及签名更新仍为既有 0.1.18。

## 功能

- 无需 GUI，通过 SSH 初始化、配对和查看节点状态。
- 显式配置项目、模型和执行授权，接收可信桌面端派发的任务，沿用现有加密协议返回摘要与成果。
- CLI 支持队列、任务权限审批、问题回答和 systemd 用户服务单元输出。
- 压缩包包含固定 Node.js 24.19.0、官方 OpenCode 1.18.25 和依赖许可，无需预装 Node/npm。

使用方法、数据目录与系统要求见 [Linux CLI](../LINUX.md)。运行环境为 x86_64 glibc Linux：内核至少 4.18、glibc 至少 2.28、libstdc++ 至少 6.0.25；不支持 Alpine/musl。Linux 使用手动升级，SHA256 校验不属于发布者数字签名或 Windows 自动更新。

## 发行来源

- 源码：`509294bbf0fd684606a5764f2af2d98375bcb939`。
- [原生 Linux x64 构建与验收](https://github.com/rivloom/rivloom-desktop/actions/runs/35357963026)。
- [独立发布与公开下载同步](https://github.com/rivloom/rivloom-desktop/actions/runs/35358465412)。
- [GitHub Release](https://github.com/rivloom/rivloom-desktop/releases/tag/linux-v0.1.18-509294bbf0fd-35357963026)。
- 文件：`Rivloom_0.1.18_linux_x64.tar.gz`，135754204 字节。
- [官方下载域直接下载](https://downloads.rivloom.com/releases/linux/linux-v0.1.18-509294bbf0fd-35357963026/Rivloom_0.1.18_linux_x64.tar.gz)。
- SHA256：`7d2b83e32f2ceea67a1ff6cce0231ca3761b3729b6bfd9666b469ede73b08122`。

原生 Ubuntu x64 已通过 CLI/权限与运行时、节点协议、配置集成、合成模型任务审批/执行/成果回传及完整包验收。包内 13650 个文件完整摘要、启动/重启/SIGTERM、身份保持、loopback/token/Origin/Host 边界通过。未将这些结果描述为 ARM64、所有 Linux 发行版、不同物理机器或真实厂商模型已通过。

正式公开包已在独立 Linux x64 环境中分别使用普通 curl、wget 完整下载，字节数和 SHA256 均一致；校验后解压、全部文件摘要、默认用户目录初始化、启动/重启及 SIGTERM 退出检查通过。

官网源码配套更新已推送，Cloudflare Pages 构建仍在等待结果，正式下载页尚未更新。官网在干净 Linux 环境中重新安装依赖、读取真实下载记录、51 项测试与完整生产构建均通过；已重试一次官网部署请求，尚不能确认线上部署成功。官网实际页面验收和其后的 R2 保留审计仍待完成，没有执行 R2 删除。
