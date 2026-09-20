# 模型选择与 Provider 接入

## 思考等级（2026-09-20 本地源码，未发布）

新对话和续聊的模型旁可选择思考等级。选项来自当前账号、自有 runtime 返回的模型能力；不为所有模型固定添加低、中、高。不提供可调等级的模型隐藏该入口。

- **自动（模型默认） / Auto (model default)**：向 runtime 省略 `variant`，使用模型、提供方和 runtime 的默认配置，包括已配置的 agent 默认值。它不切换模型，不保证动态调整，也不等同于中等级或关闭思考。
- 手动选择只发送对应模型的 variant，由 runtime 转换为提供方的 effort、thinking 或预算参数。只有模型明确提供时才显示关闭思考；高等级通常增加用量和耗时。
- 切换模型恢复 Auto。草稿、续聊与每条待执行消息保存各自选择；调整输入区不会改变已经发送的任务。失效等级会被拒绝，不静默改成其他等级。
- 委派时由执行节点自己的模型和执行设置决定等级，发起者的本机配置不会覆盖远端节点。Linux 可用 `models list` 查看 `reasoningEfforts`，通过 `execution enable ... --thinking auto|LEVEL --confirm` 设置后续接单默认值。

Thinking levels are discovered per model from the pinned runtime. Auto omits the explicit variant and uses model/runtime defaults, without model routing. Model changes reset to Auto; drafts and queued messages preserve independent selections. Remote nodes retain control of their own model and thinking configuration.

**2026-09-19 · 本地开发，未发布：** 模型接入增加 OpenRouter、硅基流动中国区、Groq、Together AI、DeepInfra 的常用入口和通用 OpenAI 兼容入口；API Key 列表优先显示常用平台，搜索支持平台别名。正式版仍为 **0.1.18**；上述入口属于当前未发布源码。

**既有功能：** 同厂商多个账号、账号别名、独立 API Key / OAuth 接入和可折叠模型分组于 0.1.17 发布，0.1.18 继续保留。真实厂商账号和套餐权限不属于本轮自动测试范围。

入口：**设备与模型 → 模型与执行 → 模型接入**。接入后的模型出现在会话输入框的“执行模型”、默认模型和连接测试中。

## 常用模型平台

