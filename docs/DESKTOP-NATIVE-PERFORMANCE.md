# 桌面底层响应优化记录

更新于 2026-09-08。本轮在[首轮前端优化](DESKTOP-PERFORMANCE.md)基础上，处理 Node 后台查询、硬件采样和 Rust 原生等待。源码及隔离回归完成；随后按用户要求生成性能候选 `43b47f27` 并通过解包校验，尚未安装，正式桌面操作继续按用户要求暂停。

## 性能安装包

[Windows x64 性能候选](../.data/verification/performance-candidate-20260908/delivery/Rivloom_0.1.4_performance_20260908_43b47f27_x64-setup.exe)，文件名 `Rivloom_0.1.4_performance_20260908_43b47f27_x64-setup.exe`，79,792,667 字节。产品版本仍为 0.1.4，应用身份和 currentUser 安装模式保持。

SHA-256：`fc416127935bc351a50f8bce5ee9ae883b340f23d7099575300f3eb1bc86bbf2`。

重新执行的前端/类型/双语、原生 Release/NSIS、构建前后 runtime 门禁和独立解包全部通过。7,639 个运行文件与准备目录逐字节一致，x64 应用 EXE 仅有 Tauri 的三字节 NSIS 标记变化。候选源码关联到两轮已完成的性能验证。新安装脚本的同版本重新安装分支静态检查通过，但本轮未执行新包安装或覆盖升级；用户自行安装，实际交互仍待测。它是本地未签名候选，未公开发布。

打包证据位于 `.data/verification/performance-candidate-20260908/`，包括 `build-result.json`、`extraction-result.json`、`optimization-source-link.json`、`installer-static-review.json`、构建日志和 1,072 文件源码快照。下方性能测量为源码验证结果，没有因打包而重新计数。

## 实现

任务监控、执行槽位、流式消息路由和远程任务绑定此前频繁读取并解析全部历史任务。新增 `TaskQueries` 使用 SQLite 表达式索引按状态、session 和远程任务 ID 查询；流式路由只读取 ID 和状态，不加载正文。新任务编号由现有编号索引求最大值。完整历史接口保留。

