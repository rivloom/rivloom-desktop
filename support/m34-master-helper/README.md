# M3.4 第二个物理 Brain 测试助手

在 **192.168.5.20** 使用。现有 Rivloom 0.1.3 窗口保持打开，不重新安装、不删数据。

1. 已有助手请按下方“已有助手更新”覆盖代码，**不要新建文件夹**。仅第一次使用才将整个压缩包解压到普通文件夹；不要直接在压缩包内运行。
2. 双击 `start-master.cmd`，等待 `READY Node=... Brain=...`。
3. 将 READY 那一行或截图发给测试协调者。先不要输入其他命令。

本助手调用本机已安装的 Rivloom 0.1.3 和官方 OpenCode，不下载依赖、不要求 Git、不需要模型 Key 或管理员权限。它在解压目录的 `.data/independent-master` 中创建独立测试数据：先在独立发现域自动形成 Brain，再以原身份接入普通网络。不会更改原客户端身份、任务、模型设置、防火墙或系统时钟；不会扫描、快照或哈希项目文件。

第一次启动会等待自动形成并重启一次，通常约半分钟，以 READY 为准。控制面本机执行能力保持关闭。启动本身不配对、不提交任务、不验收结果。端口冲突或保护软件阻止时保留错误信息并联系协调者，不关闭安全功能。

命令仅在协调者要求时使用：

- `status`：打印本测试实例的 Node、Brain、Worker 和任务状态。
- `pair`：仅向原 Worker t9MUCF 发起配对；比较短码后由另一端确认。
- `submit`：提交本助手唯一一条确定性纯文字测试任务；重复输入不创建第二条。
- `accept`：仅验收本助手处于待验收状态的那条测试任务，不是 M3.4 MVP 签字。
- `offline` / `online`：停止或恢复本助手的控制面，保留同一身份及任务；不操作现有桌面。
- `stop`：正常退出助手并保留数据。

## 竞争测试助手 v2（产品仍为 0.1.3）

已有助手更新：先在当前助手输入 `stop`，等待 CLEANUP；把新版压缩包的文件解压覆盖到**当前正在使用的助手文件夹**，保留其中的 `.data`，再双击原 `start-master.cmd`。本次 5.20 的目标是 `C:\Users\x\Desktop\Rivloom_M3.4_Master_Helper_0.1.3_race-v1`；即使 zip 名为 race-v2，也不要另建 race-v2 目录。更新后应仍是 Node Ytmgnp… / Brain 024a07…，STATUS 中 raceHelperVersion=2。包内没有 `.data`，不需要重装 Rivloom。先发 STATUS 核对身份，未确认前不 prepare/submit，也不要删除旧 Task。

新增命令仅由协调者给出具体参数时使用：

- `prepare <UUID>`：原 Worker 执行能力先由协调者关闭；此命令只登记一次测试意图，输出 RACE_PREPARED，不创建 Task、不调用模型。双方准备好后由协调者恢复 Worker 的原执行配置，助手自动提交一次固定纯文字 Portable Task。无需 UTC 时刻，不会因用户回复晚而过期。
- `race-status`：只读打印各次测试及原权威 Task/Execution 状态。RACE_DISPATCH 的 submitted 只表示 Task 已创建，不能据此判定竞争通过。
- `race-cancel <UUID>`：只撤回尚未触发的准备或旧定时器；不能取消已经发出的任务。
- `race-accept <UUID>`：协调者检查文字结果后，验收该 UUID 对应的待验收测试 Task，不影响原单条测试任务。

每个 UUID 只能使用一次。连接失败、uncertain 或 missed 时不要重输或换 UUID 补发，先把输出交给协调者；必须检查两端实际 Task/Worker 状态。资源暂未就绪时等待；发现已开放但槽位已占满则 missed，不补发。助手重启不自动恢复监听/定时器，也不自动重试；stop 会撤回未提交意图，保留原数据及已提交 Task，不会取消业务 Task。已 prepare 时先 race-cancel 再 offline。原 submit/accept 仍只处理原来的单条 B Task，与 race Task 分开。

旧 v1 ledger 可读取和验收；`arm <UUID> <UTC>` 仅保留给既有回归，不再用于人工协调物理测试。不要复制旧 UTC 命令。

本工具不增加网络监听或远程管理接口，不设置系统时钟、不修改信任/调度规则、不伪造资源报告。准备门闩使用测试 Worker 的正常本机执行能力 API；关闭/恢复由协调者操作，必须恢复原 Project/model/ask/单槽配置。开启时不能保证跨机器请求绝对同时到达；竞争是否成立必须由实际单槽准入、排队、执行与会话证据判断。

后续从同一解压文件夹再次双击即可沿用原测试身份。不要删除、移动或复制 `.data` 来制造新 Brain；不要同时启动两份助手。恢复失败应保留错误，不擅自清空数据。日志 `status.json` 位于 `.data/independent-master`，身份/认证文件不要上传或发进聊天。
