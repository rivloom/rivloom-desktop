# 实施进度

更新日期：2026-09-03。

当前里程碑以 [里程碑基线](MILESTONES.md) 为准；长期细节见 [Rivloom MVP 实施计划](plans/2026-08-31-mvp-delivery.md)。

## 当前停点

2026-09-03 保存交接：用户指定下一会话修改界面，本会话归档现有 M3.4 实现、修复、测试和文档并作本地 Git 提交，不推送、不创建分支或修改产品代码。新增 UI-HANDOFF，更新 README/HANDOFF/里程碑/长期计划的当前入口；下方任务编排建议不再是下一步，也未获采纳。保存前构建通过、59 项定向测试通过、两个 PowerShell 脚本语法解析通过，详细命令见 VERIFICATION。纯 mDNS 全量 92/93 及单独失败保留，本轮不重跑物理/安装/真实模型；原节点与数据不动。新会话以当前 Git HEAD 为基线，f5ce9ed 仅为本轮开发起点；不要使用下方历史 PID、命令或等待指令继续旧测试。

以下为历史检查点。

2026-09-03 07:10Z：用户在收到核心物理闭环通过及纯mDNS仍待查说明后回复“好，下一步吧”；据此按现有ADR-0004范围结项M3.4 MVP，保留92/93专项失败及未测边界，不宣称全量绿色。同步当前里程碑、ADR实施状态和长期计划中的过时入口；架构定义与验收条件不变。下一阶段尚未确认，建议先讨论单Brain内目标拆解/任务编排，不默认实施旧M4登录、人员/HA或跨BrainTask。仅文档修改，未运行新测试、改源码/网络/信任、提交Git或停止任何节点；测试现场与原数据保持。

2026-09-03 07:05Z：B最终权威回执07:04:36.054Z确认同Task8fe868cc/Executionbe6b9f97 completed/seq4/attempt1；本机最终只读07:05:25.922Z确认A原Task44a77700第二尝试completed/seq4、两Worker业务Task均accepted、总5accepted/5session/7Execution/5Project/0工具/五空普通目录、原历史不变/槽1。07:05:25.974Z helper模型累计仍2。本轮真实双Brain单槽竞争、review占槽、各自验收、原队列自动续跑闭环 **passed**，不再需要用户输入测试命令。核心物理验收完成，M3.4 MVP结项待确认；mDNS92/93专项待查不变。Worker/A/B与正式桌面保持，不重启、不删历史、不改源码/网络/安装；本轮仅收尾报告与文档，详见HANDOFF和 `m34-physical-prepared-race-2ebbcc36.json`。以下为历史。

2026-09-03 07:01Z：B一次验收即时仍review，但Worker已accepted/seq4；A原Task44a77700自动发起第二次Executionde478490，到达review，原拒绝尝试历史保留，没有重复Task。完整文字/绑定/0工具/空目录/旧历史核对后，07:00:26Z通过A17068精确验收一次，07:01:03Z A completed/seq4，两新增Worker业务Task均accepted。最终5accepted/5session/7Execution/5Project、夹具请求2、槽1；追加20,011ms/38次槽位与任务稳定检查通过。现只等用户5.20 B助手 `race-status` 的最终completed回执，不重复accept/submit，不先标整轮/MVP完成。Worker76974/两正式桌面保留，原启用policy不变；合法declined记录意味着以后恢复测试Worker前需核对助手预检兼容，不删历史。无代码/安装/网络/信任改动，文档和精确证据见HANDOFF与本轮报告，mDNS92/93仍待查。

2026-09-03 06:54Z：B 同一 UUID 的 prepared 回执已收到，06:52:26Z 正常恢复原 Worker 配置一次；实际产生两个独立 Brain 的 Task，**B 执行、A 在最终准入被拒后留在原 Brain 排队**。20,121 ms/86 次观察，只有 B 新业务 Task/session。06:53:48Z 完整检查旧三条 accepted/会话/四条 Execution 不变，0工具/普通文件夹空；随后释放夹具，06:54:15Z B review/seq3 且回传成功，A仍queued、槽0。当前请用户在5.20 B助手仅输入一次 `race-accept 2ebbcc36-c079-4c84-ad4e-a6d9cf6a579f` 并发RACE_STATUS，之后才能验证A原任务续跑和双完成。Worker76974已启用原配置、夹具已release；A17068仍附着原桌面。无产品代码/安装/网络/配对修改，尚未完成整轮/MVP。精确ID/证据/初次只读观察字段错误见HANDOFF及 `m34-physical-prepared-race-2ebbcc36.json`；原mDNS专项92/93仍待查。以下为历史。

