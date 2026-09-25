# Rivloom 文档

这里保存随源码分发的说明。当前正式版以根目录 [README](../README.md) 和 [官网下载页](https://rivloom.com/download/) 为准；源码中的未发布功能以对应说明标注的状态为准。

## 使用与功能

- [随包使用说明](../DESKTOP-README.md)、[安全边界](../SECURITY.md)
- [Linux 命令行执行节点（x64 0.1.21 已发布；ARM64 暂不发布）](LINUX.md)、[Linux 发行说明与上线验收](releases/linux-0.1.21.md)
- [模型接入与选择](MODEL-ACCESS.md)、[输入区](COMPOSER.md)
- [连续会话](CONVERSATION-CONTINUITY.md)、[历史管理](CONVERSATION-HISTORY.md)、[内容搜索](CONVERSATION-SEARCH.md)
- [右键菜单](CONTEXT-MENUS.md)、[消息复制](MESSAGE-COPY.md)
- [Agent 基础工具](AGENT-TOOLS.md)：快捷访问、草稿、模板、导出、会话查找、排队消息编辑与项目改动
- [共享 Skills 与 Wiki 记忆](KNOWLEDGE-LIBRARY.md)
- [0.1.21 聊天与工作区界面更新](releases/0.1.21.md)、[发行验收](releases/0.1.21-verification.md)、[R2 保留审计](releases/0.1.21-r2-retention.md)
- [0.1.20 上下文与项目记忆发行说明](releases/0.1.20.md)、[发行验收与范围](releases/0.1.20-verification.md)、[上下文、记忆与历史维护设计](adr/0016-context-memory-and-runtime-retention.md)；实际发布状态以根目录说明和官网下载页为准
- [恢复与成果](WORKFLOW-RECOVERY-RESULTS.md)、[协作文件](COLLABORATION-FILES.md)
- [应用内更新](DESKTOP-UPDATES.md)

## 开发、构建与发布

- [贡献与验证](../CONTRIBUTING.md)、[工作约定](../AGENTS.md)
- [桌面构建](DESKTOP.md)、[引擎](ENGINE.md)、[CI](CI.md)、[Runtime 核验](CI-RUNTIME.md)
- [架构决策](adr/)、[缓存机制研究](PROMPT-CACHING.md)
- [正式发布流程](RELEASING.md)、[R2 保留策略](R2-RETENTION.md)、[版本说明与发行契约](releases/)
- [第三方声明](../THIRD_PARTY_NOTICES.md)、[依赖清单](dependency-licenses.json)、[原生依赖清单](desktop-dependency-licenses.json)、[Windows 引擎源码锁](../shared/engine-source.json)、[Linux 引擎源码与 recipe 锁](../shared/engine-source-linux.json)、[许可原文](licenses/)

`licenses/`、依赖清单、两份 `shared/engine-source*.json`、Linux recipe 快照和 `releases/` 中的版本说明参与构建、核验或更新说明生成，不能作为内部记录排除。

## 维护者本地记录

交接、进度、开源准备、实机验收、性能测量、官网与邮箱维护记录，以及 `docs/plans/` 中的开发计划仅保留在维护者本机，根目录 `.gitignore` 默认忽略 `docs/` 下的新文件，只有明确列出的公开文件及 `adr/`、`releases/`、`licenses/` 放行。公开文档中提到的“维护者本地记录”不是公开可下载的文件，也不是新的验证通过声明；公开发布结果以版本说明和对应 CI / Release 记录为依据。

全新克隆没有这些内部文档，仍可按公开说明构建与测试。维护者换机器时应单独迁移本地记录，并另行备份；不要使用 `git add -f` 重新上传。取消跟踪只影响后续提交，已经存在的历史提交不会因此被删除。
