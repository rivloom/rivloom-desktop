# 桌面端性能优化记录

更新于 2026-09-07。首轮源码优化和隔离验证完成；尚未生成或安装性能候选，Windows 原生拖动仍待实机验收。正式客户端操作按用户要求暂停，后续项目见 [桌面端待测记录](DESKTOP-ACCEPTANCE.md)。

2026-09-08 追加：后台索引查询、异步硬件采样与原生等待线程的第二轮改动另见[桌面底层响应优化记录](DESKTOP-NATIVE-PERFORMANCE.md)。下方保留首轮前端测量；其中通知调度已被第二轮的显式阻塞线程池实现进一步完善。

同日按用户要求生成性能候选 `43b47f27`，包含两轮改动，构建与独立解包校验通过。安装文件和哈希见上述底层记录；尚未安装，原生实机验收仍待恢复。

## 本轮改动

网络 SSE 事件现在读取已有的 `/api/network`，任务更新、流式消息和重连仍读取完整工作区。刷新请求串行合并，完整更新优先，保留请求进行中到来的刷新。5 秒完整兜底、3 秒通知、2.5 秒队列和文件轮询频率保持。

新 `reuseJson` 对实际 JSON 字段逐项比较，复用未变分支；不依赖任务版本判断消息、审批是否变化，不修改输入。会话派生数据、历史行和消息区复用稳定结果，避免输入、节点心跳和相同轮询快照重绘整段历史，也消除了没有新消息时的滚动读写。语言改变、节点改名、会话选择和实际数据变化仍会更新。

待办的 `checkedAt` 与一次性通知投递不再写入显示快照；收到通知的发送流程保持。免打扰、Worker 报告有效期与冷却提示由正在显示的页面独立计时，不依赖无关的工作区重绘。

原生 `notify_attention` 使用 Tauri 的后台命令调度，避免 Windows 通知服务的同步等待占用窗口事件线程；来源、任务路由、通知类型校验和限流保持。这里确认了线程调度代码与编译结果，尚未量化正式 WebView2 / Windows 合成器的收益。调度依据见 [Tauri 官方说明](https://v2.tauri.app/develop/calling-rust/)，渲染复用依据见 [React memo](https://react.dev/reference/react/memo) 和 [useMemo](https://react.dev/reference/react/useMemo)。

## 固定场景与结果

使用同一生产前端的前后版本，300 个合成会话，其中当前会话 120 条消息、其余每个 10 条；一个合成在线邻居每 200 ms 变化一次。独立 headless Edge `152.0.4191.66`，1280×840，减少动效；前后交替运行三组，以下取中位数。没有正式任务读取、真实模型请求或正式客户端操作。

| 指标 | 优化前 | 优化后 | 变化 |
| --- | --- | --- | --- |
| 6 秒空闲脚本时间 | 54.68 ms | 3.12 ms | 减少 94.3% |
| 8 秒网络刷新 JSON | 33.16 MB | 3.18 MB | 减少 90.4% |
| 8 秒网络刷新脚本时间 | 240.63 ms | 41.87 ms | 减少 82.6% |
| 输入期间脚本时间 | 499.73 ms | 100.57 ms | 减少 79.9% |
| input 至下一次 rAF 回调的 P95 | 11.10 ms | 4.10 ms | 减少 63.1% |
| 网络刷新期间消息区滚动读取 / 写入 | 63 / 21 次 | 0 / 0 次 | 不再重复读写 |
| 20 次 viewport 缩放的渲染线程任务时间 | 462.22 ms | 416.63 ms | 减少 9.9% |

网络场景两边均有 32 次 API 请求；优化前其中 21 次传完整工作区，优化后为 19 次网络快照及 2 次完整工作区。请求频率与任务新鲜度没有通过降频换取数值。各短场景的完整兜底请求次数会因定时器边界略有变化，原始 JSON 保留所有请求与三次样本。

缩放的布局时间为 71.47 → 71.36 ms，样式计算为 169.56 → 177.21 ms，没有布局/样式改善证据。前后均未记录到超过 50 ms 的长任务。以上是浏览器渲染线程的固定合成场景，输入指标不是完整显示延迟或中文输入法实测，缩放也不是原生窗口拖动；未测量后端数据库、磁盘、GPU/DWM 或实际桌面的帧率，不能据此宣称用户的拖动卡顿已经消除。

## 验证与证据

- CI 逻辑组 **236/236**，零跳过，包含新增 6 项快照复用与刷新串行行为验证；测试映射审计通过。
- Rust **7/7**，离线、无默认功能编译测试通过，覆盖通知激活、路由、身份、语言与原生来源约束。
- TypeScript、双语覆盖和生产 Vite 构建通过。现有 500 kB 单块提醒保留；JS 为 560,325 → 562,179 字节，CSS 哈希一致。
- 三组前后运行每次 **11 项 UI 回归通过**：输入完整、旧消息阅读位置、新消息追随、同版本流式消息与审批更新、移除审批、中英文切换、切换会话保留草稿、节点改名、待办回原任务、免打扰到期、Worker 报告到期。零页面异常。

本机全局 `npm` 入口指向缺失的 `npm-cli.js`，因此构建通过 Node 直接依次执行同一个 build 脚本中的双语检查、TypeScript 与 Vite；没有修改全局 npm 环境。

证据根目录为 `.data/verification/desktop-performance-20260907/`：`comparison.json` / `comparison.md` 保留汇总和构建哈希，`before/verified-1` 至 `verified-3`、`after/verified-1` 至 `verified-3` 保留最终原始样本与截图，`logic-report.json` 保留测试结果，`source-snapshot/` 保留本轮源码。早期 `run-*`、`compare-*` 是中间版本；`clock-debug` 记录了补充网络页面检查时合成节点缺少字段导致的失败，补齐 fixture 后重新完成全部最终运行，不属于最终通过样本。

## 复现

`before/dist` 是改动前冻结产物，不应从当前源码覆盖。`after/dist` 为本轮最终源码产物。现有 Playwright 模块与 Edge 可用时，在仓库根目录执行：

```powershell
$env:RIVLOOM_PLAYWRIGHT_DIRECTORY = '<已安装的 Playwright 模块目录>'
node scripts/desktop-performance-check.mjs --dist .data/verification/desktop-performance-20260907/before/dist --output .data/verification/desktop-performance-20260907/before/repeat --label before-repeat
node scripts/desktop-performance-check.mjs --dist .data/verification/desktop-performance-20260907/after/dist --output .data/verification/desktop-performance-20260907/after/repeat --label after-repeat
```

脚本只向自己创建的 loopback fixture 发请求，运行结束关闭自己的浏览器与 HTTP 服务。真实拖动、连续缩放、输入法和性能候选的通知回归继续按待测清单执行；安装由用户操作，Git 仍按整体完成后统一整理。
