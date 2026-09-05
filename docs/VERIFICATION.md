# 实际验证记录

日期：2026-09-01 至 2026-09-05；Windows x64，Node.js 24.19.0，OpenCode CLI / SDK 1.18.25。执行数据保存在被版本库忽略的 `.data`，真实 AI 只修改其中的专用测试文件夹。旧项目 `C:\project\opencohive` 仅只读参考产品文档，没有复制或修改源码。

## 2026-09-05：M3.5 A–D 工程交付与验证（当前）

本轮从 `main` / `8badf8f6f31e0016a1e1a100dd70c9b43cfe6671` 的既有界面/备注/`@` 改动继续，未重置覆盖。**A–D 工程交付完成，用户验收及本轮双物理机回归待进行**。正式客户端及原验收数据未操作。本地 Git 按用户追加授权只保存本任务范围，不推送；提交号以最终 Git 记录为准。

| 本轮检查 | 实际结果和证据 |
| --- | --- |
| 创建幂等与远程时钟定向 | 14/14；`.data/verification/m35-stage-a-creation-after.log`。失败先验保留在 `m35-stage-a-creation-before.log` |
| 自动分配候选修复 | 共用每个 Brain 的实际 Worker 过滤规则；仅 Master 自身候选明确无候选，合法第三 Worker 可执行；复现/通过记录保留于 `.data/verification/m35-placement/` |
| 全量 `npm.cmd test` 首轮 | **145/146**；`.data/verification/m35-full-regression-first.log`。唯一失败仍为已有 `two isolated Rivloom instances discover and cryptographically verify each other` 的纯 mDNS verified 断言，不记全绿 |
| 全量 `npm.cmd test` 最终 | **154/155**，106.8 秒；`.data/verification/m35-full-regression-final.log`。唯一失败仍是上述纯 mDNS 用例，在 `tests/node-network.test.ts:2222` 的 `testPeers.every(...verified)` 断言；本轮其余测试通过，未把整套记为全绿 |
| 前端/HTTP 最新定向 | **23/23**：`tests/api.test.ts`、`conversation-drafts`、`node-mentions`、`task-receipts`、`conversations`；`.data/verification/m35-drafts/review-tests.log`，typecheck 为 `review-typecheck.log` |
| 模型目录消失后的本机创建确认 | 增量 **7/7**（API + 草稿），`m35-drafts/model-retry-tests.log` / `model-retry-typecheck.log`；已发出请求可保持原签名和 ID 确认，编辑新工作恢复模型前置校验 |
| 完整隔离业务服务最终复测 `npm.cmd run test:node-p0` | **12/12**；`.data/verification/m35-p0-1788581065722-2746e0ac/verification.json`、`engine-audit.json`，日志 `m35-placement/service-p0-run3.log`；全部自有服务已 stop。此前 10/10 根 `m35-p0-1788579317453-a5b08eb4` 保留 |
| 真实 session 创建崩溃窗口 | **2/2 场景通过**；`.data/verification/m35-session-crash-1788580103133-167ac635/verification.json`，运行日志 `m35-session-crash-run3.log`；8 个自有旧/新服务及引擎端口均已关闭，见 `cleanup-ports.json` |
| Tauri Debug 原生界面 | **12 条记录通过**（含 CLEANUP）；`.data/ui-conversation-c9af0886-f701-4dbb-aa4d-746b24ee8345/native-observations.json`，6 张实际窗口截图；1282×872、最窄 962×872 |
| 最终 Tauri Release 原生复查 | **8 条记录通过**（含输入模式恢复与 CLEANUP）；`.data/ui-conversation-6fddb6ac-44a5-47e5-922b-a49ce7c47234/native-release-observations.json`，4 张实际窗口截图；包括真实 Windows 拼音候选 Enter 不发送、键盘选定固定 Node、原任务 authenticated delivered/queued 第 1 位、等待文案及 signed hello 后统计保持 |
| 认证 ACK 定向回归 | `m35-placement/receipt-auth-ack-unit.log` **2/2**；`receipt-auth-ack-network.log` **4/4**，含伪 HTTP 204 拦截和部分重复单元用例，两组不累加为独立总数 |
| 路由/恢复与旧协议回归 | `m35-placement/receipt-routing-network.log` **1/1**，错误节点/路由/key/task ID、乱序/同序冲突、终态、ACK 丢失和断线重放；`receipt-legacy-network.log` **1/1**，实际 8badf8f 旧 network 模块搭配当前兼容 wire 依赖，双向基本任务通过且不发送新队列消息，未使用完整旧二进制 |
| signed hello 统计刷新 | `m35-placement/stats-hello-after.log` **1/1**；保留已认证队列统计及原采样时间；此单例不覆盖过期判断 |
| 新独立预览安装包 | **构建成功，未签名、未安装**；`.data/distribution/Rivloom_M3.5_Node_P0_Preview_0.1.3_x64_setup.exe`，**71,107,766 字节**，SHA-256 **`206B80AD363FBAC90435E085333F8D61DFB5BF8A3251734AD459A6905ED2DECE`**；`m35-preview-artifact.json` 与 `m35-preview-installer-retry.log` |
| 最终二进制闭环 | **通过并 CLEANUP**；`.data/ui-conversation-f90b3dd1-f6b1-4ca8-987a-bc51c67f0945/verification.json` 和 `native-final-binary-review.jpg`；与最终产物相同的 Release exe 完成启动、加密配对、1 remote Task → 1 业务 Task → 1 官方 session → review，实际窗口显示结果；模型请求 1/工具 0 |

完整服务使用同机隔离数据、独立发现域、官方 OpenCode 1.18.25 与确定性 loopback 模型。覆盖：丢失创建响应后四次并发重试只有一个邀请；不同内容/目标同 requestID 返回 409；发送/接收端重启保留原 ID；唯一业务 Task/session；review 重启后仍占槽；固定目标离线/撤信 409 且无本机/第三 Node 回退；普通忙碌混合来源 FIFO 不提前批量建远程业务 Task；调序/暂缓/拒绝/暂停重启保持且操作重放幂等；实际顺序与队列一致；双 Brain 同槽竞争，输家原 Task/Brain 保留并沿原任务第二尝试；unknown 重启后不重派。

最终 12/12 服务根为 `.data/verification/m35-p0-1788581065722-2746e0ac`：**7 业务 Task、7 官方 session、7 唯一绑定、0 工具、6 accepted + 1 故障注入 interrupted**；sender/other 两发起端本地 Task 均为 0。追加覆盖 `/bootstrap.network` 与 `/network` 两入口的普通成员可见范围、Brain Master 读取过滤、全队列 403、owner 不受影响、Windows 路径大小写/斜线变化脱敏；unknown 恢复后原 Execution/attempt/Brain 归属保持等候。最后一个 interrupted 是保守恢复的验证对象，不冒称七项均已验收。此结果不等同于两台物理 Windows 设备、两位真人或真实模型编程验证；M3.4 原物理证据不重复计入 M3.5。

实际 Tauri Debug 窗口验证根 `.data/ui-conversation-c9af0886-f701-4dbb-aa4d-746b24ee8345`：`@` 中普通忙碌 Node 可选，原名/备注和固定 ID 正确；切入已有来访 review 会话不污染其输入，返回新会话恢复正文和原目标；从原生发送后准确显示 queued 第 1 位/等待槽，释放 peer review 槽后同一原任务达到 review，未创建本机回退任务。等待项上移、暂缓（无排位）、恢复、拒绝原因和原 sender seq5 回执一致；暂停/恢复保留 review 槽；断线收起右栏、头部本机队列弹窗仍可用；同数据重启保留 Node 资料、Task/session、顺序和拒绝事实；CLEANUP 完成。宽 1282×872、最窄 962×872 控件在窗口内，未据此宣称 700px 或其他未测尺寸通过。

6 张 Debug 证据为 `native-draft-restored.jpg`、`native-directed-queued.jpg`、`native-queue-held.jpg`、`native-narrow.jpg`、`native-offline-narrow.jpg`、`native-offline-local-queue.jpg`。该轮使用原生文本 API 输入中文，Windows IME 候选在下一轮 Release 单独验证。同机两进程和确定性模型不计两物理机/真实 AI 工具验证。原生发现的 signed hello 刷新丢失队列统计及等待输入误导文案已修复并经最终 Release 复查。此前 Escape 误触暂停根 `.data/ui-conversation-19cbea2d-ad72-4360-91c8-ae90bc8cf91d` 保留，用户确认继续后取得新证据，不再作为当前停点。

Release 交互验证根 `.data/ui-conversation-6fddb6ac-44a5-47e5-922b-a49ce7c47234` 使用新独立数据、确定性模型及未安装的独立预览 exe。真实 Windows 拼音候选 `ni'hao` 按 Enter 仅提交 `nihao` 到草稿，没有发送，历史仍为 3 会话、本机 Task 仍为 1；随后恢复原输入模式。带空格 Node 原名与长备注正常显示，Down + Enter 选择可见候选并绑定确切 Node ID，不创建任务；显式发送才产生原远端 Task 的认证送达和 queued 第 1 位。等待区明确说明目标准备执行会话后可补充要求；多次 signed hello 保持队列统计且不冒充刷新原采样时间。8 条记录包含 CLEANUP，4 张截图为 `native-ime-candidate.jpg`、`native-ime-enter-no-send.jpg`、`native-release-mention.jpg` 和 `native-release-queued.jpg`。该轮 exe 为 **10,297,856 字节**，SHA-256 **`C5B1F4664A32F2EC6FA74DB87F2CBFB5C32B4BBFB18B3A09F05C9B377E5ADC8A`**；最终重新链接后的 exe 哈希不同，按下一段另行核对，没有将两份二进制写成相同。该证据不等同于安装器执行、两物理机或真实模型工具操作。

独立预览使用产品名 **Rivloom UI Preview**、identifier **`com.rivloom.conversationpreview`** 和版本 0.1.3。最终 NSIS 构建退出 0，唯一本轮交付文件为 `.data/distribution/Rivloom_M3.5_Node_P0_Preview_0.1.3_x64_setup.exe`，**71,107,766 字节**，SHA-256 **`206B80AD363FBAC90435E085333F8D61DFB5BF8A3251734AD459A6905ED2DECE`**，Authenticode 为 **NotSigned**，没有运行安装。最终 Release exe SHA-256 为 **`477D2AAF981510EDDF5EB901FEE4783A4632AC96281304A6A5FCF8338043B3F1`**；首次原生交互后源码/前端内容未变化，但重新链接使 exe 哈希变化，因此对最终 exe 单独启动/配对复核，不将中间哈希作为最终产物。`m35-preview-artifact.json` 记录产物事实；旧正式安装器的大小/修改时间与旧预览哈希均核对未变。

NSIS 首次封装失败保留在 `m35-preview-installer-final.log`：封装尚未结束即启动 Release 交互检查导致文件被占用（Windows error 32）。停止本轮自有预览后重新封装，`m35-preview-installer-retry.log` 退出 0；没有删除首次失败记录，也没有安装或覆盖正式客户端。最终独立根 `.data/ui-conversation-f90b3dd1-f6b1-4ca8-987a-bc51c67f0945` 使用与产物相同哈希的 exe，完成启动、加密配对及 1 remote Task → 1 业务 Task → 1 官方 session → review，模型请求 1/工具 0，实际窗口显示结果并保存 `native-final-binary-review.jpg`；`verification.json` 与 CLEANUP 均通过。此轮只确认最终二进制闭环，不重复计入此前 12+8 条交互检查。

追加真实 session 崩溃验证使用 `.data/verification/m35-session-crash-1788580103133-167ac635` 下两个独立根。`before_create` 在 Rivloom 已持久保存创建意图/queue starting、真正调用官方 `POST /session` 前强杀；`after_create` 在官方已创建并返回 session ID、但 Rivloom SDK 调用尚未返回且 Task.sessionID 未绑定时强杀。仅测试 `--import` 夹具拦截 global fetch，官方引擎没有修改。两场景均先核对自有子进程树退出、服务/引擎端口关闭，再同根同身份重启：原 Task 保持 interrupted/sessionID=null；同 requestID 返回原 Task；手动启动 409；新第二 Task ready 并等待槽位。前者官方 session 为 0，后者为 1；重启前后官方 session 列表不变、模型请求均为 0。合计 **4 Task/1 官方 session** 属两个独立根，不是 AI 执行或成果验收。各子目录保存 `verification.json`、`forced-crash.json`、`session-crash-window.json`、`service.log` 与 `restarted.log`。

该专项先前两次失败均保留：`m35-session-crash-1788579764974-3db2b02e` 为强杀后只读 SQLite WAL 读取报 disk I/O；`m35-session-crash-1788579829581-059e964f` 为 taskkill 返回 128，未完成重启。这两次不计通过。修正仅限本轮夹具：允许自有测试 DB 执行 SQLite WAL 恢复、记录 taskkill 输出并以真实进程/端口关闭为前置、独立发现端口且关闭该夹具 mDNS；第三轮另根通过，不删除旧失败证据。

保留失败与修复：`.data/verification/m35-p0-1788579198721-3dc25a40/verification.json` 在前五项通过后，重新配对遇到发现/离线竞争，confirm 返回 404；修复夹具同步后另根完整重跑通过，失败数据不删除。伪 ACK 复现保留在 `m35-placement/receipt-fake-ack-before.log`，signed hello 丢失统计复现为 `stats-hello-before-source.log`；另外两个 `stats-hello-before*.log` 仅属前置夹具无效，不计产品语义失败。前端最初缺少新模块的失败、一次中文标签空格断言与夹具类型错误分别保留在 `m35-drafts/before.log`、`c-tests.log`、`typecheck-c.log`，后续通过记录独立保存。纯 mDNS 失败未修复。