原 JSON 文档仍为任务数据来源，同一个数据库连接维护索引与事务；没有任务对象缓存。旧库首次打开自动建索引，重复启动不重复创建。返回顺序保持编号倒序，重复 session/远程引用仍取最新任务。队列准入记录另外查询实际任务状态，避免把已完成任务计为占用。缺失、空或非字符串 session 现在直接忽略，避免误匹配没有 session 的任务。表达式与查询一致的要求见 [SQLite 索引说明](https://www.sqlite.org/expridx.html)。

硬件清单的 PowerShell 与 NVIDIA 查询改为异步子进程，磁盘查询使用异步 `statfs`。构造采样器不执行探测；首次取得可信硬件清单前返回 `null`，不发布 Worker 资源报告，之后按需刷新。CPU/内存测量在一秒内复用，GPU/磁盘成功后至少间隔五秒再刷新，同一资源最多一个探测在途；清单整体或动态采样失败三十秒后再试，外部测量二十秒后过期。NVIDIA 总显存读取失败保留未知值，不单独重试静态显存清单。确认没有 GPU 时不再启动 GPU 性能查询。执行策略、项目、运行任务数和可用槽位每次重新计算，报告时间来自实际 OS 采样时间。服务关闭中止采样子进程并忽略迟到结果。

目录选择、任务文件另存改用原生回调等待，取消仍返回空选择。Windows 通知的同步操作及互斥锁等待进入阻塞线程池，避免占用异步执行器；保留来源、通知类型、目标路由、身份和限流校验。新增单异步工作线程测试覆盖等待期间其他异步任务能继续、关闭后迟到的回调、取消与错误返回。Tauri 异步命令与异步执行器行为参见 [官方命令说明](https://v2.tauri.app/develop/calling-rust/)。

## 固定合成场景的结果

数据库基准使用 Node `v24.19.0`、SQLite `3.53.3`，两份独立内存数据库各含 300 个任务、约 1.54 MB 任务 JSON。其中一个任务有 120 条消息，其余每个 10 条；所有正文均为合成数据。比较原完整读取/解析路径与新实际查询模块，前后交替三批，取中位数。以下为整批同步查询耗时，不是单次用户操作或桌面帧率。

| 场景                  | 次数 |    优化前 |  优化后 |
| --------------------- | ---: | --------: | ------: |
| 无活动任务的后台监控  |   30 | 131.95 ms | 0.11 ms |
| 有活动任务的后台监控  |   30 | 141.36 ms | 4.00 ms |
| 流式消息 session 路由 |  100 | 438.62 ms | 0.19 ms |
| 远程任务绑定查询      |   30 | 122.02 ms | 3.79 ms |
| 新任务编号查询        |   30 | 131.65 ms | 0.08 ms |
| 保存任务              |   30 |   2.86 ms | 4.03 ms |

索引建设在该样本耗时 2.56 ms，SQLite 分配空间增加 36,864 字节。保存任务的相对耗时增加约 41%，该样本绝对增加约 0.039 ms/次；这是减少高频读取的写入代价，大型实际数据库的启动、写入和磁盘行为仍需测量。查询计划确认状态和远程引用走索引，session 路由使用覆盖索引。

另记录了查询突发期间零延时定时器的实际延迟。流式路由场景中位数为 438.66 → 13.56 ms；优化后仍受 Windows 定时器精度及调度影响，不能把 0.19 ms 查询耗时当作端到端响应延迟。

资源采样基准注入固定时钟及模拟 OS/子进程边界，没有实际枚举机器硬件。场景为已确认无 GPU、零任务，每秒读取十次：

| 工作量                                      |     优化前 |    优化后 |
| ------------------------------------------- | ---------: | --------: |
| 构造阶段同步子进程                          |          2 |         0 |
| 暖缓存后同刻连续 1000 次读取的新增 CPU 采集 |       1000 |         0 |
| 暖缓存后同刻连续 1000 次读取的同步磁盘查询  |       1000 |         0 |
| 模拟一分钟的 CPU 采集                       |        600 |        60 |
| 模拟一分钟的磁盘查询                        | 600 次同步 | 12 次异步 |
| 模拟一分钟的 GPU 性能子进程（无 GPU）       |         12 |         0 |

有 GPU 的正常性能采样维持成功后最短五秒的按需刷新间隔。单独的延迟探针测试覆盖模拟失败、长时间挂起、过期和退出；实际子进程的超时终止与取消仍待候选验证。这些工作量数据不代表实际整机 CPU、耗电或 GPU 占用测量。

## 验证与待测边界

- 逻辑组 **249/249**，零跳过，包含 6 项任务查询及 7 项资源采样测试；测试映射审计通过。查询测试覆盖旧数据、同版本更新、事务回滚、重复引用、返回副本和索引查询计划。
- 节点协议组 **11/11**，零跳过。首次沙箱账户运行因 Windows DPAPI 和 Git 仓库属主校验未能完成；保留失败记录后，在正常用户环境以同一命令通过，未修改密钥保护实现或全局 Git 配置。
- 完整服务 `node-p0` **12/12**，正常退出、无超时。真实 Rivloom/OpenCode 服务配合确定性的本机模型夹具，验证创建重试幂等、唯一官方 session、重启后的任务/队列保留、待验收占槽、混合队列控制、两 Brain 共享单槽及未知执行不自动重派。使用全新身份和数据目录；mDNS 关闭，随机 UDP 端口构成独立发现域，仍发送 LAN 广播，因此不称为纯 loopback 网络测试或双物理机验收。模型端点只监听 loopback，没有真实模型调用。
- 独立查询语义审查覆盖 11 种任务状态和 **2,328 组**队列槽位组合，与原逻辑一致。
- Rust **10/10**，离线、锁定依赖、无默认功能，并限制为一个异步工作线程。测试没有打开原生对话框或发送系统通知。
- TypeScript、双语覆盖和生产 Vite 构建通过；现有 500 kB 单块提示保留。
- 本轮未修改前端；首轮三组前后、每次 11 项 UI 证据继续保留，本轮不计为重新执行这些 UI 测试。

完整工作区、通知等仍有需要读取历史的路径，本轮没有消除所有后台历史解析。真实文件系统、慢 WMI、不同 GPU 驱动、长期进程资源趋势以及原生文件选择/通知交互仍应在候选中回归，见[待测清单](DESKTOP-ACCEPTANCE.md)。

核对锁定的 Tauri/Wry/Tao 后，未发现项目额外添加的窗口移动或缩放开销。当前保留 WebView2 默认 GPU、原生窗口和每显示器 DPI 行为。移动通知是弹窗定位与无障碍的必要操作；不能通过删除移动通知或盲目关闭 GPU 来证明性能改善。依据见 [WebView2 性能指南](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance)、[线程模型](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/threading-model#block-the-ui-thread)与[父窗口移动接口](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controller#notifyparentwindowpositionchanged)。

原生标题栏拖动、连续缩放、跨 DPI 显示器与中文输入法尚未测量。后续应固定显示器刷新率、缩放、电源模式和 WebView2 版本，在独立候选中比较空闲/后台忙碌时的 UI 线程、CPU/GPU/DWM 与可见卡顿；本报告不宣称已解决用户的原生拖动卡顿。

## 证据与复现

证据根目录 `.data/verification/desktop-native-performance-20260908/` 保留：

- `backend-performance.json`：全部查询/写入的三批样本、CPU 时间、定时器延迟、查询计划与索引代价。
- `resource-sampling-before.json`、`resource-sampling-after.json`、`resource-sampling-probe.mjs`：模拟资源采样的前后计数及探针。
- `logic-test.log`、`rust-test.log`、`rust-test-summary.json`：逻辑及原生隔离测试记录。
- `protocol-user-report.json`、`protocol-user.log`：协议组最终通过记录；`protocol-sandbox-report.json`、`protocol-sandbox.log` 保留环境受限的首次失败。
- `node-p0-user-report.json`、`node-p0-verification.json`、`node-p0-user.log`：完整服务最终结果；`service-isolation-preflight.json` 记录测试网络、目录、模型及清理边界。
- `semantic-review.json`、`semantic-review-check.mjs`：查询语义审查范围及槽位差分复现脚本。
- `i18n-check.log`、`typecheck.log`、`vite-build.log`：构建检查。
- `before/`、`after/`：改动前后源码证据；`source-manifest.json` 保存本轮最终源码路径、字节数与 SHA-256，`verification-summary.json` 汇总交付状态。

在仓库根目录运行数据库基准，结果只写入指定的新证据目录，不启动应用或模型：

```powershell
node scripts/desktop-backend-performance-check.ts .data/verification/desktop-native-performance-repeat
```

全局 `npm` 入口仍指向缺失文件，构建通过 Node 直接执行现有 build 脚本中的双语检查、TypeScript 和 Vite；没有修改全局环境。安装仍由用户操作，Git 按整体完成后统一整理。
