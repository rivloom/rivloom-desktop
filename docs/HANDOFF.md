# Rivloom 当前交接状态

更新时间：2026-09-01。工作目录：`C:\project\rivloom-opencode`。

这份文件用于后续开启新会话或继续里程碑。事实明细见 [实施进度](PROGRESS.md)，测试记录见 [验证报告](VERIFICATION.md)，长期范围见 [实施计划](plans/2026-08-31-mvp-delivery.md)。

## 仓库状态

- 当前目录已初始化 Git；`main` 跟踪私有远程仓库 `https://github.com/rivloom/rivloom_desktop.git`。
- 远程原有的 Apache 2.0 `LICENSE` 初始提交已保留；MVP 源码提交为 `22eaa3c`（`feat: establish Rivloom desktop MVP`）。
- 旧项目 `C:\project\opencohive` 只读参考过产品文档，没有复制其 Codex monorepo，也没有修改旧项目。
- `.gitignore` 已排除依赖、构建产物、运行数据、凭据和测试输出：`node_modules/`、`dist/`、`.data/`、`src-tauri/target/`、`src-tauri/resources/runtime/`、`.env*` 等。

后续提交应继续包含应用源代码、文档、锁文件和许可证资料；不要强制加入上述忽略目录。尤其不能提交 `.data`，其中包含本地账号、SQLite、引擎状态、测试仓库和运行证据。安装包属于可重建产物，也位于被忽略的 `src-tauri/target`。

## 已完成产品范围

1. **M0 真实任务闭环：完成。** 创建任务、接受、真实 AI 执行、SSE 流输出、编辑/命令逐次审批、补充要求、停止、Git 差异、验收及重启恢复均已实现。
2. **M1 模型设置：无 Key 范围完成。** 桌面端已有“模型与额度”页；工作区创建者可保存/替换/移除 DeepSeek Key、确认后做真实连接测试、设置默认模型；普通成员只读。操作审计不保存 Key 或模型回复。
3. **M2 Windows 桌面交付：开发机完成。** Tauri 原生窗口、原生文件夹选择、随包 Node/OpenCode、随机 loopback 服务、进程生命周期、单实例和 NSIS 安装包已验证。
4. 独立账号、一次性邀请、发起/接受/审批/验收角色已由服务端协议测试验证。它是可复用的权限基础，**不代表节点自发现、Brain 协作或两个真人跨设备已经完成。**

架构仍保持单一执行引擎：官方、未修改的 OpenCode 1.18.25 和匹配 SDK。没有 fork OpenCode，没有自研 Agent 循环、上下文管理、模型调用或工具执行器，也没有提前建设多引擎框架。

M3 产品方向已修正：每个 Rivloom 安装实例都是节点，同网段节点自动发现；节点可承载一个或多个 Brain，Brain 以单任务单归属和跨 Brain 委派协作。发现不等于授权，首次建立信任仍需确认。详细决策与分期见 [ADR-0001](adr/0001-self-discovering-brain-network.md)。不要重新实现旧计划中的“单主机开启协作空间 + 远程访客”方案。

## 锁定运行时与最终安装包

| 组件                   | 版本/状态                                        |
| ---------------------- | ------------------------------------------------ |
| Node.js                | 24.19.0，随桌面包提供                            |
| OpenCode Windows + SDK | 1.18.25，官方未修改版本                          |
| Tauri                  | Rust 依赖锁定为 2.11.5 系列，`Cargo.lock` 已保留 |
| npm                    | `package-lock.json` 已保留                       |

最终内测安装包：

- 路径：`src-tauri/target/release/bundle/nsis/Rivloom_0.1.0_x64-setup.exe`
- 大小：70,998,334 字节
- SHA-256：`2ec2a07c782e3842f09cac0a32ca17ca286f26dc9d1935db1f95b4eb34256dd3`
- 状态：未签名内测包；开发机隔离安装、随包引擎启动、进程清理和卸载通过。