2026-09-03 06:40Z：B 已从原 race-v1 数据根同身份升级 v2，user STATUS 为 Ytmgnp/024a07、Task/model0、Worker通道就绪；新 helper/service14132/3044、远端app/peer62028/62295，本机独立匹配可信 peer。原历史预检一致并保存恢复配置后，06:39:48Z 经正常 API 暂停 Worker 接单；程序仍在线，未删除 Project。06:40:28.909Z A session17068 已 prepare UUID **2ebbcc36-c079-4c84-ad4e-a6d9cf6a579f**，无Task/.claim。当前等用户 B 同 UUID 的 RACE_PREPARED；Worker76974保持 gate关闭，不提前启用或停止。两端准备确认后才按报告 restoreBody 开放、观察实际单槽竞争。原3accepted/3session/4Execution与正式桌面保留，无产品代码修改；详情见 HANDOFF 和 `m34-physical-prepared-race-2ebbcc36.json`。

2026-09-03 06:31Z：用户知悉纯 mDNS 专项失败不等同于正常发现失效，确认继续物理单槽验收。原 Worker 旧进程均退出、遗留锁指向旧 PID；历史/6 信任核对完整后仅改名保留锁，同根同 t9MUCF 恢复为 session 76974、helper/service 996/26240、API/peer/engine 58866/60127/51469，模型 0。正式客户端和产品/网络配置不动。

第一段稳定检查在全就绪断言失败，未记录具体 peer/时刻，不算通过；即时复查恢复正常，随后只读变化观察 90,074 ms/333 次、未就绪/API 错误均 0、资源最大年龄 5,013 ms。最终旧 3 Project/3 accepted Task/3 session/4 Execution/6 信任与策略完全保持。A 控制台 session 17068 只读附着，无 active race。下一步等用户把 v2 代码覆盖到 **5.20 原 race-v1 助手目录并保留 .data**，发 Ytmgnp/024a07/v2 STATUS；门闩尚未关闭、无新 Task。92/93 与 mDNS 待查仍保留，物理竞争/MVP 不冒称完成。详情见 HANDOFF 和 `m34-physical-worker-resume-20260903.json`。

15:16Z：第二轮 arm 的旧 UTC 已过期，入口拒绝、未建 Task，A 未 arm。按 [v2 计划](plans/2026-09-02-m34-prepared-race-helper.md) 改为 prepare 仅登记意图，原测试 Worker 正常执行能力恢复后一次性提交，免人工赶 UTC，兼容旧 ledger。25 定向、两轮各 12 项完整服务、TypeScript/格式通过；code-only 包 20,017 字节/8 文件，本机同身份覆盖烟雾退出通过。

本轮全量 **92/93**，原有纯 mDNS 同机发现断言失败，单独复查再次失败，根因未知；未改产品/网络配置。按 executing-plans 重复失败停点暂停物理竞争，收尾文档并请求用户是否先排查发现问题。远端未更新，无新物理 Task，原 Worker policy 未改；15:15–15:16Z 原三条 accepted/三会话/四 Execution、A 两条 completed、两 Master 通道/槽位 1、fixture 新请求 0 保持。旧 A 控制台已停止，Worker session 67853 保留；详情见 HANDOFF，以下为历史，不再复制旧 UTC。

14:32–14:34Z：用户 B race-status 为 races=[]，旧轮协调取消已核清。复查原历史/两个 Master 通道/槽位正常，A 旧轮 cancelled 无 Task。新轮 `dbc4738a` 目标 `2026-09-02T14:42:44.641Z`，改为最终回复先给 B 命令，收到 B RACE_ARMED 且时间有效后才 arm A；目前 A 未安排。本轮只更新协调和证据，不改代码，详见 HANDOFF 与 `m34-physical-race-dbc4738a.json`。

14:21Z：因未收到 B 的 RACE_ARMED，A 在 14:21:02.983Z、触发前取消本轮 `2b08e84d` 定时，未创建 Task。到 14:21:48.573Z 的 178 次观察无新增 Worker Task/邀请/session，旧 3 Task/3 session、槽位 1 和两条 Master 通道正常。B ledger 未独立读取，需用户只发 race-status；本轮不计竞争通过，不复用 UUID/旧时刻或自动重试。Worker 恢复和 90 秒稳定通过事实保留，当前控制台/进程详见 HANDOFF。

