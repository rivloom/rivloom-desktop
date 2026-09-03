# M3.4 物理 Windows 核心验收清单

## 结项（2026-09-03）

下述核心物理闭环完成后，用户在获知结果及纯mDNS专项待查限制时回复“好，下一步吧”；据此按ADR-0004当前MVP范围结项。不是新增测试通过记录，不扩大为异常断网、HA、人员或跨BrainTask通过。本轮不再需要测试命令；下一产品阶段先确认方向和验收。原节点/数据保持，纯mDNS92/93及测试助手恢复预检限制继续保留。

## 物理结果（2026-09-03T07:05Z，结项前检查点）：本轮双物理 Brain 竞争闭环 passed

B最终只读回执07:04:36.054Z确认同Task8fe868cc/Executionbe6b9f97 completed/seq4/attempt1，原身份/Brain/Worker不变；本机07:05:25.922Z确认A原Task44a77700第二尝试completed/seq4、两Worker业务Taskaccepted、最终5accepted/5session/7Execution/5Project/模型2/0工具/五空普通目录/原历史保持/槽1。两Brain各自权威完成证据收齐，报告 `m34-physical-prepared-race-2ebbcc36.json` 已passed。

本轮真实重叠竞争、review占槽、原队列自动续跑和分别验收完成，**不再需要用户输入命令**。核心物理验收通过，该检查点当时仍待用户确认MVP结项，现已按文首结项记录更新；物理报告中的next保留当时待确认语境，不作为新的待办。原mDNS92/93专项待查不变，不把本次扩为异常断网、物理排队Master重启或新真实AI编程。原运行现场保留，不停止/重启或改数据，不改产品/OpenCode/网络/安装；后续若需恢复测试Worker，先检查现有预检对合法declined历史的限制。以下均为历史步骤和失败证据。

## 前一停点（2026-09-03T07:01Z）：A 原任务续跑及验收通过，等 B 最终回执

B06:57:59.421Z一次验收即时回执review；Worker已accepted/seq4后，A原Task44a77700自动新增第二次Executionde478490、业务Task167112f2、唯一session ses_f99f077d4ffeNvFWSbNHUOFpw9，第一拒绝尝试仍保留。07:00:25Z完整结果/绑定/0工具/五空目录/旧历史断言通过，07:00:26Z A17068精确验收一次；07:01:03Z Acompleted，两WorkerTask均accepted，总5accepted/5session/7Execution/5Project/模型2/槽1。再观察20,011ms/38次无新任务/执行、槽1稳定。精确ID和阶段报告见HANDOFF、本轮JSON。

现在仅待用户B助手 `race-status` 的同Task8fe868cc/Executionbe6b9f97 completed/seq4最终回执，不重复验收或提交。A自动队列继续和本机收尾检查通过不等于已经直接读取B最终状态；先不计整轮/MVP完成。Worker76974与正式桌面保留、原policy启用/夹具release。合法declined记录仍保留，后续恢复测试助手须先核对现有预检限制，不改历史/默认新根。无源码/安装/网络变更，mDNS92/93待查不变。

## 前一停点（2026-09-03T06:54Z）：B review 占槽，A 原 Task queued

B06:49:12.600Z确认同UUID2ebbcc36/Ytmgnp/024a07/v2准备；双方就绪且历史无变化后，06:52:26Z正常API恢复原Project/model/ask/单槽配置一次。20,121ms/86次观察取得物理竞争：B Task8fe868cc/Executionbe6b9f97先执行，A Task44a77700的Execution0808698e最终准入被拒，原Task留在A排队，只有B一个新业务Taskfb49d63f/官方session。06:53:48Z完整历史、0工具/空普通目录检查通过，再release模型；06:54:15Z B review/seq3已回传、A仍queued、槽0，旧3accepted/3session/4Execution保留。完整ID和证据见HANDOFF与 `m34-physical-prepared-race-2ebbcc36.json`。

当前Worker76974已启用原能力、夹具已release；A17068保持附着，正式客户端不动。只请用户B执行一次 `race-accept 2ebbcc36-c079-4c84-ad4e-a6d9cf6a579f` 并发RACE_STATUS；之后检查B完成、A原Task新增尝试自动续跑、A验收及总5accepted/5session/槽1。B本机权威回执与最终双完成未取证，不标记整轮/MVP完成；不重复prepare/submit，不停止节点。临时观察读取错字段在放行前失败、修正后才动作，已如实记录；mDNS92/93仍单列待查。以下是历史。

## 前一停点（2026-09-03T06:40Z）：门闩已关闭，A prepared，等 B

B 06:37:19.642Z STATUS 确认原Ytmgnp/024a07/race-v1数据根保持、v2、Task/model0，Worker通道ready；新remote app/peer62028/62295。本机独立匹配可信新端口并复核原完整历史后，保存基线和restoreBody；06:39:48Z通过Worker正常API关闭执行能力，不退出程序。A06:40:28.909Z在session17068准备UUID **2ebbcc36-c079-4c84-ad4e-a6d9cf6a579f**，无Task/claim，Worker76974 gate保持关闭。

现只等用户在5.20当前助手输入 `prepare 2ebbcc36-c079-4c84-ad4e-a6d9cf6a579f` 并回传 RACE_PREPARED；没有时间限制。B确认前不启用Worker，不关闭或重启它，不使用旧arm/submit。报告 `m34-physical-prepared-race-2ebbcc36.json` 的preflight.restoreBody为原Project c4227a2e/model fixture/m34/ask/单槽。收到双方准备后启动观察、正常API恢复原配置，才检查真实running/queued和唯一session。当前没有新Task/模型调用，不计竞争通过。

## 最新停点（2026-09-03T06:31Z）

用户确认纯 mDNS 专项待查不阻塞正常发现路径的物理争用。旧 Worker helper/service 均退出，历史完整；保留式改名旧 lock 后同根同 Node 恢复为 session 76974、PID 996/26240、app/peer/engine 58866/60127/51469，原 3 Project/3 accepted/3 session/4 Execution/6 信任保持，模型 0。两正式客户端未动。

首段检查在所有连接就绪断言失败，未保存具体 peer/时间，不计通过；之后状态恢复，带变化记录的只读观察 06:29:28.575–06:30:58.650Z 共 90,074 ms/333 次、0 未就绪/0 API 错误、最大资源年龄 5,013 ms。最终完整历史/互信/策略复查一致；不宣称根因修复。A 控制台 session 17068 只读附着、旧 race cancelled，无 active prepare。

下一步等用户在 **5.20 原 race-v1 目录** stop 等 CLEANUP、覆盖 v2 代码并保留 .data、原 start-master.cmd 后发 STATUS，核对 Ytmgnp/024a07/v2。当前 policy 仍原 enabled、没有新 Task，不能先 prepare；确认双方前提后才关 Worker 执行能力、两端 prepare 新 UUID、恢复原配置放行。报告 `m34-physical-worker-resume-20260903.json`。此前 92/93 和首段不通过均保留，物理争用与 M3.4 MVP 尚未完成；以下均为历史。

## 最新停点（2026-09-02T15:16Z）

第二次人工 UTC 因过期被校验拒绝，A 未 arm、无新物理 Task。改用 [prepared 助手 v2](2026-09-02-m34-prepared-race-helper.md)：协调者先关闭原测试 Worker 的执行能力，两端 prepare 相同新 UUID，仅登记意图；双方确认后恢复原 Project/model/ask/单槽配置，各提交一次。此流程仅工具方案，物理 gate 尚未改变、远端尚未更新；旧 UTC 不再使用。

25 定向、两轮各 12 项同机完整服务与同身份覆盖烟雾通过，包 20,017 字节/8 文件。全量 92/93，原有纯 mDNS 同机发现测试单独复查仍失败，原因未知；按 executing-plans 停点暂停新的物理动作，先报告并请求用户是否排查发现问题，不能计 M3.4 完成。15:15–15:16Z 原 Worker/A/B 通道正常、三条 accepted/三官方会话/四 Execution/槽位 1、模型 0 保留，policy 未改。Worker session 67853 继续运行，A 旧控制台 97010 已正常停止，两正式桌面未动。

后续更新只覆盖当前 `C:\Users\x\Desktop\Rivloom_M3.4_Master_Helper_0.1.3_race-v1` 的代码，保留 .data；即使新包叫 race-v2 也不另建目录。先 stop 等 CLEANUP、覆盖、原 start-master.cmd，再核对 Ytmgnp/024a07/v2 的 STATUS；不要提前 prepare/submit。后续验收仍要求实际单槽竞争、原排队继续及历史不变，不以免定时命令成功替代。

以下为历史记录，当前状态以本节和 HANDOFF 为准。

状态：单 Brain 三节点接入、90.6 秒稳定及新 Portable 文字任务闭环通过；任务 45b70f73 后台 completed、槽位恢复 1，用户已确认 5.20 显示“已验收”。原 Worker/Project 和旧失败记录保留，旧 Task A 不续测。双独立 Brain 共享执行、竞争和 Master 停止仍未完成，不用本次单 Brain 结果代替。

最新补测：原 Worker 恢复、双物理 Brain 目录、B 跨机 Task 8923109f、B 正常离线/同身份恢复及 A 的 Project Task 0119d3eb 验收均通过。同步竞争助手 v1 已准备，全量 82 项和新控制器同机完整服务 11 项通过。用户误删旧助手且回收站无法找回，已确认改用现有新 B Ytmgnp/Brain 024a07；先配对并复核 A↔Worker 通道，再进行真实重叠分配。物理竞争未通过，不标记 M3.4 MVP 完成。见本文末节、[竞争助手计划](2026-09-02-m34-physical-race-helper.md)、[端口修复](2026-09-02-m34-high-http-ports.md) 和 [恢复计划](2026-09-02-m34-completed-worker-resume.md)。

