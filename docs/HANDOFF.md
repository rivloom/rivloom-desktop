# Rivloom 当前交接状态

更新时间：2026-09-01。工作目录：`C:\project\rivloom-opencode`。

这份文件用于后续开启新会话或继续里程碑。当前顺序和双方共识以 [里程碑基线](MILESTONES.md) 为准；事实明细见 [实施进度](PROGRESS.md)，测试记录见 [验证报告](VERIFICATION.md)，长期范围见 [实施计划](plans/2026-08-31-mvp-delivery.md)。

## 当前产品决议

- M0、M1、M3.1、M3.2 已完成。
- 用户已经在 Rivloom 本机保存 DeepSeek Key，并用 `deepseek/deepseek-v4-flash` 完成官方真实连接和无 `.git` 普通文件夹固定编程任务。Key 不进入聊天或仓库。
- M2 的正式发行完善暂缓。现有安装包事实保留，但当前不投入签名、升级矩阵等工作。
- 当前开发里程碑是 M3.3；继续实现前先对齐跨节点任务的交互和完成条件。
- M3.4 的 Brain/节点关系存在认识差异，讨论清楚前不得继续设计或实现，也不得把历史方案视为已确认需求。

## 仓库状态

- 当前目录已初始化 Git；`main` 跟踪私有远程仓库 `https://github.com/rivloom/rivloom_desktop.git`。
- 远程原有的 Apache 2.0 `LICENSE` 初始提交和 `22eaa3c`（`feat: establish Rivloom desktop MVP`）均已保留；当前里程碑继续提交到 `main`，以 `git log` 的最新提交为准。
- 旧项目 `C:\project\opencohive` 只读参考过产品文档，没有复制其 Codex monorepo，也没有修改旧项目。
- `.gitignore` 已排除依赖、构建产物、运行数据、凭据和测试输出：`node_modules/`、`dist/`、`.data/`、`src-tauri/target/`、`src-tauri/resources/runtime/`、`.env*` 等。

后续提交应继续包含应用源代码、文档、锁文件和许可证资料；不要强制加入上述忽略目录。尤其不能提交 `.data`，其中包含本地账号、SQLite、引擎状态、测试仓库和运行证据。安装包属于可重建产物，也位于被忽略的 `src-tauri/target`。

## 已完成产品范围

1. **M0 真实任务闭环：完成。** 创建任务、接受、真实 AI 执行、SSE 流输出、编辑/命令逐次审批、补充要求、停止、OpenCode 会话差异、验收及重启恢复均已实现。
2. **M1 模型设置：完成。** 桌面端已有“模型与额度”页；用户已在本机保存 DeepSeek 官方 Key，并用 `deepseek/deepseek-v4-flash` 完成真实连接测试及无 `.git` 普通文件夹固定编程任务。编辑和指定测试命令经人工批准，独立测试为 1 通过、0 失败，测试文件未变，任务最终验收。操作审计和验证报告不保存 Key 或完整模型回复。
3. **M2 Windows 桌面交付：已有开发机内测包，发行完善暂缓。** Tauri 原生窗口、原生文件夹选择、随包 Node/OpenCode、随机 loopback 服务、进程生命周期、单实例和 NSIS 安装包已经验证；这不代表签名、干净机和升级矩阵已经完成。
4. **M3.1 节点身份与自发现：双向发现和正常退出通过。** 每个实例有 DPAPI 保护的稳定 Ed25519 身份；标准 `_rivloom._tcp.local` 与 LAN UDP 回退只产生候选地址，随后执行随机挑战签名校验。原包在 Win10 `192.168.5.18` 与 Win11 `192.168.5.20` 出现单向 mDNS，UDP 回退包已确认双向发现；签名退出通知的快速离线也由用户在原设备确认。异常结束进程或断网的 15/30 秒兜底仍待专项复测。
5. **M3.2 配对与加密 Brain 目录：自动化/Release 完成。** 配对闭环已通过用户的 Win10/Win11 物理双机。受信节点用签名临时 X25519、HKDF 和 AES-256-GCM 自动建立双向认证会话；伪造/重放握手、篡改/重放消息、过期、重启重建和撤销断链均已自动化验证，实际 Release WebView2 也已通过。
6. **M3.3 策略化跨节点执行：第二段完成。** 设备信任、本机执行能力和 AI 操作审批已分层。受信任务自动接收，能力关闭时等待；开启后复用本机项目和模型。任务锁定“请求批准 / 帮我批准 / 允许任何操作”，经官方 OpenCode 会话权限接口执行。真实 Release 已用“帮我批准”无人工提示完成文件任务。归属 Brain 收到单调状态和摘要，不收到本机项目、模型、任务 ID 或凭据。远程处理审批、补充、停止、差异/产物和验收仍待做。
7. **桌面直接启动：已实现。** 首次打开不再创建“工作区”或询问显示名称、用户名、密码；Tauri 启动期随机令牌自动建立/恢复本机操作者，直接进入任务界面并开始发现。内部 Web 调试仍保留显式登录。
8. 独立账号、一次性邀请、发起/接受/审批/验收角色已由服务端协议测试验证。它是后续跨节点角色映射与业务权限基础。