14:12–14:16Z：用户授权测试 Worker 重启。原实例正常 stop/锁释放、全历史预检一致；同根恢复为 session 67853、PID 11212/39764、app/peer/engine 64758/54356/51071，A↔Worker 恢复，新 B 配对保留。90,011 ms/87 样本/18 次资源刷新检查通过（最大年龄 4,957 ms），旧全部记录不变，新模型请求 0，正式桌面未重启。此为恢复成功，不称原发现故障已修复。A 控制台 session 97010 已 arm 物理争用 `2b08e84d-1a63-4f1c-953a-8ace7aa55c81` / `2026-09-02T14:21:18.535Z`，待用户 B arm 回报；尚未创建争用任务，详见 HANDOFF。

14:04–14:08Z：新 B 已按用户新短码核对并完成 Worker 一侧确认，trusted/channelReady、Brain 024a07 established/online、共享 Worker 槽位 1；旧 3 accepted Task/session、模型累计 2 保留。只读 mDNS 与网络元数据检查仍未解释本机 A↔Worker 互不可见。已申请仅正常重启同目录测试 Worker t9MUCF、不动正式客户端；用户“测试 Worke”回复未当作明确批准，先解释目标并等待确认。未重启、未 arm/创建新 Task，详见 HANDOFF。

13:51Z 用户已重新启动新 B：Ytmgnp/Brain 024a07/原 race-v1 数据根保留，helper/service PID 3852/2628，app/peer 58225/56585，Task/model 0。Worker 实查在线未信任、无待配对；旧 3 accepted Task/session、槽位 1，A 两条 completed 保留。已请用户在当前窗口 pair 回传新短码，不再处理锁或重复启动。A↔Worker 仍互不可见，竞争尚未开始；详情见 HANDOFF 和 `m34-physical-new-brain-checkpoint.json`。

13:48Z 用户明确后台助手已关，接受该现场确认，不再要求进程列表。下一步仅让用户把新 race-v1 运行目录内残留 app.lock 改名保留，再从同一文件夹启动并发 STATUS；尚未执行或验证恢复，不删除身份/任务数据。旧短码已到期，不复用。助手存在“仅凭锁文件存在即阻止启动”的体验问题，已记录；本轮不改代码或重装，后续恢复前提见 HANDOFF。

13:30–13:31Z：用户发送新 B 配对码后，报告启动时“helper already running”。Worker 的对应请求已核对短码一致、对端确认、本端未确认，但新 B 已不可见。正常用户上下文只读探测确认新助手原 peer 63344 拒绝连接、原正式桌面 59725 正常。运行锁不等于活进程；尚未核对远端进程，不删锁或重启，先确认原 pair 控制台是否仍在。配对/争用未执行，详细证据见 HANDOFF 与 `m34-physical-new-brain-checkpoint.json`。

用户确认回收站没有旧助手并授权使用新身份：5.20 Ytmgnp/Brain 024a07 继续余下物理竞争，旧 cS1v1p/b1292e 的历史证据与 Worker 记录不动、不迁移 Task。13:14:19Z / 13:14:38Z 新助手在线未信任、原 Worker 3 accepted Task/session、槽位 1、模型累计 2；A 两条旧 Task completed。不过 A 与 Worker 此时互不可见，二者各自到 5.20 原桌面的通道正常。先请用户新助手 pair 回传短码，同时只读检查本机互联；尚未确认配对、arm 或提交新 Task。以下旧目录恢复要求已被用户的新选择取代。

用户随后明确旧 5.20 助手文件夹已误删。当前暂停配对/arm，先检查回收站能否恢复原目录和 .data；未确认永久丢失，不用新 Node 冒充原身份。若无法恢复，需用户确认新 Brain 续测，旧物理通过证据和 Worker 已验收记录继续保留，禁止迁移旧 Task 归属。同步助手准备已完成，实际物理竞争仍未开始。

最新远端反馈（13:02–13:05Z）：新版工具运行，但用户从新的 race-v1 目录启动，形成 Ytmgnp/Brain 024a07，不是原 cS1v1p/b1292e。Worker 确认新 Node 未信任、无配对，原 B 离线，原 3 accepted Task/槽位 1 保留；物理竞争未开始。已要求只停止新助手，将同一 zip 覆盖到原 0.1.3 助手目录的代码、保留旧 .data（不复制新 .data），再从旧目录启动核对原身份。如原数据缺失先核对，不能默认新身份续测。下节的交付准备已完成，但原身份更新尚未完成。