实现还修复了请求期间的 UI 竞态：创建失败保留原草稿/requestID，创建成功使用精确返回 ID；提交中切换会话不抢回当前会话，设置在 busy 时禁用；队列请求结果未知时保留完整原请求（版本与 operationID），只通过“重试确认”重放，其他队列变更暂锁。已有实际执行状态/终态优先于旧队列回执，旧节点或过期统计显示未知。定向测试与上述原生操作分别记录，不互相替代。

原生检查发现：发起方 direct 任务仍在目标排队、尚无 `executionSequence` 时，原有控制协议尚不允许补充正文。输入区已改为说明“等待目标 Node 准备执行会话，开始后可补充要求”，不再误写为归属权限不足，也不将本机保存当作已送达；该文案 typecheck 通过（`m35-drafts/queued-native-copy-typecheck.log`），并经上述最终 Release 实际窗口复查。本机自有 waiting/held Task 的补充只保存，不绕过排队自动启动。发送方修改未绑定的远程正文协议没有在本轮扩大实现。

## 历史：2026-09-05 P0 分析与交接保存，未运行产品测试

用户已确认 [Node 协作 P0 计划](plans/2026-09-05-node-collaboration-p0.md)，并指定新会话实施。本次只核对代码/文档、保存计划和已接受的 [ADR-0005](adr/0005-directed-node-queues-and-receipts.md)、同步交接入口；没有实现 P0、重跑产品测试、操作运行节点、重建或安装桌面包。现有未提交界面源码和旧数据保留，未提交/推送 Git。

文档检查：9 个交接/计划文件的 102 个本地 Markdown 链接均可解析到现有文件，`git diff --check` 通过。此结果仅验证文档，不计入产品测试。

下方通过项仍只证明此前界面、备注、直发及 M3.4 的记录范围。草稿目标绑定、HTTP 创建幂等、真实队列/控制/回执和自动分配修复需要按新计划取得证据；既有自动分配 queued 和纯 mDNS 失败继续保留，不能因计划已接受而标记通过。

## 2026-09-03 至 2026-09-04：会话式桌面改版（8badf8f 之后）

本轮按用户确认的布局实施，保留 Tauri、官方 OpenCode 1.18.25、Task/Execution/Brain 归属和审批边界。开始时 main / 8badf8f 工作区干净。以下均为本轮实际结果；下方此前的测试数字不重复计入。

### 2026-09-04：本地备注和 `@Node`

| 检查                                                                                             | 实际结果                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm.cmd run typecheck` / `npm.cmd run build`                                                    | 通过；Vite 1831 modules                                                                                                                                                                                                          |
| `node --test tests/node-profile.test.ts tests/node-mentions.test.ts tests/conversations.test.ts` | 9/9；备注验证/持久化、指纹变化隔离、活动 `@` 查询、原名/备注搜索、最近使用排序和原会话/队列行为                                                                                                                                  |
| `node --test tests/remote-task-clock.test.ts`                                                    | 11/11；远程任务时钟、回复顺序和终态幂等保持                                                                                                                                                                                      |
| `node --test tests/node-network.test.ts`（正常 Windows 用户上下文）                              | 24/25；DPAPI、信任、加密通道、远程邀请、双向配对及 UDP 后备发现通过；唯一失败为已有的纯 mDNS 同机发现 verified 断言。受限沙箱内先出现的 DPAPI/网络权限失败不计产品结果                                                           |
| `node scripts/conversation-ui-fixture.ts` 的 `connect` + `mention`                               | 两轮隔离双节点闭环通过（服务与原生 Tauri Debug 各一轮）：来访任务完成，本机备注“设计工作站（小林的电脑）”，本机向该 Node 直发任务并在对端完成；本机记录 `lastUsedAt`，对端快照的备注仍为空；共 2 次确定性模型请求/轮，0 工具调用 |
| `npm.cmd run preview:conversation:installer`                                                     | 退出 0；Tauri Release 和独立 identifier 的 NSIS 完成，未安装或覆盖正式客户端                                                                                                                                                     |
| `git diff --check`                                                                               | 通过；修改仍未提交、未推送                                                                                                                                                                                                       |

服务闭环数据根 `.data/ui-conversation-5c2a037a-13c8-4f0c-8973-2f814ea85bf9`，原生闭环数据根 `.data/ui-conversation-b3402955-e79b-4b75-b769-e7ee1c584897`；两者 `verification.json` 均保存 direct `@` task、local display、`lastUsedAt`、remoteRemark=null 和 cleanup。直发走既有认证加密 remote-task 通道，不经过下述自动分配分支，因此不把下述 queued 缺陷写成已修复。目标离线或加密通道未就绪会返回 409。

| 检查                                                                                                                                                                   | 实际结果                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm.cmd run build`                                                                                                                                                    | 通过；TypeScript 与 Vite，1830 modules。原生检查发现的异步加载默认模型/文件夹问题修正后再次通过                                                                                 |
| `node --test tests/conversations.test.ts tests/node-profile.test.ts`                                                                                                   | 7/7；稳定会话/重试去重、来源分类、本机队列、连接显隐、资料持久化和图片/名称校验                                                                                                 |
| `node --test --test-name-pattern 'shared workers register\|offline pending Execution\|two nodes require bilateral\|UDP broadcast fallback' tests/node-network.test.ts` | 4/4；共享目录和重试、离线待执行 fencing、双向配对/重放/撤销、UDP 后备发现                                                                                                       |
| `npx.cmd tauri build --debug --no-bundle --config .data/conversation-native.json`                                                                                      | 通过。配置仅覆盖 identifier=com.rivloom.conversationpreview；同内容已保存为 src-tauri/tauri.preview.conf.json。Debug exe 及内置 Node/OpenCode runtime 就绪，未生成或安装新 NSIS |
| 原生窗口实际操作                                                                                                                                                       | 桌面自动鉴权、默认空白会话、本机消息发送到官方引擎并返回 review、自己的浅色/来访深色历史、历史切换、本机队列、配对机器状态、断线右栏收起；原生截图已检查                        |
| 服务/UI 隔离调试                                                                                                                                                       | 改名、预设图标、上传 PNG、同 Task/session 继续、验收、入站执行与本地 ready 共存、700px 布局、离线缓存与重启保留资料/会话；UI 控制台无错误                                       |
| `git diff --check`                                                                                                                                                     | 通过；源码和文字记录留在工作区，未提交/推送                                                                                                                                     |

服务/UI 数据根 `.data/ui-conversation-57109307-8d03-4142-a7ee-2ade9c735119`：3 个业务 Task，分别 accepted（同一 session 两轮）、入站 review、本地 ready；3 次确定性模型请求；没有真实模型费用或工具调用。`verification.json` 保留状态、资料同步、断开、同身份重启和 cleanup；`blank.png` / `connected.png` / `narrow.png` 为内部渲染检查。此前夹具启动中 DPAPI 沙箱错误、初始化接口期望码修正、非 TTY 输入提前结束未计为通过；原目录均保留。

原生数据根 `.data/ui-conversation-7d7887c4-a421-4425-a56d-7f87fb9aa2ea`：Debug Tauri 与已安装 Release 并存，Computer Use 首次窗口读取授权超时，重试后成功。原生本机会话 `5388032a-1266-467e-a0eb-6df7a9d75948` / 官方 session `ses_f98fd45b1ffeVA8tKV66cB9PNz` 返回 review，1 次本机确定性模型请求，0 工具；自身队列正确显示 1。原生 `restart` 核对同 Node ID、名称、图标、业务 Task ID 保持；`disconnect` 后离线配对资料保留且右侧隐藏。`native-connected.png` / `native-offline.png` 为原生截图证据。

**保留失败：原生双 Brain 自动分配。** 首次 connect 生成 Task `f9b38694-0b5e-446b-9ebd-3432a53ff178`，由 peer 提交给本机承载的 Brain，停在 queued；45 秒等待入站 review 超时，模型请求 0。原 Task 与失败检查仍在 verification.json 中，不重发、不删历史。源码核对确认：createScheduledTask 只在 hosted Brain 候选中排除当前 Node，远端 Brain 的 Master 自身仍可能作为候选；接收 Master 的 scheduleBrainTask 又排除自身，导致没有可执行 Worker。相关代码与 8badf8f 相同，本轮未改调度规则。该结果是后续需处理的既有调度缺陷，不能把原生跨 Brain 完整执行记为通过。另一次独立服务/UI 拓扑中的入站执行通过不覆盖此失败。

自动分配的 HTTP 接口返回网络快照；新 UI 按返回快照中新增的本机提交 Task 选中会话，没有把快照当作单个 Task。此分支做了类型/代码核对，未声称完成上述失败拓扑的端到端修复。本地 ready 队列仍需用户空闲后启动；远端尚无可用控制记录时只读显示真实状态/摘要。2026-09-04 节点网络复查 24/25 再次只留下纯 mDNS 同机发现失败；未做两物理机/真实模型/安装器升级验收。

收尾：两个夹具均输出 CLEANUP 并写入 own processes stopped；交互终端仍持有 stdin 后仅对这两个已清理的终端发送 Ctrl+C（终端退出码 1，不作测试成功退出码）。脚本已补 stdin.pause。最终只读确认 Rivloom 仅剩原安装版 PID 10628，旧 NSIS 仍为 71,083,411 字节、原修改时间；原版没有安装、关闭或重启。

2026-09-04 按用户请求生成另一台机器查看用的独立 NSIS，并在本地备注/`@Node` 完成后重建：`npm.cmd run preview:conversation:installer` 退出 0，产物名 `Rivloom UI Preview_0.1.3_x64-setup.exe`。最新复制件 `.data/distribution/Rivloom_UI_Preview_0.1.3_x64_setup.exe` 为 71,063,972 字节，SHA-256 `76302232ACEC71F35D6854B30F507AEFC703612C0D8A3FBCD9F567EEBE6B0CAA`。preview config 使用 `Rivloom UI Preview` 产品名与 `com.rivloom.conversationpreview` identifier；旧正式 installer 仍为 71,083,411 字节、2026-09-02 原修改时间。预览包未签名，没有在本机或另一台机器执行安装验收。

## 2026-09-03：新会话前保存检查

用户要求保存文档和 Git，下一会话改界面；本轮没有修改产品或测试源码。为保存现有代码基线重新执行：

| 检查                                                                                                                           | 结果                                                               |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| npm.cmd run build                                                                                                              | 通过；TypeScript 无输出错误，Vite 1824 modules，构建退出 0         |
| node --test tests/remote-task-clock.test.ts tests/http-ports.test.ts tests/physical-resume.test.ts tests/physical-race.test.ts | 59/59 通过，0 失败、取消或跳过                                     |
| PowerShell Parser 解析 scripts/desktop-install-smoke.ps1 与 scripts/m34-master-helper-package.ps1                              | 两个脚本均 0 语法错误；未执行安装/打包脚本                         |
| git diff --check / git diff --cached --check                                                                                   | 均通过；暂存区 62 个源码/测试/文档文件，无二进制、运行数据或安装包 |
| 本次交接文档的本地 Markdown 链接检查                                                                                           | 0 个失效链接                                                       |
| 待保存源码/文档的常见凭据格式检查                                                                                              | 原 60 个变更文件 0 命中；仅是提交卫生检查，不声称完整安全审计      |

定向测试使用独立隔离数据和必要的本机临时监听，没有启动物理验收、读取模型凭据、调用真实模型或停止正式节点。构建只更新被忽略的 dist，没有重建或安装桌面包。**本轮没有重跑全量测试，历史 92/93 的纯 mDNS 失败及单独复查失败仍保留**；也没有新增 Rust、原生 UI、安装器或两机验收结果。

.data/verification 的原始报告、运行身份/任务数据库和安装包不纳入 Git，继续原地保留。可追踪的结论、失败和证据路径存入本仓库文档；本地提交不等于运行数据备份或远端推送。

## 2026-09-03 前一结项记录（当时不新增测试结果）

用户在获知双Brain最终completed、M3.4核心物理验收通过及纯mDNS专项仍待查后回复“好，下一步吧”。据该上下文将M3.4当前MVP范围结项，依据下述已完成证据，不修改验收门槛、不把未覆盖行为补写为通过。纯mDNS全量92/93和单独失败继续保留，实际跨机任务使用本机确定性夹具的限制不变。

本回合仅同步文档/ADR实施状态与后续讨论入口，未运行新的自动化或物理测试，也未改产品/助手源码、节点生命周期、配对、网络设置或OpenCode。Git HEAD f5ce9ed和全部既有修改保持。下一阶段仍需产品范围确认，不能从本次结项推导新的HA、人员治理、跨BrainTask或模型登录实现授权。

## 2026-09-03：用户确认继续，原物理 Worker 同身份恢复

### 07:04–07:05Z：B 最终 completed 回执收齐，本轮物理闭环通过

- 用户07:04:36.054Z只读RACE_STATUS：原NodeYtmgnp/Brain024a07/Worker t9MUCF、race2ebbcc36、Task8fe868cc/Executionbe6b9f97均与原绑定一致，Task和唯一Execution历史均completed/seq4/attempt1，summary“已验收”。phase=submitted为一次性助手投递ledger，不影响Task完成判定。来源明确为用户远端控制台，不冒称从5.33读取5.20 loopback或数据库。
- 07:05:25.922Z重用已验证只读检查：A原Task44a77700 completed/seq4/attempt2，原被拒Execution0808698e保留；两Worker业务Taskaccepted/seq4，无pending/control/error。5accepted/5session/7Execution/5Project、原3accepted/3session/4Execution元数据完全一致，0工具part、五测试普通目录为空、原policy不变、slot1/running0。三条可信通道正常；A本机执行仍关闭/业务Task0、不持有BTask。07:05:25.974Z helper请求仍为2。
- **本轮真实两机双Brain共享Worker单槽竞争闭环passed**：真实重叠分配、最终准入拒绝、review占槽、原Task排队续跑、归属/失败尝试历史不变、双Master各自验收、唯一业务会话与最终槽释放，证据完整。报告 `m34-physical-prepared-race-2ebbcc36.json` 的competitionPassed/status已更新，远端最终完整回执保留；不再要求任何重复命令。
- 边界：确定性本机模型，不是新的真实AI编程测试；本轮没有Master离线/故障切换，正常离线/恢复和Project已有历史专项证据，不能扩大为异常断网/有排队Master物理重启。原mDNS92/93仍未修复，不重跑或声称全量绿色；M3.4核心物理验收通过，MVP结项仍待确认。本回合只读核验与文档写入，没有源码、安装、网络、信任、Task控制、进程生命周期或Git提交变更。

