# 实施进度

更新日期：2026-09-02。

当前里程碑以 [里程碑基线](MILESTONES.md) 为准；长期细节见 [Rivloom MVP 实施计划](plans/2026-08-31-mvp-delivery.md)。

## 当前停点

产品负责人已重新确认：M0、M1、M3.1、M3.2 完成；M3.3 的单人双机核心闭环也已验收为 MVP 完成。M2 的正式发行完善暂缓；下一会话从 M3.4 产品定义讨论开始，在双方确认 Brain、节点、人、任务和资源关系前不进入实现。

M1 的模型设置产品功能和无 Key 验证已经完成。当前 Windows 客户端包含模型设置页、DeepSeek 工作区凭据管理、真实连接测试、默认模型、任务模型选择和无密钥审计记录；官方 OpenCode 仍是唯一执行引擎。

用户已在 Rivloom 本机保存 DeepSeek 官方 Key，并于 2026-09-01 用 `deepseek/deepseek-v4-flash` 完成禁用工具的真实连接测试和普通文件夹固定编程任务。任务目录没有 `.git`；编辑和指定测试命令分别经人工批准，独立核对为 1 项测试通过、测试文件未变并最终验收。Key 未进入聊天、仓库、截图或报告。

**2026-09-01 项目目录规则修正：** 项目可以是任何本机可访问的普通文件夹，不要求 Git，也不自动初始化 Git。Rivloom 已移除首次执行的干净提交要求、文件扫描快照、内容哈希和验收时的哈希复核。产物页只展示 OpenCode 官方会话接口明确返回的差异；没有返回差异时，验收人直接检查本地文件和测试记录。

运行状态：用户要求关闭网页端后，`127.0.0.1:4310` 的内部 Web 调试服务及其引擎子进程已于 2026-09-01 停止。本轮所有隔离后端、桌面、安装和引擎测试进程也已停止；不会作为产品入口常驻。

产品方向已修正：M3 不采用“一台主机开启协作空间、另一台作为访客连接”的方案。安装 Rivloom 的实例都是节点，同网段节点自动发现彼此，并可承载一个或多个 Brain。桌面首次启动现已取消工作区/账号表单，通过启动期本机令牌自动建立操作者，直接进入任务界面并发现节点。M3.1 已完成节点身份与发现，M3.2 配对闭环已通过用户的 Win10/Win11 物理双机，认证加密通道和 Brain 目录已通过真实双实例、攻击路径自动化和实际 Release WebView2。

**2026-09-01 的 M3.3 产品修正已经实现功能闭环。** 设备信任、本机执行能力和 AI 操作审批已经分层：受信任务自动接收；能力关闭时等待，开启后复用本机项目和模型；每个任务锁定“请求批准 / 帮我批准 / 允许任何操作”之一。权限经 OpenCode 1.18.25 官方会话接口传入，所有模式仍禁止敏感凭据读取、子代理和技能加载。远端任务只创建一个本机业务任务和官方 OpenCode 会话；归属 Brain 按单调序号收到状态和最小人工介入快照，并可批准/拒绝具体请求、回答 AI、停止、补充要求后继续同一会话、查看官方差异并验收。控制消息绑定任务路由、唯一控制 ID 和预期执行序号，经认证加密通道传输并在执行节点持久化去重；同一任务一次只接收一项控制。执行机项目路径、模型、任务 ID、审批 metadata 和凭据不回传；官方接口无差异时不扫描或哈希文件夹。旧版 30 分钟准备记录和自动/有限/每项确认调用策略已迁移，旧界面已删除。详见 [ADR-0002](adr/0002-configurable-node-invocation-policy.md) 和 [ADR-0003](adr/0003-trust-and-ai-approval.md)。OpenCode 始终只在实际执行节点本机监听 loopback。

**2026-09-02 单人双机核心闭环已由用户确认通过。** Win11 `192.168.5.20` 与当前开发机 `192.168.5.33` 使用真实 DeepSeek 和普通文件夹完成：自动发现/受信加密通道、可信任务自动接收、本机预设项目和模型、请求批准模式下的远程一次性批准、文件实际生成、归属端补充要求后继续同一 OpenCode 会话、执行机本地核对和归属端最终验收。该结果证明真实跨设备核心产品链路，不等于两位真人角色分离已经完成。

测试前再次出现单向发现。只读诊断确认 `5.33` 的节点 TCP 端口正常监听，但随包 `%LOCALAPPDATA%\Rivloom\runtime\node.exe` 的 Private TCP/UDP 入站规则为 `Enabled=Yes, Action=Block`；改为 Allow 后，`5.20 → 5.33` TCP 探测及自动发现恢复。当前安装器仍依赖 Windows 首次联网弹窗，没有可靠创建、检测、升级和卸载命名规则。该缺口已进入后续优化清单，不阻塞当前 MVP 推进。