最新工具准备（12:40–12:59Z）：用户授权继续后，已实现测试专用一次性定时竞争控制器、两端控制台、持久化防重复和精确状态/验收；无产品/runtime/OpenCode 变更。14 项定向、全量 82/82（正常 Windows 用户上下文）、TypeScript/格式通过；同机完整服务 11 项通过，真正使用新控制器定时竞争并核对唯一执行、排队、Master 恢复和原队列继续，临时服务已清理。沙箱 DPAPI 的 8 项失败和 0 模型调用的完整服务失败保留，未更改身份保护；测试助手另修正管道命令在启动期提前消耗，实际 CMD 旧烟雾身份恢复及正常退出通过。18,870 字节/8 文件的新 race-v1 助手包不含 .data；已让用户在 5.20 stop 旧助手、原文件夹覆盖代码并保留 .data、重开回传 STATUS，尚未收到。12:58:49.652Z 原 Worker 仍 3 accepted Task/session、槽 1、本次模型请求 2，没有开始物理竞争。方案 [竞争助手计划](plans/2026-09-02-m34-physical-race-helper.md)，报告 `.data/verification/m34-physical-race-helper-preparation.json`。以下为历史检查点。

最新检查（12:22–12:34Z）：5.20 独立 Master B 正常 offline 后，A 经原 Worker 在 Project c4227a2e 执行 Task 0119d3eb / Execution 478658f7，未接管 B Task。用户 12:31:12.566Z online 后原 Node/Brain/数据根与 completed B Task/Execution/序号 4 保留，service PID 更新为 9824、app/peer 61533/59845；即时 channelReady=false，12:31:46.700Z Worker 已确认同一受信通道恢复。20,651 ms / 21 次 / 6 次资源更新检查通过，review 持续占槽且无重复 Task/session。通过 A 验收 Project Task 后，12:33:59.470Z completed/Worker accepted/序号 4、槽位 1，无待回传/错误；0 工具调用、原文件夹仍空、3 Project/3 accepted 业务 Task和官方 session/4 Execution，12:34:19.497Z 模型请求仍为 2。正常离线/同身份恢复及指定 Project 闭环通过；物理重叠分配/竞争还未通过，现有 B 助手不能重复 submit 创建新 Task，下一步需准备测试协调方式。报告 `.data/verification/m34-physical-master-offline-project-0119d3eb.json`；A/Worker 均在 5.33，不把该执行或正常恢复扩大为新跨机执行、异常断网、排队任务恢复。未改产品/测试源码、未重装。以下为历史检查点。

最新执行（12:06–12:17Z）：5.20 Brain B b1292e 的 Task 8923109f / Execution 818ffb44 已在 5.33 原 Worker 完成跨机闭环；只新增业务 Task 73a95c90、官方 session ses_f9dfc2d61ffeHD55NRsJsKCiyb、一次本机夹具请求，0 工具调用，Portable 目录为空。review/序号 3 时槽位 0；用户发出 accept 后，12:13:48.766Z Worker accepted/序号 4、待回传/错误均无，Worker 与 Master A 槽位恢复 1。Master A 不持有 B Task，旧 Task/session 保留。12:16:56.146Z 用户最终 STATUS 确认 Master B completed/序号 4、模型调用 0，勿重复提交。夹具已释放，本次调用 1；现为 3 Project/2 accepted 业务 Task/2 session/3 Execution。仅更新文档和验收证据，不改产品、不重装；物理竞争、Project 和 Master 故障仍待验收。下一步让用户仅对隔离助手执行 offline，核对 B 停调度、A 可通过原 Worker 执行测试 Project Task，再同身份 online；尚未执行。报告 `.data/verification/m34-physical-brain-b-task-8923109f.json`。以下为历史检查点。

前一接入（11:22–11:25Z）：5.20 独立 Node cS1v1p / Brain b1292e 已与原 Worker 核对短码并完成配对；用户远端 STATUS 确认 0.1.3/通道就绪/Task 0/模型请求 0。原 Worker 侧两个正式 Brain 目录与 Master A API 的 90,993 ms、88 次采样、19 次资源刷新检查通过，旧 Task/session 保持、槽位 1、Worker 当时仍 0 新模型调用。两个物理 Master 未直接配对；本节仅为目录稳定证据，不能当作竞争/MVP 完成。报告 `.data/verification/m34-physical-dual-brain-directory.json`。