安装指引更正（2026-09-02）：0.1.3 可以选择“安装前卸载”，关键是卸载时**不勾选“删除应用程序数据”**，再安装到原目录；此前将“请勿卸载”说成必选不准确。本轮升级后已完成原身份/记录保持核对，不需要重复安装。原 Worker 当前已恢复运行，详见末节。

## 环境与边界

- 需要两个已经形成的独立 Brain/master 和一个共享 Worker，共三个独立 Node 数据目录。优先三台设备各运行一个 Node；只有两台设备时，在其中一台另起隔离测试实例，先核对每个实例的 Node ID、Brain ID、目录和端口。
- 使用 M3.4 的 0.1.1 安装器 `src-tauri/target/release/bundle/nsis/Rivloom_0.1.1_x64-setup.exe`；旧 0.1.0 安装器不包含本轮 M3.4。安装与覆盖升级验证见 [安装验证计划](2026-09-02-m34-installer.md)。
- 不覆盖原有用户数据、不导入模型凭据。Worker 使用明确授权的专用普通文件夹；不要求 Git、不复制或扫描文件建立快照，不计算内容哈希。
- 真实模型调用须由用户在 Worker 本机选择和授权；无可用额度时可以使用独立本机确定性模型测试服务，但记录为模型夹具，不声称真实 AI 编程通过。
- 保持现有设备互信与本机执行开关；不新增人员身份、企业权限或全局 master。防火墙安装体验仍属后续优化，不临时修改安全设置。

## 两台机器先更新（首次 0.1.1 验收的历史步骤）

1. 先结束或保留好正在进行的任务，再退出两台电脑上的 Rivloom。不要删除数据或提前卸载。
2. 将同一份 0.1.1 安装器传到两台机器并运行。历史指引曾要求选择“请勿卸载”；2026-09-02 已更正：也可以由安装器先卸载旧程序，但不要勾选“删除应用程序数据”。安装目录保持原 Rivloom 目录，不选仓库测试目录。当前升级使用 0.1.3，不重用此历史版本。
3. 安装后各打开一个 Rivloom 窗口，进入“节点与 Brain”，核对原节点身份及 Brain 是否保留。此时先不发任务，也不更换模型 Key。
4. 两台电脑场景中的第三个 Node 由开发机另起独立后台测试实例，使用自己的数据目录、Node ID 和端口，不尝试打开两个共用数据的桌面窗口。

当前开发机历史烟雾测试遗留的产品安装位置记录指向旧 `.data/installed-smoke-app/...`，但原 `%LOCALAPPDATA%\Rivloom\Rivloom.exe` 仍存在。本轮只记录并恢复原安装元数据，没有擅自修复用户安装；该机实际更新时需明确核对原安装目录，不能直接接受这个旧测试路径。

## 逐项检查

1. 核对三实例独立身份。新 Worker 自动采用已有 Brain，两个正式 Brain 不合并；界面没有“成为 Brain / 加入 Brain”按钮，也没有遗留临时 Brain 卡片。
2. 通过已有双方配对完成互信。共享 Worker 同时出现在两个 Brain 目录；CPU、内存、GPU、磁盘与设备实际情况相符，无法可靠检测的数值显示未知。观察至少 90 秒以跨越一分钟限流窗口，动态采样更新，通道和槽位不反复闪断。
3. 两个 Brain 同时提交 Portable Task。Worker 只接受一个活动执行；另一 Task 仍属于原 Brain 并排队/重试。检查业务任务和官方 OpenCode 会话无重复。
4. 通过项目资源选项提交 Project Task，仅提供该 Project ID 的 Node 执行；另一 Node 上同名文件夹不视为副本。Portable Task 使用自己的普通临时目录。
5. 在 Worker 查看执行，在 Task 所属 Master 查看状态/结果。结果不串到另一 Brain；待验收和结果未知时槽位仍被占用，本地手动开始也不能绕过。
6. 停止一个 Master。其 Brain 暂停新调度，另一 Brain 仍能使用可用 Worker；不选举新 Master、不接管或迁移原 Brain 的 Task。恢复原 Master 后核对原 Task/Execution ID。
7. 若做断线补测：只有 Master 仍记录 pending 的旧执行可安全重派；已 accepted 的执行失联后显示结果未知，不自动重派。不得在含重要文件或有真实副作用的任务上注入故障。
8. 记录设备/实例标签、版本、验证时间、Task/Execution ID、实际结果和例外。记录不得包含 Key 或模型账号；结束后停止本轮测试进程。

## 2026-09-02 首次双机截图记录

- 证据为用户提供的截图，不是脚本报告。左侧设备地址 `192.168.5.20`，本机承载 Brain `1f466b`；右侧设备地址 `192.168.5.33`，本机承载 Brain `3b7862`（均为界面短 ID）。两端各自显示相同的两个 Brain，Master Host 不同。
- 两个 Brain 的目录中都能看到两台 Node 的 Worker 报告。报告显示 Ryzen 7 7840HS/约 47 GB 内存和 Ryzen 7 7700/约 63 GB 内存，以及 GPU、CPU/内存占用、磁盘可用空间和采样时间；这里只确认界面显示和跨机可见，未独立核对设备硬件准确性。
- 当前两台 Worker 均显示 0 个可用槽位、没有对 Brain 公开项目资源。不能由此断定具体原因，也不把 Brain 卡片的“可调度”解释为已有可执行任务的空闲槽位。
- 单张截图不能证明连续 90 秒稳定、旧身份保留、任务执行或竞争仲裁通过。下一检查点先观察在线状态和采样是否持续更新，随后再准备第三个隔离测试 Node，完成两个 Brain 竞争同一 Worker 的正式验收。

## 2026-09-02 后续检查点

- 用户随后确认两台保持打开 90 秒、观察均正常；记为双机目录稳定性的人工结果，不生成自动化采样报告，也不扩大为第三 Worker 或任务执行通过。
- 当前准备第三 Worker：新增仅测试用的 `scripts/m34-physical-worker.ts`，复用开发机已安装的 0.1.1 Node、服务代码和官方 OpenCode；不开第二个 Tauri 窗口，不重新打包产品。
- 脚本只创建自己的 `.data/m34-physical/<UUID>` 数据与普通 Project；模型使用本机确定性夹具，不导入用户凭据、不消费外部额度。独立 Worker 开放一个槽位，原两台客户端的项目和执行策略不变。
- 启动检查先核对新 Node ID、版本、官方引擎、本机测试模型及一个空闲槽位。配对仅对用户这两台已核对的设备发起，用户仍在各自客户端核对验证码并确认；不批量信任附近设备。
- 配对后再验证第三 Worker 同时注册给两个 Brain；CLI 只提供配对、状态、释放测试模型回复和停止本轮进程，不自动提交任务。测试结束通过 `stop` 清理自有进程，数据留作证据。

### 第三个 Worker 启动结果

- `scripts/m34-physical-worker.ts` 已通过 TypeScript 和 diff 检查，实际使用已安装的 0.1.1 运行时启动成功；官方 OpenCode 就绪、模型列表仅 `fixture/m34`、一个空闲槽位、模型请求 0 次。测试助手启动成功不代表共享执行通过，不需要重新安装客户端。
- 当前 Worker：`Rivloom t9MUCF`，Node ID `t9MUCFG44Q3nM4txwjG3UPI7mbwePMsM`；数据根 `.data/m34-physical/a4530002-0690-40f6-a232-b632fefc5148`；测试 Project `c4227a2e-f93c-4514-ad67-f42c65fa749c`。助手 PID 37244、Worker 服务 PID 23780；后续操作前仍应核对身份和进程，不能仅凭旧 PID 清理。
- 首次启动检查的临时助手已正常退出，模型请求 0 次。确认同机节点可能通过虚拟网卡地址被发现后，最终助手按启动参数中的两个完整 Node ID 限定可配对对象，不把某个 IP 地址当作身份。
- 两个允许的设备为 `iKsIEiktL_rpMKZhvkbmsblUkKsB36j8`（5.33）和 `o7Lzbrbv9GaX-KXPfVBUE5bonPRp-Yik`（5.20）。已由测试 Worker 发起配对并确认自身一侧，等待用户在两台真实客户端比较验证码后确认。验证码不写入持久验收文档。
- 配对过程保留异常事实：向 5.20 的首次确认返回连接不可用（503）；只读核对其仍在线及当前端口后，在同一配对 ID 上重试一次成功。没有改防火墙、降低认证或重新建立身份，也没有把一次重试成功宣称为网络故障原因已消除。
- 观察报告：`.data/verification/m34-physical-worker.json`；只记录本轮 Worker 的身份、拓扑和执行摘要，不包含用户模型凭据。助手保持运行等待本轮交互；不要关闭用户的两台桌面。退出使用助手标准输入 `stop`，不按程序名批量终止。

### 第三 Worker 配对期间的单侧不可见问题

