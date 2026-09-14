# Model access Implementation Plan

**Goal:** 让用户通过厂商 OAuth、API Key 或自定义 OpenAI 兼容 Provider 接入模型，并在现有任务模型选择器中使用。

**Architecture:** 保持官方 OpenCode 1.18.25 及 SDK，不更换执行引擎。普通密钥由官方 Auth API 保存；自定义地址和模型定义放在独立、不含密钥的受管配置。OAuth 使用临时、隔离的官方引擎完成厂商认证，仅在当前授权仍有效且成功时将凭据交给主引擎；取消、超时或迟到回调不能修改现有凭据。

**Tech Stack:** TypeScript、React、Express、Zod、官方 OpenCode SDK、Node test、Playwright。

本轮按用户已有授权在当前工作区实施，保留搜索和 R2 文档改动，不提交、推送、发布或调用真实模型。沿用 Code、writing-plans、security-auditor 的实现与验证流程，不创建其他任务。

1. `shared/model-providers.ts`、`server/provider-config.ts`：定义最小 Provider/模型/认证 DTO，验证地址、标识符、协议和有限参数，拒绝配置变量注入；测试写入、编辑、移除及保留已有定义。
2. `server/engine.ts`：支持传入隔离引擎根目录、加载独立 Provider 配置；OAuth 回调使用有界长等待，其他请求保持原超时。
3. `server/provider-oauth.ts`、`server/model-settings.ts`、`server/index.ts`：厂商目录、API Key、自定义 Provider CRUD、OAuth 开始/状态/完成/取消；复用 owner、任务空闲与 engine-settings 锁，结果和日志不返回秘密。
4. `src/model-settings.tsx`、`src/provider-settings.tsx`：在现有视觉系统中增加厂商选择、动态 OAuth 提示、自定义表单与编辑/移除；连接测试适用于所有已配置模型；保持任务模型锁定语义。提供系统浏览器打开厂商认证页。
5. `tests/model-providers.test.ts`、`scripts/model-providers-check.ts`：验证授权边界、输入过滤、OAuth 取消与迟到结果、主引擎密钥与配置刷新；使用隔离数据和本地兼容服务验证真实官方引擎的请求路径、模型 ID、认证和重启持久化，不花真实额度。
6. 隔离 UI 验证中英文、窄屏、OAuth 状态、自定义 Provider、默认模型与任务选择；运行适用逻辑、类型、双语、生产构建和测试分类门禁。
7. `docs/MODEL-ACCESS.md`、`docs/PROMPT-CACHING.md` 和交接文档：记录使用方法、验证边界和正式版状态；缓存说明引用厂商官方文档，区分机制、Agent 影响和本项目尚未测量的数据。
