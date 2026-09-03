# ADR-0004：自动 Brain master 与共享 Worker 调度

## 状态

已接受，M3.4 按本文实施。产品负责人于 2026-09-02 逐项确认本文的 Brain、Node、Project、Task、模型和算力边界。

2026-09-03实施结项：0.1.3在真实5.20/5.33完成自动接入、双独立Brain共享Worker、资源/通道稳定、跨机文字任务、指定Project和正常Master离线/同身份恢复，以及单槽竞争、review占槽、原Task排队续跑和各自验收。最终两Brain任务completed、5accepted业务Task/5官方session/7Execution/夹具2次/0工具/槽1，原记录保留。用户收到该结果及mDNS专项限制后回复“好，下一步吧”，据此按本文当前MVP范围结项。架构决策和非目标不变；纯mDNS92/93专项仍待查，不宣称全量绿色、异常断网/HA通过或新真实AI编程验收。详见 [里程碑](../MILESTONES.md) 和 [验证记录](../VERIFICATION.md)。

2026-09-02历史实现记录：独立 Brain 拓扑、旧 Brain 迁移、临时 Brain 收敛/撤回、共享 Worker 加密目录、真实硬件/动态负载、两跳 Task、独立 Execution 历史、最终准入、Portable 普通目录和桌面界面已完成。安全重调度仅处理能证明未启动的尝试，当前 Execution ID 隔离旧状态，迟到接受确认不能启动旧任务。32 项自动回归与 7 项完整业务服务检查通过，两个 Brain 竞争只产生一个业务 Task 和官方 OpenCode 会话；网络故障注入及最终 Release WebView2 表单到远端 Master/共享 Worker/结果回传的闭环也已通过。服务和 Release 均完成 90 秒通道/资源稳定性检查；模型仅为本机确定性夹具。当时物理核心拓扑验收未完成，现已按上段补齐。

本文取代 [ADR-0001](0001-self-discovering-brain-network.md) 中“每个节点提供一个默认 Brain”“Brain A 委派 Brain B”和 M3.4 跨 Brain 任务委派的旧假设。ADR-0001 的节点身份、自发现、设备信任、加密通道以及 OpenCode 只在执行节点内部运行的决策继续有效。[ADR-0002](0002-configurable-node-invocation-policy.md) 与 [ADR-0003](0003-trust-and-ai-approval.md) 的本机执行能力和 AI 审批边界也继续有效。

2026-09-02 新身份检查的诊断修正：5.20 与 Worker 配对后仍 provisional、调度候选为 0，这一事实保留；但不能直接推导其应该自动成为第二个正式 Brain。用户删除数据后，原“两台已有正式 Brain”的前置条件已不存在；5.20 发现现有 Brain，却尚未信任实际 Master 5.33，只信任不承载 Brain 的 Worker。随后与实际 Master 配对，5.20 已自动撤回临时 Brain并接入既有 Brain，90.6 秒物理稳定检查通过，无需产品修改。这验证了本 ADR 的新节点接入规则，不能替代双独立 Brain 验收。任意发现/历史广告参与阻塞的代码路径确已复现，但等待边界、提示和无可用 Master 时的行为仍需单独覆盖；尚不据此更改产品规则。详见物理验收记录末节。

## 背景

历史验证补充（2026-09-02）：新节点接入后，5.20 → 5.33 Master → 同机独立 Worker 的 Portable 文字任务已完成后台执行、回传、所属 Master 验收及槽位释放；单次 Task/Execution/官方会话、0 工具调用。用户已确认 5.20 显示“已验收”，当时仅本条闭环通过；后续双独立Brain/竞争/正常Master停止已补齐，见状态节。单条或本机确定性模型结果不扩大为真实AI编程测试。

Rivloom 已经具备受信节点发现、加密通道和单任务跨节点执行闭环。早期设计仍把 Brain 近似绑定到安装实例，并以“归属 Brain 向目标 Brain 委派任务”解释多 Brain。这无法回答分散网络中的目录查询、节点负载调度、同一节点服务多个 master，以及 Brain master 未来高可用时的脑裂问题。

M3.4 需要先验证更小的控制面模型：网络中允许一个或多个独立 Brain/master；Node 自动注册为这些 Brain 的共享 Worker；每个 Brain 只管理自己的任务；Node 对本地 Project、模型和算力保留最终准入权。当前不引入人员身份、跨 Brain 共同任务或同一 Brain 的多活动 master。

## 术语