- 用户确认 5.33 已配对，随后报告 5.20 同时看不到原 5.33 和新 Worker；共享执行验收暂停，不继续发任务。原来双机 90 秒的人工通过只适用于加入第三 Worker 前，不能扩大为新拓扑稳定通过。
- 后台核对确认 Worker 与 5.33 的信任和加密通道已建立；Worker 撤回自己的 provisional Brain，当前注册到正式 Brain `3b786211-89bf-4226-bd05-40b15e75f15c`。与 5.20 的配对未完成且原验证码已过期；模型请求仍为 0。
- 2026-09-02T03:37:33Z 至 03:37:53Z 做了六次只读采样：5.33 后台始终显示 5.20 在线、已信任、加密通道就绪，心跳持续刷新；Worker 也持续发现 5.20 在线，但尚未信任。这个结果与用户描述的页面不可见需要进一步核对，不能直接认定整条双向连接已中断，也不能据此认定 5.20 页面没有问题。
- 本机 0.1.1 的原桌面服务 PID 29244、节点端口 11183；测试 Worker 服务 PID 23780、节点端口 4635，均监听 `0.0.0.0`。两服务均存在 UDP 43531 监听。已检查的随包 `node.exe` TCP/UDP 入站规则均为 Enabled/Allow/Private，以太网也是 Private；这里只记录已查规则，不宣称排除了所有系统或对端网络因素。
- 本轮未改代码、防火墙、网卡、代理或现有信任；保留 5.33 配对和测试 Worker 运行状态。下一步请用户提供 5.20 的“附近节点”区域截图，再决定是否需要在 5.20 做本机只读诊断。
- 用户后续截图出现关键身份差异：地址为 `192.168.5.18:59676`，节点 `Rivloom GzjtkQ`、Brain `9e8d7f`，不是先前 `192.168.5.20 / Rivloom o7Lzbr / Brain 1f466b`。页首“附近的 Rivloom 自动相遇。Brain 可以独立工作，也可以在信任建立后协同任务。”与 `f5ce9ed` 的旧版界面源码一致，当前 0.1.1 页面使用不同文案并有共享 Worker 拓扑区域。只能据此确定当前截图的节点身份和页面版本不匹配，尚不能断言用户切换了物理设备、启动了旧安装还是使用了另一数据目录；先核对设备/启动入口，不改网络或删除数据，也不将此截图记为原 5.20 的掉线证据。
- 用户随后明确确认看错了实例，并要求重新配对。本次“5.20 看不到节点”的报告因此不作为网络故障证据；保留此前实际发生过的一次 503 确认重试记录。重新核对真实 5.20 的完整 Node ID 后，仅重新发起 Worker 与该设备的已过期配对；5.33 的既有信任不撤销、不重建，5.18 的旧实例不纳入本次验收。

### 两个 Brain 共享第三 Worker：注册与稳定性通过

- 用户完成真实 5.20 的配对确认，后台核对两条信任/加密通道均已就绪；Worker 当前只注册到 Brain `1f466b29-c676-4ca6-96e4-dd2bafaa55f9` 与 `3b786211-89bf-4226-bd05-40b15e75f15c`，不再承载自己的临时 Brain。
- 2026-09-02T03:45:13.566Z 至 03:46:46.271Z，共 92,705 ms、91 次采样：从 5.33 桌面服务和测试 Worker 的只读业务接口核对，两个 Brain 始终为 established/online，预期受信通道持续就绪；两个 Brain 中同一 Worker `t9MUCFG44Q3nM4txwjG3UPI7mbwePMsM` 均 accepting、一个空闲槽位，报告最大年龄 4,975 ms，没有残留临时 Brain。检查未提交 Task、未调用模型。
- 这是实际两台 Windows/三个 Node 的目录与共享槽位报告检查，不是对 5.20 原生界面逐帧检查，也不等于任务执行或竞争通过。
- 下一检查点：用户从 5.20 的“自动安排跨节点任务”提交一条 Portable Task，说明只需文字回复、不调用工具或修改文件；保持硬件要求为空，不修改两台原客户端的执行设置。记录实际选中的 Brain、Task、Execution 和 Worker，不预设任务必然属于提交节点承载的 Brain。测试模型暂缓回复，便于检查占槽，再由助手手动释放。
- 竞争验收注意：全互信拓扑中的新任务会自动选 Brain；两台提交不自动意味着两个不同 Brain 各持有一个 Task。当前界面和创建接口要求候选 Worker 有空闲槽位，第一条已占槽后可能禁止第二次提交；不能靠重复点击、改记录或沿用同机竞争结果冒充物理双 Brain 竞争。该项继续单独验证。

### 第一条物理 Task：回执被拒绝，执行尚未开始

- 用户在真实 5.20 提交 `M3.4 物理任务 A`，说明为“仅返回一条简短文字，不调用工具，不修改文件。”，验收标准为“共享 Worker 返回文字结果，且没有修改文件。”。用户随后提供权威任务卡片文字：Brain `1f466b`、Master `o7Lzbrbv`、Worker `t9MUCFG4`、Portable Task、第 1 次尝试、序号 0，状态为“已分配 Worker”。
- 实际 Brain Task 为 `7f0da3b1-4282-4b75-8784-ac19b1d72653`，Execution 为 `44b41f60-dc4c-4427-9e62-a20a5716ea47`；Worker 的归属与路由字段和卡片一致。不是任务串线，也不应因卡片显示“已分配”就判断执行已启动。
- 2026-09-02T03:51:51.237Z 的 Worker 只读记录显示：远端 Execution 本地 `accepted`，但 `deliveryError` 为“对方拒绝了冲突或无效的任务消息。”、`deliveryPending=false`、`localTaskID=null`、`executionStatus=unprepared`、`executionState=not_started`、执行序号 0。2026-09-02T03:58:09.687Z 再查仍没有本机业务 Task，模型请求 0 次、空闲槽位 1。官方执行会话尚未启动；这不是模型夹具暂缓回复造成的，也没有由此任务调用工具或修改项目文件。
- 代码路径确认：M3.4 Worker 必须先收到 Master 对接受回执的成功响应，才允许绑定本机 Task、准备 Portable 目录和启动 OpenCode；回执冲突时提前返回。这一安全边界生效，不能通过修改记录或强行启动绕过。
- 安装的 0.1.1 与工作区 `server/remote-tasks.ts` 均使用 `decidedAt < task.createdAt` 拒绝回执。前者由 Worker 的墙上时钟产生，后者来自 Master；正常先后发生的事件不能据此要求两台时钟精确同步。
- 2026-09-02T03:53:29.770Z 至 03:53:31.812Z，对已核对身份的真实 5.20 `/v1/hello` 做六次只读随机挑战请求，全部 HTTP 200、Node ID 与 nonce 匹配。以本机发出/收到时间夹住响应生成时刻，得到对端时钟领先区间依次为 `[43,116]`、`[46,147]`、`[47,140]`、`[46,147]`、`[47,156]`、`[46,151]` ms；每次都证实其时钟至少领先约 43–47 ms。这不是精确时钟同步测量，也不能还原原始接受包的时间。
- 纯内存对照复现通过：构造同路由、合法结构、仍待接受的邀请；`decidedAt=createdAt-50 ms` 能通过消息结构校验，但 `RemoteTaskStore.receiveResponse` 抛出“远端任务回复时间无效。”且保持 pending；仅将回执时间改为等于创建时间便成功接受。诊断覆盖持久化函数为内存计数器，未创建目录、未写文件、未接触真实任务记录。该结果确认时间校验缺陷，与本次现象高度吻合，但不是本次报文重放。
- 证据限制：对端 400/404/409 会被折叠为相同冲突文案；Worker 的 `markDeliveryFailed` 又覆盖了 `updatedAt`，没有单独保留原始 `decidedAt`。因此当前不能宣称已证明本次唯一拒绝原因就是时钟偏差。现有同机测试未覆盖该偏差，既有通过记录不能覆盖本次失败。
- 当前停点：未改产品代码、系统时钟、防火墙、信任或实际 Task/Execution 记录；没有取消、重发或释放模型回复，三实例继续保留现场。先向用户报告，下一步需要修复跨时钟校验并补正反向时差、过期、失效 Execution/迟到回执安全回归，再重建安装包和恢复物理验收；不能靠用户手工同步时钟或反复重发作为产品修复。

通过本清单且本地自动化、实际 Release 窗口检查保持通过后，再由用户确认 M3.4 MVP 验收。远程停止、其他审批模式、撤销信任、两真人角色和安装体验不在本清单中重新变成 M3.3 阻塞项。

### 0.1.2 修复与下一物理检查点

- 用户随后确认同意修复、回归和重打包。回执、准备和执行状态接收沿用 60 秒时差容限；首次接受使用 Master 本机到期判断，状态和 Execution 去重边界不放宽。新增 11 项定向测试与全量 43 项通过；完整服务正负时差回归、产物与边界见 [最新验证](../VERIFICATION.md)。
- 2026-09-02T04:43:42.029Z 再查，旧物理 Worker 仍为 0.1.1、一个空闲槽位，原 Task/Execution 仍未创建业务 Task，模型请求 0 次。5.20 仍在线；本机 5.33 桌面进程及运行描述文件已不存在，Worker 看到其 Brain 离线。本轮助手没有退出用户桌面；不推测退出原因，不将其算作计划内 Master 停止通过。
- 更新前先让用户关闭仍运行的正式桌面，再核对 Master 已退出；随后只对本轮测试助手发 `stop` 释放旧安装 runtime，保留所有独立数据。不要在 Master 仍在线时擅自停 Worker，因为 pending 离线会触发产品的正常取消/重调度，改变当前现场。
- 新包为 `src-tauri/target/release/bundle/nsis/Rivloom_0.1.2_x64-setup.exe`（71,051,274 字节）。两台使用同一份 0.1.2，安装到原目录并保留数据；不提前卸载或删除应用数据、不复制零散源码。本轮未运行新包安装/卸载烟雾测试，也没有更新用户安装。新版本不会自动清除已有回执错误或补发旧失败 Execution；更新后先核对实际记录，再与用户确认继续测试的任务处理步骤。
- 不重复配对或建立新 Worker 身份来掩盖失败。后续若需重启原物理 Worker，应先为助手提供经核对的同一隔离目录恢复方式；现有助手默认新建数据目录，不能直接重跑并声称身份保持。此恢复步骤尚未实施。

### 升级前释放测试运行时（2026-09-02）

