# Rivloom 维护与反馈

Rivloom 由维护者独立开发和维护，**不接受外部 Pull Request（PR）**。欢迎通过 [Issue](https://github.com/rivloom/rivloom-desktop/issues/new/choose) 提交可复现的问题和功能建议。是否实施以及实施方式由维护者决定，不承诺固定响应或交付时限。

源码继续采用 Apache-2.0。你可以按许可证使用、fork、修改和分发；本项目的 PR 接收政策不改变许可证授予的权利。请先阅读 [README](README.md) 的当前版本说明，以及 [SECURITY](SECURITY.md) 的执行和共享边界。共享 Skills 与渐进式 Wiki 记忆已随 0.1.15 发布，使用方式与实现边界见 [知识库说明](docs/KNOWLEDGE-LIBRARY.md)。

## 自行构建与验证

按 README 安装固定版本 Node.js、Rust 和 Windows 工具链，运行 `npm.cmd ci` 与 `npm.cmd run build`。原生构建使用 Rust 1.98.1；无需项目发布密钥。依赖变更应更新锁文件和许可证清单，不手改上游许可证原文。

修改后运行 `ci:versions`、`ci:coverage`、`ci:selftest`、`test:ci:logic` 和 `build`；涉及协议、引擎或服务时，再运行 [CI](docs/CI.md) 对应的隔离测试。测试使用合成数据和本机模拟模型。真实账号、真实项目、安装版数据及真实模型调用需由操作者明确选择，不是构建或验证的必需资源。

产品行为变更应覆盖失败和权限边界；纯文档或样式修正不要求新增镜像实现的测试。新增 UI 文案同步维护中英文。将适配代码留在桌面仓库，引擎内部修改放入对应 runtime fork；不要在本仓库复制整个上游源码。

## 反馈问题

- Bug 包含版本、Windows 版本、复现步骤、预期与实际结果。提交前删除日志和截图中的账号、路径、节点信息及任务内容。
- 功能建议说明实际使用场景、遇到的限制和期望结果。
- 不提交 `.data`、数据库、原始引擎日志、真实会话、凭据、签名私钥或部署 Hook。可疑漏洞请使用 SECURITY 中的私下报告方式。
- 安全漏洞使用 [私密报告入口](https://github.com/rivloom/rivloom-desktop/security/advisories/new)，不要在公开 Issue 披露漏洞利用细节。

PR 仅供有写入权限的维护者使用。main 现有保护规则与维护权限保留，正式发布仍由维护者按 [RELEASING](docs/RELEASING.md) 完成同一提交的 CI、安装、公开下载和签名验证，并记录 [R2 保留检查](docs/R2-RETENTION.md)。

## 自行分发

保留 LICENSE、NOTICE 和第三方许可；自行发行时配置自己的产品身份、更新来源和签名密钥，不复用 Rivloom 官方更新信任关系。源码开源不授予模型账号或第三方服务使用额度。