- **Brain**：分散节点网络中的逻辑 master 和调度域。它维护自己的 Worker 目录、任务队列、权威任务状态和执行事件，但不直接运行 OpenCode。
- **Master Host**：当前实际承载某个 Brain 控制面的 Node。Brain ID 与 Master Host 的 Node ID 分离。
- **Worker**：向一个或多个 Brain 自动登记能力、可接受执行分配的 Node。
- **Project**：某个 Node 明确授权给 Rivloom 的一个本地普通文件夹资源。同名文件夹不会自动被视为同一个 Project。
- **Task**：由一个 Brain 持有的稳定工作记录。
- **Execution**：某个 Worker 对 Task 的一次具体执行尝试。同一 Task 同时最多有一个活动 Execution。
- **Portable Task**：不绑定已有 Project、可由不同 Worker 在本机临时工作目录执行的 Task。
- **Project Task**：绑定一个具体本地 Project、只能在提供该 Project 的 Node 执行的 Task。

## 决策

### 1. Brain 是自动形成的逻辑 master，不是用户创建的工作区

Rivloom 不提供“创建 Brain”“我要成为 Brain”或手工选择 master 的产品流程。

- 网络中没有可用 Brain 时，第一个 Node 自动形成一个 Brain 并成为初始 Master Host。
- 新 Node 发现已有 Brain 时，不再永久创建自己的 Brain；它自动成为可达 Brain 的 Worker 和未来 Master Host 候选。
- 为保证单机立即可用，Node 可以先产生尚无正式任务的临时 bootstrap 状态；发现已有 Brain 后可以放弃该临时状态。已经持有任务或历史的正式 Brain 不自动删除、合并或拆分。
- 两个原本独立的网络后来相遇时，各自已经形成的 Brain 都保留，Node 可以同时服务它们。
- 现有版本中已经生成的默认 Brain 迁移为正式 Brain，不丢弃已有任务或协议记录。

Brain 数量和 Brain ID 在 M3.4 中保持稳定。系统不根据负载自动创建、拆分或合并 Brain。

远端 Master 的认证目录不再声明某个 provisional Brain 时，清理该 Master 已撤回的临时登记，防止其他节点继续显示幽灵 Brain。此规则不删除正式 Brain 历史，也不依据未认证的发现广播撤回 Brain。

### 2. M3.4 固定活动 Master Host，高可用只保留架构入口

完整架构允许一个 Brain 由一个活动 Master Host 和若干候选或备用 Host 承载，并在未来重新选主。M3.4 不实现状态复制、自动选主、Master 任期 fencing、脑裂检测或活动 Master 迁移。这里延后的 Master fencing 不等于本里程碑已经实现的 Worker Execution ID fencing。

当前行为是：

- 初始 Master Host 在 M3.4 生命周期内保持固定；
- 新 Node 加入只重新形成 Worker 目录，不迁移 Master；
- Master Host 离线时，该 Brain 暂停接收新 Task 和分配新 Execution；
- 已经运行的 Execution 可以继续，Worker 在本机保留待回传结果，等待原 Master 恢复；
- 另一 Brain 不自动接管该 Brain 的 Task。

### 3. Worker 自动服务所有受信且可达的 Brain

Node 不排他地属于某个 Brain。设备配对仍建立通信信任；在受信加密通道就绪且本机执行能力开启后，Node 自动向所有可达 Brain 登记为 Worker，不要求用户逐 Brain 点击加入。

同一 Node 可以同时：

- 承载零个、一个或多个 Brain 的控制面；
- 作为一个或多个 Brain 的 Worker；
- 为多个 Brain 运行互相独立的 Task。

多个 Brain 可能同时选择同一 Worker。Brain 的负载信息只是调度快照，Node 必须在启动前进行原子最终准入，并按本机全局并发限制接受或拒绝。短期内部占用只用于避免竞态，不恢复旧版需要人操作的 30 分钟准备租约。

最终准入覆盖远端分配和本地手动启动，不能从本地工作台绕过。运行、待验收、未知状态以及已为远端分配保留的 ready 任务都占用槽位，资源报告使用相同判定。M3.4 Execution 携带 `brainTaskID`；旧 M3.3 直接邀请不携带，保留原有接收后按本机策略等待的兼容行为。

### 4. Project 是 Node 本地资源

Project 是一个 Node 本机可访问并显式开放的普通文件夹。真实路径只留在本机；Brain 只保存 Project ID、显示名称、提供 Node、可用状态和必要的调度能力。

