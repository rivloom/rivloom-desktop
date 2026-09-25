# Rivloom Linux 0.1.21

2026-09-25 已发布 x86_64（x64）命令行执行端，源码 [3e6e44ea0d0de3bf408d3de0a9c0878890a04bf9](https://github.com/rivloom/rivloom-desktop/commit/3e6e44ea0d0de3bf408d3de0a9c0878890a04bf9)。[GitHub Release](https://github.com/rivloom/rivloom-desktop/releases/tag/linux-v0.1.21-3e6e44ea0d0d-36144935474)。

| 文件 | 字节数 | SHA256 |
| --- | ---: | --- |
| [Rivloom_0.1.21_linux_x64.tar.gz](https://downloads.rivloom.com/releases/linux/linux-v0.1.21-3e6e44ea0d0d-36144935474/Rivloom_0.1.21_linux_x64.tar.gz) | 126105687 | `b5a69b36443480052fa9220d5f45f0dee03395b210c06fecc6ad6c884c1f6044` |
| [SHA256SUMS.txt](https://downloads.rivloom.com/releases/linux/linux-v0.1.21-3e6e44ea0d0d-36144935474/SHA256SUMS.txt) | 98 | `f4c1f7de53f4681a0838901bd8efce08523421250134d65bfde14af7618219b6` |

与 Windows 使用同一源码，保持固定 Runtime 9b07cf4、Node.js 24.19.0 和 SDK/plugin 1.18.31。本版聊天、引用和设置界面改进主要由 Windows 桌面提供；Linux 延续 SSH 初始化、可信配对、项目/模型授权及执行节点能力。

原生 CI、公开 curl/wget、完整树、隔离启动/重启/SIGTERM、身份保持、官网命令及 R2 保留核验通过，见 [发行验收与限制](0.1.21-verification.md)。ARM64 暂不发布；系统要求和手动升级见 [Linux 使用说明](../LINUX.md)。