## 阶段状态

| 阶段                   | 状态                                                          |
| ---------------------- | ------------------------------------------------------------- |
| M0 真实引擎与任务闭环  | 新 Release 桌面包内真实回归 11 组通过，包含桌面无表单自动身份 |
| M1 模型设置与 DeepSeek | 已完成；真实连接及无 `.git` 普通文件夹固定编程任务均通过      |
| M2 Windows 安装包      | 已有开发机内测包；正式发行完善按用户决定暂缓                  |
| M3.1 节点自发现        | 用户确认完成                                                  |
| M3.2 配对与加密连接    | 用户确认完成                                                  |
| M3.3 跨节点任务协作    | MVP 验收完成；剩余物理回归和防火墙体验延后优化                |
| M3.4 多 Brain 协作     | 下一会话先讨论并重新定义；确认前不实现                        |
| M4 ChatGPT 登录        | 待做、按需验证                                                |
| M5 商业内测发布检查    | 待做；锁版和必要开源声明已有                                  |

## 本轮交付

- `server/index.ts`、`server/auth.ts`：桌面启动期随机令牌、常量时间校验、自动创建/恢复本机操作者和令牌清理；业务接口仍需 HttpOnly 会话。
- `src-tauri/src/main.rs`、`src/desktop.ts`：只有当前 Tauri 主窗口和精确本机 origin 能取得启动令牌；不写入 WebView 持久化。
- `src/main.tsx`：桌面无工作区/账号初始化页，直接进入任务工作台；侧栏显示本机 Brain 和自动发现状态。
- `scripts/desktop-ui.ts`、`scripts/integration.ts`：全新目录直达工作台验证，以及错误/正确原生令牌与真实任务闭环回归。
- `server/model-settings.ts`：安全读取本地状态；DeepSeek 凭据设置/移除；状态失效；真实连接测试的超时、停止和清理；10 分钟 3 次限频；任务与设置互斥。
- `server/store.ts`：schema 3，增加只含操作人、操作类型、模型、结果和时间的 `model_operations`，不保存 Key 或测试回复。
- `src/model-settings.tsx`：桌面内“模型与额度”页面。创建者可保存/替换/移除凭据、确认后测试连接和设置默认模型；成员只读。
- `scripts/model-settings-check.ts`：真实应用和官方 OpenCode 1.18.25 公共 API 检查，不调用模型。
- `scripts/model-settings-ui.ts`：实际 Release Tauri WebView2 页面检查与截图。
- `scripts/desktop-install-smoke.ts`：当前 NSIS 的隔离安装、随包引擎启动、进程清理、卸载和数据保留检查。
- `server/node-identity.ts`：稳定 Ed25519 节点身份、Node ID/指纹派生和 Windows DPAPI CurrentUser 私钥保护。
- `server/node-network.ts`、`server/node-trust.ts`：独立受限节点端点、发现与离线处理、签名配对会话、短码派生、双方确认、公开信任记录持久化、冲突拒绝、撤销和重试。
- `server/node-channel.ts`、`server/node-network.ts`：Ed25519 签名临时 X25519 握手、HKDF 方向密钥、AES-256-GCM、严格序号/时间窗、10 分钟轮换和撤销断链；当前开放最小 Brain 目录、协作任务控制和有序执行状态消息。新增签名单边恢复请求，由较小 Node ID 确定性重建通道，避免单侧仍持有旧会话时永久失联。
- `server/execution-policy.ts`、`server/remote-tasks.ts`、`server/index.ts`、`src/node-network.tsx`：持久本机能力配置；受信任务自动接收；请求批准/帮我批准/允许任何操作三种 AI 审批；旧策略安全迁移；远端任务与本机业务任务唯一绑定；真实 OpenCode 启动；单调状态与人工介入快照回传；远程批准/拒绝、回答、停止、补充要求后续跑同一会话、官方差异展示和最终验收；同项目和并发保护。控制按任务路由和执行序号校验并持久去重；同一任务一次只处理一个控制；撤销来源设备信任会停止其仍在本机运行的任务，已有修改不回滚。
- 正常关闭会主动发送签名离线通知；异常断电或断网时每 5 秒刷新签名心跳，约 15 秒显示离线、约 30 秒移除。顶部、Brain 和侧栏数量只统计在线节点，恢复心跳自动上线。
- `tests/node-network.test.ts` 与 `scripts/node-network-ui.ts`：分别关闭回退或 mDNS 的真实双实例测试，覆盖握手伪造/重放、密文篡改、消息重放、过期、重启与撤销，以及 Release WebView2 加密通道页面验证。

## 当前证据