在“模型接入”点击 **OpenRouter**，界面会切到对应 API Key 表单。填写账号别名和该平台的 Key，保存后即可从执行模型菜单选择这个账号的模型；保存不会自动发送模型请求。模型目录来自官方引擎，实际调用权限取决于账号和模型。OpenRouter 使用独立 API Key，参见 [OpenRouter 接入说明](https://openrouter.ai/docs/quickstart)。

快捷入口优先使用实际引擎目录中的原生厂商及专用 SDK。若当前目录没有对应 API Key 接入，入口会提供新的兼容服务草稿，预填以下官方地址；仍须填写真实模型 ID 和 Key，再手动保存。草稿使用独立 Provider ID，不覆盖已有内置厂商、账号或自定义服务，不预设可用模型。

| 平台 | 内置 Provider ID | 兼容配置的默认 API 地址 |
| --- | --- | --- |
| [OpenRouter](https://openrouter.ai/docs/quickstart) | `openrouter` | `https://openrouter.ai/api/v1` |
| [硅基流动（中国区）](https://docs.siliconflow.cn/docs/userguide/quickstart) | `siliconflow-cn` | `https://api.siliconflow.cn/v1` |
| [Groq](https://console.groq.com/docs/overview) | `groq` | `https://api.groq.com/openai/v1` |
| [Together AI](https://docs.together.ai/docs/inference/openai-compatibility) | `togetherai` | `https://api.together.ai/v1` |
| [DeepInfra](https://docs.deepinfra.com/chat/overview) | `deepinfra` | `https://api.deepinfra.com/v1/openai` |

硅基流动中国区与国际区的地址、账号和 Key 分开处理；国际区仍可在 API Key 页搜索 `siliconflow` 或“国际区”，不会把其凭据写入中国区。其他服务可点击“通用 OpenAI 兼容”，自行填写基础地址、协议和完整模型 ID。带 `/` 的模型 ID 应完整保留，不能去掉厂商或组织前缀。

## 同厂商多个账号

1. 选择“账号登录”或“API Key”，查找并选择厂商。
2. 在账号区域点击“添加账号”，填写便于辨认的别名，例如“工作套餐”“个人套餐”。
3. 为这个账号保存 API Key 或完成厂商登录。再点“添加账号”即可接入同一厂商的另一账号。
4. 在执行模型菜单中，按“厂商名称 + 账号别名”找到要用的模型。

账号标签可以切换编辑；“保存别名”只改显示名称，不替换凭据或已有任务的账号。别名在同一厂商内不能重复，最多 40 个字符。原有凭据继续作为默认账号使用，可直接改名，无须重新接入。

两个 OpenCode Go 账号可以分别保存 Key，并以不同别名选择模型。新增账号使用独立的官方引擎和凭据目录，内部保留原始 `opencode-go` Provider ID 及其专用请求处理。当前实现支持明确选择账号，没有自动轮换、额度合并或套餐共享；是否有权限调用某个模型仍由各账号的实际响应决定。[OpenCode Go 官方说明](https://opencode.ai/docs/go/)

**当前本地源码新增，未发布：** 已完成的普通本机会话可在原输入框继续发送，并为下一条消息选择模型。选择随当前会话草稿保存，不修改新会话的默认选项；正在执行时不切换当前模型。工作流的选择随新消息排队，到该消息开始下一轮时生效。

普通本机会话在同一账号内换模型会复用引擎会话。显式选择另一账号时，先确认旧引擎空闲，再建立该账号的引擎会话，保留旧可见消息并将完整可见历史作为背景传入；历史上下文超过 128 KiB 时明确拒绝换账号，不静默截断。停止、审批仍作用于当前实际绑定的引擎。远端会话沿用远端模型配置，不发送本机账号标识代替远端配置。

修改默认模型不改写历史任务。删除某个新增账号会移除它的认证与模型目录；其他账号不受影响。仍绑定被删除账号的旧任务不会偷偷改用其他凭据，必须恢复账号或新开会话。

## 登录与 API Key

- **账号登录**：直接列出引擎实际支持 OAuth 的厂商，可搜索厂商或登录方式，例如 ChatGPT。选择账号后点击“登录 OpenAI”等对应按钮。
- **API Key**：只列出支持普通密钥接入的厂商，选择账号、粘贴密钥后保存。切换厂商或账号会清空未提交的密钥。
- **自定义服务**：填写兼容接口或本机模型；不同 Provider ID 可分别保存独立凭据，详见下方。

账号登录提供“打开厂商授权页”和复制链接，使用系统浏览器完成授权。回到 Rivloom 后按提示点击“已完成授权，连接”；需要授权码的方式会显示输入框。等待限时 10 分钟，可取消；确认授权成功后的短暂保存阶段会锁定取消按钮。浏览器可能记住上次登录的厂商账号，新增另一账号时应在厂商页面确认实际授权身份。

OAuth 方式来自打包的官方 OpenCode 1.18.25，不为仅支持 API Key 的厂商虚构 OAuth 按钮。隔离目录探测曾确认 OpenAI / ChatGPT、GitHub Copilot、GitLab Duo、xAI / SuperGrok、Poe、DigitalOcean、Snowflake Cortex；实际以当前引擎返回为准。要求额外专用 API 参数的厂商暂不显示普通 Key 按钮，可选自定义兼容接口。

接入表单直接点击登录或保存，不再要求勾选额度确认；接入流程不会自动调用模型。真实连接测试仍须单独点击并确认，沿用无工具权限、60 秒等待和 10 分钟最多 3 次的限制。连接成功只证明本次请求成功，不代表任意业务任务都适合该模型。

## 分组模型菜单

“执行模型”按厂商/Provider 分组，同厂商多个账号分别显示别名。组头使用独立底色、边框、模型数量及展开箭头；默认仅展开当前所选组，没有已选模型时展开第一组，可点击组头或“展开全部 / 收起全部”。

搜索同时匹配模型名称、完整 ID、厂商、Provider ID 和账号别名，支持空格分词，搜索时自动展开匹配组。分组按厂商及别名自然排序，组内模型按名称自然排序，同名时按完整 ID 稳定排序。同名模型属于不同账号时分别保留，选择始终对应确切的账号与模型。

上下键移动，左右键折叠/展开组或进入组内，Enter 展开组或选择模型，Esc 关闭并返回焦点；输入法确认不会误选择。菜单自适应输入区位置，列表独立滚动，中英文与窄窗口可用。

容量和“图片”标签来自引擎模型目录。容量采用十进制缩写，例如 1,000,000 → `1M`、262,144 → `262.1K`，悬停可看完整 Token 数；未知容量不显示，只为明确声明图片输入能力的模型显示“图片”。这些声明不等于真实账号调用或图片处理已验收。

## 自定义 Provider

点击“自定义服务”，填写：

| 字段 | 用法 |
| --- | --- |
| 显示名称、Provider ID | ID 使用小写字母、数字、短横线，保存后固定，不能占用内置厂商 ID 或 `rivloom-account-` 前缀 |
| API 地址 | 完整基础地址，例如 `https://api.example.com/v1`，或本机兼容服务 `http://localhost:1234/v1` |
| 接口协议 | Chat Completions 或 Responses，与服务商支持的接口一致 |
| 模型 ID | 每行一个，保留完整 ID，包括其中的 `/`；可写 `ID \| 显示名称` |
| API Key | 需要认证的服务填写；编辑时留空保留原 Key。免认证服务勾选“不需要 API Key” |
| 可选容量 | 默认上下文 32768、输出 4096 Token，小容量模型可按实际限制调整 |

保存后点击已接入标签可修改，点击“添加另一个服务”继续添加。移除自定义 Provider 会删除其受管定义和凭据，并重置失效的默认模型。原始内置账号移除的是认证信息，引擎自带的免认证模型可能继续可用。

基础地址不接受 URL 中嵌入的密码、查询参数、片段和配置变量，Key 单独保存。当前没有增加温度、任意请求头、任意 SDK 包或逐模型复杂参数。

## 存储与运行边界

- 只有工作区创建者可修改接入、完成/取消 OAuth 或执行测试，成员只能查看可用模型。存在运行、等待人工介入或执行中断的任务时，接入配置被锁定；OAuth 进行期间也会阻止启动任务。
- 旧默认引擎保留 `engine/data/opencode/auth.json`；新增账号使用 `engine/accounts/<账号 ID>/` 下独立的官方引擎目录。凭据经官方 Auth API 保存，不进入 Rivloom 业务数据库、接口响应或操作日志。
- `engine/rivloom-accounts.json` 仅记录账号 ID、所属厂商和别名；自定义地址与模型仍由不含 Key 的 `rivloom-providers.json` 保存。新增账号最多 32 个，每个独立引擎会占用本机资源。
- OAuth 在随机暂存目录中的官方引擎完成，成功后仅向所选账号写入认证；取消或迟到回调不能替换原凭据。正常结束会确认暂存进程退出并清理；异常退出不自动恢复登录或导入遗留认证。
- 厂商登录页由系统浏览器显示，Rivloom 不收集厂商密码。Token 后续刷新和厂商专用协议继续由该账号的官方引擎处理。

## 本地预览与验证

先运行 `npm run build`，再用 `node scripts/model-access-preview.ts --open` 查看账号接入，或 `node scripts/model-picker-preview.ts --open` 查看分组菜单。预览只操作合成内存数据，不填写真实凭据。

`node scripts/ci-services.ts provider-accounts` 使用隔离应用、官方引擎及两份合成 Key，验证两个 Go 账号的并发请求、独立停止/恢复、别名持久化、干净重启和删除后的剩余账号调用。OAuth 账号目标、成功/取消/迟到回调用隔离测试验证；本轮未登录真实厂商、未消耗真实额度。

浏览器检查使用 `scripts/provider-access-ui-check.mjs` 和 `scripts/model-picker-ui-check.ts`，可用 `PLAYWRIGHT_MODULE` 指向已有 Playwright。测试结果与桌面构建记录见维护者本地交接文档。

缓存机制说明见 [缓存与 Agent](PROMPT-CACHING.md)。