最新（2026-09-02，0.1.3 升级后）：两端原身份/互信及已验收 Task 保留；5.33 实际版本已读取，5.20 版本依据用户更新反馈。原 Worker 的“已完成任务 + 授权/Portable 两 Project”恢复预检已实现，新增 13 项/全量 68 项通过；原 Worker 同目录恢复后 90,090 ms、87 次采样、19 次资源刷新通过，0 新模型调用，原 Task/session/Execution 不变。当前助手 session 38378、PID 39992/25020，API 62388、peer 53946、engine 61627；夹具尚未 release。当前仍只有一个物理 Brain，不重复配对或提交旧任务。免安装独立 Master 助手包已本机验证并准备交给用户在 5.20 启动，等待 READY 身份；物理双 Brain 验收未完成。详见 [恢复与助手计划](plans/2026-09-02-m34-completed-worker-resume.md) 和 [物理记录](plans/m34-physical-acceptance.md) 末节。以下为历史检查点。

最新操作（2026-09-02T10:49–10:51Z）：用户授权停止 5.33，原物理 Worker 经助手 `stop` 正常关闭，session 77892 退出码 0，旧安装目录关联进程已清空。原 Node、授权 Project、Portable Project、已验收 Task/官方 session、两条 Execution 和信任/拓扑文件保留，模型请求累计仍为 1。用户现在可保留数据安装 0.1.3；不要勾选“删除应用程序数据”。尚未升级或重启 Worker，旧“零 Task / 单 Project”恢复预检需适配已有完成任务后才能重用。详见 [停止记录](plans/m34-physical-acceptance.md) 末节；下方运行中状态为此前检查点。

当前（2026-09-02，0.1.3）：用户授权的高位 HTTP 端口修复已完成；桌面后台、节点通信和本机官方引擎的自动端口均为 49152–65535，冲突/系统保留端口有界重试，不改 UDP 发现或系统设置。55 项 Node 回归、1 项原生 URL 校验、TypeScript/Vite/Cargo 检查均通过。新打包运行时完整生命周期 **11 项通过**，含 90.3 秒稳定、双 Brain 竞争、Project、Master 停止/同身份重启、原排队任务继续和 18 个高端口检查；3 个已验收业务 Task/官方会话、0 工具调用。报告 `m34-fresh-brains-bd24ebd5-73b6-423c-860a-12a73b41ffa3.json`；详见 [修复记录](plans/2026-09-02-m34-high-http-ports.md)。0.1.3 安装包已生成（71,083,411 字节），尚未安装。07:53:35Z 原两台/Worker 仍运行 0.1.2，配对与已验收 Task 45b70f73 正常，Worker 槽位 1；模型已释放，原零任务恢复预检不可直接重用。新测试进程均退出；历史失败证据保留。仍需安排升级及真正双机双 Brain 验收，不标记 M3.4 MVP 完成。下方为历史记录。

最新（2026-09-02T06:35:41Z）：用户截图核对后两台与原 Worker 均配对成功、加密通道就绪。但新拓扑稳定检查在首轮失败：5.20 Brain 持续 provisional，虽有共享空闲 Worker 仍不能调度。已定位并纯内存复现“任意发现的 established 广告阻塞正式化”路径，当前只记录诊断，未修产品代码；暂停新任务，保留两条配对。下方为恢复/配对的先前检查点，细节以 [物理记录](plans/m34-physical-acceptance.md) 末节为准。

用户确认卸载时勾选了“删除应用数据”，因此两台新身份按全新安装继续，不算覆盖升级丢数据。原 Worker 的显式同目录恢复已实现，限定测试根目录、原 Node、无业务任务及本机夹具模型；4 项只读定向检查、TypeScript 通过。2026-09-02T06:21:41Z 用安装的 0.1.2 恢复原 t9MUCF，原 Project/旧 Execution 保留、业务 Task 0、模型调用 0、空闲槽位 1。已分别向新的 5.20/5.33 发起配对，等待用户比较验证码后确认，先不发任务。旧 Task A 不迁移、不续测；详见物理验收记录末节。

升级前历史检查：2026-09-02T05:00:47Z 两个 Master 均离线后，物理助手正常 `stop`，自有进程退出、模型调用 0 次、隔离数据保留。随后用户自行安装；不提供重复安装教程，不新建 Worker 身份。

产品负责人已重新确认：M0、M1、M3.1、M3.2 完成；M3.3 的单人双机核心闭环已验收为 MVP 完成。M2 正式发行完善暂缓。M3.4 定义与历史服务/Release 回归已完成；物理 Task A 暴露回执时差问题后，用户授权修复。0.1.2 修复和 43 项回归通过，随包完整服务正负 5 秒时差各 8 项通过；当前继续新身份下的物理验收，不标记 M3.4 MVP 完成。

M1 的模型设置产品功能和无 Key 验证已经完成。当前 Windows 客户端包含模型设置页、DeepSeek 工作区凭据管理、真实连接测试、默认模型、任务模型选择和无密钥审计记录；官方 OpenCode 仍是唯一执行引擎。

