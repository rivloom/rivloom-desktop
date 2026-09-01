# 实际验证记录

日期：2026-09-01；Windows x64，Node.js 24.19.0，OpenCode CLI / SDK 1.18.25。执行数据保存在被 Git 忽略的 `.data`，仅此目录下的专用测试仓库被真实 AI 修改。旧项目 `C:\project\opencohive` 仅只读参考产品文档，没有复制或修改源码。

## Windows 桌面端（2026-09-01 更新）

`RIVLOOM_TEST_DESKTOP_EXECUTABLE=...Rivloom.exe node scripts/integration.ts`：**安装包对应的真实桌面可执行程序 10 组检查全部通过**。

- Tauri 进程自动启动随包 Node.js、本地服务和未修改的官方 OpenCode 1.18.25；使用随机 loopback 端口。
- 从桌面进程完成真实模型编辑、SSE 流输出、编辑/命令人工审批、Git 产物、人工验收、持久化重启、补充要求停止和异常退出恢复。
- 最终安装包重新构建后，真实任务 `0a0084e9-5eaf-484d-ab23-c3346de86835`、官方引擎会话 `ses_fa564ffa1ffeQ43AqzV4XtjQ1c` 再次通过；2 次审批，1 个变更产物。
- 强制结束桌面父进程后，随包 Node 和 OpenCode 进程均被清理；下次启动任务转为 `interrupted`，没有自动继续或写入。
- 机器报告：`.data/verification/desktop-integration.json`。

真实 Windows 窗口检查：**通过**。在隔离测试目录启动 Release 可执行程序，通过实际 WebView2 创建合成测试账号并进入任务工作台；首次页面没有要求用户打开终端读取初始化码；桌面标签和原生目录操作存在。模型设置完成后，再次通过 Release Tauri WebView2 检查“模型与额度”页面、无 Key 状态、密码输入、额度确认、默认模型和审计界面。证据：`.data/verification/desktop-ui.json`、`.data/verification/desktop-model-settings.json`、`.data/verification/desktop-workbench.png` 和 `.data/verification/desktop-model-settings.png`。

当前 NSIS current-user 安装包重新通过开发机隔离目录的静默安装烟雾测试：安装后的客户端成功启动随包引擎；关闭后后台进程树清理；卸载移除应用可执行程序并保留独立用户数据目录。报告为 `.data/verification/desktop-install.json`。安装包 71,004,533 字节，SHA-256：`48ef221a2320eaf4402c26930b7f80bbc29489b909d3f3faa20036b4ad801b72`。

尚未在一台干净 Windows 虚拟机执行完整安装、升级、卸载矩阵，也未代码签名。这里不把开发机 Release 测试宣传成完成商业发行验收。

## M3.1 节点身份与局域网自发现

`npm run test:node-network-ui`：**5 项实际 Release 桌面检查通过**。测试启动安装包对应的 `Rivloom.exe` 和第二个完全隔离的真实节点实例，不使用网络 mock。

- 两个实例各自生成稳定 Ed25519 身份；私钥 PKCS#8 只以 Windows DPAPI CurrentUser 密文保存在节点身份文件中，重载后 Node ID 不变。
- 两个实例在本机真实 mDNS/DNS-SD 网络栈发布和发现 `_rivloom._tcp.local`，使用不同数据目录、Node ID、Brain ID 和端口。
- 发现方连接对方独立的 `/v1/hello` 端点，发送随机 nonce，并核对公钥派生 Node ID、指纹、响应时间与 Ed25519 签名。
- 实际 Tauri WebView2 “节点与 Brain”页显示本机节点、Brain 和附近节点；对方明确保持“签名已验证、尚未配对授权”。
- 节点端点拒绝畸形请求，业务路径返回 404；React 业务服务与 OpenCode 没有暴露到局域网。

机器报告和截图：`.data/verification/desktop-node-network.json`、`.data/verification/desktop-node-network.png`。这是同一台 Windows 上的双实例网络验证，尚未覆盖两台物理设备、不同防火墙/网卡环境。配对、撤销、加密业务通信和任务委派属于 M3.2 以后范围；不能把“签名身份已验证”写成“设备已信任”。

