# Windows 桌面端

产品交付形态是 Tauri 桌面客户端。React 只负责窗口内界面；浏览器入口保留作内部调试，不是给客户的启动方式。

## 当前实现

- 原生 Windows 窗口、图标、最小尺寸、单实例聚焦。
- 原生文件夹选择器，用于选择本机已审核的 Git 项目。选择目录仍需确认信任，不能代替沙箱。
- 启动时自动运行随包 Node.js 24.19.0、本地业务服务、官方 OpenCode 1.18.25；无需客户另装 OpenCode 或 Node。
- 业务服务使用随机 loopback 端口；引擎也只监听 loopback，另有私有随机密码。前端不接触引擎地址和密码。
- 每个 Windows 用户/数据目录生成稳定 Ed25519 节点身份，私钥由 Windows DPAPI CurrentUser 加密。桌面“节点与 Brain”页显示本机身份、Brain、局域网发现状态和通过签名验证的附近节点。
- 自动发现以 `_rivloom._tcp.local` 为标准路径，并用 LAN UDP 43531 查询、临时端口单播回复处理 Windows 单向 mDNS 故障。两者只提供候选地址，必须再通过随机挑战和 Ed25519 签名校验；不暴露业务服务或 OpenCode。发现节点默认未配对、无任务权限；两台设备核对相同短码和指纹并分别确认后，才保存设备信任。
- 受信节点自动用 Ed25519 签名临时 X25519 握手，并以 HKDF 与 AES-256-GCM 建立 10 分钟会话；消息绑定双方身份、方向、严格序号和时间窗。桌面会区分“正在建立加密通道”和“加密通道就绪”。当前同步 Brain 目录，支持任务邀请控制；接受方可在本机选择已授权项目和模型，用 30 分钟准备租约保留项目。对方只看见状态/期限，准备不会启动 AI。
- 正常关闭会向附近节点发送签名离线通知；异常断电或断网时，每 5 秒一次的签名心跳用于兜底，约 15 秒显示离线、约 30 秒移除，重新出现时自动恢复在线。顶部和侧栏只统计在线节点。
- 首次启动自动建立或恢复本机操作者，直接进入任务工作台并在后台开始节点发现；不显示工作区、显示名称、用户名或密码初始化表单。任务审批确认仍保留。
- 本机自动登录使用每次后台启动随机生成的临时令牌。Tauri 只向通过窗口标签和精确 origin 校验的应用 WebView2 提供该令牌；普通网页不可调用，退出时删除，重启即失效。
- 客户端内置“模型与额度”页面。工作区创建者通过官方 OpenCode API 管理 DeepSeek 凭据、确认后执行真实连接测试、设置新任务默认模型；其他成员只读。
- 默认数据目录：`%LOCALAPPDATA%\com.rivloom.desktop\workspace`。独立 SQLite、引擎数据和 WebView2 配置保存在这里；不会自动迁移此前 `.data` 或个人 OpenCode 账号。
- 关闭窗口会先提示正在执行的任务将停止；后台通过 stdin 和 IPC 监控父进程退出。重启不会自动继续未完成的任务。
- 原生桥只开放启动信息和目录选择两个命令，同时限制窗口和当前服务的精确 origin。禁用导航到外部站点和新开窗口；不开放 shell、通用文件读写或引擎代理。

## 启动和构建

对内测试安装包：`src-tauri/target/release/bundle/nsis/Rivloom_0.1.0_x64-setup.exe`。安装后从开始菜单启动 Rivloom。当前产物为 71,024,519 字节，SHA-256：`0f8a150c2e1f4f5cb20c096d5c99de8be66af61a5bf26dfe599a484944a0ed3c`。

开发者使用：

```powershell
npm.cmd ci
npm.cmd start
```

需要 Node.js 24、Rust 和 Visual Studio C++ Build Tools。`npm start` 会准备随包资源并打开 Tauri 窗口；不再打开浏览器。Windows 安装包构建：

```powershell
node scripts/notices.ts
node scripts/desktop-notices.ts
npm.cmd run desktop:build
```