- 用户确认已关闭两台桌面，并明确升级由自己操作，不需要助手逐步指导。2026-09-02T05:00:47.658Z 核对本机无 Rivloom 桌面进程，物理 Worker 观察两个正式 Brain 均离线；原 Task A 无本机业务任务，模型请求 0 次。
- 仅向已核对身份的本轮助手输入 `stop`；返回 `CLEANUP stopped=true`、原隔离根目录和 `modelRequests=0`。助手/Worker 原 PID 37244/23780 已退出，Node 身份、信任及远端任务记录文件保留。没有运行安装器、取消/重发任务、删除数据或按程序名终止其他进程。
- 当前等待用户自行将两台更新为 0.1.2；更新后再准备原隔离 Worker 的同目录恢复并继续验收。不默认新建身份或要求重复配对。

### 用户重新打开后：默认数据目录中的节点身份发生变化

- 用户表示两台已打开，由助手负责后台测试。检查本机实际程序为 `%LOCALAPPDATA%\Rivloom\Rivloom.exe`，桌面/后端 PID 为 31832/40536，版本 0.1.2，业务 URL `http://127.0.0.1:12812`（后续使用前应重新读取运行描述）。
- 本机仍使用先前的 `%LOCALAPPDATA%\com.rivloom.desktop\workspace`，但当前 Node 为 `tRCQ1_OopLOZTbZpU-vnFboWPwj69ob7`、Brain 为 `0ed79cba-4ed8-4373-ad3f-1dfc4a695800`，不再是原 `iKsIEiktL_rpMKZhvkbmsblUkKsB36j8` / `3b786211-89bf-4226-bd05-40b15e75f15c`。身份记录的 `createdAt` 为 `2026-09-02T06:09:41.701Z`，文件创建时间为 `06:09:42.264Z`。
- 只读业务检查：本机 Project 0、Task 0、Brain Task 0，`trusted-nodes.json` 不存在；应用数据父目录只列出 `workspace`。这证明当前目录未提供原身份/业务/信任数据，但不证明其他位置不存在旧数据或备份，不进行全盘搜索或数据恢复写入。
- 当前发现的 `192.168.5.20:53816` 为 `Rivloom As64SU`、Node `As64SUH5wlu5deeBDPuHLsE47DWempcQ`，在线但未受信，也不同于原 `o7Lzbrbv9GaX-KXPfVBUE5bonPRp-Yik`。5.20 安装版本及数据路径尚未独立读取，不能仅凭发现地址认定完整升级保持通过。
- 生成的 NSIS 脚本在勾选“删除应用数据”且非更新模式时会清理两处 app-data 目录；这是可能路径，不是用户确实勾选的证据。当前不把现象直接归因于用户操作或安装器缺陷，先请用户确认是否卸载并删除了应用数据。
- 原测试 Worker 隔离目录、Node `t9MUCFG44Q3nM4txwjG3UPI7mbwePMsM`、两个旧受信身份和执行策略仍存在。助手保持停止，同目录恢复支持尚未修改/启动；没有改变正式或测试节点的身份、信任、Task/Execution，也没有提交新的模型任务。本检查只记录到文档。

### 用户确认清空数据后：重新建立物理验收基线

- 用户明确回答“是的”：此次先卸载并勾选了“删除应用数据”。因此当前是清空后的全新身份，不将此现象作为覆盖升级丢数据的证据；0.1.2 身份保持升级仍未实际复验。
- 最新只读核对仍为 5.33 `tRCQ1_OopLOZTbZpU-vnFboWPwj69ob7`、5.20 `As64SUH5wlu5deeBDPuHLsE47DWempcQ`。两端尚未互信；本机 0.1.2 已确认，对端版本仍以用户安装反馈为据。
- 旧 Worker `t9MUCFG44Q3nM4txwjG3UPI7mbwePMsM` 的目录中无运行锁，业务 Task 为 0，原 Project `c4227a2e-f93c-4514-ad67-f42c65fa749c` 和 `fixture/m34` 单槽策略保留。旧 Execution `44b41f60-dc4c-4427-9e62-a20a5716ea47` 不改归属、不补发、不删除。
- 本检查点的实施顺序：① 测试助手添加显式同目录恢复参数，启动前只读校验限定目录、原 Node、项目/模型及无活动任务；② 定向验证后，用已安装 0.1.2 启动原 Worker，确认原身份/Project/旧 Execution 保留且模型调用为 0；③ 只向以上两个新 Node 发起配对，真实客户端仍由用户比较验证码并确认。步骤不改产品协议、不需要重打安装包。
- 新验收采用两个独立 Master 分别信任同一 Worker 的拓扑，暂不让两个 Master 互相配对，便于确认任务各属自己的 Brain。旧拓扑的 92.7 秒稳定报告仅保留为历史结果，新拓扑需重新观察。后续新建任务使用新标题/ID，与旧失败 Task A 明确区分。

### 原 Worker 同目录恢复结果

- `scripts/m34-physical-worker.ts` 增加 `--resume-root` 和 `--expect-node`；只读预检在 `scripts/m34-physical-resume.ts`，仅支持本次无业务 Task、旧接受回执失败且未绑定本机任务的场景，不是通用任务恢复或迁移工具。拒绝错误根目录、链接跳转、运行锁、身份不符、非夹具模型、项目/策略变化和其他执行现场。
- 4 项只读断言、TypeScript、格式及 diff 检查通过。使用已安装 `%LOCALAPPDATA%\Rivloom\runtime\node.exe` 运行，无需重打包或再次安装。
- 实际启动时间 `2026-09-02T06:21:41.240Z`，版本 0.1.2，原隔离根目录、Node `t9MUCFG44Q3nM4txwjG3UPI7mbwePMsM`、Project `c4227a2e-f93c-4514-ad67-f42c65fa749c` 和旧 Execution `44b41f60-dc4c-4427-9e62-a20a5716ea47` 全部保留。官方引擎就绪、模型列表仅 `fixture/m34`，业务 Task 0、模型调用 0、可用槽位 1。旧两个 Brain 保留为离线，不承载新 Brain。
- 助手 PID 41256、Worker PID 19256，工具交互 session 77892；后续使用前核对，清理只输入 `stop`，不按程序名终止其他进程。状态报告仍为 `.data/verification/m34-physical-worker.json`，由最新状态覆盖，历史结果以本文件记录为准。
- 已向 5.20 `As64SUH5wlu5deeBDPuHLsE47DWempcQ` 和 5.33 `tRCQ1_OopLOZTbZpU-vnFboWPwj69ob7` 各发起一次配对，Worker 一侧确认成功，等待用户在各自正式客户端比较验证码后确认。没有替用户确认真实客户端一侧、没有配对两个 Master、没有提交新任务。配对码不写入持久文档。

### 配对过期后的现有请求处理

- 用户反馈上轮配对可能已过期。2026-09-02T06:28:04Z 从同一 Worker 读取：两台正式客户端均已重新发起请求并确认自身一侧，正在等待 Worker；没有再发起重复请求，也没有撤销信任或重启实例。业务 Task 和模型调用仍为 0。
- 2026-09-02T06:29:09Z，通过 5.33 与 Worker 各自本机认证接口核对完整 Node ID、同一配对 ID、验证码一致及未到期，仅补确认 Worker 一侧；实际加密通道已就绪。没有替用户操作真实客户端的确认按钮。
- 5.20 的新请求仍待 Worker 确认；已向用户展示 Worker 侧的新验证码，请其与 5.20 页面比较。验证码不写入持久文档；未核对一致前不补确认，若过期则重新检查。当前不发任务。

- 用户再次反馈号码/状态似乎不对。2026-09-02T06:31:03Z 只读核对：两台都已经换成另一条新配对 ID，均由正式客户端发起并确认自身一侧，Worker 尚未确认；因此上一轮验证码不再适用。5.33 与 Worker 的信任文件均记录在 `06:29:27Z` 撤销（两侧相差约 8 ms），当前不再受信；这只证明信任状态发生变化，不单凭记录断言具体操作者或故障原因。助手本轮未撤销、重发或确认任何请求。已请用户暂停操作并提供 5.20 当前配对卡片截图，核对对方名称和号码后再继续；“5.33 配对成功”仅是上一检查点结果，不能当作当前状态。

### 截图核对后配对完成；自动 Brain 正式化检查失败

- 用户提供两台页面截图，对方均为原 Worker `Rivloom t9MUCF`；两个验证码分别对应两条独立关系，本来就不要求相同。将截图中的完整配对关系与 Worker 当前请求 ID、号码、对端已确认和有效期逐项对照后，只确认 Worker 一侧。`2026-09-02T06:32:44.810Z` 两台均 trusted/channelReady；没有重新发起、取消或操作正式客户端的确认按钮。
- 5.20 的新 Brain 完整 ID 为 `fb03a2d7-2aa6-482b-8668-c17ce30af08f`，Master 为 `As64SUH5wlu5deeBDPuHLsE47DWempcQ`。5.33 仍为 Brain `0ed79cba-4ed8-4373-ad3f-1dfc4a695800`。两者目录都显示原 Worker 的一个空闲槽位，旧 Brain 历史离线保留。
- `06:33:36.833Z` 发起新拓扑 90 秒只读检查，在首轮“两个 Brain 都为 established”断言失败，未完成采样，不记为稳定性通过。`06:33:56Z` 和 `06:35:41.912Z` 再查，5.20 仍为 provisional；两个受信通道保持就绪。5.33 为 established。当前业务 Task 为 0，没有提交新任务或释放模型。
- 工作区及本机已安装 0.1.2 的自动正式化条件均使用所有已发现节点的 `brains.some(state === established)` 作为阻塞条件，未区分在线受信的实际 Master、未配对的候选和 Worker 登记的其他/历史 Brain。调度器又仅接纳 established/online Brain。将实际 5.20 拓扑交给纯排名函数，虽有一个空闲 Worker，候选数仍为 0。
- 纯内存复现：单个未受信节点的 established 广告就令 `settleProvisional` 保持临时状态；无该广告时可正常正式化。覆写的仅为独立内存对象的保存方法，没有触碰产品实例或真实拓扑文件。它证实实现存在该阻塞路径；未直接读取 5.20 安装源码或其完整候选列表，不将推断扩大为对端全部内部状态的证明。
- 当前停在自动 Brain 正式化问题，不能靠改拓扑文件、临时关闭邻居、合并两个 Master 或允许 provisional 接任务来冒充通过。须先明确可用 Brain 与发现候选的边界并修复回归，再继续新物理任务。本轮只改记录，不改产品代码、不重装、不调整系统或信任；两台配对已成功，应保留。