## 模型设置与 DeepSeek 公共接口

`npm run test:model-settings`：**6 项检查通过**。这组检查启动真实应用和未修改的官方 OpenCode 1.18.25，不使用 mock，也不发模型请求。

| 检查            | 实际结果                                                                                |
| --------------- | --------------------------------------------------------------------------------------- |
| 无 Key 初始状态 | 可读取免费模型；DeepSeek 明确显示未配置                                                 |
| 权限与输入      | 普通成员修改返回 403；含空格的错误格式 Key 返回 400                                     |
| 官方凭据保存    | 测试字符串经 OpenCode `auth.set` 写入引擎凭据；`provider.list` 返回 3 个 DeepSeek 模型  |
| 敏感信息        | 业务 SQLite、应用响应和模型操作记录均未出现测试 Key；提供方错误信息只返回固定的安全提示 |
| 默认模型与重启  | DeepSeek 模型可设为新任务默认值；干净重启后凭据状态和默认模型恢复                       |
| 官方凭据移除    | OpenCode `auth.remove` 后 DeepSeek 断开，测试 Key 不再存在于引擎凭据或业务数据          |

机器报告：`.data/verification/model-settings.json`。模型操作记录只包含操作人、操作类型、provider、模型、结果和时间。真实连接测试使用无项目文件、全部工具 deny 的单次 OpenCode 会话；60 秒超时、可停止、不自动重试，工作区 10 分钟最多 3 次。安全测试另外覆盖损坏配置回退和上游错误不回显秘密。

**没有有效 DeepSeek Key，所以没有验证 DeepSeek 认证、额度、回复或编程能力。** 测试字符串能被 OpenCode 保存并列出模型，只证明薄适配层使用的公开接口可用，不能标记为“DeepSeek 已连接”。真正的连接测试需要创建者在桌面客户端本机输入 Key 并再次确认可能计费。

## 第一阶段：先验证官方引擎

`npm run engine:probe`：**通过**。

- 官方服务启动并核对版本；随机 Basic Auth 密码，loopback 监听。
- 创建真实会话，模型为官方 `opencode/mimo-v2.5-free`。
- 原始函数直接返回输入，模型修改为处理大小写、连续空白/标点、首尾连字符；三个断言均通过。
- 67 条 SSE 增量事件、2 次权限回复（文件编辑和 `node --test slugify.test.mjs`）。
- 读取真实会话结果；Git 取得真实代码 diff。
- 第二个真实会话进入待审批后调用 abort；文件未被修改；显式 reject 残留权限后请求清空。

探针会话：`ses_fa8b60165ffeIS3uONFh7AabLS`。完整输出在 `.data/verification/engine-probe.json`。

**没有掩盖的失败/降级：**

- 现有 OpenCode Go 凭据请求返回余额不足。没有充值或修改原账号，改用官方免费模型验证。为探针临时导入的凭据副本已移除，原文件未改动。
- `opencode-ai` npm 安装包装器失败，改用其提示的同版本官方 Windows 平台包。
- 官方 `session.diff` 在本机真实修改后仍返回 `[]`。当前产物审阅使用只读 Git diff，并在界面标注来源。没有修改引擎来规避问题。
- abort 后仍可能留下待审批请求，薄适配层显式 reject。

## 完整应用与独立账号

`npm run test:integration` 最后一次完整运行：**10 组检查通过**。

使用同一真实应用服务、两个独立账号/不同会话 cookie（另加非参与者账号），不是前端角色切换，也不是 mock。

