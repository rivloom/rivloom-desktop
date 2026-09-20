# Windows 桌面端

**2026-09-19 当前源码（未发布）：** 安装包准备阶段使用自有 OpenCode runtime 固定源码，SDK/plugin 基线 1.18.31，详见[引擎](ENGINE.md)。`engine:prepare` 从固定提交构建、校验并缓存，`desktop:prepare` 自动调用；不再依赖官方 Windows npm EXE。正式版本/下载仍见 [README](../README.md)。下文旧 M2/M3.5 验收段落仅作历史，不能替代本轮云 CI、安装或发行记录。

产品交付形态是 Tauri 桌面客户端。React 只负责窗口内界面；浏览器入口保留作内部调试，不是给客户的启动方式。

用户已启动 M2/M5 官网、CI 与发行接口第一轮实施。桌面四份 Windows 工作流与发行记录契约已落地；真实 runtime prepare 与只读 gate 已通过，核对 Node/OpenCode 哈希和版本、88 个运行依赖、267 个 Rust 依赖及 722 份 notices，证据为 `.data/verification/ci-runtime-precommit.json`。Rust/Cargo 1.98.1 已安装并核对版本，本轮原生构建尚未执行，桌面云 runner 仍待验证；细项见 [CI](CI.md)。官网首版已推送，用户已授权 Cloudflare 仅访问官网仓库并部署/绑定 `rivloom.com`；云 CI 修复与重试、Cloudflare 连接和域名绑定正在推进，尚无上线成功或公开下载声明。updater、R2 分发及签名未实施；完整边界见 [RELEASING](RELEASING.md)、[ADR-0006](adr/0006-website-distribution-and-safe-updates.md) 和维护者本地官网交接记录。

当前可供检查的 M3.5 交付预览仍为 `Rivloom_M3.5_Node_P0_Preview_0.1.3_docs1_x64_setup.exe`，未签名、未安装。已有构建、手动升级与文档修订包证据不代表接入了 updater，也不代替本轮新候选的验收；精确产物和版本状态以维护者本地界面交接记录、维护者本地里程碑记录 和维护者本地验证记录 为准。

## 当前实现

### 任务完成提示音（当前源码，未发布）

在侧栏「待办中心」选择「任务完成提示音」：轻柔双音、清脆铃声、简短提示或关闭，支持试听并按操作者保存。任务在本机或远端 Linux Node 完成后，由接收通知的 Windows 桌面播放一次；同批完成合并提醒，重复同步与重新打开应用不补播旧任务。关闭桌面通知或开启免打扰会静音，试听仍由用户主动触发。Windows 使用随包的三段原创短音频，不依赖联网；Linux 无界面执行节点无需声卡。

In **Attention center → Task completion sound**, choose Soft chime, Clear bell, Quick pulse, or Off, and preview the selection. Preferences are saved per operator. The Windows desktop plays once for newly completed local or remote tasks; duplicate polling and previously observed completions do not replay sounds. Desktop notification settings and Do Not Disturb also control automatic playback. Linux execution nodes do not play audio.

### 桌面基础能力