### 重新核对产品定义：先修正测试前提，不强制第二个 Brain

- 用户问下一步后，对照 ADR-0004 重新检查：新 Node 发现现有 Brain 时应接入现有 Brain；只有已经独立形成的正式 Brain 相遇时才保持多个。两台卸载删除数据后，不能继续套用旧两个正式 Brain 的前置条件。此前将 5.20 的等待状态直接定为“必须修复的自动正式化缺陷”过早，应收紧为已观察到的等待路径与测试前提缺口。
- `2026-09-02T06:41:27.889Z` 只读确认：Worker 与两台均 trusted/channelReady；5.33 与 5.20 不受信。5.33 Brain established，5.20 Brain provisional；Worker 没有 hosted Brain，业务 Task 为 0。
- 纯内存对照确认：只收到 Worker 的空 hosted 目录，临时 Brain 不会被接纳/撤回；收到真实 Master 的 established 认证目录后，会撤回自己的临时 Brain并登记既有 Brain。不写真实数据，不进行实际新配对。该结果是代码路径对照，不冒充物理接入通过。
- 原完整服务测试在启动前为两个 Master 调用 `loadNodeIdentity`，后续按旧身份迁移为 established；因此它覆盖“双已有 Brain”，不是当前“同网新安装且尚未信任 Master”的前置条件。原通过仍有效，但不能扩大覆盖新节点接入。
- 下一检查点：请用户在 5.20 对 `Rivloom tRCQ1_`（5.33 的实际 Master）发起配对，核对同一请求的验证码并完成双方确认；已有两条 Worker 信任不改。随后只读核对 5.20 临时 Brain 自动撤回、两台都看到既有 Brain、Worker 空闲槽位和稳定状态，再做一条跨机任务。这是“新节点接入 / 单 Brain 跨机”的验收，不算双 Brain 竞争通过。
- 双独立 Brain 共享 Worker、竞争和 Master 停止仍是 M3.4 未完成项，后续应明确准备“原本独立形成再相遇”的合法初始环境；不编辑 Brain 状态，不通过临时屏蔽节点掩盖等待路径，不把单 Brain 结果替代双 Brain。
- 等待提示、只有过期/历史广告、未信任任何实际 Master 时的可用性边界仍保留为待核对问题。当前不把“仅凭发现即可永久阻塞”扩大为已接受的产品规则，也不擅自改成“每个未配对节点自动固定一个 Brain”。本轮只修正文档，无产品代码、任务、配对或进程写操作。

### 新节点接入现有 Brain：物理验证通过

- 用户完成 5.20 与 5.33 彼此配对。`2026-09-02T06:44:42Z` 只读核对：三条设备信任/加密通道全部就绪，5.20 的认证目录仅声明已接入的 Brain `0ed79cba-4ed8-4373-ad3f-1dfc4a695800`，Master 为 5.33 `tRCQ1_OopLOZTbZpU-vnFboWPwj69ob7`；原临时 Brain `fb03a2d7-2aa6-482b-8668-c17ce30af08f` 已自动撤回，并从 Worker 与 Master 的目录中消失。不是合并或删除已有任务的正式 Brain。
- `06:45:49.673Z` 至 `06:47:20.314Z`，90,641 ms、89 次采样通过：Worker 与本机 Master 的认证接口始终显示三条受信关系/通道正常，只有同一正式 Brain 在线，5.20 的认证目录持续指向该 Master，没有重新出现临时 Brain；Worker 始终 accepting/空闲槽位 1。Master 收到 19 次不同采样时间的资源报告，最大报告年龄 4,994 ms。
- 证据边界：没有直接读取 5.20 的本机数据库或逐帧检查其 UI，远端接入状态来自两方收到的已认证目录；不是双 Brain 竞争或任务执行通过。业务 Task 与 Brain Task 均为 0；助手 `06:47:18.690Z` 状态记录模型请求 0 次，旧失败 Execution 保留。本次不改产品代码、系统设置或配对，不需要新安装包。
- 结果摘要 `.data/verification/m34-physical-adoption-20260902T064549Z.json`；助手观察 `.data/verification/m34-physical-worker.json` 已刷新。该正常接入结果进一步支持上一节对测试前提的修正；不据此宣布所有无可用 Master/历史广告的等待边界均已解决。
- 下一步只提交一条新任务：在 5.20 的“自动安排跨节点任务”，标题 `M3.4 新节点文字任务 A`、项目资源 Portable Task、说明“仅返回一条简短文字，不调用工具，不修改文件。”、验收标准“返回文字结果，且没有修改文件。”；硬件要求留空，点击“自动选择 Brain 与 Worker”。用户只提交一次后告知，助手核对 5.20 → 5.33 Master → 原 Worker 的真实 Task/Execution/官方会话和占槽，再释放本机确定性模型回复。旧 Task A 不重发、模型凭据和两台本机执行开关不变。

### 新 Portable 文字任务：后台闭环及提交端人工确认通过

- 用户从 5.20 提交一次 `M3.4 新节点文字任务 A`。Master 记录提交者 `As64SUH5wlu5deeBDPuHLsE47DWempcQ`、归属 Brain `0ed79cba-4ed8-4373-ad3f-1dfc4a695800`、Master `tRCQ1_OopLOZTbZpU-vnFboWPwj69ob7`、Worker `t9MUCFG44Q3nM4txwjG3UPI7mbwePMsM`；Task 与 Execution 独立、没有换 Brain 或重复尝试。
- Brain Task `45b70f73-e911-4f65-8e75-db31c3efa2fa`，Execution `2414f24a-a968-4e19-8b5d-24b493e7db4e`；Worker 业务 Task `503ce474-6c44-4152-b8db-4f31015595be`，官方 OpenCode 会话 `ses_f9f184136ffexqtgBdYAJ7vpb4`。实际数据库始终只有一个业务 Task 和一个官方会话；旧失败 Execution 仍未绑定本机 Task、序号 0，不重发、不迁移。
- `06:56:59Z` running / 序号 2，Worker 槽位为 0、没有投递错误；助手 `06:57:19Z` 观察模型请求恰好 1 次。`06:57:50Z` 核对后只释放原测试模型的文字回复；`06:58:24Z` Worker 与 Master 均 review / 序号 3，Master 摘要含测试模型的文字结果，发回提交节点的加密消息已成功应答（deliveryPending=false、deliveryError=null）。review 仍占用槽位 0。
- 只读官方会话 part 记录确认工具调用 0 次；Portable Project `05a8ef8f-d81d-4462-bdcf-29e922caaca2` 对应原 Worker 下 `portable-tasks/2414f24a-a968-4e19-8b5d-24b493e7db4e`，普通文件夹、无 `.git`，释放回复前、review 和验收后直接列目录均为空。没有复制授权项目、文件快照或哈希；官方差异接口未返回文件差异，如实保留空结果。
- 助手通过所属 Master 的正常控制接口提交本条测试的验收（expectedExecutionSequence=3），验收备注明确为本机确定性模型、单任务/会话、无工具/文件改变，不代表真实 AI 编程或整个 M3.4。`06:59:45.098Z` Master completed / 序号 4，Worker 业务任务 accepted、槽位恢复 1、runningTasks=0；完成消息得到 5.20 成功应答。`07:00:39Z` 复查仍只有一个官方会话且工具调用 0 次。没有把这次脚本代办验收冒充用户的 MVP 验收。
- 模型是本机 `fixture/m34`，总调用 1 次，无用户外部模型额度。模型释放开关当前保持 released，后续任务不会自动停在等待回复；助手继续运行，已存在完成任务，现有仅支持“无业务任务现场”的恢复预检不能直接用于再次恢复，不应贸然停掉后默认重跑。
- 证据范围：提交与状态返回跨真实 5.20/5.33；Master 与 Worker 虽是两个 Node/目录，却同在 5.33，因此不宣称本次覆盖了物理 Master/Worker 时差。不是双 Brain 竞争、Project Task、Master 停止或所有 M3.4 条目通过。
- 结果 `.data/verification/m34-physical-single-brain-task-45b70f73.json`，状态更新为本条测试通过。用户随后明确反馈“是的，写的 已验收”（记录时间 `2026-09-02T07:06:54Z`），据此确认 5.20 可见验收结果；如实保留其观察文字，不改写成其逐字看到了“已完成”状态徽标。后台 Brain Task completed / Worker accepted 的证据来自前述接口核对。本条单 Brain 跨机文字任务闭环完成，不是整个 M3.4 MVP 验收。
- 本确认回合仅同步文档和结果摘要，未改产品代码、安装包、系统设置、任务或配对。原助手/模型夹具保持此前状态，后续仍需准备双独立 Brain 的合法初始环境，继续竞争、Project Task 和 Master 停止等未完成验收项。

### 继续测试：同机自动形成与竞争通过若干检查，端口问题阻断重启

