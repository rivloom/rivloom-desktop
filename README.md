# Rivloom

Rivloom 是 Windows x64 上的人与 AI 任务工作区：在本机或已配对的设备上安排任务，查看审批、执行过程和成果。

[下载与使用指南](https://rivloom.com/download/) · [随包使用说明](DESKTOP-README.md) · [维护与反馈](CONTRIBUTING.md) · [安全边界](SECURITY.md)

Rivloom 现阶段由维护者集中开发，**暂不接受外部 Pull Request（PR）**，计划在后续开发阶段开放，具体时间另行公布。欢迎通过 [Issue](https://github.com/rivloom/rivloom-desktop/issues/new/choose) 报告问题或提出建议；你仍可按 Apache-2.0 许可证使用、修改和分发源码。

## 当前状态

源码正在准备 **0.1.21**，包含聊天与设置页优化、独立引用卡片、文件拖入及输入框左右附件/设备入口，详见 [0.1.21 更新说明](docs/releases/0.1.21.md)。该版本尚未正式发布。

当前 Windows 正式版为 **0.1.20**，新增上下文查看与编辑、显式项目记忆、Wiki/Skill 固定版本分页、可重试的 Runtime 历史清理，并修复普通会话中断后续聊和知识工具交接。历史与知识正文页最多 32 KiB 的 UTF-8 JSON。详见 [版本说明](docs/releases/0.1.20.md)及[发行验收与范围](docs/releases/0.1.20-verification.md)，安装包见[官网下载页](https://rivloom.com/download/)。

**2026-09-22 发行验收：** 两平台源码为 [`ef9e4e75ef0d587c137eedfb0fcc4cda106f52b3`](https://github.com/rivloom/rivloom-desktop/commit/ef9e4e75ef0d587c137eedfb0fcc4cda106f52b3)。同提交云端 CI、Windows 候选安装与独立静态核验、公开下载与原公钥更新签名、Linux 原生构建与公开包隔离运行、官网及 R2 保留检查已完成。三台 Windows 设备的功能测试范围及未覆盖项见[验收说明](docs/releases/0.1.20-verification.md)。Windows 与 Linux x64 核心保持 `9b07cf4`，SDK/plugin 为 1.18.31。首次构建运行 `npm.cmd run engine:prepare`，或由 `desktop:prepare` 自动执行；详见[引擎构建流程](docs/ENGINE.md)。ARM64 暂缓。

**共享 Skills 与渐进式 Wiki 记忆** 默认保留本机，手动分享给 Brain；其他节点通过 Brain 发现并按需读取共享内容。任务首次读取时固定版本，新任务获取来源最新版。整理功能目前生成分类索引和标记完全重复正文，不包含独立 AI 后台语义重写。详情见 [知识库说明](docs/KNOWLEDGE-LIBRARY.md)和 [0.1.15 版本说明](docs/releases/0.1.15.md)。

**Linux x86_64 命令行执行节点 0.1.20 已发布**，面向无 GUI 的局域网设备，经 SSH 配置、配对并接收桌面端任务。原生 CI、公开完整下载及 curl / wget 验收已通过，文件见 [Linux 发行说明](docs/releases/linux-0.1.20.md)；[官网下载页](https://rivloom.com/download/) 及配套中英文指南提供下载、校验值和 curl / wget 命令。ARM64 保留源码适配，待原生架构验收后单独发布，目前不提供下载。使用与运行要求见 [Linux CLI](docs/LINUX.md)。macOS 和 Codex runtime 尚未接入；Windows 与 Linux 正式包使用 **OpenCode 1.18.31-rivloom.9b07cf442a7e**，随包 Node.js 为 **24.19.0**。

## 从源码运行

准备 Windows x64、Git、Node.js **24.19.0**。以下是 PowerShell 命令：

```powershell
git clone https://github.com/rivloom/rivloom-desktop.git
cd rivloom-desktop
npm.cmd ci
npm.cmd run build
```

桌面运行还需要 Rust **1.98.1**、`x86_64-pc-windows-msvc` target、Visual Studio C++ Build Tools 和 WebView2：

```powershell
rustup toolchain install 1.98.1 --profile minimal --target x86_64-pc-windows-msvc
$env:RUSTUP_TOOLCHAIN = '1.98.1'
npm.cmd start
```

首次准备 runtime 会下载并校验固定版本的 Node.js；npm、Cargo 依赖也需要联网下载。开发实例和正式安装版使用各自的数据目录。无需 Rivloom 的发布凭据；运行 AI 任务前需自行配置模型账号，模型服务可能计费。

## 无真实模型的验证

```powershell
npm.cmd run ci:versions
npm.cmd run ci:coverage
npm.cmd run ci:selftest
npm.cmd run test:ci:logic
npm.cmd run test:ci:protocol
npm.cmd run test:ci:engine
npm.cmd run test:knowledge
```

这些检查使用隔离目录和合成数据；Windows 引擎检查运行固定源码构建的 Rivloom runtime，知识库服务使用本机模拟模型。它们不代表真实模型、两台物理机或安装升级已验收。`engine:probe`、`test:integration` 和界面中的模型连接测试可能调用真实模型，按需自行授权运行。

[文档目录](docs/README.md) · [CI 说明](docs/CI.md) · [正式发布流程](docs/RELEASING.md)

仓库保留使用说明、架构决策、构建与发布流程以及依赖许可。维护者的交接、开发计划和原始验证记录仅在本地维护，不随源码分发；从源码构建不需要这些内部文档。

## 仓库分工

| 仓库 | 范围 |
| --- | --- |
| [rivloom-desktop](https://github.com/rivloom/rivloom-desktop) | 桌面、Brain / Node、工作流、Skills、记忆与 runtime 适配 |
| [rivloom-opencode-runtime](https://github.com/rivloom/rivloom-opencode-runtime) | OpenCode fork，后续引擎源码维护与固定版本发行 |
| [rivloom-codex-runtime](https://github.com/rivloom/rivloom-codex-runtime) | Codex fork，后续引擎源码维护与接入 |

Windows 与 Linux x64 已从 OpenCode fork 的固定源码构建随包引擎，不追踪其最新 HEAD；Codex runtime 尚未接入。维护方式见[引擎说明](docs/ENGINE.md)及 [ADR 0011](docs/adr/0011-open-source-and-runtime-fork.md)。

## 安全与许可

Rivloom 面向可信参与者和项目，**不提供操作系统安全沙箱**。AI 工具以执行主机的用户权限运行；配对、审批和项目目录校验不能代替系统隔离。共享内容可能影响 Agent 行为，使用前应审查来源与内容。请勿将真实会话、个人资料、数据目录、凭据或原始日志提交到仓库或公开 Issue。漏洞报告方式见 [SECURITY.md](SECURITY.md)。

自有代码采用 **Apache-2.0**，Copyright 2026 Rivloom contributors。见 [LICENSE](LICENSE)、[NOTICE](NOTICE) 和 [第三方声明](THIRD_PARTY_NOTICES.md)。上游代码、字体和依赖保留各自许可。Rivloom 是独立项目，并非 OpenCode 或 OpenAI 官方产品。`private: true` 仅阻止 npm 发布，与 GitHub 可见性无关。

## Star 历史

<a href="https://www.star-history.com/?repos=rivloom%2Frivloom-desktop&amp;type=date&amp;legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=rivloom/rivloom-desktop&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=rivloom/rivloom-desktop&amp;type=date&amp;legend=top-left" />
    <img alt="Rivloom GitHub Star 数量随时间变化的统计图" src="https://api.star-history.com/chart?repos=rivloom/rivloom-desktop&amp;type=date&amp;legend=top-left" width="800" />
  </picture>
</a>