架构仍保持单一执行引擎：官方、未修改的 OpenCode 1.18.25 和匹配 SDK。没有 fork OpenCode，没有自研 Agent 循环、上下文管理、模型调用或工具执行器，也没有提前建设多引擎框架。

M3 产品方向已修正：每个 Rivloom 安装实例都是节点，同网段节点自动发现；节点可承载一个或多个 Brain，Brain 以单任务单归属和跨 Brain 委派协作。发现不等于授权，首次建立信任仍需确认。详细决策与分期见 [ADR-0001](adr/0001-self-discovering-brain-network.md)。不要重新实现旧计划中的“单主机开启协作空间 + 远程访客”方案。

M3.3 又于 2026-09-01 修正：完成设备配对即建立任务发送信任，不再叠加逐任务接受或节点白名单；本机执行开关决定是否开始，AI 审批模式决定 OpenCode 工具是否询问。旧版 30 分钟准备记录和自动/有限/每项确认调用策略只作为迁移历史保留。实现边界见 [ADR-0002](adr/0002-configurable-node-invocation-policy.md) 和 [ADR-0003](adr/0003-trust-and-ai-approval.md)。

## 锁定运行时与安装产物

| 组件                   | 版本/状态                                        |
| ---------------------- | ------------------------------------------------ |
| Node.js                | 24.19.0，随桌面包提供                            |
| OpenCode Windows + SDK | 1.18.25，官方未修改版本                          |
| Tauri                  | Rust 依赖锁定为 2.11.5 系列，`Cargo.lock` 已保留 |
| npm                    | `package-lock.json` 已保留                       |

上一版已验证的内测安装包：

- 路径：`src-tauri/target/release/bundle/nsis/Rivloom_0.1.0_x64-setup.exe`
- 大小：71,016,423 字节
- SHA-256：`f3b5085622258e4957c6d92ded9ca54f1c5cf32550c98ba37ec2d8bdc8225ab2`
- 状态：未签名内测包；开发机隔离安装、随包引擎启动、进程清理和卸载通过。

该 NSIS 早于普通文件夹和本轮设备信任/AI 审批改动，不能作为当前最新安装器分发。本轮已更新 `src-tauri/target/release/Rivloom.exe`；再次发给其他设备前需重建并复测 NSIS。

客户安装 Rivloom 后不需要另装 OpenCode 或本产品所需的 Node。Rivloom 项目不要求 Git；项目自身需要的语言工具链和 WebView2 仍是环境前提。

## 最终验证基线

