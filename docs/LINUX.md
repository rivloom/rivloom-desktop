# Linux 命令行执行节点

Linux 端用于局域网内没有图形界面的服务器和迷你主机。通过 SSH 初始化和管理，让 Rivloom 桌面端发现、配对并派发任务；Linux 端在本机已授权的项目目录内执行，不需要桌面环境。

**2026-09-20 未发布源码：** 接单设置新增 `--thinking auto|LEVEL`。`rivloom models list` 返回各模型支持的 `reasoningEfforts`，例如 `low`、`high`；只可使用该模型列出的等级。省略参数或使用 `auto` 表示模型与 runtime 默认策略，不会自动换模型。示例：`rivloom execution enable --project PROJECT_ID --model PROVIDER/MODEL --approval ask --thinking high --confirm`。设置仅影响后续接收的任务，已有任务保留原来的选择。中英文帮助保持相同命令和 JSON 字段。

The unpublished CLI adds `--thinking auto|LEVEL` to `execution enable`. Discover supported levels using `models list`. Auto uses model/runtime defaults without changing models; saved settings apply to subsequently admitted tasks.

**2026-09-19 未发布源码：** Linux x64 改用自有 runtime 固定源码构建的 `1.18.31-rivloom.9b07cf442a7e`，SDK/plugin 同步为1.18.31。不再使用官方 npm Linux 可执行包。源码构建、来源核验和升级步骤见 [引擎说明](ENGINE.md)。ARM64 自有构建暂缓；当前新构建命令只接受 x64。官网仍提供下述已发行包，不能把本地候选当成已上线版本。

**新引擎的运行基线：** x86_64 glibc Linux，内核至少4.18、glibc至少 **2.30**，系统 `libstdc++.so.6` 提供 `GLIBCXX_3.4.25` 或更新版本。自编译 ELF 本体最高引用 `GLIBC_2.17`，但实际嵌入并在运行时释放的 `libfff_c.so` 要求 `GLIBC_2.30`，因此整包不能沿用旧版的2.28门槛；Node.js仍决定内核和libstdc++基线。当前本地原生验证环境为 WSL Ubuntu x86_64、glibc2.39，满足ABI下限不等于所有旧发行版已经实测。Alpine/musl、32位和ARM64不在本次交付范围。