- 用户要求继续测试。先在 5.33 新建独立测试数据，使用安装的 0.1.2 和官方 OpenCode；两 Master 在不同测试发现端口上自行经历 provisional → established，之后保留原数据接入同一测试发现域。只用测试进程的既有发现配置，不预建身份、不改 Brain 文件，不隐藏现有物理节点或宣称解决未信任 Master 的等待边界。
- 现有 43 项回归全通过；新场景第二轮通过 7 项断言，包括 90,224 ms 稳定、两个独立 Brain 同时竞争一个 Worker 只运行一条、另一条留在原 Brain 排队、review 占槽、同名项目不替代、停止一个 Master 后另一 Brain 的指定 Project Task 到达 review 且不接管原 Task。全部在一台机器，不能勾掉本清单中的物理双 Brain 条目。
- 整轮报告 `m34-fresh-brains-793f9de8-5d9f-4e31-b544-92d2524b7c77.json` 为 **failed**：重启 Master B 分到 `http://127.0.0.1:1719`，Node Fetch 明确拒绝 `bad port`，恢复身份和排队续跑未验到。产品与测试都采用 OS 分配的 `PORT=0`，没有筛除浏览器受限端口；本机动态 TCP 范围包含 1719。实际原生窗口在该端口失败尚未直接验证，不称为 Brain 数据或引擎损坏。完整证据、首轮测试读取错误及修正、所有 ID 见补测计划。
- 第二轮模型请求 2 次、官方会话 2 个、工具调用 0；第一条 Portable 已验收，Project 仍 review，另一 Brain 的 Task 仍 queued。新测试进程全部停止、数据保留；没有修改产品、重打包、改变系统端口范围、防火墙、原信任或旧任务。
- 07:29:38Z 再查，现有两台与原 Worker 的三条通道仍在线可信，用户 Task 45b70f73 保持 completed、原 Worker Task accepted 且槽位 1。后续先与用户确认是否修复 Rivloom 的安全可用端口选择，再完成重启/排队及真正双机回归；额外 5.20 隔离实例尚未启动。

### 0.1.3 高位端口修复后：同机完整生命周期通过

- 用户明确授权修复，并要求端口大一些。应用 HTTP、节点 HTTP、官方 OpenCode 的 Rivloom 启动包装器统一使用 49152–65535 自动端口；冲突/保留端口有界重试，固定端口严格保留或报错。UDP 发现不变，不修改系统范围、防火墙或 OpenCode。
- 0.1.3 打包运行时的报告 `m34-fresh-brains-bd24ebd5-73b6-423c-860a-12a73b41ffa3.json` **11 项通过**。上轮未完成的 Master 重启、同 Node/Brain/Task/Execution 历史保持、槽位释放后原队列继续均通过；3 个业务 Task/官方会话、3 次本机模型请求、0 工具调用，均经测试验收。6 次启动/重启的 18 个 HTTP 端口全部在高位范围，90,285 ms / 167 次通道与资源报告检查通过。具体 ID 与端口表见修复计划。
- 这是同机隔离服务自动回归，**不勾掉物理双 Brain 条目**。所有新测试进程已退出、数据和先前失败报告保留。07:53:35Z 复查，原 0.1.2 两桌面/Worker 的三条通道、用户已验收任务、原 Worker 的一个空闲槽位保持正常；未安装新包、未重配对、未停止原物理 Worker。
- 下一物理步骤仍需协调升级和合法双 Brain 初始环境。用户自行安装；升级前先安排退出正式桌面并安全停止占用安装 runtime 的原测试 Worker，保留数据。原助手的“零业务 Task”恢复预检不适用于当前已有完成任务的 Worker，不得停止后直接默认新建身份或套用该预检。

### 0.1.3 交互安装指引更正（2026-09-02）

- 用户反馈“不点卸载没法安装”。只读核对生成的 `src-tauri/target/release/nsis/x64/installer.nsi`：升级页的“安装前卸载”会调用旧卸载器，成功后继续安装；“请勿卸载”分支也设计为继续安装，因此不能仅凭源码认定用户当前页面为何无法继续，尚未取得该页截图或交互复现。
- 更正操作指引：允许安装器先卸载旧程序；卸载确认页不勾选“删除应用程序数据”，随后继续安装 0.1.3 到原目录。源码中清理 `com.rivloom.desktop` 两处应用数据目录由该复选框控制，卸载程序与删除应用数据不是同一个操作。安装后仍须核对原 Node、Brain、信任及 Task，不能预先声称交互升级保持已经通过。
- 先前隔离安装烟雾测试使用 `/UPDATE`，不能替代本次普通交互卸载后安装的验证。此次没有运行安装器、卸载器或删除数据，仅纠正说明。
- 本轮只读检查：旧桌面 PID 31832 已不在列，`desktop-runtime.json` 不存在；这不证明应用数据被删除。测试助手 PID 41256 和 Worker PID 19256 仍运行于 `%LOCALAPPDATA%\\Rivloom\\runtime\\node.exe`。5.33 暂不能执行最终卸载/覆盖，需先完成原 Worker 的安全停止与同目录恢复准备；5.20 退出 Rivloom 后可按上述保留数据流程由用户升级。

### 用户授权停止 5.33，释放升级占用（2026-09-02T10:49–10:51Z）

- 用户明确要求“5.33 你先停止吧”。向原助手 session 77892 发送 `status`，10:49:55.252Z 确认原 Node `t9MUCFG44Q3nM4txwjG3UPI7mbwePMsM`、原隔离根目录、PID 41256/19256；运行任务 0、空闲槽位 1，唯一业务 Task `503ce474-6c44-4152-b8db-4f31015595be` 已 accepted，模型请求累计 1。所见 Master 均离线，没有重发或创建任务。
- 仅向该助手发送 `stop`，收到 `CLEANUP stopped=true`、原根目录和 `modelRequests=1`；随后原 exec session 以 0 退出。检查旧安装目录 `%LOCALAPPDATA%\Rivloom\` 关联进程为 0，Worker 的 `app.lock` 已移除。不按程序名批量终止进程，不删除或复制业务数据，不运行安装/卸载器。
- 10:51:36.515Z 使用随包准备目录中的 Node 只读检查落盘记录：原 Node、授权 Project `c4227a2e-f93c-4514-ad67-f42c65fa749c`、Portable Project `05a8ef8f-d81d-4462-bdcf-29e922caaca2`、已验收业务 Task/原官方 session、两条新旧 Execution 均保留；信任、拓扑及执行策略文件仍存在。证据汇总 `.data/verification/m34-physical-stop-before-0.1.3.json`。
- 首次停后检查误断言数据库只有一个 Project，实际为 2；只读复查确认第二个是已验收 Portable Task 的既有本地 Project，而非本次停止新建。未改数据来满足断言。后续同目录恢复预检必须同时考虑一个已完成 Task 和两个 Project，不能套用原“零 Task / 单 Project”恢复限制，也不能默认新建身份。当前仅完成停止，不声称恢复支持或升级验收已完成。
- 5.33 已可由用户安装 0.1.3：允许“安装前卸载”，不勾选“删除应用程序数据”，保持原安装目录。升级后先核对正式客户端身份与任务，再准备原 Worker 同目录恢复；不重新配对或重发已验收 Task 掩盖历史。

### 升级完成后：保留历史恢复原 Worker（2026-09-02T10:56–11:07Z）

- 用户报告两个客户端均已打开并要求继续。5.33 的实际安装 runtime/桌面版本为 0.1.3，PID 10628/880、应用端口 57350、peer 64916；原 Node tRCQ1_、Brain 0ed79c 及 completed Task 45b70f73 / Execution 2414f24a 均保留。5.20 原 Node As64SU、peer 59725 仍可信/通道就绪，版本据用户更新反馈，不声称读取了远端 EXE。
- 仅测试助手新增严格已完成历史预检及启动后等值检查：原授权 Project、Portable Execution 目录、accepted Task/官方 session、归属及回传状态必须吻合；活动任务、待验收、待回传、非测试模型、未知/可重放邀请或路径变化均拒绝。原失败未绑定 Execution 44b41f60 保留且不补发。新增 13 项/全量 68 项通过，TypeScript/格式检查通过；不修改产品、不重建安装器。
- 11:03:53Z 用安装 0.1.3 恢复原 Worker：session 38378、helper PID 39992、Worker PID 25020；API `http://127.0.0.1:62388`、peer 53946、官方引擎 61627，全部高位。原 Node t9MUCF、两个 Project、已验收业务 Task 503ce474 / 官方 session ses_f9f184136ffexqtgBdYAJ7vpb4、新旧 Execution 全保留，未重新配对。本次新模型夹具为未释放状态，启动请求 0，不沿用上次 release 的内存状态。
- `m34-physical-upgrade-0.1.3.json`：11:05:17.600Z–11:06:47.708Z，90,090 ms / 87 次采样 / 19 次资源刷新 / 最大报告年龄 4,928 ms；原通道、空闲槽 1、旧 Task/session 和 completed 权威 Task 稳定，无新增业务执行。11:07:36.555Z 助手 `status` 确认模型请求仍 0。当前仍为单 Brain 三节点拓扑，原 Worker 保持运行等待下一步。

### 5.20 第二个独立 Master 助手：仅本机准备和验证

- 用户澄清“我现在就运行着”指的是原客户端窗口，没有额外助手。不能要求该原节点主动成为 Brain，也不能以新建身份覆盖原窗口；提供明确隔离助手模拟两个原本独立网络相遇。
- 包 `.data/distribution/Rivloom_M3.4_Master_Helper_0.1.3.zip`（13,488 字节）：解压后双击 `start-master.cmd`，调用安装的 0.1.3，在解压目录自己的 `.data/independent-master/<UUID>` 保存全部测试数据。先隔离发现自动形成，再不改 Node/Brain 接入标准网络；执行能力关闭，默认不配对、不建 Task、不验收。后续指令只针对原 Worker t9MUCF 和一条带本助手 run ID 的纯文字测试 Task；`offline`/`online` 仅控制自己的进程。
- 本机验证 Node `e8n8VINNZTlYseN-Bg1N7bP50vOLYCqc`、Brain `3c0057aa-7fda-4858-954b-1a261d3ad1cc`：11:12:05Z 首次加入端口 app 54195 / peer 55865；offline/online 后 app 61957 / peer 49761、同身份；11:13:21Z 通过实际 CMD 入口第二次启动，app 61093 / peer 55310、同身份。全程 Task 0、配对 0、本机模型请求 0；两轮正常停止，数据保留。这是 5.33 本机验证身份，不能作为 5.20 远端 Brain 证据。
- 压缩包只含 7 个代码/说明文件，已经枚举检查，无本机 `.data`、身份、凭据、会话数据库，不捆绑或修改 OpenCode。用户下一步需复制 zip 到 5.20 并完整解压启动，将 READY 行发回；当前尚未真实在 5.20 启动或执行新助手的配对/Task/验收命令，不提前计入双物理 Brain 验收。