- 原生 Windows 窗口、图标、最小尺寸、单实例聚焦。
- 原生文件夹选择器，用于选择本机已审核的普通项目文件夹；不要求 Git，不建立文件快照或内容哈希。选择目录仍需确认信任，不能代替沙箱。
- 启动时自动运行随包 Node.js 24.19.0、本地业务服务和固定版本自有 OpenCode；无需客户另装 OpenCode 或 Node。
- 业务服务使用随机 loopback 端口；引擎也只监听 loopback，另有私有随机密码。前端不接触引擎地址和密码。
- 每个 Windows 用户/数据目录生成稳定 Ed25519 节点身份，私钥由 Windows DPAPI CurrentUser 加密。桌面“节点与 Brain”页显示本机身份、Brain、局域网发现状态和通过签名验证的附近节点。
- 自动发现以 `_rivloom._tcp.local` 为标准路径，并用 LAN UDP 43531 查询、临时端口单播回复处理 Windows 单向 mDNS 故障。两者只提供候选地址，必须再通过随机挑战和 Ed25519 签名校验；不暴露业务服务或 OpenCode。发现节点默认未配对、无任务权限；两台设备核对相同短码和指纹并分别确认后，才保存设备信任。
- 受信节点自动用 Ed25519 签名临时 X25519 握手，并以 HKDF 与 AES-256-GCM 建立 10 分钟会话；消息绑定双方身份、方向、严格序号和时间窗。桌面会区分“正在建立加密通道”和“加密通道就绪”。当前同步 Brain 目录，支持加密协作任务和有序执行状态。
- 设备信任、本机执行能力和 AI 操作审批分开管理。受信设备发来的任务自动接收；执行能力关闭时等待，开启后使用本机预设项目和模型。AI 审批可选“请求批准 / 帮我批准 / 允许任何操作”，由官方 OpenCode 会话权限规则执行。归属 Brain 可通过加密任务通道批准/拒绝具体请求、回答 AI、停止、补充要求并继续同一会话，还能查看经过脱敏和限长的 OpenCode 官方差异并验收。匹配任务只创建一个本机业务任务和官方 OpenCode 会话，不发送本机绝对路径、项目 ID、模型标识、本机任务 ID、审批 metadata 或凭据。
- 正常关闭会向附近节点发送签名离线通知；异常断电或断网时，每 5 秒一次的签名心跳用于兜底，约 15 秒显示离线、约 30 秒移除，重新出现时自动恢复在线。顶部和侧栏只统计在线节点。
- 首次启动自动建立或恢复本机操作者，直接进入任务工作台并在后台开始节点发现；不显示工作区、显示名称、用户名或密码初始化表单。任务审批确认仍保留。
- 本机自动登录使用每次后台启动随机生成的临时令牌。Tauri 只向通过窗口标签和精确 origin 校验的应用 WebView2 提供该令牌；普通网页不可调用，退出时删除，重启即失效。
- 客户端内置“模型与额度”页面。工作区创建者通过官方 OpenCode API 管理 DeepSeek 凭据、确认后执行真实连接测试、设置新任务默认模型；其他成员只读。
- 默认数据目录：`%LOCALAPPDATA%\com.rivloom.desktop\workspace`。独立 SQLite、引擎数据和 WebView2 配置保存在这里；不会自动迁移此前 `.data` 或个人 OpenCode 账号。
- 关闭窗口会先提示正在执行的任务将停止；后台通过 stdin 和 IPC 监控父进程退出。重启不会自动继续未完成的任务。
- 原生桥只开放启动信息和目录选择两个命令，同时限制窗口和当前服务的精确 origin。禁用导航到外部站点和新开窗口；不开放 shell、通用文件读写或引擎代理。

## 启动和构建

**历史 0.1.0 构建记录：** 普通文件夹、设备信任、AI 审批和远端结果闭环曾编译到 `src-tauri/target/release/Rivloom.exe`（当时 10,264,576 字节，SHA-256：`9da6c7b764f4cef3a33a02508ff4fbb414fba84c3721a47295d31bdf1f5c24cd`）。对应 `src-tauri/target/release/bundle/nsis/Rivloom_0.1.0_x64-setup.exe` 为 71,070,646 字节，SHA-256：`d688e2d9a2f978fc7bde08fa09c88ffc17ab3bc86f607e3947bd9e92b281ef01`；当时未重新执行隔离安装/启动/卸载烟雾测试。这些数值只描述该历史构建，不代表当前同名 EXE 的内容。后续 0.1.3 与独立 UI Preview 的状态和证据见 [README](../README.md) 与维护者本地验证记录，不能混用为新版本发行验收。

开发者使用：

```powershell
npm.cmd ci
npm.cmd start
```

需要 Node.js 24.19.0、Git、PowerShell 7、Rust 和 Visual Studio C++ Build Tools。`npm start` 会准备随包资源并打开 Tauri 窗口；不再打开浏览器。Windows 安装包构建：