用户已在 Rivloom 本机保存 DeepSeek 官方 Key，并于 2026-09-01 用 `deepseek/deepseek-v4-flash` 完成禁用工具的真实连接测试和普通文件夹固定编程任务。任务目录没有 `.git`；编辑和指定测试命令分别经人工批准，独立核对为 1 项测试通过、测试文件未变并最终验收。Key 未进入聊天、仓库、截图或报告。

**2026-09-01 项目目录规则修正：** 项目可以是任何本机可访问的普通文件夹，不要求 Git，也不自动初始化 Git。Rivloom 已移除首次执行的干净提交要求、文件扫描快照、内容哈希和验收时的哈希复核。产物页只展示 OpenCode 官方会话接口明确返回的差异；没有返回差异时，验收人直接检查本地文件和测试记录。

运行状态：内部 Web 调试服务 `127.0.0.1:4310` 保持关闭。物理 Worker `Rivloom t9MUCF` 的 0.1.1 现场保留；此前与 5.20/5.33 配对后 92.7 秒、91 次目录/通道/槽位检查通过。“5.20 不可见”已由用户确认是看错 5.18 旧实例。用户从 5.20 提交的 Portable Task A（`7f0da3b1` / `44b41f60`）接受回执失败，尚无业务 Task/执行会话，模型请求 0 次；0.1.2 已修复高度吻合的跨机器严格时间比较问题，原始回执时间未保留，故不宣称是本次唯一原因。2026-09-02T04:43:42Z 本机 5.33 桌面已不在运行、其 Brain 离线，5.20 仍在线；助手未关闭用户桌面，也未取消、重发或改实际任务记录。升级前先确认正式 Master 退出，再停自有 Worker 释放 runtime；详情见 [物理验收记录](plans/m34-physical-acceptance.md)。

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
| M3.4 多 Brain 协作     | 0.1.2 时差修复、43 项回归和双向服务测试通过；待物理复验     |
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
- `scripts/desktop-install-smoke.ts` 与 `.ps1`：0.1.1 NSIS 全新安装和真实 0.1.0 覆盖升级；核对随包引擎、M3.4 UI/API、身份/Project/Task/策略保留、重启与卸载。强制 PowerShell 包装器记录并恢复两处确切安装元数据，避免 `/D` 测试污染原安装位置。
- `server/node-identity.ts`：稳定 Ed25519 节点身份、Node ID/指纹派生和 Windows DPAPI CurrentUser 私钥保护。
- `server/node-network.ts`、`server/node-trust.ts`：独立受限节点端点、发现与离线处理、签名配对会话、短码派生、双方确认、公开信任记录持久化、冲突拒绝、撤销和重试。
- `server/node-channel.ts`、`server/node-network.ts`：Ed25519 签名临时 X25519 握手、HKDF 方向密钥、AES-256-GCM、严格序号/时间窗、10 分钟轮换和撤销断链；当前开放最小 Brain 目录、协作任务控制和有序执行状态消息。新增签名单边恢复请求，由较小 Node ID 确定性重建通道，避免单侧仍持有旧会话时永久失联。
- `server/execution-policy.ts`、`server/remote-tasks.ts`、`server/index.ts`、`src/node-network.tsx`：持久本机能力配置；受信任务自动接收；请求批准/帮我批准/允许任何操作三种 AI 审批；旧策略安全迁移；远端任务与本机业务任务唯一绑定；真实 OpenCode 启动；单调状态与人工介入快照回传；远程批准/拒绝、回答、停止、补充要求后续跑同一会话、官方差异展示和最终验收；同项目和并发保护。控制按任务路由和执行序号校验并持久去重；同一任务一次只处理一个控制；撤销来源设备信任会停止其仍在本机运行的任务，已有修改不回滚。
- 正常关闭会主动发送签名离线通知；异常断电或断网时每 5 秒刷新签名心跳，约 15 秒显示离线、约 30 秒移除。顶部、Brain 和侧栏数量只统计在线节点，恢复心跳自动上线。
- `tests/node-network.test.ts` 与 `scripts/node-network-ui.ts`：分别关闭回退或 mDNS 的真实双实例测试，覆盖握手伪造/重放、密文篡改、消息重放、过期、重启与撤销，以及 Release WebView2 加密通道页面验证。
- `server/brain-topology.ts`：Brain 与 Node 身份分离后的 v1 拓扑存储；旧 `brainID` 安全迁移、provisional/established 状态、确定性 provisional 收敛、空白新节点采用已有 Brain，以及正式 Brain 永不自动合并。
- `server/worker-resources.ts`、`server/node-network.ts`：只在受信加密目录交换 Worker 的 Project ID/名称、真实静态硬件、动态 CPU/内存/GPU/磁盘、任务数、槽位和采样时间；30 秒过期、Project/硬件硬过滤、负载/队列排序和稳定 Node ID 决胜。公开发现刷新不再覆盖加密目录。
- `server/brain-tasks.ts`、`server/remote-tasks.ts`、`server/index.ts`、`server/worker-admission.ts`：提交 Node 先持久化稳定 Brain Task，远端 Master 保存权威副本并创建不同 ID 的 Worker Execution；可选 Project ID 和结构化硬件要求随两跳幂等消息保存。Worker 在节点级全局串行区内复核 Project、模型、硬件和槽位，通过后才回复接受；竞争失败会明确拒绝。Task 持久化尝试号和 Execution 历史，明确拒绝、邀请过期或尚未接受时 Worker 离线可安全创建新 Execution，当前 Execution ID fence 旧尝试的迟到状态。Portable Task 使用 `.data` 下按 Execution ID 隔离的本机普通临时目录，不用 Git、快照或哈希。
- `src/node-network.tsx`：新增 Brain/Master/队列/共享 Worker 拓扑，显示静态硬件、动态负载、槽位、项目资源、采样时间、当前 Execution 尝试及失败历史；跨节点任务入口不再手选 Node 或 Brain。
- `scripts/m34-fixtures.ts`、`scripts/m34-service-check.ts`、`scripts/m34-desktop-fixture.ts`：隔离完整业务服务和原生 Release 窗口夹具，使用未修改的官方 OpenCode 与本机确定性模型，覆盖共享槽位、独立会话、待验收占用与自动安排；不使用用户 Key、外部额度或重要文件。
- `scripts/m34-physical-worker.ts`：新增物理验收后台 Worker 助手，复用已安装 0.1.1 运行时、独立数据/普通 Project、本机测试模型和一个槽位；配对限定两个明确 Node ID，真实客户端仍由用户确认。共享助手支持指定运行资源目录和模型超时，默认行为不变；未改产品代码或安装包。
- 本轮修复迟到接受回执误判成功、本地手动启动绕过全局槽、临时 Brain 未撤回、显存截断和阻塞采样；进一步修复认证目录未保活及发现/hello/加密消息共用限流预算导致的 429 掉线。分层限流保留来源 IP、上限、大小与认证校验，不降低设备信任要求。运行资源复制解引用依赖链接，Release 不依赖开发机的 pnpm 路径。

