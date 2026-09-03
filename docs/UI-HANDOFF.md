# 下一会话：界面改版交接

更新：2026-09-03。项目：`C:\project\rivloom-opencode`。

## 用户最新决定

下一会话修改界面；本会话只保存进度、文档和本地 Git。具体页面、布局、视觉风格和交互尚未给出，先听用户说明，不擅自重做界面。此前提出的“单 Brain 目标拆解/任务编排”未获采纳，不作为下一项功能。

## 已保存的产品基线

- 产品版本 0.1.3，官方 OpenCode/SDK 1.18.25；M3.3 和 M3.4 当前 MVP 范围已结项。
- 多个独立 Brain 通过共享 Worker 使用资源，每个 Task 只属于一个 Brain，Task 与每次 Execution 分离。当前 Master Host 固定，不存在已实现的选主/HA。
- Node 管理本地普通文件夹 Project、模型、凭据、额度和最终准入。Brain 不是每台 Node 上必有一个的对象，不持有统一模型池。
- 两物理设备单槽竞争、review 占槽、原 Task 排队续跑和分别验收通过。最终 5 accepted 业务任务、5 官方 session、7 Execution、0 工具调用；测试模型是确定性本机夹具，不冒称新增真实 AI 编程验证。
- 纯 mDNS 专项仍失败：最近完整回归为 92/93，单独复查也失败；正常 mDNS + UDP 物理路径通过不能代替它。M3.3 后续优化、人员/企业治理、HA/脑裂和跨 Brain Task 不自动纳入改版。

先读 [HANDOFF](HANDOFF.md)、[MILESTONES](MILESTONES.md)、[PROGRESS](PROGRESS.md)、[VERIFICATION](VERIFICATION.md)、[ADR-0004](adr/0004-automatic-brain-masters-and-shared-workers.md)。涉及旧信任和审批交互时再核对 ADR-0001/0002/0003。旧“待配对/待验收”、PID、端口和会话号只作历史，不照抄执行。

## Git 与验证

- 原开发起点是 `f5ce9ed`；当前检查点提交标题为 `feat: complete M3.4 shared-worker MVP and save UI handoff`。新会话先运行 `git status --short --branch`、`git log -3 --oneline`，以实际 HEAD 为准。
- 本次仅在当前 `main` 保存本地提交，不推送远端、不创建分支/worktree、不改写历史。
- 保存前重新通过 `npm.cmd run build` 和 59 项时差/高位端口/恢复/竞争助手定向测试；两个 PowerShell 脚本语法解析通过。具体命令见 VERIFICATION，不宣称全量绿色。
- `.data`、`dist`、安装包、运行身份/任务数据库和凭据被 Git 忽略，原地保留，不在提交中。Git 记录保存源码和文字证据，不是运行数据备份。

## 界面代码入口

| 文件 | 当前职责 |
| --- | --- |
| `src/main.tsx` | App、侧栏、任务工作台、项目和成员页面、任务详情与弹窗 |
| `src/node-network.tsx` | 节点与 Brain 页、资源/执行能力、发现配对与 Brain 任务 |
| `src/model-settings.tsx` | 模型与额度设置 |
| `src/styles.css` | 全局视觉、布局和组件样式 |
| `src/api.ts` / `src/desktop.ts` | 业务接口、桌面鉴权和目录选择；改视觉时不要顺带改变协议 |
| `shared/types.ts` | 前后端业务类型与状态，不能为界面方便改变任务归属或审批语义 |

仍交付 Windows Tauri 桌面产品；浏览器只用于内部调试，不自行改成网页产品。涉及业务或架构变化，先讨论并更新 ADR、最小闭环和验收，再实现。有必要启动预览时先核对既有进程和数据目录，使用隔离开发数据，不重用正式或物理验收目录。

## 原现场与产物

- 本轮没有停止/重启两台正式客户端或测试 Worker/A/B，没有重放 Task、改变执行策略或配对。上次采样 Worker 空闲槽 1、夹具已 release；当前存活状态必须重新只读核对。
- 原 Worker 根：`.data/m34-physical/a4530002-0690-40f6-a232-b632fefc5148/worker`，Node `t9MUCFG44Q3nM4txwjG3UPI7mbwePMsM`。合法 declined 历史会触及助手恢复预检限制；不能删历史或新建身份绕过。
- 最终物理报告：`.data/verification/m34-physical-prepared-race-2ebbcc36.json`；其中 next 保留当时待确认结项的历史语境，当前下一步以本交接为准。不再 prepare/accept/submit。
- 内测安装器：`src-tauri/target/release/bundle/nsis/Rivloom_0.1.3_x64-setup.exe`（71,083,411 字节）；助手包：`.data/distribution/Rivloom_M3.4_Master_Helper_0.1.3_race-v2.zip`（20,017 字节）。本轮未重建/安装，保存不等于签名发行。
- 不修改或 fork OpenCode；不要求 Project 有 Git；不建立文件快照或内容哈希；不读取或提交用户凭据，不自动清理数据或关闭正式程序。

## 可复制的新会话开场

> 继续 `C:\project\rivloom-opencode`，这次修改界面。先读 `docs/UI-HANDOFF.md` 和其中的交接/里程碑/验证文档，再核对 Git；M3.4 当前 MVP 已结项，纯 mDNS 专项仍待查。先听我说明具体界面要求，不自动做任务编排、人员、HA 或跨 Brain 委派，保留现有架构和节点数据。