客户安装 Rivloom 后不需要另装 OpenCode 或本产品所需的 Node。Git、项目语言工具链和 WebView2 仍是环境前提。

## 最终验证基线

- 最终 Release 桌面程序真实闭环：10 项通过；模型 `opencode/mimo-v2.5-free`；任务 `0a0084e9-5eaf-484d-ab23-c3346de86835`；OpenCode 会话 `ses_fa564ffa1ffeQ43AqzV4XtjQ1c`。
- 官方 OpenCode 模型设置接口：6 项通过。测试字符串经 `auth.set/remove` 和 `provider.list` 完成保存、刷新、重启恢复与移除；看到 3 个 DeepSeek 模型；没有发送模型请求。
- Release Tauri WebView2 模型页面：5 项通过；验证无 Key 状态、密码输入、额度确认、默认模型与审计界面。
- 当前 NSIS：安装/启动/卸载烟雾测试通过。
- 本地：TypeScript 检查与生产构建通过；6 项安全测试通过；Cargo fmt/clippy 通过；生产依赖离线 audit 为 0 个已知漏洞。

机器报告位于被 Git 忽略的 `.data/verification`。它们用于本机核对，不应直接提交或公开：

- `desktop-integration.json`
- `model-settings.json`
- `desktop-model-settings.json` 与 `desktop-model-settings.png`
- `desktop-install.json`

## 明确未完成

- **DeepSeek 真实调用尚未验证。** 用户尚未提供有效 Key。测试字符串接口检查不能写成认证成功、额度可用或真实回复成功。
- M3 节点身份、自发现、设备配对、单 Brain 分布式任务、最小跨 Brain 委派，以及两位真人/两台设备验收。
- ChatGPT 登录。
- 干净 Windows 虚拟机的安装/升级/卸载矩阵、代码签名、自动更新和正式商业发行审查。
- 完整多租户权限、自研沙箱、陌生参与者安全边界、压力/灾难恢复和 DLP。

下次若用户准备好 DeepSeek Key，只让用户在 Rivloom 客户端本机“模型与额度”页面输入，不要让其发到聊天、仓库、截图或报告。真实连接测试会请求提供方并可能计费，必须保留界面确认；连接通过后再用专用 slugify fixture 做完整编程回归。

若用户暂不提供 Key，下一项产品工作是 M3.1 节点身份与自发现，而不是继续扩大内部网页功能。当前版本的应用和引擎仍只监听 loopback；M3 只为 Rivloom 节点协议增加受限网络端点，OpenCode 永远不直接暴露到局域网或公网。

## 运行状态与禁止事项

- 用户要求关闭的内部 Web 调试服务 `127.0.0.1:4310` 已关闭；最终检查没有 Rivloom/OpenCode 产品进程常驻。
- 本机 OpenCode Go 已过期，不再使用或自动导入。
- 不修改或 fork OpenCode；若需求必须改引擎，先说明并建议缩减范围。
- 不把工作目录限制、人工审批或可信成员当作安全沙箱。
- 不把独立测试客户端冒充两个真人协作，不把未签名包宣传成商业发行完成。

## Git 日常建议检查

重要提交前先审阅待提交文件和忽略规则，再运行：

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

`npm run test:model-settings` 会启动真实 OpenCode 但不调用模型；`npm run test:integration` 和 `npm run engine:probe` 会实际调用模型。不要在没有明确需要时把收费或联网测试放进每次提交钩子。

给新会话的最小开场信息可以是：

> 请先阅读 `docs/HANDOFF.md`、`docs/PROGRESS.md`、`docs/adr/0001-self-discovering-brain-network.md` 和实施计划。先核对仓库状态，不重做 M0/M1/M2，不使用过期 OpenCode Go，不修改旧项目。若我提供 DeepSeek Key，只指导我在客户端本机输入；否则从 M3.1 节点身份与自发现继续，不做单主机邀请式协作。