### 06:57–07:01Z：B 验收、A 原队列继续与本机最终核验

- 用户B06:57:59.421Z回执首次提供本轮权威Task8fe868cc/Executionbe6b9f97及v2单次submitted ledger（dispatch06:52:28.812Z、finish06:52:28.871Z）。验收即时仍review/seq3，不代表未生效，也不重复验收。06:58:23Z Worker助手已见Baccepted、新A业务Taskreview、模型请求2。后续认证接口确认B业务更新时间06:57:59.983Z/Executionaccepted seq4，回传成功。
- A原Task44a77700保留Brain0ed79c与第一次Execution0808698e failed历史，自动创建第二次Executionde478490（06:58:08.701Z）；业务Task167112f2/Project81ece1b5/session ses_f99f077d4ffeNvFWSbNHUOFpw9仅新增一个。业务创建06:58:08.788Z晚于同Worker上的Baccepted，07:00:25.167Z A权威review/seq3/attempt2。没有新的A Task、跨Brain转移或手工重发。这里只从持久元数据及前后观察确认顺序，不声称连续测量了精确调度延迟。
- 验收前逐项核对两条确定性文字、精确Task/Execution/Project/session绑定、无工具/审批/问题/错误；官方SQLite只读共5session、tool part0；五个测试目录为空。原三条accepted、三个旧session、四条旧Execution完全一致，A本机执行仍关闭/业务Task0，A不持有BTask，三条原可信通道正常。
- 07:00:26.823Z在既有A17068输入一次race-accept，即时review保留。07:01:03.531Z A权威completed/seq4/attempt2，两Worker新Task/Execution均accepted/seq4，无pending/error/control。总5accepted/5session/7Execution/5Project、原policy不变、槽1；追加07:01:03.552–07:01:23.543Z **20,011ms/38次**全部保持槽1/running0/5accepted/7Execution/Acompleted。07:01:36.603Z helper模型累计仍2，无额外调用。
- A queued→第二尝试→完成以及Worker单槽释放已经验证；**B最终权威completed仍待用户只读race-status回执**，不把Worker回传ack冒充直接读远端API。本轮报告补齐后才计整轮通过，M3.4不提前验收。Worker/两正式桌面保留、不重启，不为已有declined邀请扩大恢复预检范围或删除历史。无源码变更，不重跑或掩盖原mDNS92/93专项失败；所有新证据写入 `m34-physical-prepared-race-2ebbcc36.json`。

### 06:49–06:54Z：物理单槽竞争及 review 占槽通过，等 B 验收

- 用户B回执06:49:12.600Z：同UUID2ebbcc36、Ytmgnp/024a07、v2/prepared/fireAt=null/taskID=null。06:50Z原A仍prepared无Task，Worker关闭接单、原3accepted/3session/4Execution、模型0。06:51:33Z临时观察代码错误地读取network.executionPolicy而不是bootstrap.executionPolicy，在任何恢复API前退出；修正后06:52:26.736Z全部前置断言通过，没有重复任务或产品修改。
- 正常API恢复精确原Project c4227a2e/model fixture/m34/ask/单槽一次。20,121 ms/86次状态观察：06:52:29.845Z B业务Task running/唯一新session，A权威Task queued，原归属不变。B Task8fe868cc / Executionbe6b9f97 / WorkerTaskfb49d63f / sessionses_f99f5a54dffe0iIbZ60F6OHsQY / Project1cd4e8ad；A Task44a77700 / 第一次Execution0808698e被Worker declined且无本机Task绑定，原Task保留排队和失败尝试历史。完整ID和变化记录见报告。
- 06:53:01.112Z Worker助手本生命周期模型请求1。06:53:48.950Z认证API、官方只读SQLite和测试目录检查：原3accepted/3session/4Execution字段一致；总4业务Task/4session/6Execution/4Project，仅一新业务会话；A本机执行关闭/业务Task0；无审批/问题/错误，工具part0，各测试普通目录为空，不读取文件内容、不做文件快照或哈希。
- 随后只向原Worker76974输入一次release。06:54:15.632Z B业务Task及回传Execution均review/序号3、deliveryPending=false/error=null，文字结果为本机确定性夹具回复；A仍queued、第一次尝试未重发、Worker runningTasks1/槽0。review占槽断言通过，原历史/4session/0tool/空目录再次通过。
- 当前尚未发B验收，需用户在其所属Master助手执行一次精确race-accept并回传RACE_STATUS；若即时仍review只读复查，不重复验收。B本机权威Task尚未直接取证；后续A原排队自动继续、两任务completed和最终槽释放尚未覆盖，**不计整轮或M3.4 MVP完成**。夹具现在已release，Worker原策略已恢复，禁止按之前关闭状态重新启用或重发。两正式客户端和产品/OpenCode/系统设置未改；全量mDNS92/93待查记录不变。本轮只验证运行现场并更新文档，报告 `m34-physical-prepared-race-2ebbcc36.json`。

### 06:37–06:40Z：B 同身份 v2 更新确认，准备阶段尚未执行

- 用户 STATUS 06:37:19.642Z：原目录/Node Ytmgnp/Brain024a07保持，raceHelperVersion2/product0.1.3、helper/service14132/3044、remote loopback62028/peer62295，Task/model0、Worker通道ready/空闲槽1。本机 06:38:56.912Z 认证 API 匹配该可信 peer 新端口，原完整历史及 policy、A两条completed和原桌面身份核对通过。
- 按既定 prepare 门闩方案，先持久化 baseline/restoreBody，再于06:39:48.809Z仅通过原 Worker 正常 API 保存 enabled=false/ask/Project和model=null/单槽。06:39:52.993Z A已见原Worker accepting=false/槽0；关闭清空配置引用是产品正常语义，Project和历史记录未删。原3accepted/4Execution及A两条completed保持。
- 06:40:28.909Z A session17068准备新UUID2ebbcc36-c079-4c84-ad4e-a6d9cf6a579f成功；version2、fireAt=null、prepared、taskID=null、无claim。06:40:30.859Z复查原Worker gate关闭、B可信通道正常，无新业务任务。B准备回执未收到，不计物理执行或竞争通过，不提前恢复policy。
- 下一步只要求用户B输入相同prepare命令并发RACE_PREPARED。原Worker76974和两正式桌面保持，无额外网络监听/产品/OpenCode变更、无模型调用。报告 `m34-physical-prepared-race-2ebbcc36.json` 含准确恢复配置；如中止需先撤回双方意图，再恢复policy，不能直接启用触发单边任务。

### 06:21–06:31Z：恢复与观察记录

- 正常发现复核：5.33 原桌面看见 5.20 原桌面，online/trusted/channelReady。此前全量 92/93 的失败是禁用 UDP fallback 的纯 mDNS 专项，依旧待查；用户确认可继续正常产品路径的物理争用，不将专项标绿或修改测试条件。
- 06:21–06:24Z 旧 Worker helper/service 11212/39764 返回 ESRCH、API 64758 ECONNREFUSED，app.lock 仍旧 PID；退出原因未知。06:23:50.922Z 原身份/Project/Task/Execution/session 元数据核对；再次证明旧 PID 不存在后，仅把原 lock 改名保留为 `app.lock.stale-20260903-1423`，未删除任何项目或身份数据。
- 06:24:34.007Z `checkPhysicalResume` 全检查通过：3 Project/3 accepted Task/3 session/4 Execution/6 信任保留。06:24:49.505Z 使用安装的 0.1.3 runtime 同根同 Node t9MUCF 恢复，session 76974、PID 996/26240、HTTP app/peer/engine 58866/60127/51469（均高位），模型 0，未重复执行。
- **第一段观察失败保留**：进程 77439 在 `assert(ready(n))` 退出 1；在内存的采样明细没有输出，不能给出准确失败 peer/时刻，也不能计满 90 秒。06:28:40.932Z 只读复查三条通道及两 Master 都正常。不重启、不更改产品或系统设置。
- 后续只读状态变化记录 **06:29:28.575–06:30:58.650Z，90,074 ms、333 次、0 未就绪、0 API 错误、最大资源年龄 5,013 ms**：Worker→A/B/原5.20 桌面全程在线受信通道就绪，两个独立 Brain 在线、A 所见 Worker 接受任务且槽位 1。该后续观察通过，但不能声称前次变化或 mDNS 根因被修复。
- 06:31:40.081Z 再次核对原完整历史/官方 session/6 信任及 execution policy 完全一致，模型 0、槽位 1。未改物理门闩、未准备或创建新 Task。A 控制台 17068 只读检查只有旧 cancelled 2b08e84d，无对应 Task。两正式客户端未停止；本轮观察进程已结束、原测试 Worker 与 A 控制台保留。
- v2 既有 zip 复核 20,017 字节/8 文件、raceHelperVersion=2、无私有数据；不重新打包。下一步仅用户在原 race-v1 目录正常 stop/覆盖代码保留 .data/重开/发 STATUS。远端尚未验证更新、物理争用尚未发生。汇总 `m34-physical-worker-resume-20260903.json`；本轮无代码修改，不重跑已通过的 v2 开发回归。

## 最新：prepared 助手 v2 验证及未解决的 mDNS 失败

- dbc4738a 人工时刻 14:42:44.641Z 过期，入口报 `Schedule must be 5 seconds to 10 minutes ahead`，检查时 14:58Z。校验早于 ledger/Task 创建，A 未 arm、无对应 ledger，原历史不变。不是执行失败或竞争通过。
- TDD：新增 8 测试先因 prepare 未实现失败，原 14 仍通过；实现并补并发/关闭/其他 Task 守卫后 **25/25** 通过。覆盖准备无 POST/无 UTC、准确关闭 Worker/资源新鲜度、放行一次/永久 claim、忙槽不追发、取消/退出时在途读取不提交、重启不重放、uncertain 不重试、精确 Task/Execution 验收、v1 兼容。
- 两轮 `--prepared-race` 均使用安装 0.1.3/未修改官方 OpenCode、独立发现域和本机确定性模型，各 **12 项通过**。报告 `m34-fresh-brains-f36827cf-a09b-4acf-a798-dbc5a6725707.json`：15:10:14.028–15:12:46.323Z，90,407 ms/168 次/最大年龄 5,007 ms。最终源码报告 `m34-fresh-brains-56791fbf-f7a3-4848-8fee-96dee9782895.json`：15:13:55.394–15:16:31.527Z，90,382 ms/168 次/最大年龄 5,028 ms。prepared 时 0 Task/session/model；真实 policy 开放后各一次提交，一执行一排队/review 占槽，Master 正常恢复、原队列继续，最终 3 accepted/3 session/3 夹具请求/0 tool/普通空文件夹，全部自有服务退出。仅同机，不代替物理双机竞争。
- **全量失败保留**：正常用户上下文 `npm test`，93 项、92 通过、1 失败、0 跳过、72,384.0957 ms。原有 `two isolated Rivloom instances discover and cryptographically verify each other`（禁用 UDP fallback，纯 mDNS）在 `tests/node-network.test.ts:1485` 的 `testPeers.every(node => node?.verified)` 失败。单独同名复查仍失败（1 项/0 通过/21,578.4743 ms）。原因未知，不改阈值/跳过/网络设置，不能声称并行负载导致或发现根因已修复。
- TypeScript、定向 Prettier、git diff --check 通过。v2 zip **20,017 字节 / 8 文件** 严格白名单，无私有数据/二进制；旧包保留。同一已停止烟雾目录覆盖代码后 e8n8VI/3c0057 保留、v2、0 Task/model、race-status=[]，正常 CLEANUP/CMD 退出 0。旧 A 控制台 97010 退出，不停桌面。
- 15:15:49.478Z 物理 API/官方 session 检查原 3 accepted Task/3 session/4 Execution 与路由保留，A 两条 completed，两 Master 通道正常。policy 仍原 enabled/ask/Project c4227a2e/model fixture/m34/maxConcurrent=1，未改门闩；15:16:33.363Z Worker helper 模型 0、槽位 1。物理准备/放行未进行，远端未更新 v2。
- 按 executing-plans 重复失败停点暂停新的物理竞争，报告并请求用户是否先排查发现问题；仅文档收尾，不继续改产品/网络或循环重试。汇总 `.data/verification/m34-prepared-race-helper-preparation.json`。

## 历史：同步竞争助手 v1 的本机验证通过，物理竞争未开始

- 用户 14:32:46.504Z B `race-status` 明确 races=[]。14:33:44.475Z API/SQLite 官方会话只读复查：原历史完全一致、A 两条 completed、Worker 3 accepted Task/3 session/4 Execution、槽位 1、两 Master 通道正常；14:34:42.563Z A ledger 旧轮 cancelled/task=null。上一轮可确认为无执行的协调取消。新 UUID dbc4738a 只准备了 B 命令，A 未 arm，不计任何争用/执行通过。