- 不要求 Git，不自动初始化 Git；
- 不扫描文件夹建立快照，不计算内容哈希；
- 不根据名称、内容或路径推断两个 Node 上的 Project 等价；
- 同一个本地 Project 可以被本机开放给多个 Brain；
- Project Task 不能因原 Node 忙碌而自动迁移到另一个同名文件夹。

逻辑项目、多节点副本和同步一致性属于后续设计。

### 5. 模型与额度完全由执行 Node 自治

模型配置、供应商凭据、额度判断、模型选择和模型并发全部由执行 Node 本地管理。Brain 不维护模型资源池，也不要求接收具体模型名称、供应商账号、余额或用量。

Brain 只看到 Node 综合后的执行状态。Node 在收到候选分配后，根据本机 Project、模型、额度和并发再次判断是否接受。模型不可用或额度不足时，Node 返回暂不可执行；Brain 不推测供应商余额，也不跨 Node 代理模型凭据。

OpenCode 继续只在实际执行 Node 本机监听 loopback；Rivloom 不修改或 fork OpenCode。

### 6. 硬件档案和实时负载向 Brain 注册

为支持有效调度，Worker 通过认证加密通道向 Brain 登记：

- 静态档案：操作系统、架构、CPU 型号与核心数、总内存、GPU 型号/数量/显存、本地磁盘容量和执行能力；
- 动态负载：CPU 使用率、可用内存、GPU 使用率与可用显存、可用磁盘、正在执行的任务数、可用执行槽和采样时间。

不登记硬件序列号、MAC、用户名、本地绝对路径、模型凭据或供应商账号。硬件报告用于调度而非安全证明；Node 仍拥有最终准入权。

Task 可以携带可选结构化硬件要求，例如操作系统、最低内存、CPU 核数、GPU 与最低显存。Brain 先按 Project 和硬条件过滤 Worker，再按实时负载、剩余执行槽和稳定 ID 评分选择。

Windows 上无法可靠确定的显存必须标为未知，不把 `Win32_VideoController.AdapterRAM` 的 32 位值当作现代 GPU 的实际显存。当前 NVIDIA 使用本机 `nvidia-smi` 可确认值；GPU 动态采样异步执行，避免阻塞节点心跳。

成功的认证目录往返也是在线证据；发现组播过期不能覆盖仍新鲜的认证通信。发现查询、hello、控制握手和加密消息按实际来源 IP 分别限流，避免共享 Worker 的正常多节点流量耗尽同一预算。各类请求在认证前仍受限，认证、消息大小、序号和路由校验不放宽。这是可用性修正，不是高可用选主。

### 7. Task 与 Execution 分离

Task 是稳定记录；Worker 中断、拒绝或重试时创建新的 Execution，不复制 Task。同一 Task 同时最多有一个活动 Execution。

- Project Task 指向一个具体 Project，只能在该 Project 的提供 Node 上执行；Node 忙碌或离线时等待。
- Portable Task 不绑定已有 Project，可以在满足硬件要求的 Worker 间重新调度，并使用 Worker 的本机临时工作目录。
- Task 不保存 API Key、模型额度、CPU/GPU 实例、本地绝对路径或 OpenCode 通用接口。

每次分配都会在 Task 中追加一条带尝试号、Execution ID、Worker ID、状态和序号的历史。只有 Master 可以证明旧 Execution 尚未启动时才允许自动新建下一次尝试：Worker 明确拒绝、邀请自然过期，或 Worker 离线时 Master 记录仍为 `pending`。重试优先换另一个合格 Worker；原 Worker 采用 30 秒起、最高 5 分钟的指数冷却，最多 8 次自动尝试。已经接受但尚未收到执行状态的 Worker 离线时，系统保持等待，不以重派换取潜在的重复副作用。

Worker 必须收到 Master 对接受回执的成功确认，且没有待发送状态或拒绝错误，才可绑定业务任务并启动。Master 已取消/过期的 Execution 收到迟到接受时返回冲突，不能以“没有状态变化”返回成功。已接受但结果未知的 M3.4 Execution 不允许按未启动邀请取消；离线显示等待，不自动重派。上述窗口已用独立节点停止/重启与取消包丢失注入验证。

2026-09-02 物理回归补充：Worker 的 `decidedAt/statusAt` 与 Master 的 `createdAt` 来自不同机器，不能用严格的墙上时钟先后证明消息有效性。0.1.2 沿用现有协议的 60 秒时差容限，将接受回执、执行准备及状态回传的创建时间下界设为 `createdAt - 60 s`，未来时间上界仍保留。首次接受必须在 Master 本机邀请期限内，即使过期扫描尚未运行也拒绝；已成功接受的同一回执仍可幂等重试，不因邀请期限后来过去而撤销。取消消息与创建时间来自同一 Master，不放宽其下界。