`npm run desktop:prepare` 校验官方 Node/OpenCode SHA-256，只复制应用代码、生产依赖和开源声明，拒绝哈希不匹配的二进制。不复制 `.data`、个人配置、账号或密钥。Rust 依赖使用 `src-tauri/Cargo.lock`，npm 依赖使用 `package-lock.json`。

内置 Node 二进制 SHA-256：`3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237`，对应 [Node 官方 24.19.0 校验表](https://nodejs.org/dist/v24.19.0/SHASUMS256.txt)。

## 开发调试与验证

```powershell
# 独立测试数据目录，不影响默认桌面工作区
$env:RIVLOOM_DATA_DIR = 'C:\project\rivloom-opencode\.data\my-desktop-test'
npm.cmd start

# 对真正的桌面可执行程序执行真实模型回归
$env:RIVLOOM_TEST_DESKTOP_EXECUTABLE = 'C:\project\rivloom-opencode\src-tauri\target\release\Rivloom.exe'
node scripts/integration.ts

# 不使用真实 Key，验证官方 OpenCode 凭据生命周期和当前安装包
npm.cmd run test:model-settings
npm.cmd run test:node-network-ui
npm.cmd run test:installer
```

真实模型回归命令会打开桌面窗口，在独立测试目录自动建立本机操作者、调用真实模型、验证审批/验收/重启，并模拟异常退出。节点网络命令也打开实际 Release WebView2，同时启动第二个隔离节点，完成发现、配对、加密邀请、本机项目/模型准备、远端隐私检查、普通任务拦截、准备撤销与设备撤销。单元测试另覆盖握手/密文攻击、任务幂等、旧记录迁移、自动过期、持久化和重启。不会操作个人工作区；同机双实例不等于两个真人或两台物理设备已验证。

内部 Web 调试需显式使用 `npm run server:dev` 或 `npm run server:start`，默认 `127.0.0.1:4310`。桌面和内部 Web 不要共用数据目录运行。

## 交付限制

- 这是未签名的内测包，尚未完成代码签名、自动更新、干净 Windows 虚拟机安装/升级/卸载矩阵和商业发行审查。不要关闭系统安全防护来运行它。
- WebView2 已安装的机器可直接使用；缺失时 NSIS 使用 Microsoft 的联网 bootstrapper，不承诺离线安装。配置依据 [Tauri Windows 安装器文档](https://v2.tauri.app/distribute/windows-installer/) 和 [配置参考](https://v2.tauri.app/reference/config/)。
- 编程项目所需 Git 和语言工具链仍需本机准备。随包 Node 可以执行 Node 测试，不代表任意项目无需环境配置。
- 模型配置界面已完成；DeepSeek 真实回复仍要等创建者在客户端本机填入有效 Key 后验证。ChatGPT 登录和两台设备的伙伴客户端接入仍是后续里程碑。
- M3.1 的发现、正常退出和 M3.2 的配对闭环已由用户在 Win10 `192.168.5.18` 与 Win11 `192.168.5.20` 确认。认证加密通道与 Brain 目录同步已通过双实例、攻击路径自动化和实际 Release WebView2，新包的物理双机状态仍待用户复测。异常结束进程或断网的 15/30 秒兜底仍待专项复测；任务授权与委派尚未开放。专用网络首次发现可能出现 Windows 防火墙提示。
- Windows 当前用户下的本地进程仍可能读取本地文件；不是防恶意本机用户的隔离系统。已运行的命令可能有不可撤销副作用，脱离进程树的外部进程不在停止保证内。
- 退出会停止执行，不支持关闭窗口后继续无人值守运行。暂无托盘、开机启动或分布式执行。

开源声明位于安装目录 `runtime/THIRD_PARTY_NOTICES.md`、`runtime/Node-LICENSE.txt` 和 `runtime/docs/licenses`。涉及 MPL 的依赖附带对应未修改的 `.crate` 源码归档；未修改或维护这些依赖的 fork。