- 本次物理协调未完成竞争：B RACE_ARMED 未回传，A 于 14:21:02.983Z 在目标 14:21:18.535Z 前取消 `2b08e84d`，phase=cancelled/dispatchedAt=null/taskID=null。14:20:13.808Z–14:21:48.573Z 只读观察 178 次，无 A 新 Task、无 Worker 新邀请/业务 Task/session，原 3 Task/session、槽位 1、两条 Master 通道正常；观察进程退出 0。报告 `m34-physical-race-2b08e84d.json`。未读取 B ledger，不能从 Worker 无执行推断 B 没有 arm/queued Task；等待用户 race-status，不自动补发、不计物理竞争通过。

- 用户授权后的原 Worker 正常重启/同根恢复通过：旧 session 38378 CLEANUP/退出 0，14:12:32.380Z 锁已自然释放且 3 Project/3 accepted Task/3 session/4 Execution/6 信任预检一致。14:13:06.419Z 新 session 67853、helper/service 11212/39764、端口 64758/54356/51071，原身份保留，A 与新 B 通道恢复。14:14:13.505Z–14:15:43.516Z **90,011 ms / 87 样本 / 18 次资源刷新 / 最大年龄 4,957 ms** 全通过，正式桌面运行描述/PID 不变，原历史不变；14:16:33.371Z 新夹具请求 0、未 release，旧生命周期累计 2 单独保留。报告 `m34-physical-worker-discovery-restart.json`。本机发现异常根因未确认/未修复，不因恢复就改记为故障修复通过。
- A 已于 14:16:32.241Z 安排 race `2b08e84d-1a63-4f1c-953a-8ace7aa55c81`，目标 UTC 14:21:18.535Z；B 相同命令已发用户、待其 RACE_ARMED。当前未发新 Task，不提前计竞争通过。

- 新 B 配对通过：14:04:21.655Z 核对精确 Node/Brain、用户新码、请求 `85af9af3-589b-4999-a1f6-24d364665b09`、remoteConfirmed=true/localConfirmed=false 和有效期后，14:04:51.380Z 通过原 Worker 正常 API 确认。14:04:54.157Z trusted/channelReady=true、Brain established/online、原 Worker 注册/槽位 1、pendingPairings=0，旧 3 accepted Task/session 保持；14:08:01.852Z helper 模型累计仍 2。无新 Task。
- 本机发现诊断仍未通过：正常用户上下文在物理网卡 192.168.5.33 做 6 秒 mDNS 只读 PTR 查询，仅收到 5.20 的新 B/原桌面，未见本机 A/Worker；未发布服务，临时 socket 已销毁。读取相关 UDP 端口/组播路由/网卡优先级后仍不能确定根因，尤其不能由共享端口枚举缺某 PID 就认定该进程没有 socket。未修改系统设置、信任或代码。已申请原目录重启测试 Worker 进行恢复核对，用户回复含义不明确，未执行；物理竞争尚未开始。

- 13:51:12.699Z 用户 STATUS 确认新 B 同 Node Ytmgnp/Brain 024a07/原数据根恢复，0.1.3/race helper v1、helper/service 3852/2628、app/peer 58225/56585、Task/model 0。13:51:35.700Z Worker API 确认新端口在线未信任、旧配对已清空、3 accepted Task/原 session、槽位 1，A 两条旧 Task completed；A↔Worker 仍互不可见。已要求在现有助手窗口重新 pair 回传短码，未确认配对、未 arm/发任务。未独立读取远端锁备份，只计该新身份重新启动通过，不计恢复旧已删除 Brain。

- 13:48Z 用户确认已关闭后台助手，属于用户现场确认，未取得远端进程列表。按此条件给出仅重命名原 app.lock 为 `app.lock.stale-20260902-2148` 的可恢复操作指引，再同目录启动；指引尚未由用户回报执行，不记为锁已处理或身份恢复通过。旧配对已到期，保持未确认，无新 Task/arm。

- 新助手启动错误检查（13:30–13:31Z）：用户回传短码与 Worker incoming pairing `63e6d1ec-0d50-4a16-bfb7-98851360750d` 一致，remoteConfirmed=true/localConfirmed=false、13:33:53.564Z 到期；未进行确认写操作。Worker 已不见新 B，但原 5.20 桌面通道正常。受限外网请求 EACCES 后，获准正常上下文 13:31:15.784Z 对已知两个 peer 只读 hello：63344 ECONNREFUSED、59725 HTTP 200/原 As64SU 身份。用户的 app.lock 断言只证明存在锁，不能证明活进程或直接删除；下一步核对原助手窗口/精确进程。没有重启、改锁/数据/产品或发 Task，详见 `m34-physical-new-brain-checkpoint.json`。

- 用户确认回收站没有旧助手，并授权用新 Ytmgnp/Brain 024a07 继续。此为新身份续测，不计旧 cS1v1p/b1292e 恢复，旧证据和 Worker 任务归属保留。13:14:19.080Z 两个本机认证 API、13:14:38.923Z 原 Worker status 核对：新 B 在线未信任、无待配对，3 accepted 业务 Task/原 session、槽位 1、模型请求仍 2，A 两条旧 Task completed。但 A 与 Worker 互不在 nearby 列表，二者到 5.20 原桌面均 trusted/channelReady，故不能计当前共享拓扑通过。已请用户新助手 pair 回传短码，未确认 Worker 一侧；仅做只读互联检查，未 arm/提交任务。
- 13:17–13:18Z A↔Worker 只读诊断：双方信任数组仍含对方，原 peer 53946/64916 的 TCP 在本机接口均可达，LAN hello 均返回 HTTP 200/原 Node ID。受限诊断上下文 3 秒 UDP 广播无回复、LAN/loopback 单播只收到 A，不能据此断言安装进程的广播同样失败。Get-NetIPAddress/Get-NetTCPConnection 在受限上下文拒绝访问；未修改防火墙/网卡/时钟，未重启服务。根因未确认、竞争继续暂停；证据 `m34-physical-new-brain-checkpoint.json`。

- 用户随后确认旧 5.20 助手文件夹误删，原身份数据是否能从回收站恢复尚待核对；不将新目录的 Node 视为升级后身份保持，也不能从 Worker 回传记录重建原 Master 私钥或权威任务。暂停配对/arm，先恢复原 .data，若不能恢复则需要用户明确选择新身份续测；保留此前真实通过的历史证据，不改 Task 归属、不默认重做。

- 远端更新检查未通过身份保持条件：用户 13:02:09.556Z STATUS 虽为 raceHelperVersion=1，但 root 在新 race-v1 文件夹，Node YtmgnpZtwNcSWpdPvAWuhf3IREFuNfEt / Brain 024a0766-64db-4419-a4cc-7b0d53688927、0 Task/model，不是原 cS1v1p/b1292e。13:05:49.649Z Worker 认证 API 确认新 Node 在线/未信任/未配对，原 B 离线、3 accepted Task/槽位 1 保留。未配对新身份、未 arm；要求 stop 新助手后把同一个 zip 的代码覆盖原助手文件夹并保留旧 .data，再核对原身份。未读取远端旧数据，不能断言已删除；此反馈不影响先前物理通过事实，也不计新版原身份升级通过。

- 新增 14 项控制器测试，验证规范 UTC/窗口、身份和唯一 Worker、重复 UUID/并发调用、取消/迟到、不确定 HTTP 不重试、只读 status、精确归属和序号验收、重启不恢复定时器、退出取消安排及未完成任务保护。初次先缺模块失败，实现后通过；TypeScript 曾发现闭包赋值的可空控制器清理路径收窄错误，修正访问方式后通过。全量 **82/82**、0 跳过、55,189.3791 ms，TypeScript/Prettier/diff 通过。
- 首次受限环境全量 74 通过/8 失败（44,977.7065 ms），DPAPI 私钥保护不可用导致节点网络不开启；完整服务也因 local=null 在首个端口检查退出，0 模型调用、测试服务全部停止，保留 `m34-fresh-brains-b821a673-459d-4b93-a757-601c1b19c41b.json`。公开字符串的独立 CurrentUser DPAPI 回环在沙箱失败、获准正常用户上下文成功；之后相同全量/服务测试通过，未关闭 DPAPI、改系统安全或替换身份。
- 同机真实服务报告 `m34-fresh-brains-7c58b90b-0c8d-4302-95e8-9fe2d598cdd1.json`，12:51:51.891Z–12:54:26.002Z，**11 项通过**。稳定 90,068 ms/166 次、最大资源年龄 5,008 ms；新控制器同一 race d34f86c0 于 12:53:52.719Z/.721Z 分别提交，只产生一个执行/会话、另一权威 Task 排队，review 占槽，排队 Master 停止/同身份重启后原任务继续。最终 3 accepted Task/3 官方 session、3 次确定性模型请求、0 工具调用，服务均已停止。仅同机，不计物理竞争通过。
- 新版实际 CMD 入口用原本机烟雾 Node e8n8VI / Brain 3c0057 恢复，12:57:04.966Z status/race-status/stop 通过，Task/race/model 均 0，CLEANUP=true、退出码 0。首次将命令管道提前送入暴露 readline 在启动期消耗命令，已把读取推迟到命令循环；只清理零任务烟雾 helper PID 29704，确认子服务 PID 14564 不存在后将其残留 app.lock 移为 smoke-aborted-lock-14564.json，保留可恢复证据和原身份。未清理用户/物理实例。A 端只读控制台 12:57:32.073Z 正确附着原 tRCQ1_/Brain 0ed79c、races=[]、正常退出且不停止桌面。
- 新包 `.data/distribution/Rivloom_M3.4_Master_Helper_0.1.3_race-v1.zip` **18,870 字节/8 个枚举文件**，无 .data/身份/凭据/数据库，旧包保留；可复用脚本 `scripts/m34-master-helper-package.ps1` 拒绝覆盖已存在包。用户须只更新 5.20 原助手代码、保留 .data 后回传 STATUS，再协调 arm；此时尚未更新远端或发新物理 Task。12:58:49.652Z 原 Worker 3 accepted Task/原 session、槽位 1、夹具本次请求 2 不变。
- 汇总 `.data/verification/m34-physical-race-helper-preparation.json`；计划 [物理竞争助手](plans/2026-09-02-m34-physical-race-helper.md)。本轮只改测试/交付助手和文档，不改产品，不重建安装器、不 fork OpenCode，不要求 Git 或扫描文件建立快照/哈希。M3.4 仍待物理同时竞争及最终确认。

## 前一检查点：远端 Master 正常离线/恢复与 Project 任务闭环通过（12:22–12:34Z）

- 用户 12:22:11.852Z helper STATUS 报告 B offline、API null、模型 0。助手源码在 offline 时不读取任务，tasks=[] 不作为删除证据。12:24:00.678Z Worker/本机 Master A 认证 API 确认 B 离线且归属 Master cS1v1p 不变，A 在线，原两桌面通道保持、Worker 槽位 1、无自有 Brain，两个已验收业务 Task/三条旧 Execution 保留。
- 12:25:20.041Z 由 A 提交一次 Project Task 0119d3eb / Execution 478658f7，限定 c4227a2e；12:25:23.171Z 的第 4 次观察为 review/序号 3，唯一业务 Task 455eefc8 / 官方 session ses_f9deb4729ffejtK9Y451ujwmL7。请求与实际 Project ID、原 `worker/authorized-folder` 路径一致，3 Project 数量未增加，官方 session 总计 3、0 工具 part、文件夹为空、没有文件快照/哈希。Master A/Worker 槽位均 0，B 在这些采样中持续离线，旧 Execution 身份/归属/序号/执行状态未变，A 不持有 B Task。
- 12:25:59.704Z Worker helper 本次累计模型请求 2（此前 1）；只用 fixture/m34，已读到预期短文字结果，无错误/审批/问题。新 Project Task 保留 review，供后续同身份恢复时验证占槽。
- 用户 12:31:12.566Z online STATUS：原 Node cS1v1p、Brain b1292e、数据根及 B Task 8923109f / Execution 818ffb44 completed/序号 4 保留；helper PID 7412、service PID 9824、app 61533/peer 59845、本机模型调用 0。即时 channelReady=false，但 12:31:46.700Z Worker 认证 API 已确认同一 peer 在线受信、通道就绪。未重新配对或调用 5.20 loopback API，不以跨机器时间戳推导精确恢复耗时。
- 12:32:43.641Z–12:33:04.292Z 恢复观察 **20,651 ms / 21 次 / 6 次资源更新通过**，Master A 报告最大年龄 4,913 ms；B Master/Brain 未变且正式在线，原通道保持，Project Task review/序号 3 持续占槽 0，无重复业务 Task/官方 session，旧归属/执行状态保留。只读官方数据库仍为 3 session、0 工具 part，授权文件夹为空。
- 12:33:58.361Z 仅经 owning Master A 发出对 Project Task 0119d3eb 的验收控制；12:33:59.470Z 第 2 次检查为 Master completed、Worker accepted/序号 4，Worker 与 Master A 所见槽位 1，deliveryPending/controlPending=false、deliveryError=null。三个业务 Task 全 accepted，三个原会话及两条已验收旧 Task/Execution 保留。12:34:19.497Z helper 确认模型累计仍 2，没有恢复重跑。报告已补齐远端恢复和最终验收证据，此项通过；物理同时竞争和离线期间排队任务恢复仍不计通过。
- 初次只读预检把原授权路径误放在外层 run 根；对照 helper 源码确认为 `worker/authorized-folder`，修正诊断断言后通过，未移动/改写 Project。报告 `.data/verification/m34-physical-master-offline-project-0119d3eb.json`；未改产品或测试源码，不重跑/冒称新全套回归。远端停止发生于 5.20，A 和 Worker 均在 5.33；不将此 Project 执行当作另一条跨物理机任务，也未验证异常断网、同名 Project 负例或同时竞争。

## 前一检查点：Brain B 跨机 Task 完整闭环通过（12:06–12:17Z）