## 当前证据

- `.data/verification/model-settings.json`：6 项官方 OpenCode 凭据/模型接口检查通过；看到 3 个 DeepSeek 模型；无真实模型请求。
- `.data/verification/deepseek-plain-folder.json`：Release Tauri 中用 `deepseek/deepseek-v4-flash` 完成无 `.git` 普通文件夹编程任务；1 项测试通过、测试文件未变、任务已验收，报告不含凭据或完整模型回复。
- `.data/verification/desktop-model-settings.json`：5 项实际 Release WebView2 模型设置页面检查通过。
- `.data/verification/desktop-model-settings.png`：模型设置桌面页面截图。
- `.data/verification/desktop-integration.json`：最终 Release 使用 `opencode/mimo-v2.5-free` 的 11 组真实闭环检查通过；任务 `46dd767c-ae19-401d-890a-e65ba5bfef59`，引擎会话 `ses_fa4bf8155ffe1Iq2eD7Uzu9sz2`。
- `.data/verification/desktop-ui.json` 与 `desktop-direct-start.png`：全新数据目录无账号/工作区表单，自动建立本机操作者并直达任务工作台，发现已启动。
- `.data/verification/desktop-install.json`：0.1.1 安装器 7 项开发机隔离检查通过，覆盖全新安装、0.1.0 升级、随包引擎、M3.4 UI/API、身份/任务/策略保留、重启与卸载保留数据；`installationMetadataRestored: true`。无真实模型请求或用户凭据。
- `.data/verification/desktop-node-network.json`、`.png` 与 `desktop-node-pairing.png`：上一完整运行的 23 项实际 Release 节点页检查通过；真实第二实例完成加密协作任务、能力关闭仍自动接收但不启动、发起方界面回答/拒绝/停止、随包 OpenCode 在人工介入点被远程停止、另一真实会话经远程一次性批准后生成文件、有序状态、隐私边界、同项目并发拒绝及设备撤销。AI 提问界面使用协议级执行快照触发，不冒充模型真实提问。
- M3.3 上一阶段的 Release 实际 WebView2 已完成新增的官方差异卡片、补充要求和远程验收控制的加密往返；随后真实 `opencode/mimo-v2.5-free` 停止夹具在 10 分钟内只产生空 assistant 消息、没有进入人工介入点，因此整组新报告没有写成通过。产品逻辑与外部免费模型可用性分开记录。
- 用户在物理设备 `192.168.5.20` 与 `192.168.5.33` 上用真实 DeepSeek 完成普通文件生成任务、远程一次性批准、补充要求同会话续跑、本地核对和远程验收；这是人工确认，不生成或伪造自动化机器报告。
- `.data/verification/permission-policy.json`：官方 OpenCode 1.18.25 成功创建并读回三种会话权限规则；没有发送模型请求或读取凭据。
- M3.4 本地检查：TypeScript、Vite、Cargo fmt/clippy 与 32/32 项 Node 测试通过；四节点验证两个正式 Brain、两个共享 Worker、两跳路由、重调度、Execution fencing、Master 停止和 20 秒发现刷新中断。7 项完整业务服务检查通过：90 秒通道/槽位稳定、两个 Brain 竞争只创建一个业务 Task/官方 OpenCode 会话，待验收占槽，本地启动不能绕过。最终 Release 原生窗口在三节点全互信拓扑稳定 90 秒后，表单提交自动选择远端 Master，再由共享 Worker 执行；仅一次尝试，结果回传并显示等待验收。模型为本机确定性夹具，不等同于真实 AI 编程或物理多机验收。报告见 `.data/verification/m34-service.json`、`m34-desktop.json`。

