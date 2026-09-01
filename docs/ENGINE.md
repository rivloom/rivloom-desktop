# OpenCode 接入与范围决策

核对日期：2026-08-31。CLI/SDK 均锁定 **1.18.25**，使用官方 `opencode-windows-x64` 平台包和 `@opencode-ai/sdk`。完整 npm integrity 在 `package-lock.json`，Windows 二进制 SHA-256 在 [engine-lock.json](engine-lock.json)。

官方来源：

- [发布版 v1.18.25](https://github.com/anomalyco/opencode/releases/tag/v1.18.25)
- [服务与 HTTP API](https://opencode.ai/docs/server/)
- [官方 TypeScript SDK](https://opencode.ai/docs/sdk/)
- [权限配置](https://opencode.ai/docs/permissions/)
- [配置文件与优先级](https://opencode.ai/docs/config/)
- [该发布版 MIT 许可证](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.25/LICENSE)

`opencode-ai` npm 包的安装包装器在本机未找到平台二进制并失败；按其错误提示，直接安装官方 Windows 平台包。没有修改 postinstall、绕过许可证或重编译上游。运行方式仍是官方 `opencode.exe serve`。

## 公开接口映射

SDK 使用公开导出 `@opencode-ai/sdk/v2`（这里的 v2 是 SDK 导出入口，不代表调用所有实验性 `/v2` 路由）。

| 产品能力         | 官方接口 / SDK                                                             |
| ---------------- | -------------------------------------------------------------------------- |
| 启动与版本核对   | `serve --hostname 127.0.0.1 --port …`、`global.health`                     |
| 列出可用模型     | `provider.list`                                                            |
| 创建任务内的会话 | `session.create`                                                           |
| 发送任务 / 继续  | `session.promptAsync`                                                      |
| 流式输出         | `event.subscribe`、`message.part.delta`                                    |
| 断线状态恢复     | `session.status`、`session.messages`、`permission.list`、`question.list`   |
| 操作审批         | `permission.reply`，仅 once/reject                                         |
| AI 主动提问      | `question.reply` / `question.reject`（实现完成，真实提问分支尚未专项验证） |
| 停止             | `session.abort`，然后拒绝残留权限请求和问题                                |
| 结果             | `session.messages`，业务层保存可显示的执行记录                             |
| 引擎差异         | `session.diff`；有返回则展示，本机实测可能为空                             |
| 产品产物         | 仅映射 OpenCode 明确返回的会话差异；不扫描、快照或哈希项目文件夹           |

没有调用 OpenCode 内部模块，没有自写 Agent 循环。业务层的定时同步只查询状态和保存 UI 执行记录，不生成提示循环或执行工具。

## 真实验证发现

1. 现有 OpenCode Go 账号返回余额不足；没有充值。使用官方免费提供方 `opencode/mimo-v2.5-free` 完成同一个真实测试。
2. `session.diff` 多次返回空数组，但真实文件修改与测试均正常。MVP 不修改引擎，也不自行扫描、快照或哈希文件夹；界面明确提示验收人直接检查本地文件和测试记录。
3. `session.abort` 后可残留等待审批条目。薄适配层先 abort，再通过公开权限接口 reject，避免停止后的陈旧批准入口。
4. 任务验收是应用业务状态，不等于引擎 idle。结果、测试说明、角色和验收意见均保存在本地 SQLite。

升级引擎前必须重新跑 `engine:probe` 与 `test:integration`，核对权限行为、输出事件、结果格式和许可证，再更新两个包版本和锁文件。不使用宽范围版本或自动升级。