- 用户 5.20 助手 STATUS（12:06:55.171Z）给出 Brain b1292e / Task 8923109f / Execution 818ffb44，assigned/序号 0、Master 本机模型调用 0。实际 5.33 原 Worker 已绑定唯一业务 Task 73a95c90 和官方 session ses_f9dfc2d61ffeHD55NRsJsKCiyb；该 Task 只归属原 Brain B，没有出现在 Master A 的权威任务中。
- 手动释放本机确定性模型后，12:08:44.007Z 检查为 review/序号 3、回传无 pending/error、槽位仍 0。Portable Project 545085d1 的路径严格对应该 Execution 本地目录，目录为空、官方数据库工具 part 为 0；没有使用文件快照/内容哈希，也不宣称真实 AI 编程或 Project Task 验收通过。
- 用户按指引执行 accept，12:12:18.422Z 即时 STATUS 尚为 review/序号 3。12:13:48.766Z Worker 已 accepted/序号 4、controlPending/deliveryPending 均 false、deliveryError=null；Worker 和 Master A 所见槽位均恢复 1，原 completed Task 45b70f73 / accepted 业务 Task 503ce474 / 原 session 保留。共 2 个业务 Task、3 Project、2 官方 session，只有本次新增的一份执行，没有重复会话。用户补充的 12:16:56.146Z 最终 STATUS 确认 Master B 同一 Task/Execution 为 completed/序号 4、本机模型请求 0，补齐完整闭环证据；没有从 5.33 直接调用远端 loopback API。
- 12:14:14.405Z 原 Worker 助手再确认本次模型请求累计 1。夹具已 release，后续同一进程中的请求会直接回复；未来竞争/故障场景不能误以为仍暂停。一次只读检查因误用 network.localWorker 字段失败，改为实际 network.local.worker 后通过，未修改产品状态以满足检查。
- 报告 `.data/verification/m34-physical-brain-b-task-8923109f.json`。此处是 5.20 Master 到 5.33 Worker 的单条真实跨机执行及 Worker 验收，**不是双 Brain 同时竞争**。本轮未改产品/测试代码，未重跑历史 68 项全套；物理竞争、Project 固定、Master 离线/同身份恢复及 M3.4 MVP 确认仍未完成。

## 前一检查点：0.1.3 保持原身份、恢复 Worker 与 5.20 助手准备

后续物理接入（11:22–11:25Z）：用户已在 5.20 启动独立 Brain b1292e，Node cS1v1p，与原 Worker 核对短码后完成双边配对；远端用户 STATUS 证实 0.1.3、可信加密通道、0 Task/模型调用。90,993 ms / 88 次采样 / 19 次资源更新通过，最大 Master A 报告年龄 4,990 ms；原 Worker 同时登记两个正式 Brain，无新执行，旧 Task/session 保持、槽位 1，结束后本次模型调用仍 0。实时检查来源为 Worker 认证目录和 Master A API；Master B 侧是用户提供的控制台状态，未冒称直接读取远端应用 API。报告 `.data/verification/m34-physical-dual-brain-directory.json`；执行、竞争、Project 和故障验收仍待继续。

- 10:56:22Z，5.33 安装 runtime/桌面描述实际为 0.1.3，Node tRCQ1_、Brain 0ed79c、completed Task 45b70f73 和 Execution 2414f24a 保留；5.20 Node As64SU 保持受信/加密就绪。远端 0.1.3 以用户安装反馈为据，不能把高位 peer 端口当作 EXE 版本证明。
- 新增 13 项已完成任务恢复校验，包含拒绝活动/待验收任务、丢失 session、非夹具模型、待处理交互、变更归属、待回传/准备租约、可重放邀请和错误 Project 路径。全量 **68/68 通过**、0 跳过、52,590.3439 ms；TypeScript、Prettier 通过。测试先因新导出尚未实现而失败，随后一项测试的坏 ID 先触发归属检查；修正该测试输入后全通过，没有改业务数据规避断言。
- 安装 0.1.3 从原目录恢复 Worker，保留原 Node、两 Project、accepted Task、一个官方 session、新旧两条 Execution；启动没有新增模型请求。90 秒实际网络观察通过：90,090 ms、87 次采样、19 次资源更新、最大年龄 4,928 ms，原互信通道/空闲槽 1/已验收结果保持。11:07:36.555Z 助手状态确认模型调用仍为 0。报告 `.data/verification/m34-physical-upgrade-0.1.3.json`，范围是原身份和单 Brain 拓扑恢复，不等于双物理 Brain 验收。
- 5.20 免安装助手本机验证：从全新隔离发现域自动形成 Brain，再同目录接入常规发现；`offline` / `online` 与实际 CMD 入口再次启动保留 Node e8n8VI / Brain 3c0057，0 配对、0 Task、0 模型调用，验证后正常停止。仅验证助手启动/恢复，配对/提交/验收命令尚待真实物理阶段。包 `.data/distribution/Rivloom_M3.4_Master_Helper_0.1.3.zip` 13,488 字节，7 个文件，已核对不含 `.data`、身份、凭据或数据库；不是安装器，不修改官方 OpenCode。详见 [执行计划与记录](plans/2026-09-02-m34-completed-worker-resume.md)。

## 历史操作：5.33 原 Worker 已停止待升级（2026-09-02T10:49–10:51Z）

用户授权停止后，原助手 `status` 确认 0 个运行任务、1 个空闲槽位、唯一业务 Task 已 accepted、模型请求累计 1；`stop` 返回 `CLEANUP stopped=true`，原 session 77892 以 0 退出。旧安装目录关联进程检查为空，Worker `app.lock` 消失。只读 SQLite/JSON 检查确认原 Node、两个既有 Project、已验收 Task/官方 session 及新旧 Execution 保留，信任/拓扑/策略文件存在。第一次检查误将 Project 总数断言为 1，复查确认另一个为既有 Portable Project，未改数据。汇总 `.data/verification/m34-physical-stop-before-0.1.3.json`；详见 [物理记录](plans/m34-physical-acceptance.md) 末节。仅完成停止和留存核对，不代表 0.1.3 交互升级或 Worker 恢复通过；安装由用户进行，卸载旧程序时不要勾选删除应用程序数据。

## 高位 HTTP 端口修复 / 0.1.3（2026-09-02）

用户明确要求修复并使用较大端口。Rivloom 的桌面后台、节点 HTTP 通信和官方 OpenCode 启动包装器自动端口均改为 **49152–65535**；端口占用/系统保留错误最多重试 64 个候选，显式固定端口不自动换号，并拒绝 Fetch 禁用端口。原生桌面也拒绝低端口启动 URL。UDP 发现端口、绑定地址、认证、Brain 规则和 OpenCode 二进制未变。实现与完整证据见 [修复计划](plans/2026-09-02-m34-high-http-ports.md)。

- **55/55 Node 测试通过**，0 跳过，54,548.0482 ms；包含原 43 项、10 项端口分配测试及 2 项真实官方引擎测试。OpenCode 占用端口实际只报 ServeError，包装器依据失败子进程退出后的 OS 绑定探测判断是否换端口，不依赖错误文案，不重试其他引擎故障。
- 原生 Rust URL 边界测试 **1/1 通过**；TypeScript、Vite、Prettier、Cargo fmt/clippy 和 diff 检查通过。低端口 1719/49151、非 loopback、非 HTTP 和异常路径不能作为桌面后端 URL。
- 新 0.1.3 打包运行时完整服务回归 **11 项全通过**：自动独立形成 Brain、共享 Worker、90.3 秒稳定、同名 Project 不替代、竞争单槽、review 占槽、Master 停止、指定 Project 执行、同身份重启、原队列继续执行，以及启动/重启的三类 HTTP 高端口。报告 `.data/verification/m34-fresh-brains-bd24ebd5-73b6-423c-860a-12a73b41ffa3.json`；07:50:07.800Z–07:52:43.820Z。167 次稳定采样，最大报告年龄 4,997 ms；6 次服务启动/重启、18 个端口全部符合范围。
- 3 个已验收业务 Task / 3 个官方会话、3 次本机模型请求、0 工具调用；文件夹为空且无 Git。排队 Task 保持原 Brain，恢复后第 2 次 Execution 完成，没有重复业务 Task/会话。新测试进程全退出，旧失败报告保留。
- **范围限制**：上述完整回归在一台物理 5.33 上，模型为本机确定性夹具；不等于两机物理双 Brain 或真实 AI 编程通过。没有安装/升级用户客户端，也没有用新原生 Release 窗口重新跑 UI 闭环。07:53:35Z 原两台与原 Worker 的通道仍正常，已验收 Task 45b70f73 保持 completed，原 Worker 槽位 1。M3.4 MVP 尚未整体验收。
- 0.1.3 打包成功：`src-tauri/target/release/bundle/nsis/Rivloom_0.1.3_x64-setup.exe` **71,083,411 字节**；Release EXE **10,266,624 字节** / ProductVersion 0.1.3。新包尚未安装；旧 0.1.2 安装及当前进程未被覆盖。升级前需协调退出桌面和安全停止原测试 Worker，不能在安装 runtime 被占用时直接覆盖。

## 历史：0.1.2 全新 Brain 生命周期补测（2026-09-02）

用户确认物理文字任务“已验收”后继续测试。本轮仅新增隔离测试脚本及文档，不改产品或 OpenCode，不重装、不改正式节点信任/数据；完整过程见 [补测计划与结果](plans/2026-09-02-m34-fresh-brain-regression.md)。

