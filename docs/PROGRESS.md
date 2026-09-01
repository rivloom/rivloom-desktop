# 实施进度

更新日期：2026-09-01。

整体计划：[Rivloom MVP 实施计划](plans/2026-08-31-mvp-delivery.md)。

## 当前停点

M1 模型设置产品功能和 M2 开发机桌面交付均已完成。当前 Windows 客户端包含模型设置页、DeepSeek 工作区凭据管理、真实连接测试、默认模型、任务模型选择和无密钥审计记录；官方 OpenCode 仍是唯一执行引擎。

有效 DeepSeek Key 尚未提供，因此没有产生 DeepSeek 成功回复或 DeepSeek 编程任务报告。所有不需要真实 Key 的工作已经完成：使用测试字符串通过官方 OpenCode `auth.set` / `auth.remove` 和 `provider.list` 验证凭据生命周期；业务数据库与接口响应未出现 Key；真实 Release WebView2 页面和新安装包均已验证。

运行状态：用户要求关闭网页端后，`127.0.0.1:4310` 的内部 Web 调试服务及其引擎子进程已于 2026-09-01 停止。本轮所有隔离后端、桌面、安装和引擎测试进程也已停止；不会作为产品入口常驻。

产品方向已修正：M3 不采用“一台主机开启协作空间、另一台作为访客连接”的方案。安装 Rivloom 的实例都是节点，同网段节点自动发现彼此，并可承载一个或多个 Brain。桌面首次启动现已取消工作区/账号表单，通过启动期本机令牌自动建立操作者，直接进入任务界面并发现节点。M3.1 已完成节点身份与发现，M3.2 配对闭环已通过用户的 Win10/Win11 物理双机，认证加密通道和 Brain 目录已通过真实双实例、攻击路径自动化和实际 Release WebView2。

**2026-09-01 的 M3.3 产品修正已经实现第一段。** 本机所有者一次配置项目、模型和调用方式：自动调用是界面默认，也可限制到指定受信节点或改为每项确认。匹配的加密协作任务只创建一个本机业务任务和官方 OpenCode 会话；归属 Brain 按单调序号收到状态和最终摘要，但收不到本机项目/模型/任务 ID 或凭据。旧版 30 分钟准备记录会迁移为不可自动执行的历史记录，旧界面已删除。实际 Release WebView2 已让真实第二节点发起任务，由随包 OpenCode 在隔离 Git 项目生成并核对 `RESULT.txt`。跨设备审批、补充要求、停止、差异/产物和验收仍待下一切片。详见 [ADR-0002](adr/0002-configurable-node-invocation-policy.md)。OpenCode 始终只在实际执行节点本机监听 loopback。

## 阶段状态

| 阶段                   | 状态                                                                          |
| ---------------------- | ----------------------------------------------------------------------------- |
| M0 真实引擎与任务闭环  | 新 Release 桌面包内真实回归 11 组通过，包含桌面无表单自动身份                 |
| M1 模型设置与 DeepSeek | 功能已实现并完成无 Key 验证；真实 DeepSeek 调用待用户在客户端本机填入有效 Key |
| M2 Windows 安装包      | 开发机安装/启动/卸载通过；干净机、升级矩阵和签名待发行阶段                    |
| M3 自发现节点与 Brain  | 配对物理通过；策略化自动调用和真实执行 Release 通过，远程控制/产物待做        |
| M4 ChatGPT 登录        | 待做、按需验证                                                                |
| M5 商业内测发布检查    | 待做；锁版和必要开源声明已有                                                  |

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
- `server/node-channel.ts`、`server/node-network.ts`：Ed25519 签名临时 X25519 握手、HKDF 方向密钥、AES-256-GCM、严格序号/时间窗、10 分钟轮换和撤销断链；当前开放最小 Brain 目录、协作任务控制和有序执行状态消息。
- `server/execution-policy.ts`、`server/remote-tasks.ts`、`server/index.ts`、`src/node-network.tsx`：持久本机能力配置；自动/有限/每项确认策略；旧准备记录安全迁移；远端任务与本机业务任务唯一绑定；真实 OpenCode 启动；单调状态/摘要回传；同项目和并发保护。撤销来源设备信任会停止其仍在本机运行的任务，已有修改不回滚。
- 正常关闭会主动发送签名离线通知；异常断电或断网时每 5 秒刷新签名心跳，约 15 秒显示离线、约 30 秒移除。顶部、Brain 和侧栏数量只统计在线节点，恢复心跳自动上线。
- `tests/node-network.test.ts` 与 `scripts/node-network-ui.ts`：分别关闭回退或 mDNS 的真实双实例测试，覆盖握手伪造/重放、密文篡改、消息重放、过期、重启与撤销，以及 Release WebView2 加密通道页面验证。