最新时差修复包为 `src-tauri/target/release/bundle/nsis/Rivloom_0.1.2_x64-setup.exe`，71,051,274 字节；Release EXE 10,266,624 字节，版本字段与锁文件同步为 0.1.2。旧 0.1.1 安装器和其 7 项安装/升级验证保留为历史基线；本次尚未安装或重跑安装测试，避免干扰验收实例。identifier、默认数据目录、依赖和官方运行时版本未变，用户实际安装未被更新。新增 11 项时差回归、全量 43 项及随包完整服务检查见 [最新验证](VERIFICATION.md)；一次注入夹具造成的失败也保留。更新时使用原 `%LOCALAPPDATA%\Rivloom` 并保留数据，详见 [升级步骤](plans/m34-physical-acceptance.md)。正式发行完善仍暂缓。

## 下一次恢复工作时

1. 继续 ADR-0004，不重新讨论已确认定义；本地 32 项回归、7 项完整服务检查、网络故障和最终 Release 窗口闭环已经通过，无需重做已完成工作。
2. 0.1.2 已修复时差并构建安装器，11 项定向及全量 43 项通过；最新完整服务时差结果见 VERIFICATION。先让用户确认正式桌面已退出，再停止自有测试助手释放 runtime、升级两台并按 [物理验收清单](plans/m34-physical-acceptance.md) 核对 Task/Execution/配对和 Worker 身份，再继续执行、单槽竞争、项目固定和 Master 停止；不能直接释放模型或重发来冒充修复。
3. 记录真实设备证据，再由用户确认 M3.4 MVP；在此之前保持“历史本地/Release 通过、物理验收暂停于回执失败”。人员身份、高可用选主/脑裂、跨 Brain 共同 Task 和 M3.3 延后优化不擅自扩进当前切片。

## 后续优化清单（不阻塞 M3.4）

1. 为随包 `node.exe` 设计仅限 Private/LocalSubnet 的 Rivloom 命名防火墙规则或等效低摩擦方案，覆盖安装、升级、诊断和卸载；不得开放 React、OpenCode 或通用引擎接口。
2. 物理补测远程停止、“帮我批准 / 允许任何操作”、执行中撤销来源设备信任、重启保持、异常结束/断网恢复和两真人角色映射。
3. 后续发行阶段继续干净 Windows 的安装/升级/卸载矩阵、代码签名和双机发现回归；当前 0.1.1 的开发机覆盖升级检查不等于正式发行验收。

## 持续约束

不使用已过期的 OpenCode Go；不修改旧项目；不修改或 fork OpenCode；不公开引擎接口；不把自动发现等同于自动信任；不把共享工作区凭据宣传成每个成员独立账号；不把测试字符串接口验证宣传成 DeepSeek 已连接；不把未签名内测包宣传成完成商业发行审查。