容差只解决正常时差，不决定 Execution 是否仍有效：认证、路由、幂等键、取消/过期状态、当前 Execution ID 和单调序号均不放宽。代价是仍不支持任意时钟偏差，也不处理系统时钟大幅跳变；不新增 NTP/时间同步或高可用机制，不以用户手工同步到毫秒作为运行前提。新增测试用隔离进程时间注入，不修改操作系统或官方 OpenCode。

多个 Brain 可达时，提交 Node 根据 Brain 在线状态、队列长度、匹配 Worker 数量、执行槽和网络状态自动选择一个 Brain。选择结果在首次发送前持久化；Brain 接收后 Task 归属保持固定，不因超时或负载自动迁移到另一个 Brain。

### 8. M3.4 的多 Brain 协同只共享 Worker

M3.4 不实现 Brain A 向 Brain B 委派任务，也不实现多个 Brain 共同持有一个 Task。

- 每个 Brain 拥有自己的 Task 和事件状态；
- 多个 Brain 通过自动注册到它们的同一 Worker 共享执行资源；
- Worker 在本机统一仲裁来自不同 Brain 的 Execution；
- Brain 之间不共写数据库、不传递 Task、不共同审批或验收。

人员身份、一人多节点、一节点多人、企业角色、跨 Brain 任务协议和共同任务治理已经讨论但明确不进入 M3.4。

### 9. 个人与企业复用同一个最小模型

个人版和未来企业版不使用两套 Brain/Node/Task 概念。两者都由相同的最小关系组成：一个或多个 Brain 持有 Task；一个或多个 Node 承载 Master 或共享 Worker；Project、模型和算力由执行 Node 自治。

- 个人场景通常是一个 Brain 和少量个人设备，也允许已有的多个独立 Brain 共用一台 Worker。
- 企业场景可以是多个业务 Brain 和一组共享执行 Node；M3.4 不因为“企业”而增加全局总 master、跨 Brain 公共 Task 或统一模型密钥池。
- 未来企业需要的组织身份、角色、策略、审计、计费和隔离是在同一最小拓扑之上的治理层，不改变 Brain、Node、Task、Project、模型和算力的基本归属。
- M3.4 暂不把当前本机 owner/user 账号映射为网络中的“人”，也不由设备信任推导企业权限。

## M3.4 最小闭环

1. 启动两个持有不同正式 Brain 的独立 Master Host，再启动或连接一个共享 Worker。
2. 三个 Node 完成现有发现、设备信任和加密通道；不出现创建或加入 Brain 的产品操作。
3. Worker 自动注册到两个 Brain，并向两者上报静态硬件与动态负载；模型、凭据和本地路径不离开 Worker。
4. 两个 Brain 各自创建一个只属于自己的 Task，并根据 Task 要求和 Worker 负载自动选择执行 Node。
5. Worker 对来自两个 Brain 的分配执行本机全局准入；同一执行槽不会被两个 Brain 重复占用。
6. Project Task 只在持有指定 Project 的 Node 执行；Portable Task 可以在合格 Worker 间重新选择。
7. 每个 Task 只产生一个活动 Execution，重复消息不重复执行；状态和结果只回到该 Task 的 Brain。
8. 关闭一个 Brain 的 Master Host 后，另一个 Brain 继续调度；离线 Brain 的新任务暂停且不会被另一 Brain 接管。

## M3.4 验收标准