## 当前证据

- `.data/verification/model-settings.json`：6 项官方 OpenCode 凭据/模型接口检查通过；看到 3 个 DeepSeek 模型；无真实模型请求。
- `.data/verification/desktop-model-settings.json`：5 项实际 Release WebView2 模型设置页面检查通过。
- `.data/verification/desktop-model-settings.png`：模型设置桌面页面截图。
- `.data/verification/desktop-integration.json`：最终 Release 使用 `opencode/mimo-v2.5-free` 的 11 组真实闭环检查通过；任务 `46dd767c-ae19-401d-890a-e65ba5bfef59`，引擎会话 `ses_fa4bf8155ffe1Iq2eD7Uzu9sz2`。
- `.data/verification/desktop-ui.json` 与 `desktop-direct-start.png`：全新数据目录无账号/工作区表单，自动建立本机操作者并直达任务工作台，发现已启动。
- `.data/verification/desktop-install.json`：当前安装包开发机隔离安装/启动/卸载通过。
- `.data/verification/desktop-node-network.json`、`.png` 与 `desktop-node-pairing.png`：17 项实际 Release 节点页检查通过；真实第二实例完成加密协作任务、默认自动策略、本机项目/模型复用、随包 OpenCode 会话和文件生成、有序远端状态、隐私边界、同项目并发拒绝和设备撤销。
- 本地检查：TypeScript/生产构建通过；15 项测试通过，其中握手/密文攻击、远端任务幂等、旧记录迁移、策略持久化、唯一任务绑定、单调状态、重启与撤销均有验证；`cargo fmt --check`、`cargo clippy -- -D warnings` 通过；生产依赖离线 audit 为 0 个已知漏洞。

安装包：`src-tauri/target/release/bundle/nsis/Rivloom_0.1.0_x64-setup.exe`，71,016,423 字节，SHA-256 `f3b5085622258e4957c6d92ded9ca54f1c5cf32550c98ba37ec2d8bdc8225ab2`。这是包含策略化自动调用的未签名内测包；实际 Release WebView2 和该精确 NSIS 的安装/启动/卸载烟雾测试均通过。

## 下一次恢复工作时

1. 在现有有序状态通道上实现跨设备角色映射和远程控制：审批/拒绝、回答问题、补充要求和停止都必须绑定任务、角色、事件序号与当前版本。
2. 回传差异摘要、产物清单和内容哈希，再由归属 Brain 的验收人接受或退回；不要直接开放本机路径或 OpenCode API。
3. 用 Win10 `192.168.5.18` 与 Win11 `192.168.5.20` 物理复测新版能力配置、自动调用、真实执行、撤销信任停止任务和重启恢复。
4. 强制结束进程或断开网络，专项确认另一端约 15 秒显示离线、约 30 秒移除；恢复后自动上线并重建通道，不能重复执行任务。
5. 正式发给更多内测者前，完成干净 Windows 虚拟机安装/升级/卸载、代码签名和发布安全审查。
6. 用户若准备好 DeepSeek Key，只在 Rivloom 客户端“模型与额度”页面本机输入，不发到聊天、仓库或截图；确认额度共享后做真实连接测试，再用专用 fixture 回归完整编程闭环。

## 持续约束

不使用已过期的 OpenCode Go；不修改旧项目；不修改或 fork OpenCode；不公开引擎接口；不把自动发现等同于自动信任；不把共享工作区凭据宣传成每个成员独立账号；不把测试字符串接口验证宣传成 DeepSeek 已连接；不把未签名内测包宣传成完成商业发行审查。
