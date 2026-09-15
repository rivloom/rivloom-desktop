# ADR 0011：开源边界与独立 runtime fork

日期：2026-09-14。状态：用户已确认仓库分工与 Apache-2.0 授权；桌面公开和 fork runtime 接入尚未执行。当前实查、修复及未覆盖项见 [开源准备记录](../OPEN-SOURCE-READINESS.md)。

## 决定与仓库分工

用户计划长期修改 OpenCode 和 Codex 引擎源码，因此两个引擎分别维护真正的上游 fork，不把引擎源码复制进桌面仓库。

| 仓库 | 当前状态 | 上游 / 职责 |
| --- | --- | --- |
| rivloom/rivloom-desktop | 私有，准备公开 | 桌面 UI、Brain / Node、工作流、共享 Skills、记忆、权限适配、安装与更新 |
| rivloom/rivloom-website | 继续私有 | 官网、使用指南与下载入口 |
| rivloom/rivloom-opencode-runtime | 已公开，默认 dev | anomalyco/opencode 的 fork；引擎改动、上游同步、SDK/插件兼容与发行 |
| rivloom/rivloom-codex-runtime | 已公开，默认 main | openai/codex 的 fork；后续 Codex 源码维护、适配与发行 |

本轮两个 fork 仅检查配置，没有修改引擎源码、分支、Actions 或权限。Codex fork 已有历史开发分支和 Actions 运行记录，不能当作空白新仓库覆盖。

桌面自有代码沿用 Apache-2.0，版权为 Copyright 2026 Rivloom contributors。上游代码、字体和依赖继续保留原有版权与许可；npm 的 private 标志仅防止包发布。

## 当前实现边界

正式版仍为 **0.1.14**。共享 Skills/Wiki 为尚未发布的工作区改动，默认本机、手动分享给 Brain。源码公开和发行新安装包分别验收，不因准备开源而提前发布新功能。

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

## 开源与发布条件

当前桌面源代码和 Git 历史、标签、Release、Actions 日志及 artifacts 均属于公开前检查范围。敏感内容发现只做脱敏记录；历史重写、凭据轮换、远端配置和公开操作需以具体结果向用户确认。

公开前统一许可、随包 NOTICE、贡献入口和安全说明；检查外部 PR 不接触发布凭据，正式发行绑定同仓库 main 的同一提交 CI 证据。GitHub 保护规则和私密漏洞报告须在可用时实际启用并验证，不能只凭文档认定生效。

正式发行继续执行 [CI](../CI.md)、[RELEASING](../RELEASING.md) 和 [R2-RETENTION](../R2-RETENTION.md)，保留原更新公钥与验证流程。官网保持独立私有，本轮不部署官网、不发布安装包、不执行存储清理。