### 5.20 独立助手实际出现，尚未配对（11:19:25.544Z）

- 用户回传 `READY Node=cS1v1puDjyxtdOvAjPeWZdLZljoapnCF Brain=b1292ebb-990a-48c0-8e6b-88b9adbe24b8`。通过原 Worker 的只读认证 API 发现完全相同的 Node 与 Brain，地址 `192.168.5.20:59263`、online=true，Brain 广告为 established。当前 trusted=false、channelReady=false，pairings 为空；这只证明新身份实际可发现，不是共享 Worker 或执行验收。
- 原 5.20 客户端 As64SU 和 5.33 Master tRCQ1_ 均继续受信且加密就绪；原 Worker 运行任务 0、槽位 1。未修改这些身份、信任、执行策略或 Task，未提交新的模型请求。
- 下一步仅让用户在新测试助手输入 `pair`，比较它输出的短码后由助手确认原 Worker 一侧。暂不配对两个 Master，也不提交新 Task。新 Master 与共享 Worker 的这条边完成后，才能继续两个正式 Brain 的目录与资源稳定检查。

### 两个物理 Master 配对与目录稳定通过（11:22–11:25Z）

- 用户发回短码，原 Worker 的 incoming 配对 `08e0e50c-a085-413b-89eb-3b6fe211895e` 身份/短码一致，新 Master 已确认且邀请未过期；11:22:18.740Z 确认原 Worker 侧后 trusted/channelReady 均为 true。只新增 cS1v1p–t9MUCF 这条边，未配对两个 Master、未改变原客户端信任。
- 用户提供的远端 STATUS（11:23:32.864Z）：0.1.3，Node cS1v1p / Brain b1292e，helper PID 7412、service PID 476、API 56092、peer 59263，原 Worker 在线受信且通道就绪，Task 0、本机模型请求 0。来源明确为用户控制台证据，未从 5.33 调用 5.20 的 loopback API。远端原测试根为 Desktop 下助手文件夹的 `.data/independent-master/361d6264-a313-471d-88e7-b8099341fddb`。
- 只读采样 11:23:42.574Z–11:25:13.570Z：**90,993 ms / 88 次 / 19 次资源更新通过**；最大 Master A 远端 Worker 报告年龄 4,990 ms。Worker 认证目录同时登记 Brain 0ed79c 和 b1292e，实际 Master 分别为 5.33 tRCQ1_ 与 5.20 cS1v1p，均 established/online，Worker 不承载自有 Brain；空闲槽 1、运行任务 0，两个 Master 未直接配对。
- 保留原 completed Task 45b70f73、accepted Worker Task 503ce474 和一个官方 session；两条原 Execution 不变，没有提交/验收任何新 Task。11:25:38.946Z 原助手 status 再确认本次模型请求 0。报告 `.data/verification/m34-physical-dual-brain-directory.json`，只计配对/目录稳定，不计双 Brain 执行、竞争、Project 或 Master 故障通过。
- 下一步让用户在 5.20 助手输入一次 `submit`，核对 Brain B 到 5.33 Worker 的真实跨机纯文字任务。模型夹具仍未释放；先观察分配/执行身份，再处理结果。竞争需要后续重叠提交的明确证据，不能用本次单 Task 冒充。

### Brain B 跨机纯文字任务完整闭环（12:06–12:17Z）

- 用户 12:06:55.171Z STATUS：Brain b1292ebb-990a-48c0-8e6b-88b9adbe24b8，Task 8923109f-6064-42fc-8276-72ba20821b3e，Execution 818ffb44-163d-4161-92d8-9267c0a85192，assigned/序号 0、Master 模型调用 0。5.33 Worker 实际已 running/序号 2，绑定唯一业务 Task 73a95c90-3053-4dcf-8e39-706bdf99768c 与官方 session ses_f9dfc2d61ffeHD55NRsJsKCiyb；本次夹具调用 1。
- 向原 Worker 助手 session 38378 发出 release 后，12:08:44.007Z Worker review/序号 3、deliveryPending=false、deliveryError=null，槽位仍 0。Task 的 Portable Project 545085d1-dbd5-4921-a1fb-a9e69dc92aaf 路径精确对应 worker/portable-tasks/818ffb44-163d-4161-92d8-9267c0a85192；目录为空、官方 session 数据库工具 part 为 0。仅使用隔离夹具，不访问外部模型或用户文件，不建立文件快照/哈希。
- 用户随后按指引输入 accept，12:12:18.422Z 即时 STATUS 仍 review/序号 3。12:13:48.766Z 经 Worker 认证 API 核对已 accepted/序号 4，无 pending control/delivery/error；Worker 与 Master A 槽位均为 1。旧 completed Task 45b70f73、accepted 业务 Task 503ce474 与旧官方 session 保留；Master A 没有持有 B 的 Task。共 3 Project、2 accepted 业务 Task、2 官方 session、3 Execution，未重复创建。
- 12:14:14.405Z helper status 再确认模型调用仍 1。初次只读汇总误用了 network.localWorker（真实字段为 network.local.worker）而失败，修正检查后通过，没有修改业务数据。用户 12:16:56.146Z 最终 STATUS 确认同一 Brain/Task/Execution 已 completed/序号 4、Master 本机模型调用仍 0；此项跨机文字任务闭环通过。报告 `.data/verification/m34-physical-brain-b-task-8923109f.json`。
- 原 Worker、两个 Master 及两个原桌面保持运行。夹具当前已经释放，对该进程后续请求立即回复；后面的竞争/故障检查须另行明确准备可控暂停，不能沿用“未 release”假设。此轮没有产品或测试代码变更，不需重新安装；单条跨机执行不替代同时竞争、Project 固定或 Master 离线/恢复验收。
- 下一检查点：用户只在 5.20 隔离助手输入 offline，保留控制台和原桌面；核对 Brain B 的 Master 离线、Worker 保留两 Brain 注册但仅 A 可调度，随后经 A 提交原授权 Project 的纯文字 Task，验证另一 Brain 可继续工作且不接管 B Task，再由用户 online 核对 B 原身份/Task/Execution 不变。本步骤尚未执行，只测试正常停止，不冒称异常断网、自动故障切换或执行中副作用恢复。

### 远端 Master B 正常离线，Brain A 的原 Project 执行（12:22–12:26Z）

- 用户 12:22:11.852Z 从原 5.20 助手返回 offline STATUS，online=false、apiURL=null、Master 模型调用 0。助手在 offline 时直接输出 tasks=[]，不能据此宣称任务丢失；后续 online 需核对原 completed B Task。没有关闭用户原桌面或删除数据。
- 12:24:00.678Z 本机 Worker/Master A 认证 API 确认 B offline、Master cS1v1p 不变，A 在线，两个原客户端通道正常；Worker 不承载 Brain、槽位 1，两条 accepted 业务 Task 与三条旧 Execution 保留。原授权 Project c4227a2e 仍为准确 `worker/authorized-folder`、空文件夹；初次诊断误将路径写到外层根，经 helper 源码核对后修正断言，不改变 Project 或目录。
- 12:25:20.041Z 只通过 A 的真实应用 API 提交一次限定 Project 纯文字 Task 0119d3eb-3cc1-47cc-9a3d-224943ae7316 / Execution 478658f7-04b7-4ed6-9e1d-540121885bb9。12:25:23.171Z 第 4 次采样 review/序号 3，唯一业务 Task 455eefc8-44bf-4bc3-8f6e-ba44d8c4d875 / 官方 session ses_f9deb4729ffejtK9Y451ujwmL7，确实在原 Project c4227a2e-f93c-4514-ad67-f42c65fa749c 执行，没有另建 Portable Project。期间 B 保持离线，不接管其旧 Task、不改归属、不重复旧 Execution。
- Worker/Master A 槽位均 0；共 3 Project、3 业务 Task、3 官方 session、4 Execution。官方数据库 0 工具 part、授权文件夹仍空，返回确定性短文字，无异常/审批/问题；12:25:59.704Z 本次模型累计 2，比前一 B Task 后仅增加 1。报告 `.data/verification/m34-physical-master-offline-project-0119d3eb.json`。
- 当前保留新 Project Task review，占槽待恢复测试；已请用户在原助手输入 online，检查原 Node/Brain/Task/Execution/信任恢复，之后再通过 owning Master A 验收释放槽位。本步恢复尚未完成。A 与 Worker 均在 5.33，仅离线 Master 在 5.20；不扩大为新的跨机 Project 执行、同名 Project 拒绝负例、异常断网或物理同时竞争。本轮未改产品/测试代码、未重装。

### 原 Master B 同身份恢复，Project Task 完成验收（12:31–12:34Z）