| 检查                        | 实际结果                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| 未登录读取 / 跨源写入       | 401 / 403                                                                                                |
| 一次性邀请、独立注册和登录  | 通过，邀请码重用被拒绝                                                                                   |
| 非参与者访问任务 / 事件范围 | 任务读取被拒绝，列表不包含该任务；事件服务端按参与者过滤                                                 |
| 接受与启动的角色限制        | 发起人不能替接受人接单/启动；接受人可启动                                                                |
| 同项目并发                  | 第二个任务启动返回 409                                                                                   |
| 真 AI 执行与权限            | 编辑和 Node 测试均真实审批；非审批人回复被拒绝；重复批准被拒绝                                           |
| SSE 与产物                  | 正文增量到达，真实测试通过，捕获一个变更文件                                                             |
| 验收                        | 非验收人被拒绝；外部改动导致 409；恢复同一产物后验收成功                                                 |
| 已完成任务重启恢复          | 账号、会话、状态、消息、产物与活动仍在                                                                   |
| 补充要求 / 异常退出恢复     | 补充要求先停止、关闭残留审批、文件不变；执行中强制结束应用后重启为 interrupted，不自动继续；可再确认停止 |

最终真实引擎会话：`ses_fa898e4b3ffepaqwHlDoZObNDL`；业务任务 ID：`9f83f830-c688-4ced-a156-d4597ea8738e`。机器可读报告：`.data/verification/integration.json`。

测试早期发现后台同步会偶尔抢占用户审批锁，已修正为用户操作串行排队、后台同步避让，并重新通过上述完整流程。模型曾额外请求 `ls -la`，严格测试拒绝并判失败；集成测试随后只增加了人工检查过的两个固定只读目录命令，仍独立断言编辑和指定 Node 测试命令必须发生。没有把失败标成成功或启用通用自动批准。

这里验证的是两个独立身份/会话的协作协议；没有声称已由两个真人完成产品内测，也没有验证跨设备网络。

## 本地检查

- `npm run typecheck`：通过（strict、noUnusedLocals、noUnusedParameters）。
- `npm run build`：通过，生成 React 生产构建。
- `npm test`：9 项通过；在原有安全检查外，新增私有地址过滤、Windows DPAPI 稳定身份，以及两个隔离节点的真实 mDNS 发现/随机挑战/签名校验/未授权边界。
- `npm audit --offline --omit=dev`：当日 0 个已知漏洞；不是安全认证。
- `cargo fmt --check` 与 `cargo clippy --all-targets -- -D warnings`：通过。
- 官方版本、npm integrity、二进制 SHA-256、MIT 原文及 123 个已安装依赖的许可证元数据已保存。

## 浏览器与启动验收

在独立 UI 测试工作区（4318 端口）实际操作：初始化账号 → 添加真实 Git 项目 → 创建/接受任务 → 风险确认 → 逐次批准只读目录查询、文件修改和测试命令 → 核对真实 Node 输出（1 pass / 0 fail）→ 查看 Git diff → 填写验收意见 → 已验收。测试会话 `ses_fa89bcbaeffeTWAA2smQGQJYB3`。这项 UI 测试使用一个明确标注的测试账号，不声称是两人测试。

桌面截图保存在 `.data/verification/ui-workbench.png`。390px 窄屏工作台未出现横向溢出；浏览器没有 error/warn 日志。实际刷新后任务与待审批请求仍可恢复。

生产模式与开发模式均能启动。开发首页包含 Vite 客户端，返回 HTTP 200。端口占用返回明确错误且不再启动引擎；同一数据目录改用另一端口双开仍被进程锁拒绝。没有占用时，新实例可以恢复已退出进程留下的锁。

## 尚未验证或不包含

- 两台物理设备/两个真人协作、不同局域网环境的发现兼容性、设备配对与撤销、加密节点业务通信、单/多 Brain 任务委派和跨网络运行。同机双实例自发现与签名校验已经验证。
- DeepSeek 有效凭据的真实连接回复和完整编程任务；ChatGPT 登录。
- 干净 Windows 虚拟机安装/升级矩阵、自动更新、代码签名、ARM64/macOS/Linux。
- AI 主动 question 分支的实际模型触发（接口和 UI 已实现）；长期 shell / 已脱离进程树的后台任务的可靠停止。
- 大仓库/大量任务/长时间运行、磁盘满、断电、损坏数据恢复；完整安全审计与 DLP。

停止不回滚；可信测试目录不是沙箱；免费模型可用性和提供方政策可能变化。更详细的风险范围见 [SECURITY.md](../SECURITY.md)。