- 现有自动化 **43/43 通过，0 跳过，51.9 秒**；TypeScript、测试脚本 Prettier 和 diff 检查通过。
- 新测试不预建身份、不直接写拓扑：两个全新测试 Node 在各自独立发现域自动从 provisional 变为 established，再用同一数据接入共同发现域。**7 项断言通过**：独立形成、共享 Worker、90.2 秒稳定、同名项目不替代、双 Brain 单槽竞争、review 占槽、停止一个 Master 后另一 Brain 仍可在指定 Project 执行且不接管任务。全部在物理 5.33 上运行、使用安装的 0.1.2 和本机确定性模型，**不算双机物理验收**。
- **整体仍失败**：重启 Master B 时，产品 `PORT=0` 实际获得 `127.0.0.1:1719`；Node Fetch 拒绝 `bad port`，故身份/任务恢复及队列继续执行未验到。现机 TCP 动态端口范围 1024–15000 包含此端口；Rivloom 后端和原生启动代码未筛选浏览器受限端口。Node 本地源码与 [Fetch 规范](https://fetch.spec.whatwg.org/#port-blocking) 均列明 1719 被禁止。推断同一路径存在桌面启动风险，但本轮没有原生 WebView2 在该端口失败的直接证据；不能称为引擎或 Brain 持久化损坏。
- 报告 `.data/verification/m34-fresh-brains-793f9de8-5d9f-4e31-b544-92d2524b7c77.json` 保留失败。此前首轮报告 `m34-fresh-brains-fd6d1d89-5081-4446-8ebe-2ad6f49c44d8.json` 是测试代码将返回的网络状态误读为单条 Task，已修正并完整重跑，不能作为产品缺陷或竞争通过证据。
- 第二轮结束时第一条 Portable Task 已验收，Project Task 已返回结果但仍待验收，另一 Brain 的 Task 排队。只产生 2 个业务 Task/官方会话、2 次本机模型请求，官方工具 part 为 0。新建测试进程均退出、隔离数据保留。07:29:38Z 正式两台与原 Worker 的三条可信通道仍就绪，用户的 Task 45b70f73 仍 completed，Worker 空闲槽位 1。
- 下一步建议先确认并修复 Rivloom 本机 HTTP 端口选择，再完成重启/队列回归及物理双 Brain 测试。本轮没有修产品、构建新安装包或宣称 M3.4 MVP 完成。

## M3.4 回执时差修复 / 0.1.2（2026-09-02）

当前任务结果：`M3.4 新节点文字任务 A` 的单 Brain 三节点闭环 **通过**。5.20 提交的 Brain Task `45b70f73-e911-4f65-8e75-db31c3efa2fa` 由 5.33 的 Brain 0ed79c 持有，Execution `2414f24a-a968-4e19-8b5d-24b493e7db4e` 交给原 Worker。仅 1 个业务 Task `503ce474-6c44-4152-b8db-4f31015595be` / 官方会话 `ses_f9f184136ffexqtgBdYAJ7vpb4`，确定性模型请求 1 次、官方 part 工具调用 0 次；普通 Portable 目录始终为空，无 Git/快照/哈希。running 2 → review 3 → completed 4 有序回传；review 槽位仍占用，助手通过 Master 验收后恢复 1，完成消息获得提交节点成功应答。旧失败 Execution 保留未绑定。报告 `.data/verification/m34-physical-single-brain-task-45b70f73.json`；用户已明确反馈 5.20 显示“已验收”（记录于 07:06:54Z），保留其实际用词，不推定具体状态徽标文字。Master 和 Worker 同在物理 5.33，仅提交/回传跨机器，因此不冒充物理 Master/Worker 时差、双 Brain 竞争或整个 MVP 通过。本轮无产品修改，自动验收明确仅针对本条夹具任务。

最新：新节点接入实际 Master **通过**。用户完成 5.20 ↔ 5.33 配对后，5.20 自动撤回临时 Brain fb03a2、加入 5.33 的正式 Brain 0ed79c；Worker 与 Master 的目录同步撤回临时登记。`06:45:49.673Z` 至 `06:47:20.314Z`，90,641 ms、89 次只读采样通过：三条受信通道正常、仅同一正式 Brain 在线、Worker accepting/空闲槽位 1；Master 收到 19 次不同采样时间的报告，最大年龄 4,994 ms。两方收到的 5.20 认证目录持续声明同一 Master，未直接读取对端数据库或逐帧检查 UI。业务 Task/Brain Task 为 0，助手观察模型请求 0 次。摘要 `.data/verification/m34-physical-adoption-20260902T064549Z.json`，本轮未改产品代码。该结果修正了下面将等待直接定为自动形成 bug 的判断；不代表双 Brain 竞争、任务执行或全部等待边界通过。

测试前提复核（06:41:27Z）：清空后并非两个已形成的正式 Brain；5.20 只信任无 hosted Brain 的 Worker、未信任实际 Master 5.33。按 ADR，应先验证新节点与实际 Master 互信后接入现有 Brain，不能仅因下面的 provisional 断言失败就要求其强制正式化。纯内存对照通过：Worker 空 hosted 目录不触发接入，真实 Master established 目录触发临时 Brain 撤回。原服务测试预先生成 Master 身份、按旧版本迁移为 established，不能覆盖此新安装前提。实际新节点接入仍待用户发起 Master 配对；本轮未改产品代码或实际信任，双 Brain 和等待广告边界仍未通过。

最新物理检查：用户截图中的两条配对与 Worker 当前会话一致，2026-09-02T06:32:44Z 两端均完成可信通道。随后新拓扑 90 秒检查在首轮 established 断言失败，不能记为通过；至 06:35:41Z，5.20 Brain `fb03a2d7-2aa6-482b-8668-c17ce30af08f` 仍 provisional、5.33 established，两条通道正常且原 Worker 有一个空闲槽位。实际 5.20 拓扑的排名结果为 0 候选。安装代码及纯内存复现确认：仅发现未受信节点的 established 广告也能持续阻止本机正式化，调度却只接受 established。未直接读取远端完整内部候选或源码，证据范围见物理记录。当前暂停新任务，本轮未改产品代码或真实拓扑文件；历史时差回归仍有效，但不能覆盖本次自动形成问题。

用户安装后检查：本机确为 0.1.2，新 Node `tRCQ1_OopLOZTbZpU-vnFboWPwj69ob7` 创建于 `2026-09-02T06:09:41.701Z`，初始 Project/Task/Brain Task 为 0、无信任文件；5.20 新 Node 为 `As64SUH5wlu5deeBDPuHLsE47DWempcQ`。用户随后确认卸载时删除了应用数据，故不是覆盖升级保持数据测试，也不作为安装器丢数据证据。5.20 版本尚未独立读取，用户反馈已安装；详见 [物理记录](plans/m34-physical-acceptance.md)。

原 Worker 恢复检查：测试脚本支持显式 `--resume-root` / `--expect-node`，在启动前只读确认限定根目录、无链接跳转/运行锁、原身份、专用 Project、仅本机模型及没有业务 Task；仅允许保留失败且未绑定执行的旧接受回执。4 项检查通过：真实基线匹配、拒绝正式客户端目录、拒绝不同 Node ID、拒绝无效 Node ID；TypeScript 和 diff 检查通过。2026-09-02T06:21:41.240Z 实际从安装的 0.1.2 恢复同一 Worker/Project/旧 Execution，官方 OpenCode 就绪、一个空闲槽位、业务 Task 0、模型请求 0。只刷新本机测试模型的临时端口配置，没有修改身份、旧信任、项目策略或实际 Task/Execution。已向两个新身份发起配对并确认 Worker 一侧，等待真实客户端人工比较/确认；尚未计为新拓扑稳定或执行通过。本轮只改测试助手和文档，未重建产品或重跑已有 43 项全量回归。

升级前清理检查点：用户确认两台桌面关闭；2026-09-02T05:00:47.658Z Worker 观察两个 Master 离线，本机桌面进程数为 0。仅向已核对的物理助手发送 `stop`，返回 `stopped=true`、模型调用 0 次；助手/Worker 原 PID 已退出，隔离目录中的身份、信任及远端 Task 文件保留。用户自行升级，本轮没有替用户运行安装器。

用户在物理 Task A 停点后授权修复、补回归和重打包。实现与安全边界见 [修复计划](plans/2026-09-02-m34-clock-skew.md) 及 ADR-0004；没有修改实际 Task/Execution、配对、系统时间、防火墙或 OpenCode。

- 新增 `tests/remote-task-clock.test.ts`。旧实现运行结果为 5 通过/6 失败；修复后 **11/11 通过**：正负 50 ms、5 s、60 s、非法/超界时间、路由/幂等键不匹配、接受/拒绝、准备与执行状态、重复/乱序消息、取消/过期（包括过期 tick 前的边界）及已接受后重试。仅使用临时 Store，没有启动引擎或修改用户文件。
- `npm.cmd test` **43/43 通过，0 跳过**（54.1 s，正常 Windows 用户上下文）。包含旧的真实加密网络故障回归：pending 离线重派、取消包丢失、迟到接受被拒绝、accepted 未知等待。
- 负 5 秒完整服务回归 **8 项通过**：从 `src-tauri/resources/runtime` 的新 0.1.2 随包代码启动三个独立服务，显式测试 preload 只偏移 Worker 后端进程的 Date。90 秒稳定性、两个 Brain 竞争仅一个业务 Task/官方会话、Portable 普通目录、review 占槽、结果归属和本地启动不能绕过均通过。模型仅为 loopback 确定性夹具。报告 `.data/verification/m34-service-clock--5000.json`，根 `.data/m34-service/1788323988930`，业务 Task `a8486266-0b94-45d8-baa5-82db5bac52cd`、官方会话 `ses_f9f9399fcffesH3Sds632AtcKK`。
- 原正 5 秒 Worker 注入运行失败，报告 `.data/verification/m34-service-clock-5000.json` 保留。官方引擎已完成 assistant（`finish=stop`），但其创建时间 `1788324269886` 早于被人工拨快的后端 `runAfter=1788324274276`，差 4390 ms；`task-service.ts` 的本机本轮消息筛选排除了它，测试等待 review 超时后按正常清理转 interrupted。该注入人为破坏 Worker 后端与本机 OpenCode 共用时钟的前提，不作为实际机器间时差失败，也不因此修改产品的消息筛选。
- 修正为只偏移两个不执行任务的 Master 后端，Worker 和官方 OpenCode 始终共用真实本机时钟；不注入或修改引擎。Master 慢 5 秒（Worker 相对快 5 秒）**8 项通过**，报告 `.data/verification/m34-service-master-clock--5000.json`；根 `.data/m34-service/1788324470046`，业务 Task `0b876c1e-2238-4eee-bc0d-b4773c081555`、官方会话 `ses_f9f8c6cceffeXjMYDnZylYjsde`。Master 快 5 秒（Worker 相对慢 5 秒）也 **8 项通过**，报告 `.data/verification/m34-service-master-clock-5000.json`；根 `.data/m34-service/1788324612004`，业务 Task `02c260e2-c44d-41dd-a49e-87040076d4ca`、官方会话 `ses_f9f8a2f7fffeOF9Xe5X7zTH8NG`。两组均从新包运行资源执行、完整通过 90 秒稳定性和竞争/执行/回传；测试进程均已按自有进程清理，数据保留。原先失真的注入不作为这两组的通过证据。
- TypeScript、Vite、Cargo fmt/clippy 和 `git diff --check` 已通过。`npm.cmd run desktop:build` 成功生成 `src-tauri/target/release/bundle/nsis/Rivloom_0.1.2_x64-setup.exe`，**71,051,274 字节**；Release EXE 为 **10,266,624 字节**、产品版本 **0.1.2**。旧 0.1.1 安装器（71,075,905 字节）保留，未覆盖用户安装目录。
- 已检查随包资源包含回执/准备/执行状态的时差修复及 Master 本机到期校验；运行时版本为 0.1.2、OpenCode 仍为 1.18.25，`snapshot: false`。测试时钟 preload 不在产品运行资源内，不引入生产环境时间开关。

尚未验证：新 0.1.2 的实际安装/覆盖升级、原生 UI 点击和两台物理 Windows 闭环。用户验收实例仍占用安装运行时，本轮不运行可能按进程名退出 Rivloom 的安装/卸载测试；旧 0.1.1 安装结果只作为历史证据。2026-09-02T04:43:42.029Z 观察：5.33 本机桌面进程及 `desktop-runtime.json` 已不存在，Worker 看到其 Brain 离线；5.20 仍在线。助手未停止这些桌面，也不能将此观察冒充有计划的 Master 停止验收。原 Task A 仍没有业务任务和模型调用，隔离物理 Worker 保留运行。

## M3.4 核心实现（2026-09-02，0.1.1 历史基线）

本轮先完成 ADR-0004、里程碑、最小闭环和实施计划，再写实现。没有修改或 fork OpenCode，没有给 Project 增加 Git、文件快照或内容哈希。

以下为物理验收前已完成的自动检查；后续第一条物理 Task 暴露回执时间校验缺陷，其修复回归见上节，不能由这些历史通过项推导当前 M3.4 MVP 已通过。

最终自动检查：

| 检查                                                                                   | 结果                                                                                                                              |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `node --test tests/security.test.ts tests/node-network.test.ts`                        | **32/32 通过**；在正常 Windows 用户上下文运行，使临时测试节点可使用 DPAPI CurrentUser                                             |
| `node scripts/m34-service-check.ts`                                                    | **7 项通过**；90 秒稳定性、三个完整业务服务、三个独立数据库、官方 OpenCode、本机确定性模型，不使用真实模型额度                    |
| `node --test --test-name-pattern="offline pending" tests/node-network.test.ts`         | **通过**；真实节点停止/重启、取消包丢失、迟到接受回执拒绝、接受未知保持等待                                                       |
| `node --test --test-name-pattern "shared workers register" tests/node-network.test.ts` | **通过**；两个正式 Brain master、两个共享 Worker、四个独立数据目录/Node ID/Brain ID，第一次拒绝后自动换 Worker                    |
| `.\node_modules\.bin\tsc.cmd --noEmit`                                                 | **通过**                                                                                                                          |
| `.\node_modules\.bin\vite.cmd build`                                                   | **通过**；1824 modules transformed                                                                                                |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`                            | **通过**                                                                                                                          |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`       | **通过**                                                                                                                          |
| 真实 `WorkerResourceSampler` 严格字段校验                                              | **通过**；实际 Release 检出 Ryzen 7 7700、16 线程、约 63 GiB 内存和两张 GPU；NVIDIA 工具回报 16311 MiB 显存，其他不可靠值保留未知 |
| `git diff --check`                                                                     | **通过**                                                                                                                          |

新增测试和核对覆盖：

- 旧 `node-identity.json` 的 Brain ID 首次迁移为正式 Brain，之后重载不因新的 legacy 输入改变。
- 全新 Node 先形成 provisional Brain；遇到正式远端 Brain 时放弃空白 provisional；两个 provisional 以稳定 Node ID 确定收敛；两个正式 Brain 相遇时保持独立。
- 同一个受信 Worker 通过两个独立加密通道出现在两个 Brain 的目录中。报告包含 Project ID/名称、OS/架构、CPU、内存、GPU/显存（可检测时）、磁盘、动态负载、运行任务、槽位和时间；严格验证拒绝额外 serial 等字段。
- stale、关闭执行能力、无槽位、Project 不匹配、OS/架构/CPU/内存/GPU 不满足的 Worker 不入选；其余按负载、Brain 队列和稳定 ID 排序。
- Master 本机创建 Portable Task 时不手选 Node/Brain；Brain 先固定，Master 再固定 Worker，同一 Task ID、Brain ID、目标 Worker 和硬件要求在执行端保持一致。
- 不承载 Brain 的普通 Worker 可以在两个可达 Brain 中自动固定一个，把同一 Task ID 提交给其 Master。Master 保存 `owned` 权威 Task，生成不同的 Execution ID、按自己的最新目录选择 Worker，再把分配状态回传提交节点；测试断言 Task ID 与 Execution ID 不同且三端路由一致。
- Worker 的本机执行路径在节点级全局串行区内复核 Project、模型是否本机可用、硬件要求和全局占用，通过后才向 Master 回复接受。并发准入测试同时提交两个竞争操作，只产生一次槽位保留。Portable Task 使用按远端 Execution ID 隔离的本机普通临时目录；Project Task 只接受执行策略中同一个 Project ID。
- Brain Task 保存尝试号和 Execution 历史。四节点测试让第一次选中的 Worker 明确拒绝，Master 保持原 Brain/Task，立即选择另一个合格 Worker并创建不同的第二个 Execution；提交端收到相同历史。单元测试还确认旧 Execution 的迟到状态因当前 Execution ID 不匹配而无法覆盖新尝试，v1 Brain Task 记录可迁移为 v2 历史。
- 自动重调度只处理能证明未启动的旧尝试：明确拒绝、邀请过期，或 Worker 离线时 Master 仍记录为 `pending`。已接受但是否启动未知时不会自动重派；这是避免重复副作用的安全边界，不是把超时猜成失败。
- 停止一个 Master 后，共享 Worker 将该 Brain 标记为不可调度；另一个正式 Brain 仍在线且仍拥有该 Worker。
- 测试过程中曾发现公开发现心跳会覆盖加密目录中的 Worker 报告；修复为同一受信指纹刷新地址/在线时间时保留加密 Brain/Worker 字段。重调度测试又发现“每个 Brain 只返回排名第一的 Worker”会让冷却过滤后看不到备选 Worker；Master 调度现按该 Brain 的完整合格 Worker 排名选择。相关定向测试和全量回归均通过。

边界与未验证项：

- 完整服务竞争已通过：两个 Master 同时向一个 Worker 分配，只有一个业务 Task 和一个官方 OpenCode `session` 数据库记录；另一 Task 留在原 Brain 排队。真实引擎只请求本机 OpenAI-compatible 确定性模型，不能称为真实 AI 编程验证。报告 `.data/verification/m34-service.json`。
- 故障注入已通过：Worker 本地保存接受但回执未发送时停止；Master 按 pending 安全重派，故意丢失旧取消包，Worker 重启后迟到接受通过真实加密 HTTP 被 409 拒绝，无法绑定本机任务。第二 Worker 接受后离线，跨过调度 tick 仍保持同一 Execution 和“结果未知”，禁止按未启动邀请取消。
- 发现并修复迟到接受被误当幂等成功的竞态。新增可选 `brainTaskID`（远端记录 v7，兼容旧版本），区分 M3.4 最终准入与 M3.3 旧邀请“先接收、能力关闭时等待”。本地手动启动和远端启动共用 Node 准入锁；运行、待验收、未知和已保留 ready 任务占用同一个槽，报告与准入一致。
- 官方 OpenCode 配置明确使用 `snapshot: false`，不启用引擎文件快照；仍仅消费官方返回的差异，空差异不做内容哈希或文件复制兜底。
- 实际 Release 发现并修复：其他节点未清理 Worker 已撤回的 provisional Brain 登记；只由该 Master 的认证目录撤回其临时记录，不删除正式 Brain 历史。Windows `AdapterRAM` 不能可靠表示现代显存，改用 `nvidia-smi` 获取可确认值，未知值不虚构；GPU 动态采样改为后台异步，避免阻塞加密心跳。新增撤回和显存解析单元回归。
- 在线证据修正：认证目录收发更新 `lastSeen`；新鲜认证通道存在时，mDNS 过期不直接删除节点。四节点回归停用发现刷新 20 秒后，认证目录仍保活。
- Release 实测曾出现每分钟周期性的节点离线和一次 pending Execution 重试；只读探测确认返回 HTTP 429。原因是发现查询、hello 和加密消息共用每个 IP 每分钟 60 次的桶。现按归一化的真实来源 IP 分为 discovery 60、hello 120、control 60、channel 600 次/分钟，桶总数限制为 1024；所有请求仍在认证前受限，不能通过伪造 Node ID 或 IPv4-mapped 地址绕过上限。单元测试覆盖类别隔离、独立地址与上限，完整服务稳定性延长为 90 秒以跨越限流窗口。
- 最终 `scripts/m34-desktop-fixture.ts` 启动实际 Release Tauri WebView2 和两个独立服务；三节点全互信、两正式 Brain、共享 Worker 拓扑连续 90 秒通过。原生窗口检查拓扑、硬件、槽位和自动安排表单，真实点击提交后自动选中远端 Master，经 Worker 执行并回传至同一 Brain/提交端；只有一次 Execution，界面显示等待验收。旧 `scripts/node-network-ui.ts` 的完整 M3.3 模型回归未在本轮重跑，不冒用其历史 23 项报告。
- M3.4 物理双机验证进行中：用户先确认两设备目录连续观察 90 秒正常；第三个独立 Worker 随后已分别与真实 5.20/5.33 配对并注册给两个 Brain，原 provisional Brain 已撤回。2026-09-02T03:45:13.566Z 至 03:46:46.271Z 从 5.33 桌面服务与 Worker 接口做 91 次只读采样，共 92,705 ms，两个 Brain、预期加密通道和同一 Worker 的一个空闲槽位始终正常；报告最大年龄 4,975 ms。没有发任务或调用模型，不代替共享执行/竞争、硬件准确性或 Master 停止验收。中间的“不可见”截图由用户确认看错了 5.18 旧实例，不计为 5.20 断线；一次真实 503 配对确认重试仍如实保留。详情见 [物理验收记录](plans/m34-physical-acceptance.md)。
- 物理 Task A 尚未执行：Task `7f0da3b1-4282-4b75-8784-ac19b1d72653`、Execution `44b41f60-dc4c-4427-9e62-a20a5716ea47` 已到共享 Worker，但接受回执被 Master 拒绝；用户的权威卡片仍为第 1 次尝试/序号 0。Worker 未绑定业务 Task/启动执行会话，模型请求为 0、空闲槽位为 1。实测六次 hello 均显示 5.20 时钟至少领先本机约 43–47 ms；纯内存对照确认 `decidedAt=createdAt-50 ms` 被 `receiveResponse` 误拒绝，而相同时间通过。安装的 0.1.1 含同一严格跨时钟比较。原始回执时间未保留、远端错误被泛化，因此这是已复现的缺陷及高度吻合的原因，尚不能断言为本次唯一原因。未改系统时间或真实任务记录；物理验收暂停等待修复和时差回归。详细证据见 [物理任务停点](plans/m34-physical-acceptance.md#第一条物理-task回执被拒绝执行尚未开始)。
- 单节点仍可用本地工作台执行；当前自动调度不将所选 Master 自身作为远端 Execution 目标，不能把本轮三节点闭环宣称为所有单节点/同机承载组合都已覆盖。
- 最终全量测试曾与另一组完整服务同时运行，四节点 UDP 发现等待出现一次超时；两组拆开重跑后 32/32 通过。没有把那次失败计为通过，后续采集验收证据时应串行运行发现测试组。

### M3.4 最终 Release 窗口证据

本组窗口检查使用 `node scripts/desktop-prepare.ts` 和 Tauri `build --no-bundle` 重建的 M3.4 EXE 与运行资源，当时版本号仍为 0.1.0；随后构建的 0.1.1 NSIS 安装验证单列如下。原生窗口操作使用 Computer Use，报告中的状态由业务服务读取，不把 API 操作当作界面点击。

- 隔离根目录：`.data/m34-desktop/1788312123974`；三个独立数据目录、Node ID 和 SQLite，两个正式 Brain。实际窗口显示三节点在线、两 Brain、同一 Worker、真实硬件和更新中的负载/槽位，无遗留 provisional Brain。
- 表单任务：`M34 final Release placement`。未选择 Brain/Worker；系统选择远端 Master，桌面保存 `submitted`，远端保存 `owned`。Brain `8315b7b4-295a-4a20-907b-babd025710a4`；Task `36e1b99b-6fcb-41a7-896c-697ea0072ac4`；Execution `97709fc9-ff72-412e-8237-8518f7643330`。
- Worker 业务 Task `db7b8feb-b5ac-4159-9463-f402b675224b`；官方会话 `ses_fa0464a36ffeTjHHtvK5WoaIMV`。只读核对官方会话数据库只有这一条 session，Execution 仅第 1 次尝试，本机模型请求为 1 次。
- 释放本机确定性模型回复后，Worker、所属 Master 和提交端均为 `review`；原生卡片显示“等待验收”、相同 Task/Execution、序号 3 和最终摘要。本轮不调用工具、不修改用户项目，不声称真实 AI 编程验收。
- 状态记录：`.data/verification/m34-desktop.json`（2026-09-02T01:27:25Z）；独立 ID/会话断言通过。完整服务机器报告 `.data/verification/m34-service.json` 为 7 项通过，官方会话 `ses_fa04c21abffej8n21anDbLw7T7`。
- 修复前的一次窗口任务曾因 429 触发安全重试，其记录不作为最终稳定性通过证据；修复后重新建目录、重建 Release、重新运行全互信 90 秒检查和原生任务，以上是最终结果。

### M3.4 0.1.1 安装与覆盖升级（2026-09-02）

`npm.cmd run desktop:build` 生成 `src-tauri/target/release/bundle/nsis/Rivloom_0.1.1_x64-setup.exe`，71,075,905 字节；Release EXE 为 10,266,624 字节。应用 identifier、默认数据目录、Node 24.19.0 和官方 OpenCode 1.18.25 均未改变，未修改依赖版本。0.1.1 的 TypeScript、Vite、32/32 项 Node 测试、Cargo fmt/clippy 均通过。

`npm.cmd run test:installer` 使用真实 NSIS 安装器和独立 `.data/installer-smoke/<UUID>` 目录，**7 项通过**：

1. 全新 0.1.1 安装启动实际 Tauri、随包 Node 与官方 OpenCode；版本正确，安装资源提供 M3.4 UI/API。
2. 全新安装卸载后程序被移除，自有进程清理，独立数据保留。
3. 用保留的真实旧 0.1.0 安装器创建普通 Project、未执行 Task 和本机执行策略。
4. 原安装目录覆盖为 0.1.1 后，Node/Brain/操作者 ID、Project、Task 和执行策略保持一致。
5. 升级后的桌面重启，身份与未执行 Task 保持。
6. 升级后卸载移除程序，SQLite、节点身份、Brain 拓扑和普通 Project 保留。
7. 整个安装测试没有发送模型请求、导入凭据、初始化 Git、建立 Project 快照或计算内容哈希。

额外安全检查：强制 `scripts/desktop-install-smoke.ps1` 包装器先记录再逐值/类型恢复两处准确的 HKCU 安装元数据；`/NS` 不创建快捷方式，`/UPDATE` 避免自动卸载用户原应用或清除其数据。只按自有 PID 清理测试进程，用户真实安装目录和数据未被更新。测试安装已卸载，隔离数据保留；报告 `.data/verification/desktop-install.json` 的 `status` 为 `passed`、`installationMetadataRestored` 为 `true`。

该检查验证安装后的资源/API和应用启动，不冒充一次新的原生表单点击回归。包仍未签名；这不是干净 Windows 虚拟机矩阵，也不是至少两台真实设备的 M3.4 核心验收。开发机原安装位置元数据已指向历史 `.data/installed-smoke-app/...`，本轮原样恢复而非擅自修复；实际更新请按 [物理验收清单](plans/m34-physical-acceptance.md) 核对原安装目录。

## Windows 桌面端（2026-09-01 历史验证）

`RIVLOOM_TEST_DESKTOP_EXECUTABLE=...Rivloom.exe node scripts/integration.ts`：**安装包对应的真实桌面可执行程序 11 组检查全部通过**。

- Tauri 进程自动启动随包 Node.js、本地服务和未修改的官方 OpenCode 1.18.25；使用随机 loopback 端口。
- 从桌面进程完成真实模型编辑、SSE 流输出、编辑/命令人工审批、人工验收、持久化重启、补充要求停止和异常退出恢复。该历史脚本当时还使用 Git 产物基线；当前产品已改为普通文件夹且不再使用该基线。
- 最终安装包重新构建后，真实任务 `46dd767c-ae19-401d-890a-e65ba5bfef59`、官方引擎会话 `ses_fa4bf8155ffe1Iq2eD7Uzu9sz2` 再次通过；4 次审批，1 个变更产物。新增检查确认缺失桌面启动令牌返回 403，而原生令牌可自动建立本机操作者且无需初始化表单。
- 强制结束桌面父进程后，随包 Node 和 OpenCode 进程均被清理；下次启动任务转为 `interrupted`，没有自动继续或写入。
- 机器报告：`.data/verification/desktop-integration.json`。

真实 Windows 窗口检查：**通过**。在全新隔离测试目录启动 Release 可执行程序，实际 WebView2 通过启动期原生令牌自动建立本机操作者并直接进入任务工作台；首次页面没有工作区、显示名称、用户名、密码或终端初始化码表单，节点发现已经启动，原生目录操作可用。缺失令牌返回 403，正确令牌返回 200；关闭桌面后令牌文件和后台进程均被清理。随后通过 Release Tauri WebView2 检查节点页和“模型与额度”页面。证据：`.data/verification/desktop-ui.json`、`.data/verification/desktop-direct-start.png`、`.data/verification/desktop-node-network.json`、`.data/verification/desktop-model-settings.json` 及对应截图。

上一版 NSIS current-user 安装包曾通过开发机隔离目录的静默安装、随包引擎启动、进程清理及卸载保留数据测试。M3.3 随后重建的 0.1.0 安装器现仅保留为本轮覆盖升级基线，不能证明 M3.4。`.data/verification/desktop-install.json` 已由上节 0.1.1 的最新安装/升级检查更新，不再指代这份历史报告。

尚未在一台干净 Windows 虚拟机执行完整安装、升级、卸载矩阵，也未代码签名。这里不把开发机 Release 测试宣传成完成商业发行验收。

## M3.1 自发现、M3.2 加密通道与 M3.3 策略化执行

上一份 `npm run test:node-network-ui` 完整机器报告：**23 项实际 Release 桌面检查通过**。测试启动 `Rivloom.exe` 和第二个完全隔离的真实节点实例，不使用网络 mock；局域网同时存在真实 Rivloom 时，脚本按精确测试 Node ID 选取节点，避免操作其他设备。本轮脚本已扩充到远端差异、补充和验收，新增确定性部分通过，但完整运行受免费模型无响应阻塞，详见本节末尾。

- 两个实例各自生成稳定 Ed25519 身份；私钥 PKCS#8 只以 Windows DPAPI CurrentUser 密文保存在节点身份文件中，重载后 Node ID 不变。
- 两个实例在本机真实 mDNS/DNS-SD 网络栈发布和发现 `_rivloom._tcp.local`，使用不同数据目录、Node ID、Brain ID 和端口。
- 单独强制关闭 mDNS 后，两个实例通过 LAN UDP 43531 查询、临时端口单播回复在约 1 秒内发现对方；候选地址随后仍进入相同的 nonce 和 Ed25519 验签流程。
- 发现方连接对方独立的 `/v1/hello` 端点，发送随机 nonce，并核对公钥派生 Node ID、指纹、响应时间与 Ed25519 签名。
- 实际 Tauri WebView2 “节点与 Brain”页显示本机节点、Brain 和附近节点；发起后两端得到相同六位短码，页面同时展示完整公钥指纹供人工核对。
- 只确认桌面一端时两端仍未受信；第二实例确认后两端同时受信，并显示“已建立设备信任 · 加密通道就绪”。最小 Brain 目录经实际加密消息往返同步。
- 桌面端向第二节点加密发送协作任务；目标端保存同一任务 ID 和待处理状态，由测试端接受后两端都显示已接受。任务消息没有项目路径、模型或 OpenCode 会话。
- 第二节点反向发送任务时，本机执行能力处于关闭状态。Release 自动接收可信任务，归属端看到已接受，但执行序号保持 0、状态为 `not_started`，没有创建 OpenCode 会话；发送方随后成功取消。
- 桌面执行节点一次选择专用普通文件夹和本机可用的 `opencode/mimo-v2.5-free`。第二节点反向发任务后，桌面无需逐任务选择资源或确认，自动接受并只创建一个本机业务任务和官方 OpenCode 会话。
- 发起方实际 WebView2 任务卡通过认证加密通道回答一项 AI 提问、拒绝一项操作，并发送停止请求；第二节点逐项收到正确控制并按唯一控制 ID 去重。这项 AI 提问由协议级执行快照触发，用于稳定覆盖界面和通道，不冒充模型真实提问。
- 本机审批模式选择“请求批准”。第一个真实随包 OpenCode 会话在进入待审批或待补充的人工介入点后由归属节点远程停止，`SHOULD_NOT_EXIST.txt` 未出现。第二个真实会话产生至少一项操作审批；归属节点看到的快照不含执行机项目路径或 metadata，发送“仅本次允许”后会话继续完成。
- 最终直接读取隔离普通文件夹的 `RESULT.txt`，内容严格等于 `rivloom remote execution verified`。归属节点收到单调递增状态并最终进入 `review`。
- 归属节点公开记录中的本机项目 ID、模型标识和本机任务 ID 均为空；节点消息也不包含凭据。远端结果待验收时，第二个普通本机任务在创建新 OpenCode 会话前被同项目并发保护拒绝。
- 自动化还验证同一签名配对请求重放返回 409、重启两个节点后信任和通道重建、伪造/重放 X25519 握手被拒绝、AES-GCM 密文篡改/重放被拒绝、会话过期失效，以及信任记录冲突时安全失败。
- 本轮增加单边通道丢失回归：只删除较大 Node ID 一端的本地会话，另一端仍认为通道在线；较大节点发送签名恢复请求，确定的较小节点重新握手，两端恢复同一加密通道。该真实双实例网络测试通过。
- 节点端点拒绝畸形请求和未开放的加密消息类型；项目、模型、工具、产物和 OpenCode 路径返回 404，React 业务服务与 OpenCode 没有暴露到局域网。

机器报告和截图：`.data/verification/desktop-node-network.json`、`.data/verification/desktop-node-network.png`、`.data/verification/desktop-node-pairing.png`。这份机器报告仍是上一完整运行的 23 项结果。M3.3 上一阶段的 Release 实际 WebView2 已继续通过新增的限长官方差异卡片、补充要求和最终验收控制的认证加密往返；随后真实 `opencode/mimo-v2.5-free` 停止夹具在 10 分钟内只产生空 assistant 消息，没有进入人工介入点，因此脚本按失败退出并未覆盖旧机器报告。此前同一补充流程已实际继续到第二轮 OpenCode 操作审批，但当时暴露单边通道丢失；修复后的完整真实模型续跑仍需使用可用模型复测。

早期物理测试使用 Win10 `192.168.5.18` 与 Win11 `192.168.5.20`：双向发现、签名退出通知、双端短码/指纹核对、单方不授信、双方授信、重启保持和撤销均由用户确认通过。

2026-09-02 又在 Win11 `192.168.5.20` 与当前开发机 `192.168.5.33` 完成单人双机核心任务闭环：执行机配置普通文件夹、真实 DeepSeek 和“请求批准”；归属端加密发送文件生成任务；任务自动接收并启动；归属端“仅本次允许”文件写入；文件在执行机实际生成；归属端补充第二行要求后继续同一 OpenCode 会话；执行机核对内容；归属端提交最终验收。结果由用户人工确认，没有伪造自动化报告，也不声称两个真人完成角色分离。

这次测试前出现单向发现：`5.33` 本机节点服务在 `0.0.0.0:10557` 和 UDP `43531` 正常监听，`5.33` 可持续验证 `5.20`，但 `5.20 → 5.33:10557` 为 `TcpTestSucceeded=False`。防火墙规则检查显示随包 `node.exe` 的 Private TCP/UDP 入站规则 `Enabled=Yes` 但 `Action=Block`；改为 Allow 后用户确认恢复。当前包尚未自动建立/修复该规则，不能把这次手工系统配置视为安装器通过。

`npm run test:permission-policy`：**通过**。脚本启动未修改的官方 OpenCode 1.18.25，在三个隔离目录分别以“请求批准 / 帮我批准 / 允许任何操作”的规则创建会话，再通过官方 `session.get` 读回并逐项比对。没有发送模型请求、使用凭据或修改用户项目。机器报告：`.data/verification/permission-policy.json`。

## 模型设置与 DeepSeek 真实普通文件夹任务

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

用户随后在 Release Tauri 客户端本机保存有效 DeepSeek 官方 Key，并主动确认可能计费的连接测试。`deepseek/deepseek-v4-flash` 返回真实回复，界面显示连接通过，没有自动重试；Key 没有进入聊天、仓库、截图或报告。

同日又完成无 `.git` 普通文件夹中的固定编程任务：**通过并已验收**。

| 项目               | 实际结果                                                                            |
| ------------------ | ----------------------------------------------------------------------------------- |
| 业务任务           | `RV-001`；OpenCode 会话 `ses_fa2e2a5f4ffeFyQrlJVwILugr4`                            |
| 项目目录           | 专用普通文件夹；确认不存在 `.git`，只含 `slugify.mjs` 与 `slugify.test.mjs`         |
| 初始状态           | `node --test slugify.test.mjs` 失败，符合测试夹具预期                               |
| 人工介入           | 拒绝计划外 `Get-ChildItem`；补充明确约束后继续；分别批准编辑和指定测试命令          |
| 文件与测试         | 只修改 `slugify.mjs`；测试文件逐字未变；独立执行为 1 通过、0 失败                   |
| 会话差异           | OpenCode 官方 `session.diff` 返回空数组；产物页显示无会话差异并提示直接检查本地文件 |
| Rivloom 文件跟踪   | 没有扫描文件夹、建立快照、计算内容哈希或进行验收指纹比对                            |
| 最终状态与敏感信息 | 人工填写核对结论后验收；报告不含 API Key、完整模型回复或用户项目内容                |

机器报告：`.data/verification/deepseek-plain-folder.json`。这次验证确认普通文件夹可以完成真实执行闭环，也确认官方差异为空时只能依靠执行记录、测试结果和验收人直接检查本地文件；没有将空差异伪装成已取得代码 diff。

## 第一阶段：先验证官方引擎

`npm run engine:probe`：**通过**。

- 官方服务启动并核对版本；随机 Basic Auth 密码，loopback 监听。
- 创建真实会话，模型为官方 `opencode/mimo-v2.5-free`。
- 原始函数直接返回输入，模型修改为处理大小写、连续空白/标点、首尾连字符；三个断言均通过。
- 67 条 SSE 增量事件、2 次权限回复（文件编辑和 `node --test slugify.test.mjs`）。
- 读取真实会话结果；独立探针当时另用 Git 取得代码 diff。当前产品不再消费该 Git 兜底。
- 第二个真实会话进入待审批后调用 abort；文件未被修改；显式 reject 残留权限后请求清空。

探针会话：`ses_fa8b60165ffeIS3uONFh7AabLS`。完整输出在 `.data/verification/engine-probe.json`。

**没有掩盖的失败/降级：**

- 现有 OpenCode Go 凭据请求返回余额不足。没有充值或修改原账号，改用官方免费模型验证。为探针临时导入的凭据副本已移除，原文件未改动。
- `opencode-ai` npm 安装包装器失败，改用其提示的同版本官方 Windows 平台包。
- 官方 `session.diff` 在本机真实修改后仍返回 `[]`。当前产品不再使用 Git、文件快照或哈希兜底；界面如实提示直接检查本地文件。没有修改引擎来规避问题。
- abort 后仍可能留下待审批请求，薄适配层显式 reject。

## 完整应用与独立账号（历史基线）

独立服务基线的 `npm run test:integration`：**10 组检查通过**；最终 Release 在相同闭环外增加原生启动令牌检查，共 11 组通过。这组历史报告完成于产品改用普通文件夹之前，其中产物捕获和验收指纹结论已被本次改动废止，不能继续作为当前能力声明；账号、权限、流式执行、审批、停止和重启部分仍是有效基线。

使用同一真实应用服务、两个独立账号/不同会话 cookie（另加非参与者账号），不是前端角色切换，也不是 mock。

| 检查                        | 实际结果                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| 未登录读取 / 跨源写入       | 401 / 403                                                                                                |
| 一次性邀请、独立注册和登录  | 通过，邀请码重用被拒绝                                                                                   |
| 非参与者访问任务 / 事件范围 | 任务读取被拒绝，列表不包含该任务；事件服务端按参与者过滤                                                 |
| 接受与启动的角色限制        | 发起人不能替接受人接单/启动；接受人可启动                                                                |
| 同项目并发                  | 第二个任务启动返回 409                                                                                   |
| 真 AI 执行与权限            | 编辑和 Node 测试均真实审批；非审批人回复被拒绝；重复批准被拒绝                                           |
| SSE 与产物                  | 正文增量到达，真实测试通过；历史版本曾用本地文件捕获，当前已移除                                         |
| 验收                        | 非验收人被拒绝；当前版本直接由验收人检查本地文件和测试，不做哈希一致性拦截                               |
| 已完成任务重启恢复          | 账号、会话、状态、消息、产物与活动仍在                                                                   |
| 补充要求 / 异常退出恢复     | 补充要求先停止、关闭残留审批、文件不变；执行中强制结束应用后重启为 interrupted，不自动继续；可再确认停止 |

最终真实引擎会话：`ses_fa898e4b3ffepaqwHlDoZObNDL`；业务任务 ID：`9f83f830-c688-4ced-a156-d4597ea8738e`。机器可读报告：`.data/verification/integration.json`。

测试早期发现后台同步会偶尔抢占用户审批锁，已修正为用户操作串行排队、后台同步避让，并重新通过上述完整流程。模型曾额外请求 `ls -la`，严格测试拒绝并判失败；集成测试随后只增加了人工检查过的两个固定只读目录命令，仍独立断言编辑和指定 Node 测试命令必须发生。没有把失败标成成功或启用通用自动批准。

这里验证的是两个独立身份/会话的协作协议；没有声称已由两个真人完成产品内测，也没有验证跨设备网络。

## 本地检查

- `npm run typecheck`：通过（strict、noUnusedLocals、noUnusedParameters）。
- `npm run build`：通过，生成 React 生产构建。
- 当时的 `npm test`：16 项通过；在原有安全检查外，包含三种会话权限规则与敏感项拒绝、私有地址过滤、Windows DPAPI 稳定身份、信任记录冲突拒绝、mDNS/LAN UDP、双端配对、握手/密文攻击，以及任务幂等、旧记录迁移、能力策略持久化、唯一任务绑定、单调执行状态、重启保持和撤销边界。本轮扩展后的最终结果见顶部 M3.4 小节：32/32 通过。
- `npm audit --offline --omit=dev`：当日 0 个已知漏洞；不是安全认证。
- `cargo fmt --check` 与 `cargo clippy --all-targets -- -D warnings`：通过。
- 官方版本、npm integrity、二进制 SHA-256、MIT 原文及 123 个已安装依赖的许可证元数据已保存。

## 浏览器与启动验收

在独立 UI 测试工作区（4318 端口）曾实际操作：初始化账号 → 添加测试项目 → 创建/接受任务 → 风险确认 → 逐次批准只读目录查询、文件修改和测试命令 → 核对真实 Node 输出（1 pass / 0 fail）→ 填写验收意见 → 已验收。测试会话 `ses_fa89bcbaeffeTWAA2smQGQJYB3`。该历史版本曾显示 Git diff；当前普通文件夹界面已由上面的 DeepSeek Release 任务重新验证。这项 UI 测试使用一个明确标注的测试账号，不声称是两人测试。

桌面截图保存在 `.data/verification/ui-workbench.png`。390px 窄屏工作台未出现横向溢出；浏览器没有 error/warn 日志。实际刷新后任务与待审批请求仍可恢复。

生产模式与开发模式均能启动。开发首页包含 Vite 客户端，返回 HTTP 200。端口占用返回明确错误且不再启动引擎；同一数据目录改用另一端口双开仍被进程锁拒绝。没有占用时，新实例可以恢复已退出进程留下的锁。

## 尚未验证或不包含

- 物理双机的请求批准、真实 DeepSeek 文件生成、补充要求同会话续跑和最终验收已经通过；仍未物理覆盖远程停止、“帮我批准 / 允许任何操作”、执行中撤销信任、异常结束/断网恢复和两真人角色映射。
- 安装器自动创建、升级和卸载仅限 Private/LocalSubnet 的 Rivloom 防火墙规则；当前测试依靠手工把错误的 Block 规则改为 Allow。
- ChatGPT 登录。
- 干净 Windows 虚拟机安装/升级矩阵、自动更新、代码签名、ARM64/macOS/Linux。
- AI 主动 question 分支的实际模型触发（接口和 UI 已实现）；长期 shell / 已脱离进程树的后台任务的可靠停止。
- 大仓库/大量任务/长时间运行、磁盘满、断电、损坏数据恢复；完整安全审计与 DLP。

停止不回滚；可信测试目录不是沙箱；免费模型可用性和提供方政策可能变化。更详细的风险范围见 [SECURITY.md](../SECURITY.md)。

上述未验证项继续保留为事实和后续优化清单。产品负责人已接受现有单人双机核心闭环作为 M3.3 的 MVP 验收结果，因此这些项目不阻塞 M3.4 实施，也不能被误写成已经通过。
