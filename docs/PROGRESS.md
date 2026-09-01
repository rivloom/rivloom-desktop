# 实施进度

更新日期：2026-09-01。

整体计划：[Rivloom MVP 实施计划](plans/2026-08-31-mvp-delivery.md)。

## 当前停点

M1 模型设置产品功能和 M2 开发机桌面交付均已完成。当前 Windows 客户端包含模型设置页、DeepSeek 工作区凭据管理、真实连接测试、默认模型、任务模型选择和无密钥审计记录；官方 OpenCode 仍是唯一执行引擎。

有效 DeepSeek Key 尚未提供，因此没有产生 DeepSeek 成功回复或 DeepSeek 编程任务报告。所有不需要真实 Key 的工作已经完成：使用测试字符串通过官方 OpenCode `auth.set` / `auth.remove` 和 `provider.list` 验证凭据生命周期；业务数据库与接口响应未出现 Key；真实 Release WebView2 页面和新安装包均已验证。

运行状态：用户要求关闭网页端后，`127.0.0.1:4310` 的内部 Web 调试服务及其引擎子进程已于 2026-09-01 停止。本轮所有隔离后端、桌面、安装和引擎测试进程也已停止；不会作为产品入口常驻。

产品方向已修正：M3 不采用“一台主机开启协作空间、另一台作为访客连接”的方案。安装 Rivloom 的实例都是节点，同网段节点自动发现彼此，并可承载一个或多个 Brain。桌面首次启动现已取消工作区/账号表单，通过启动期本机令牌自动建立操作者，直接进入任务界面并发现节点。M3.1 已完成稳定节点身份、DPAPI 私钥保护、mDNS/DNS-SD、LAN UDP 查询/单播回复回退、随机挑战签名验证、受限公开端点和桌面节点页。Brain 任务归属、设备配对和委派仍待后续；OpenCode 始终只在实际执行节点本机监听 loopback。架构边界见 [ADR-0001](adr/0001-self-discovering-brain-network.md)。

## 阶段状态

| 阶段                   | 状态                                                                          |
| ---------------------- | ----------------------------------------------------------------------------- |
| M0 真实引擎与任务闭环  | 新 Release 桌面包内真实回归 11 组通过，包含桌面无表单自动身份                 |
| M1 模型设置与 DeepSeek | 功能已实现并完成无 Key 验证；真实 DeepSeek 调用待用户在客户端本机填入有效 Key |
| M2 Windows 安装包      | 开发机安装/启动/卸载通过；干净机、升级矩阵和签名待发行阶段                    |
| M3 自发现节点与 Brain  | Win10/Win11 双向发现已通过；30 秒离线/120 秒移除修复待原设备复测              |
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
- `server/node-network.ts`：独立受限节点端点、`_rivloom._tcp.local` 发布/发现、LAN UDP 查询/单播回复回退、私有来源过滤、限频、随机挑战签名校验和节点过期处理。
- `src/node-network.tsx`：桌面“节点与 Brain”页，区分本机、签名已验证的附近节点和尚未配对授权状态。
- 节点心跳每 10 秒刷新；30 秒没有成功签名心跳改为离线，120 秒后移除。顶部、Brain 和侧栏数量只统计在线节点，恢复心跳自动上线。
- `tests/node-network.test.ts` 与 `scripts/node-network-ui.ts`：分别关闭回退或 mDNS 的真实双实例发现/签名边界测试，以及 Release WebView2 页面验证。

## 当前证据

- `.data/verification/model-settings.json`：6 项官方 OpenCode 凭据/模型接口检查通过；看到 3 个 DeepSeek 模型；无真实模型请求。
- `.data/verification/desktop-model-settings.json`：5 项实际 Release WebView2 模型设置页面检查通过。
- `.data/verification/desktop-model-settings.png`：模型设置桌面页面截图。
- `.data/verification/desktop-integration.json`：最终 Release 使用 `opencode/mimo-v2.5-free` 的 11 组真实闭环检查通过；任务 `46dd767c-ae19-401d-890a-e65ba5bfef59`，引擎会话 `ses_fa4bf8155ffe1Iq2eD7Uzu9sz2`。
- `.data/verification/desktop-ui.json` 与 `desktop-direct-start.png`：全新数据目录无账号/工作区表单，自动建立本机操作者并直达任务工作台，发现已启动。
- `.data/verification/desktop-install.json`：当前安装包开发机隔离安装/启动/卸载通过。
- `.data/verification/desktop-node-network.json` 与 `.png`：5 项实际 Release 节点页检查通过；第二个隔离实例通过真实 mDNS、nonce 和 Ed25519 签名被发现，保持未授权。
- 本地检查：TypeScript/生产构建通过；10 项测试通过，其中 mDNS 与 LAN UDP 回退分别强制验证；`cargo fmt --check`、`cargo clippy -- -D warnings` 通过；生产依赖离线 audit 为 0 个已知漏洞。

安装包：`src-tauri/target/release/bundle/nsis/Rivloom_0.1.0_x64-setup.exe`，71,010,576 字节，SHA-256 `3fb676844d87998cc49174fbe50a49d215b24c05fa40b3607e5224cb1b2ecc5b`。这是包含 LAN UDP 回退和离线状态修复的未签名内测包，开发机隔离安装/启动/卸载已通过。

## 下一次恢复工作时

1. 把当前包含离线状态修复的新包安装到 Win10 `192.168.5.18` 与 Win11 `192.168.5.20`；关闭一端，确认另一端约 30 至 40 秒显示离线、约 120 至 130 秒后移除。
2. 重新启动关闭的客户端，确认它自动恢复在线，Node ID/Brain ID 与关闭前一致。
3. 实现 M3.2 双方确认配对、持久信任与撤销；在认证加密通道完成前，不开放任何任务或业务 API。
4. 配对验证后再做单 Brain 分布式任务和最小跨 Brain 委派；正式发给更多内测者前，完成干净 Windows 虚拟机安装/升级/卸载、代码签名和发布安全审查。
5. 用户若准备好 DeepSeek Key，只在 Rivloom 客户端“模型与额度”页面本机输入，不发到聊天、仓库或截图；确认额度共享后做真实连接测试，再用专用 fixture 回归完整编程闭环。

## 持续约束

不使用已过期的 OpenCode Go；不修改旧项目；不修改或 fork OpenCode；不公开引擎接口；不把自动发现等同于自动信任；不把共享工作区凭据宣传成每个成员独立账号；不把测试字符串接口验证宣传成 DeepSeek 已连接；不把未签名内测包宣传成完成商业发行审查。
