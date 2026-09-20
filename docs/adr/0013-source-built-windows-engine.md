# ADR 0013：Windows 使用自有 runtime 固定源码构建

状态：2026-09-19 已在本地实现，尚未正式发布。

## 背景

desktop 原先直接安装官方 Windows OpenCode npm 平台包。独立 runtime fork 已有 1.18.31 构建基线，用户要求实际构建并供 desktop 使用，同时跟进官方更新。不能覆盖 npm 文件、依赖可变分支或将本地 dirty 构建伪装成远端已提交源码。

## 决定

- `shared/engine-source.json` 为唯一固定源码配置：仓库、commit/tree、上游版本/commit、工具链、构建输入及批准导入摘要。
- 全新 Windows 构建从固定 commit 克隆独立工作目录，核对前后完整源码与输入，运行真实 EXE 的隔离合成模型 smoke；另支持精确批准产物的导入。产物置于独立、被忽略的 vendor 目录，失败不回退到官方 npm 包。
- 每次构建的 EXE/manifest/smoke 和 receipt 绑定；安装包的完整字节树、实际版本、许可、安装及发行门槛继续生效。receipt 描述构建过程，不是独立签名。跨机器二进制不要求可重复生成同一哈希。
- SDK/plugin 与 Windows 基线对齐。Linux 保持官方 1.18.25 独立平台配置，升级仍须 Linux 原生验证。
- 官方更新只读检查稳定版及标签/commit，再人工评估、合并、回归和更新 desktop pin；客户端禁用引擎自更新。

## 取舍

固定源构建比下载官方 EXE 更慢，需要 Git/PowerShell/Node/Bun及公开依赖网络；也能直接验证本产品实际使用的 fork。避免复制上游源码进 desktop，降低两仓库重复维护。直接下载可变 `latest` 或手改 node_modules 虽简单，但无法绑定来源和完整验收，故不采用。

本地 producer schema 2 改造与云端已提交 baseline 分开记录，提交并验证后再更新 pin。云 CI、原生安装、真实厂商和正式发行各有独立验收，不用本地合成检查代替。