- **自动形成**：无 Brain 环境自动形成一个 Brain；发现已有 Brain 的空白新 Node 不永久形成额外 Brain。
- **两个独立 master**：两个正式 Brain 同时在线，Brain ID、任务队列和权威状态互相独立。
- **共享 Worker**：同一真实或完全隔离的独立 Worker 自动出现在两个 Brain 的目录中，无逐 Brain 加入操作。
- **资源报告**：两个 Brain 都收到签名加密的静态硬件档案和更新中的动态负载；报告不含项目路径、模型、凭据、硬件序列号或 MAC。
- **约束调度**：不满足 OS、内存或 GPU 硬要求的 Worker 不入选；无硬要求时优先选择有执行槽且负载更低的 Worker。
- **Project 边界**：Project Task 只在声明该 Project 的 Node 执行，同名目录不被当作副本；不使用 Git、文件快照或哈希。
- **Node 最终准入**：两个 Brain 竞争同一 Worker 时，本机全局并发限制有效，拒绝或等待不会产生第二个活动 Execution。
- **Task 隔离**：Task 只属于初选 Brain，不跨 Brain 复制、迁移或共同写入；两个 Brain 的状态和控制不能串线。
- **正常时差**：接受和状态回传允许协议已有的有界时差；时差容限不得复活取消/过期或被替换的 Execution，不得破坏状态序号去重。物理验收前须通过正负时差回归。
- **故障边界**：一个 Master Host 停止后，其 Brain 暂停新调度，另一 Brain 继续工作；M3.4 不声称完成自动选主或脑裂处理。
- **引擎边界**：真实执行继续使用官方未修改的 OpenCode；OpenCode 和业务 Web API 不暴露到局域网。
- **实际界面**：Release WebView2 能显示 Brain/master、共享 Worker、硬件/负载、调度选择与任务归属，不把两个前端视角或同一数据库冒充多个 Brain。

## 非功能要求和失败处理

| 情况                           | M3.4 行为                                                                |
| ------------------------------ | ------------------------------------------------------------------------ |
| 硬件/负载报告过期              | Worker 降级为不可调度，恢复新报告后重新参与                              |
| 两个 Brain 同时分配同一槽位    | Node 在全局串行准入区内接受一个；另一项明确拒绝并等待或重选              |
| Portable Task 的候选 Node 拒绝 | 保持同一 Task ID 和归属 Brain，追加历史并创建下一 Execution              |
| Project Task 的 Node 离线      | Task 等待该 Node，不猜测同名 Project 等价                                |
| Master Host 离线               | 该 Brain 暂停；不自动接管、不跨 Brain 迁移                               |
| Worker 离线                    | 未接受邀请可安全取消并重调度；已接受或已运行则等待，已有副作用不自动回滚 |
| 重复或延迟消息                 | Brain ID、Task ID、尝试号、当前 Execution ID、序号和幂等键共同去重       |
| 受信 Worker 提供错误硬件信息   | 可能调度失败，但不能借此取得其他 Node 的凭据或路径                       |

## 影响

### 正面

- Brain 成为明确的控制面和调度域，不再等同于设备或 AI Agent。
- 多个独立 Brain 可以共享 Worker，而不需要跨 Brain 任务所有权或多主数据库。
- Master 根据真实硬件和实时负载调度，Node 仍控制本地项目、模型、额度与并发。
- 个人节点网络和未来企业节点网络可以复用同一调度协议。

### 代价

- Brain 目录需要保存 Worker 注册、硬件档案、动态负载和任务归属。
- 自动 Task 选 Brain、Brain 选 Worker与 Node 最终准入形成两级调度，需要明确幂等和过期语义。
- Master Host 仍是单点；当前只明确暂停，不提供高可用承诺。

### 中性

- 现有每实例 Brain ID 需要迁移为“已形成的正式 Brain”，但不再代表 Node 与 Brain 永久一一对应。
- M3.3 的审批、补充、停止、官方差异和验收通道继续复用，路由术语需要从“目标 Brain”改成“归属 Brain 的 Worker Execution”。

## 未采用方案

- **用户点击创建或加入 Brain**：Brain 是自动控制面，不是协作空间产品对象。
- **每个 Node 永久一个 Brain**：会把控制面身份绑定设备，无法表达共享 Worker 或未来 Master 迁移。
- **按负载自动拆分或合并 Brain**：需要控制面分片、Task 迁移和跨 Brain 一致性，当前 Worker 调度已足够。
- **M3.4 直接实现 Master 高可用**：状态复制、选主、Master 任期 fencing 和脑裂超出本切片。
- **Brain A 委派 Brain B**：引入跨 Brain 任务授权和所有权，且当前没有人员身份模型。
- **Master 管理模型额度**：供应商能力不一致并扩大凭据边界；Node 自治更符合当前实现。
- **根据同名目录自动迁移 Project Task**：没有可靠一致性依据，也违反不使用 Git、快照和哈希的约束。

## 参考

- [里程碑基线](../MILESTONES.md)
- [实施进度](../PROGRESS.md)
- [验证报告](../VERIFICATION.md)
- [ADR-0001](0001-self-discovering-brain-network.md)
- [ADR-0002](0002-configurable-node-invocation-policy.md)
- [ADR-0003](0003-trust-and-ai-approval.md)