- 最终 Release 桌面程序真实闭环：11 项通过；模型 `opencode/mimo-v2.5-free`；任务 `46dd767c-ae19-401d-890a-e65ba5bfef59`；OpenCode 会话 `ses_fa4bf8155ffe1Iq2eD7Uzu9sz2`。新增项验证桌面本机令牌与无表单自动身份。
- 官方 OpenCode 模型设置接口：6 项通过。测试字符串经 `auth.set/remove` 和 `provider.list` 完成保存、刷新、重启恢复与移除；看到 3 个 DeepSeek 模型；没有发送模型请求。
- DeepSeek 普通文件夹真实任务：`deepseek/deepseek-v4-flash`，任务 `RV-001`，OpenCode 会话 `ses_fa2e2a5f4ffeFyQrlJVwILugr4`；目录无 `.git`，1 项测试通过、测试文件未变并完成验收。官方 `session.diff` 返回空数组，Rivloom 没有用文件快照或哈希兜底。
- Release Tauri WebView2 模型页面：5 项通过；验证无 Key 状态、密码输入、额度确认、默认模型与审计界面。
- 上一版 NSIS：安装/启动/卸载烟雾测试通过；普通文件夹和设备信任/AI 审批改动尚未重建安装器。
- M3 Release WebView2：18 项通过；真实第二节点完成发现/配对、可信任务自动接收、能力关闭时不启动、“帮我批准”无人工提示执行、随包 OpenCode 会话和文件生成、有序状态、远端隐私边界、同项目并发拒绝及设备撤销。
- 官方 OpenCode 权限接口：1.18.25 成功创建并读回三种会话权限规则，没有发送模型请求或读取凭据。
- 本地：TypeScript 检查与生产构建通过；15 项测试通过；Cargo fmt/clippy 通过；生产依赖离线 audit 为 0 个已知漏洞。

机器报告位于被 Git 忽略的 `.data/verification`。它们用于本机核对，不应直接提交或公开：

- `desktop-integration.json`
- `desktop-ui.json` 与 `desktop-direct-start.png`
- `model-settings.json`
- `desktop-model-settings.json` 与 `desktop-model-settings.png`
- `deepseek-plain-folder.json`
- `desktop-install.json`
- `desktop-node-network.json`、`desktop-node-network.png` 与 `desktop-node-pairing.png`

## 明确未完成

- Win10 `192.168.5.18` 与 Win11 `192.168.5.20` 的受信任务自动接收、三种 AI 审批、真实 OpenCode 执行、撤销信任停止任务及异常进程结束/断网兜底物理复测；远程审批/补充/停止、差异/产物、角色映射和两位真人验收仍未完成。
- ChatGPT 登录。
- 干净 Windows 虚拟机的安装/升级/卸载矩阵、代码签名、自动更新和正式商业发行审查。
- 完整多租户权限、自研沙箱、陌生参与者安全边界、压力/灾难恢复和 DLP。

项目目录已经改为普通文件夹语义：不要求 Git、不自动初始化 Git、不建立文件快照或内容哈希。产物页仅展示 OpenCode 官方接口明确返回的会话差异；验收直接依据本地文件、执行记录和测试结果。

下一步在已完成的策略化自动执行和有序状态之上实现跨设备角色与控制消息：先接审批/拒绝、回答、补充要求和停止，再接差异/产物及验收。所有控制必须校验任务路由、角色、事件序号和任务版本。业务应用和引擎仍只监听 loopback；OpenCode 永远不直接暴露到局域网或公网。

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

> 请先阅读 `docs/HANDOFF.md`、`docs/PROGRESS.md`、`docs/adr/0001-self-discovering-brain-network.md`、`docs/adr/0002-configurable-node-invocation-policy.md`、`docs/adr/0003-trust-and-ai-approval.md` 和实施计划。先核对仓库状态，不重做 M0/M1/M2 或 M3 已完成的底层协议，不使用过期 OpenCode Go，不修改旧项目。设备信任、本机执行能力与 AI 审批已经分层；受信任务自动接收，三种审批模式经官方 OpenCode 会话权限传入。下一步接跨设备角色、审批/回答/补充/停止，再接差异、产物和验收。