- `.data/verification/model-settings.json`：6 项官方 OpenCode 凭据/模型接口检查通过；看到 3 个 DeepSeek 模型；无真实模型请求。
- `.data/verification/deepseek-plain-folder.json`：Release Tauri 中用 `deepseek/deepseek-v4-flash` 完成无 `.git` 普通文件夹编程任务；1 项测试通过、测试文件未变、任务已验收，报告不含凭据或完整模型回复。
- `.data/verification/desktop-model-settings.json`：5 项实际 Release WebView2 模型设置页面检查通过。
- `.data/verification/desktop-model-settings.png`：模型设置桌面页面截图。
- `.data/verification/desktop-integration.json`：最终 Release 使用 `opencode/mimo-v2.5-free` 的 11 组真实闭环检查通过；任务 `46dd767c-ae19-401d-890a-e65ba5bfef59`，引擎会话 `ses_fa4bf8155ffe1Iq2eD7Uzu9sz2`。
- `.data/verification/desktop-ui.json` 与 `desktop-direct-start.png`：全新数据目录无账号/工作区表单，自动建立本机操作者并直达任务工作台，发现已启动。
- `.data/verification/desktop-install.json`：当前安装包开发机隔离安装/启动/卸载通过。
- `.data/verification/desktop-node-network.json`、`.png` 与 `desktop-node-pairing.png`：上一完整运行的 23 项实际 Release 节点页检查通过；真实第二实例完成加密协作任务、能力关闭仍自动接收但不启动、发起方界面回答/拒绝/停止、随包 OpenCode 在人工介入点被远程停止、另一真实会话经远程一次性批准后生成文件、有序状态、隐私边界、同项目并发拒绝及设备撤销。AI 提问界面使用协议级执行快照触发，不冒充模型真实提问。
- 本轮新 Release 实际 WebView2 已完成新增的官方差异卡片、补充要求和远程验收控制的加密往返；随后真实 `opencode/mimo-v2.5-free` 停止夹具在 10 分钟内只产生空 assistant 消息、没有进入人工介入点，因此整组新报告没有写成通过。产品逻辑与外部免费模型可用性分开记录。
- 用户在物理设备 `192.168.5.20` 与 `192.168.5.33` 上用真实 DeepSeek 完成普通文件生成任务、远程一次性批准、补充要求同会话续跑、本地核对和远程验收；这是人工确认，不生成或伪造自动化机器报告。
- `.data/verification/permission-policy.json`：官方 OpenCode 1.18.25 成功创建并读回三种会话权限规则；没有发送模型请求或读取凭据。
- 本地检查：TypeScript/生产构建通过；16 项测试通过，其中权限策略、握手/密文攻击、远端任务幂等、旧记录迁移、策略持久化、唯一任务绑定、单调状态、重启与撤销均有验证。新 Release 与实际 WebView2 整组回归通过。

当前安装包 `src-tauri/target/release/bundle/nsis/Rivloom_0.1.0_x64-setup.exe` 已在本轮重建：71,070,646 字节，SHA-256 `d688e2d9a2f978fc7bde08fa09c88ffc17ab3bc86f607e3947bd9e92b281ef01`。对应 `Rivloom.exe` 为 10,264,576 字节，SHA-256 `9da6c7b764f4cef3a33a02508ff4fbb414fba84c3721a47295d31bdf1f5c24cd`。新安装器尚未重新执行隔离安装/启动/卸载烟雾测试，仍为未签名开发机内测产物。

## 下一次恢复工作时

1. 只讨论 M3.4 产品定义，先用个人和企业场景说清 Brain、节点、人、任务、项目、模型额度与算力资源分别是什么、如何组合，以及“一个或多个 Brain 协同做事”的最小可见行为。
2. 对照用户原始意图检查历史 ADR-0001 和实施计划；历史“每节点一个 Brain / Brain A 委派 Brain B”只能作为草案，不能当成已确认需求。
3. 讨论完成后先更新里程碑和 ADR，列出 M3.4 最小闭环、明确不做项和验收方法，再开始实现。

## 后续优化清单（不阻塞 M3.4）

1. 为随包 `node.exe` 设计仅限 Private/LocalSubnet 的 Rivloom 命名防火墙规则或等效低摩擦方案，覆盖安装、升级、诊断和卸载；不得开放 React、OpenCode 或通用引擎接口。
2. 物理补测远程停止、“帮我批准 / 允许任何操作”、执行中撤销来源设备信任、重启保持、异常结束/断网恢复和两真人角色映射。
3. 后续发行阶段重建并复测 NSIS 的安装、启动、双机发现、升级、退出清理和卸载。

## 持续约束

不使用已过期的 OpenCode Go；不修改旧项目；不修改或 fork OpenCode；不公开引擎接口；不把自动发现等同于自动信任；不把共享工作区凭据宣传成每个成员独立账号；不把测试字符串接口验证宣传成 DeepSeek 已连接；不把未签名内测包宣传成完成商业发行审查。