**Linux x86_64（包名 `x64`）0.1.18 已发布。** 同提交 GitHub 原生 CI、公开完整下载及 Linux curl / wget 命令验收通过，见 [Linux 0.1.18 发行说明](releases/linux-0.1.18.md)。[官网下载页](https://rivloom.com/download/) 及配套中英文指南已实际上线并复核，提供 x64 下载、校验值和 curl / wget 命令。ARM64 的源码和构建适配保留，等待原生架构验收后再单独开放，目前不发布 ARM64 下载。Windows 安装包及签名更新指针保持不变。

## 下载与解压

从 [官网下载页](https://rivloom.com/download/) 选择 Linux x86_64，并复制页面给出的完整 curl / wget 命令。当前发行文件也可从 [GitHub Linux 0.1.18](https://github.com/rivloom/rivloom-desktop/releases/tag/linux-v0.1.18-509294bbf0fd-35357963026) 获取，固定公开下载地址和 SHA-256 见 [发行说明](releases/linux-0.1.18.md)。校验通过后解压，无需 `sudo`，也不执行下载下来的安装脚本。

文件名为 `Rivloom_<版本>_linux_x64.tar.gz`。解压后的顶层目录是 `rivloom/`，包含启动入口 `bin/rivloom`、固定 Node.js、OpenCode 引擎、应用和依赖许可。已发布首版内置官方引擎；新源码构建将自有 ELF 和来源记录放入 `app/vendor/rivloom-opencode/linux-x64/<commit12>/`。包内带运行时，不要求额外安装 Node.js 或 npm。

已发布 0.1.18 的运行要求为 x86_64 glibc Linux，内核至少 4.18、glibc 至少 2.28，系统 `libstdc++.so.6` 提供 `GLIBCXX_3.4.25`（libstdc++ 6.0.25）或更新版本。这是随包 [Node.js 24.19.0 的官方运行基线](https://github.com/nodejs/node/blob/v24.19.0/BUILDING.md#platform-list)；已核对固定 OpenCode baseline 二进制的 glibc 依赖没有高于该门槛。优先使用仍受发行商支持的发行版，不支持 Alpine/musl、32 位系统。满足 ABI 门槛不表示所有旧发行版都已实测。

首次运行可用 `uname -m`、`uname -r` 和 `getconf GNU_LIBC_VERSION` 检查架构、内核和 glibc。设备上实际需要的 Git、编译器及项目工具仍由该项目自行提供；Rivloom 不附带完整开发工具链。GitHub 原生 x64 构建与运行检查、实际设备验收分别记录，不用 x64 或 WSL 的通过结果代替 ARM64 验收。

可以将解压目录放在自己的固定位置，例如 `~/.local/opt/rivloom/current/`，然后把其中的 `bin` 目录加入 PATH。以下示例假设 `rivloom` 已在 PATH；也可替换为完整路径 `./rivloom/bin/rivloom`。

```sh
rivloom --version
rivloom --help
rivloom init --name lab-linux
rivloom serve --peer-port 43532
```

`serve` 在前台运行，Ctrl+C 正常退出。保持这一 SSH 会话，在另一 SSH 会话配置节点；长期运行见后面的 systemd 示例。初始化和启动均不启用远程执行，也不调用模型。`init --name` 只写首次名称；已有节点改名用 `rivloom name 新名称`。

## 数据与网络

命令行帮助和命令报错支持中英文：使用 `rivloom --lang zh-CN --help` 或 `rivloom --lang en --help`。未指定时按 `LC_ALL`、`LC_MESSAGES`、`LANG` 的顺序选择，中文环境使用中文，其他环境使用英文。命令名、JSON 字段及状态枚举保持不变，设备名、模型回复和文件内容不翻译。节点仍不需要图形桌面或音频设备；远端任务完成提示音在接收结果的桌面端“待办中心”设置，支持轻柔双音、清脆铃声、简短提示和关闭。

CLI help and command errors support English and Simplified Chinese. Use `rivloom --lang en --help` or `rivloom --lang zh-CN --help`; otherwise locale selection follows `LC_ALL`, `LC_MESSAGES`, then `LANG`. Command names, JSON keys and state enums remain stable. Headless nodes do not need audio devices: completion sounds play on the receiving desktop, where Attention center offers Soft chime, Clear bell, Quick pulse or Off.

默认数据目录为 `${XDG_DATA_HOME}/rivloom`，未设置有效的绝对 XDG 路径时为 `~/.local/share/rivloom`。可用 `--data-dir /绝对路径` 或 `RIVLOOM_DATA_DIR` 指定。所有管理命令必须使用与 `serve` 相同的用户和数据目录。

```sh
rivloom --data-dir "$HOME/.local/share/rivloom-lab" init --name lab-linux
rivloom --data-dir "$HOME/.local/share/rivloom-lab" serve --peer-port 43532
# 另一个终端
rivloom --data-dir "$HOME/.local/share/rivloom-lab" status
```

身份、信任、模型配置和任务保存在数据目录，升级时保留。目录权限为 `0700`，本机控制凭据文件为 `0600`，由当前 Linux 用户管理；不要把数据目录作为共享网络目录。首次使用自己的已有目录时，需要它属于当前用户且权限已收紧为 `0700`；CLI 会拒绝权限过宽或以符号链接作为数据根的目录。重复启动相同目录会被拒绝。CLI 的管理 HTTP 只监听 `127.0.0.1` 随机端口，使用仅本机用户可读的凭据认证，不需要开放该端口或转发到外网。

以普通、专用于该设备任务的 Linux 用户运行即可，不需要 root。任务工具继承服务用户权限；项目授权和审批不是操作系统沙箱。Linux 身份和模型凭据依靠用户文件权限保护，没有 Windows DPAPI 式静态加密。

局域网发现沿用 UDP 43531 和 mDNS UDP 5353；设备间加密通道使用 TCP peer 端口。上例通过 `--peer-port 43532` 固定该端口；省略时自动选择，也可通过 `RIVLOOM_PEER_PORT` 设置。若有防火墙，在设备实际局域网范围允许发现端口及选定的 TCP 端口。CLI 不修改系统防火墙。不同 VLAN、访客 Wi-Fi 隔离或组播过滤可能影响自动发现。

`rivloom status` 输出节点 ID、连接状态、引擎状态、执行策略与队列。大多数管理命令默认输出 JSON，也接受 `--json`，可交给 `jq` 或脚本处理；失败时退出码非零。

## 与桌面端配对

先在同一局域网启动桌面端和 Linux 节点，再查看发现的设备：

```sh
rivloom nodes
rivloom pair request DESKTOP_NODE_ID
rivloom pair list
```

也可以从桌面端主动请求配对，Linux 的 `pair list` 同样显示待配对记录。逐项核对目标设备及两端显示的短码相同，在 Linux 端输入当前短码，并在桌面端确认：

```sh
rivloom pair confirm PAIRING_ID --code SHORT_CODE
```

两端各自确认后才建立信任，CLI 不自动确认。短码不一致或过期时会拒绝，可取消后重试：

```sh
rivloom pair cancel PAIRING_ID
rivloom pair revoke NODE_ID --confirm
```

配对建立信任；任务执行还需要在 Linux 端选择项目、模型并显式启用执行能力。

## 授权项目和配置模型

项目目录应先存在。`--confirm` 表示允许 Rivloom 在该本机项目内执行任务。

```sh
rivloom projects add /home/me/projects/demo --name demo --confirm
rivloom projects list
rivloom providers list
```

API Key 只从标准输入读取，不放在命令参数中。以下为 Bash 的不回显输入示例；厂商 ID 取自 `providers list`：

```bash
read -r -s -p 'API Key: ' RIVLOOM_API_KEY
printf '\n'
printf '%s' "$RIVLOOM_API_KEY" | rivloom providers key deepseek --stdin --confirm
unset RIVLOOM_API_KEY
rivloom models list
rivloom models default deepseek/deepseek-chat
```

`--confirm` 同时确认将凭据用于此 Rivloom 工作区。模型可用性由实际厂商配置决定；查看、保存配置和选择模型不会自动发起付费模型测试。可用 `--account 账号名称` 添加同一厂商的独立账号，更新已有独立账号时再带 `--account-id ID`。`models list` 返回实际模型 ID，执行配置应使用该 ID。

自定义兼容接口从权限受控的 JSON 文件或管道读取。若使用 `provider.json`，创建前设 `umask 077`，不要把含真实密钥的文件提交到项目或公开分享：

```json
{
  "provider": {
    "id": "lab-api",
    "name": "Lab API",
    "baseURL": "https://your-provider.example/v1",
    "protocol": "chat",
    "models": [{ "id": "your-model", "name": "Your model" }],
    "context": 32768,
    "output": 4096
  },
  "key": "YOUR_API_KEY"
}
```

```sh
rivloom providers custom --stdin --confirm < provider.json
rivloom providers remove lab-api --confirm
```

无凭据的本地接口可设 `provider.keyless: true` 并省略 `key`。协议支持 `chat` 和 `responses`。首次 CLI 覆盖 API Key 和自定义接口配置，暂不提供桌面浏览器 OAuth 登录流程。

## 开放执行与处理等待

从 `projects list` 和 `models list` 获取 ID 后，在 Linux 端明确开启执行：

```sh
rivloom execution enable --project PROJECT_UUID --model PROVIDER/MODEL --approval ask --confirm
rivloom execution status
rivloom execution concurrency 3
```

`ask` 对需授权的编辑、命令等操作等待人工批准；`auto` 允许常规编辑和命令，其他工具继续按策略处理；`full` 采用更宽的引擎权限，仍受已有强制限制。模型可能提出补充问题，各模式均可能等待输入。远程执行并发可设 1–10，默认 3。桌面端此时可选择 Linux 节点派发任务，结果继续通过既有加密通道返回。

通过 SSH 查看并处理本机等待：

```sh
rivloom pending
rivloom approve TASK_ID REQUEST_ID once
# 或拒绝本次请求
rivloom approve TASK_ID REQUEST_ID reject
printf '%s' '[["第一个问题的答案"],["第二个问题的答案"]]' | rivloom respond TASK_ID REQUEST_ID --stdin
```

`pending` 显示权限内容、问题和选项。每个问题对应一个非空答案数组，多选答案放在同一数组；使用当前有效的任务和请求 ID。

```sh
rivloom queue list
rivloom queue pause
rivloom queue resume
rivloom execution disable
```

暂停队列阻止新任务进入执行槽；关闭执行能力停止接受新的自动执行。它们不等同于立即中止已运行任务，执行中的控制仍遵循既有任务协议和桌面端操作。停止服务会中断当前节点服务，不应把重启视为任务已经完成。

## 作为 systemd 用户服务运行

`service` 只输出单元文件，不安装、不启动服务，也不修改系统设置。将程序目录放在固定位置后，先退出前台 `serve`，再执行：

```sh
RIVLOOM_SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$RIVLOOM_SYSTEMD_DIR"
rivloom service --executable "$HOME/.local/opt/rivloom/current/bin/rivloom" --peer-port 43532 > "$RIVLOOM_SYSTEMD_DIR/rivloom.service"
systemctl --user daemon-reload
systemctl --user enable --now rivloom.service
systemctl --user status rivloom.service
journalctl --user -u rivloom.service -f
```

自定义数据目录时，同样给 `service` 加上 `--data-dir`，生成文件会保留该目录和选定的 peer 端口。单元设有 `UMask=0077`、失败重启和子进程随服务停止，保持与交互启动相同的 Linux 用户。

systemd 不会自动加载 SSH 交互 shell 的配置。若项目依赖仅在 `.bashrc`、nvm 等环境中可见的工具，为这个用户服务显式配置所需 `PATH`，然后重启服务；随包 Node 本身不依赖系统 PATH。固定的 `--executable` 路径必须指向实际已解压的程序，不要移动仍在运行中的目录。

用户服务在登出后是否保留取决于设备的 systemd/logind 配置。需要无人登录也常驻时，由设备管理员按本机策略启用该用户的 lingering，例如 `loginctl enable-linger "$USER"`；CLI 不自动执行此操作。

```sh
systemctl --user stop rivloom.service
systemctl --user restart rivloom.service
systemctl --user disable --now rivloom.service
```

## 升级与诊断

下载并校验新包，解压到新的版本目录；在任务状态允许时停止服务、备份数据目录，再切换固定启动路径并重启。不要删除原数据目录或用其他设备的数据覆盖它；保持身份才能保留既有配对。Linux CLI 暂不使用 Windows 桌面 updater。

管理命令提示节点未运行时，检查服务状态、当前 Linux 用户和 `--data-dir` 是否一致。`status.engine.ready` 为 `false` 时查看 `engine.error` 和服务日志。设备列表为空时检查两端网络、发现端口及固定 peer TCP 端口；配对后还应确认设备 `channelReady`。任务未执行时检查执行策略、模型、项目、队列暂停及 `pending`。

源码检查前先执行 `npm ci` 与 `npm run engine:prepare`，随后可运行 `node cli/index.ts --help`、`node --test tests/headless-cli.test.ts tests/headless-runtime.test.ts` 和 `node scripts/headless-service-check.ts`；最后一项使用隔离数据、真实 CLI/API、自有引擎与本机合成厂商配置，不调用模型。`node scripts/headless-task-check.ts` 额外使用本机合成模型验证配对、实际写文件、CLI 审批、成果返回与重启去重，不使用真实模型服务。Linux 包与 GitHub 构建验收按 [CI 文档](CI.md) 执行。正式发布及公开文件维护遵循 [发布流程](RELEASING.md) 和 [R2 保留策略](R2-RETENTION.md)。