- 用户原助手执行 online 后，12:31:12.566Z STATUS 确认 Node cS1v1p / Brain b1292e / 原数据根不变；旧 Task 8923109f / Execution 818ffb44 仍 completed/序号 4、本机模型调用 0。helper PID 7412 保持，新 service PID 9824，loopback app 61533、peer 59845。即时 Worker trusted=true、channelReady=false；12:31:46.700Z Worker 认证 API 已见同一 Node 在 192.168.5.20:59845 在线/受信/通道就绪，不重配对。没有独立测量精确通道恢复时延。
- 12:32:43.641Z–12:33:04.292Z，20,651 ms、21 次采样、6 次资源刷新通过，Master A 报告最大年龄 4,913 ms。恢复后的 B 保持原 Master/Brain，原各通道正常；Project Task 0119d3eb 始终 review/序号 3、Worker 槽位 0。Worker 不承载新 Brain，A 不接管 B Task，旧 Task/Execution 状态归属和 3 个官方 session 保留、无重复执行。
- 12:33:58.361Z 通过 owning Master A 验收这条明确隔离的确定性文字 Project Task；12:33:59.470Z 已 Master completed/Worker accepted/序号 4，槽位 1，无待回传/控制/错误。3 个业务 Task 均 accepted，旧官方 session 保留，0 工具 part、原授权文件夹仍空。12:34:19.497Z 原 Worker helper 本次累计模型请求仍 2。报告 `.data/verification/m34-physical-master-offline-project-0119d3eb.json` 已补齐此闭环。
- 原 Worker 和两个 Master/两个原桌面继续运行。正常离线/同身份恢复与指定 Project 验收通过；A/Worker 在同一物理机，不扩大为新的跨机执行或异常断网恢复，也未覆盖 B 离线时存在排队 Task 的物理恢复。仍需真正重叠分配的双 Brain 单槽竞争；当前远端 helper submit 只去重保留旧 Task，不能要求用户再次 submit 冒充第二条竞争任务。下一步先准备可控协调方式，不通过改业务记录/拓扑/资源报告或扩大产品范围构造结果。本轮只更新证据/文档，不改产品或测试源码、不重装。

### 同步竞争助手 v1 已本机验证，待远端更新（12:40–12:59Z）

- 用户要求继续。仅测试工具新增一次性 UUID/规范 UTC 定时提交、持久化 claim、防重复与不确定结果不重试；B 原任务和 race Task 分开，offline/online 可保留二者；A 控制台只附着原桌面，不控制其生命周期。没有新的网络监听或产品代码变更。具体步骤/失败事实见 [新计划](2026-09-02-m34-physical-race-helper.md) 和 `.data/verification/m34-physical-race-helper-preparation.json`。
- 14 项定向、正常 Windows 用户上下文全量 82/82、TypeScript/格式通过。新控制器实际同机定时竞争的完整服务 11 项通过，90,068 ms/166 次稳定，唯一执行和原队列恢复、无工具；仅本机。沙箱 DPAPI 失败证据保留，未绕过保护。CMD 启动期读取指令问题已修并用旧烟雾身份复验正常退出，所有本机临时服务停止。
- 包 `.data/distribution/Rivloom_M3.4_Master_Helper_0.1.3_race-v1.zip`，18,870 字节、8 个代码/说明文件，无 `.data`/身份/凭据/DB。用户下一步只在 5.20 原助手 stop 等 CLEANUP，原文件夹覆盖代码保留 .data，再 start-master.cmd，回传原 cS1v1p/b1292e 且 raceHelperVersion=1 的 STATUS。不要重新配对、不要先 arm、不要给原 Rivloom 重装。
- 12:58:49.652Z 原物理 Worker 仍 3 accepted Task/session、槽 1、夹具已释放/模型累计 2，无新物理 Task。收到远端更新后再启动 A 控制台（交互 stdin），给两个控制台同一新 UUID/未来 UTC；是否成立以实际两个 Brain 的权威 Task、单槽准入与排队证据为准，命令时间不算通过。提前/迟到或一边未创建 Task 时保留现场，不自动补发。
- 13:02–13:05Z 远端回传的是新 race-v1 文件夹生成的 Node Ytmgnp/Brain 024a07；不是原 cS1v1p/b1292e。Worker 确认未信任/未配对，原 B 离线、3 accepted Task/槽位 1 保留。暂停 arm，要求仅停止新助手，把同一个 zip 代码解压到原 0.1.3 助手目录、保留旧 .data（绝不复制新 .data 覆盖），再从旧目录启动核对。如旧数据缺失先核对，不默认建立替代身份；这不计保留身份更新通过。
- 用户随后确认旧助手文件夹误删。先核对回收站可否恢复原目录及 .data，暂不配对或 arm 新身份；未确认永久丢失。无法恢复时需用户确认新独立 Brain 续测，旧通过事实/Worker 记录保留，不迁移旧 Task、不声称原身份恢复。当前仍停在物理竞争开始前，不要求重新安装正式 Rivloom。

### 新 Brain 续测获用户确认（13:14Z）

- 用户确认回收站没有旧目录，明确授权使用新助手 YtmgnpZtwNcSWpdPvAWuhf3IREFuNfEt / Brain 024a0766-64db-4419-a4cc-7b0d53688927；不再要求恢复旧目录，既有 race-v1 包和新 .data 继续使用。旧 Task/证据保留、不改归属，不算同身份恢复。
- 13:14:19.080Z API 和 13:14:38.923Z Worker status：新 B 位于 5.20:63344，在线未信任/无配对。原 Worker 仍 3 accepted Task/session、槽位 1、模型累计 2；A 的两条旧权威 Task completed。已请用户新助手 pair 并发短码，未确认 Worker 一侧、未发新 Task。
- 当前 A 与 Worker 互不在 nearby 列表，但二者各自到 5.20 原桌面均 trusted/channelReady；继续只读诊断，不以此前目录稳定报告覆盖此现状，不擅自重启或修改信任。物理同步竞争等待全部通道前提满足。

### 新助手退出后残留锁与恢复（13:30–13:51Z）

- 新 B 发出短码后退出，再启动触发 helper 的 app.lock 存在断言。对应请求只由 B 确认，Worker 未确认；旧 peer 63344 拒绝连接，正式桌面保持正常。用户确认窗口和后台助手已关，按只重命名 app.lock、保留 .data 的指引恢复；没有产品/助手代码改动或重装。
- 用户 13:51:12.699Z STATUS：原新 B Node Ytmgnp/Brain 024a07 和 race-v1 数据根保留，helper/service PID 3852/2628、app/peer 58225/56585、Task/model 0。13:51:35.700Z Worker 侧实查新 B 在线未信任，无待配对；旧 3 accepted Task/session、槽位 1、A 两条 completed 保持。未独立核对远端重命名文件，恢复结论依据 STATUS 与 Worker API。
- 已请用户当前窗口重新 pair 并发新短码，保持窗口打开、不重复启动；旧短码已过期不可复用。A↔Worker 互不可见仍待处理，未 arm/提交新物理任务。

### 新 B 配对通过，本机通道仍待恢复（14:04–14:08Z）

- 用户新码与当前请求和 Ytmgnp/Brain 024a07 匹配，14:04:51.380Z Worker 经正常确认接口完成配对；14:04:54.157Z 双向认证通道就绪，Brain established/online、共享 Worker 注册/槽位 1。旧 3 accepted Task/会话保留；14:08:01.852Z helper 模型累计 2，无新 Task。
- 本机 A↔Worker 仍互不可见。6 秒正常用户上下文的 mDNS 查询只收到 5.20 两实例；未发布测试身份、未变更系统设置，根因尚未确认。已申请仅正常停止/原目录恢复一次隔离测试 Worker，不触碰正式客户端或旧记录；用户“测试 Worke”回复未视为明确批准，已解释并等待确认。未执行重启，未开始同步竞争。

### 用户授权 Worker 重启并恢复共享拓扑（14:12–14:16Z）

- 用户明确“你按你要测试的来”。14:12:01.753Z 确认原 Worker 3 accepted Task/3 session/4 Execution/3 Project、0 活动任务、6 信任和 A 两条 completed；正常 stop 原 session 38378，CLEANUP/退出 0，14:12:32.380Z 锁自然释放且恢复预检全部一致。
- 14:13:06.419Z 同根同 Node 恢复为 session 67853、helper/service 11212/39764、app/peer/engine 64758/54356/51071，A 和新 B 通道恢复。新夹具请求从 0 计，旧生命周期累计 2 保留，尚未 release；未重启两台正式桌面。
- 14:14:13.505Z–14:15:43.516Z：90,011 ms/87 次采样/18 次资源更新、最大年龄 4,957 ms 全通过，原身份/互信/任务/会话/执行绑定不变，三条 Worker 通道及 A 所见 Worker 正常、两个正式 Brain 共享原 Worker。报告 `m34-physical-worker-discovery-restart.json`；恢复不能代表原发现异常根因已经修复。
- A 控制台 session 97010 于 14:16:32.241Z arm race `2b08e84d-1a63-4f1c-953a-8ace7aa55c81`，UTC `2026-09-02T14:21:18.535Z`；用户已收到 B 同命令，待 RACE_ARMED。记录 `m34-physical-race-2b08e84d.json`，当前未触发或计竞争通过；夹具暂缓回复直到实际检查重叠任务/唯一会话。
- 本轮最终未完成同步：未收到 B RACE_ARMED，14:21:02.983Z 触发前取消 A 定时，未 dispatch/建 Task。至 14:21:48.573Z 的 178 次只读观察无 Worker 新邀请/Task/session，旧记录和槽位 1、两条 Master 通道正常。已告知用户旧 arm 不再使用，B 已安排则取消未触发定时、已触发则回传状态不重试。B 实际 ledger 未读取，需先让用户只输入 race-status，再决定新的协调窗口；不能把本轮计成竞争通过或自动重复提交。
- 用户 14:32:46.504Z 回传 B races=[]；14:33:44.475Z 再检旧历史、官方会话、两条 Master 通道和槽位 1 均正常，旧轮未产生执行。新轮 dbc4738a 的 UTC 为 14:42:44.641Z，最终回复先交 B arm 命令，取得 B 回执且时间仍有效后才 arm A，避免在无回执时预先安排本机一侧。A 目前未 arm；过期或单边已触发先检查实际记录，不追发。
