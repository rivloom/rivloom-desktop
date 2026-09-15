# ADR 0011：开源边界与独立 runtime fork

决定日期：2026-09-14；状态更新：2026-09-15。桌面仓库已采用 Apache-2.0 公开，0.1.15 已正式发布；两个 runtime fork 已建立，发行物尚未接入桌面。当前实查、修复及未覆盖项见 [开源准备记录](../OPEN-SOURCE-READINESS.md)。

## 决定与仓库分工

用户计划长期修改 OpenCode 和 Codex 引擎源码，因此两个引擎分别维护真正的上游 fork，不把引擎源码复制进桌面仓库。

| 仓库 | 当前状态 | 上游 / 职责 |
| --- | --- | --- |
| rivloom/rivloom-desktop | 已公开，Apache-2.0 | 桌面 UI、Brain / Node、工作流、共享 Skills、记忆、权限适配、安装与更新 |
| rivloom/rivloom-website | 继续私有 | 官网、使用指南与下载入口 |
| rivloom/rivloom-opencode-runtime | 已公开，默认 dev | anomalyco/opencode 的 fork；引擎改动、上游同步、SDK/插件兼容与发行 |
| rivloom/rivloom-codex-runtime | 已公开，默认 main | openai/codex 的 fork；后续 Codex 源码维护、适配与发行 |

两个 fork 保留各自上游历史、许可和默认分支。Codex fork 已有历史开发分支和 Actions 运行记录，不能当作空白新仓库覆盖。

2026-09-15 已按用户授权，为两个公开 fork 开启密钥扫描（secret scanning）和推送保护（push protection），GitHub API 回读均为 enabled；默认分支源码和 Actions token 权限与变更前一致。这两项用于发现或拦截误提交的凭据，不是构建上游代码的前置条件，也不代表已完成两个 fork 的全量历史审计。

桌面自有代码沿用 Apache-2.0，版权为 Copyright 2026 Rivloom contributors。上游代码、字体和依赖继续保留原有版权与许可；npm 的 private 标志仅防止包发布。

## 当前实现边界

当前正式版为 **0.1.15**。共享 Skills 与渐进式 Wiki 记忆已发布，默认保留本机、手动分享给 Brain，其他节点经 Brain 发现并按需读取。任务首次读取时固定版本，新任务获取来源最新版；整理当前生成分类索引并标记完全重复正文，独立 AI 后台语义重写尚未实现。源码公开与安装包发行已分别核验，见 [验证记录](../VERIFICATION.md) 顶部。

现行产品仍使用未修改的官方 OpenCode **1.18.25**，二进制、SDK、插件与来源哈希固定；两个 fork 的发行物尚未接入。Codex runtime 也未集成。此前“不 fork”属于旧阶段策略；之前“仅在必要时 fork Codex”的建议已由用户确认的长期源码修改方向替代。

## runtime 维护与升级

保持 upstream remote 和可追溯上游历史；从明确的上游 tag/commit 建立 Rivloom 维护分支。先构建未做业务修改的 Windows x64 基线，再增加补丁。保留上游结构，仅发行所需组件。自建二进制不要求与上游分发字节相同，但必须绑定源码、工具链、版本和 SHA-256。

桌面消费固定、不可变的 runtime 发行物，禁止在用户启动时拉取上游最新分支。需要同步调整：

- package.json / lock 中的二进制、SDK 与插件来源、版本和兼容关系。
- docs/engine-lock.json 的来源、版本、哈希及 modified 标志。
- server/engine.ts、插件依赖准备、desktop-prepare、runtime 验证及关于页面中的版本显示。
- 第三方许可、发行清单、平台产物和安装/升级验证记录。

升级顺序：选择上游提交 → 合并并审查补丁 → 引擎和接口测试 → runtime 候选 → Rivloom 合成服务集成 → 隔离安装与更新 → 锁定正式发行物。权限、取消、事件流、OAuth 隔离、上下文和知识工具都属于兼容性验收范围。上游同步不等于向用户自动升级；失败时维持已验证版本。

若数据格式变化，先验证备份和升级路径，不能假设旧二进制可读取新数据库。真实账号登录由用户操作，真实模型额度调用须先确认。

## Codex 适配方向

独立实现 runtime 适配器，保持任务、审批、事件、凭据、模型与会话的统一产品接口。初步候选是 App Server，简单批处理可评估 SDK/exec；具体协议成熟度和所选固定源码版本在接入时重新核对。

本机此前只验证过 Codex 的版本与帮助入口，没有运行 Agent 任务、登录或调用真实模型。桌面随附的 alpha 版本不是 Rivloom 已选定的发行依赖。Fork 已存在不代表接入、兼容测试或发行流水线已完成。

## 开源状态与后续发布

桌面公开前已检查源代码、Git 历史、标签、Release、Actions 日志及 artifacts；覆盖范围和限制见 [开源准备记录](../OPEN-SOURCE-READINESS.md)。自有许可、随包 NOTICE、贡献入口与安全说明已同步，私密漏洞报告、密钥扫描、推送保护以及 main 和发布标签保护已实际启用并核验。

2026-09-15 用户决定由维护者独立开发，不接受外部 PR；源码许可保持 Apache-2.0，Issue 反馈与私密漏洞报告继续开放。真实外部 fork PR 验收已从当前待办移除。维护者使用现有权限和保护规则开展开发，正式发行继续绑定同仓库 main 的同一提交 CI 证据。

正式发行继续执行 [CI](../CI.md)、[RELEASING](../RELEASING.md) 和 [R2-RETENTION](../R2-RETENTION.md)，保留原更新公钥与验证流程。官网保持独立私有，由 Cloudflare Pages 执行测试、构建与部署，重复的官网 GitHub Actions 已停用。本次文档维护不改变 0.1.15 安装包或执行 R2 清理。