```powershell
node scripts/notices.ts
node scripts/desktop-notices.ts
npm.cmd run desktop:build
```

`npm run desktop:prepare` 校验官方 Node SHA-256，以及自有 OpenCode 固定源码/构建记录/二进制摘要，只复制应用代码、生产依赖、独立引擎产物和开源声明。不复制 `.data`、个人配置、账号或密钥。Rust 依赖使用 `src-tauri/Cargo.lock`，npm 依赖使用 `package-lock.json`。

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
npm.cmd run test:permission-policy
npm.cmd run test:node-network-ui
npm.cmd run test:installer
```

真实模型回归命令会打开桌面窗口，在独立测试目录自动建立本机操作者、调用真实模型、验证审批/验收/重启，并模拟异常退出。权限策略检查通过官方 OpenCode 1.18.25 创建并读回三种会话权限，不发送模型请求。节点网络命令也打开实际 Release WebView2，同时启动第二个隔离节点，完成发现、配对、可信任务自动接收、能力关闭时不启动、加密协作任务、界面回答/拒绝/停止/补充、官方差异卡片、远程验收、真实随包 OpenCode 任务、隐私检查、同项目并发拒绝与设备撤销。模型可用性不固定；本轮免费模型 10 分钟无响应时脚本按失败退出，没有写成通过。不会操作个人工作区；同机双实例不等于两个真人或两台物理设备已验证。

内部 Web 调试需显式使用 `npm run server:dev` 或 `npm run server:start`，默认 `127.0.0.1:4310`。桌面和内部 Web 不要共用数据目录运行。

## 交付限制

- 这是未签名的内测包，尚未完成代码签名、自动更新、干净 Windows 虚拟机安装/升级/卸载矩阵和商业发行审查。不要关闭系统安全防护来运行它。
- WebView2 已安装的机器可直接使用；缺失时 NSIS 使用 Microsoft 的联网 bootstrapper，不承诺离线安装。配置依据 [Tauri Windows 安装器文档](https://v2.tauri.app/distribute/windows-installer/) 和 [配置参考](https://v2.tauri.app/reference/config/)。
- 编程项目自身所需的语言和构建工具链仍需本机准备；只有项目本身依赖 Git 时才需要安装 Git。随包 Node 可以执行 Node 测试，不代表任意项目无需环境配置。
- 模型配置界面已完成，DeepSeek 官方真实连接和无 `.git` 普通文件夹中的完整编程任务均已通过。ChatGPT 登录仍为后续里程碑；两设备协作已有 M3.3/M3.4 物理核心证据，完整人员身份与两真人角色回归仍未完成。
- M3.1 的发现、正常退出和 M3.2 的配对闭环已由用户在 Win10 `192.168.5.18` 与 Win11 `192.168.5.20` 确认。M3.3 又在 `192.168.5.20` 与 `192.168.5.33` 用真实 DeepSeek 完成单人双机文件生成、请求批准、补充要求同会话续跑和最终验收，MVP 范围据此完成。停止、另外两种审批、撤销信任、两真人角色、异常断网和防火墙安装体验保留为后续优化。专用网络首次发现可能出现 Windows 防火墙提示。
- Windows 当前用户下的本地进程仍可能读取本地文件；不是防恶意本机用户的隔离系统。已运行的命令可能有不可撤销副作用，脱离进程树的外部进程不在停止保证内。
- 退出会停止执行，不支持关闭窗口后继续无人值守运行。暂无托盘、开机启动；跨节点自动执行和远程批准/回答/停止/补充、官方差异和验收已经可用，但跨设备完整人员角色映射仍未完成。

开源声明位于安装目录 `runtime/THIRD_PARTY_NOTICES.md`、`runtime/Node-LICENSE.txt` 和 `runtime/docs/licenses`。涉及 MPL 的依赖附带对应未修改的 `.crate` 源码归档；未修改或维护这些依赖的 fork。
