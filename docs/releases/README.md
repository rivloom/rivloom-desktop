# Windows x64 发行记录契约

这是阶段 D 的自定义签名发行记录契约与工具基础，保留其原有更严格声明要求。当前普通 Release / R2 手动下载使用独立 DownloadRecord；0.1.5 新增的 Tauri 签名清单也独立校验，见 [应用内更新](../DESKTOP-UPDATES.md)。下文自定义契约不是线上手动下载记录或 Tauri JSON，不能混用。发布门槛仍见 [RELEASING](../RELEASING.md) 和[官网/CI/CD计划](../plans/2026-09-05-website-ci-cd-and-updates.md)。

## 唯一记录与身份边界

`scripts/release-record.ts` 导出严格 Zod schema、TypeScript 类型、候选构造函数和解析器。`schemaVersion: 1`、`kind: rivloom-windows-release` 的记录只描述一个 `windows-x86_64` NSIS 安装包。未知字段和不支持的平台会被拒绝；这份自定义记录不是 Tauri updater JSON。

| 字段                  | 约束与含义                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`              | `candidate` 或 `published`；候选的 `publishedAt` 和安装包 `url` 必须为 `null`                                                               |
| `product`             | `desktop` 必须配 `com.rivloom.desktop`；`conversation-preview` 必须配 `com.rivloom.conversationpreview`                                     |
| `channel` / `version` | 正式身份仅用 `stable/beta`；Preview 仅用 `preview`。严格 SemVer；stable 无 prerelease，beta 必须显式使用 `-beta` prerelease                 |
| `source`              | 完整非零 40 位小写 Git commit 与 `clean/dirty` 工作树声明；published 必须为 clean                                                           |
| `artifact`            | 最终安装器的 basename、字节数、小写 SHA-256、`nsis` 格式和下载 URL；哈希计算后不能再改变文件字节                                            |
| `signatures`          | 独立记录 Authenticode 与 Tauri updater 的状态；不能用 SHA-256 代替任一签名                                                                  |
| `notes`               | 摘要、变化、已知问题以及可空的真实公开说明 URL；不要把未覆盖项目写成已验证                                                                  |
| `compatibility`       | 经验证的 Windows 版本、currentUser 安装/WebView2 要求、可升级来源版本、Node 协议/capability/实测应用组合、数据读写/迁移格式；不承诺自动降级 |

正式 stable 记录要求有带时间戳的 Authenticode 验证声明，且验证声明引用最终安装器 SHA-256、验证时间不晚于发布时间。Tauri updater 的 `verified` 声明也必须引用同一哈希，并提供实际签名文件的 base64 内容与公钥指纹；`.sig` URL 不能代替签名内容。Preview 不加入正式 updater 频道。没有 updater 配置的正式记录可以描述手动下载，不意味着客户端已支持自动更新。

兼容字段中的应用版本列表是明确覆盖的版本集合，空列表表示没有声明经过验证的组合，不代表任意版本兼容。这些声明不会替客户端实现版本比较、数据迁移或滚动升级。

这里校验的是**声明的格式及相互一致性**。它不会证明 `source` 声明真实，不会从 NSIS 中提取产品 identifier、证明包内应用架构，也不会验证 Authenticode/minisign 的密码学有效性。候选 CI 和后续发布步骤必须将目标配置、包内身份、commit、签名实测结果与最终包绑定后再形成已发布记录；不能通过手工把状态改成 `verified/published` 绕过发布门槛。

## 目录与 URL

不可变安装包路径固定为：

```text
/releases/<product.identifier>/<channel>/<encodeURIComponent(version)>/<encodeURIComponent(fileName)>
```

published 必须提供规范化的绝对 HTTPS URL，且 pathname 完全匹配上述路径。拒绝账号密码、查询参数、fragment、自定义端口、IP/本地域名、占位域名和 `r2.dev` 开发入口；不会产生伪下载 URL。URL 校验只是语法和路径检查，**不访问网络，也不证明域名归属、文件存在或 CDN 不可变性**。

上传端仍须落实版本目录只写一次、远端字节/签名检查、频道互斥及原子提升。官网只读取通过 `parseReleaseRecord(value, { requirePublished: true })` 的已发布记录。未来 updater 适配器应从同一已发布记录生成官方格式，并单独落实验签、升级和维护流程；不能把网站可展示记录当成可安全安装的证明。

## 本地命令

生成前提供 `candidateMetadataSchema` 要求的 `product/channel/version/source/notes/compatibility` JSON，以及明确的最终安装器路径。元数据必须来自目标构建与真实覆盖范围；这一步没有默认包路径，也不会扫描现有 Preview。签名等会改变字节的步骤应先结束。

```powershell
node scripts/release-generate.ts --metadata <候选元数据.json> --installer <最终安装器.exe> --output-root <本轮独立输出目录>
node scripts/release-validate.ts --record <candidate.json> --artifact <同一最终安装器.exe>
```

生成器检查显式文件是普通 PE 文件，流式计算大小与 SHA-256，并检查读取期间文件是否变化。PE 头检查不等于证明文件是正确产品、有效 NSIS 或安全安装器；NSIS 启动器本身也可能是 x86，不能据此误判包内应用架构。

输出路径为 `<output-root>/releases/<identifier>/<channel>/<version>/candidate.json`，使用排他创建；即使内容相同也不覆盖。重新构建必须用独立输出目录。它只写 `candidate`，签名状态固定为“未验证/未配置”；没有 `--published`、签名、上传或切换频道选项。

以下仅是不可发布的结构片段，不是完整发行记录，没有下载地址：

```json
{
  "status": "candidate",
  "publishedAt": null,
  "artifact": { "url": null },
  "signatures": {
    "authenticode": { "status": "not-verified" },
    "tauriUpdater": { "status": "not-configured" }
  }
}
```

检查未来已经由受控发布流程形成的记录：

```powershell
node scripts/release-validate.ts --record <release.json> --artifact <最终安装器.exe> --require-published
```

`--artifact` 会重新核对文件名、字节数和 SHA-256；省略时仅校验记录。CLI 明确报告未执行签名验证和公网下载。成功退出不是批准发布；`--require-published` 只是拒绝误用候选记录。JSON 输入限 2 MiB，签名私钥、存储凭据、个人路径和未脱敏测试数据不得放进公共记录。

## 本轮验证

```powershell
node --test tests/release-record.test.ts
```

测试覆盖正式/Preview 身份互斥、SemVer/频道规则、不可变 URL 路径、公开 URL 约束、状态/签名哈希声明一致性、兼容声明、候选生成与拒绝覆盖、包大小/字节/文件名变化及非法输入。测试中的 PE 头和签名声明是显式的合成夹具，不是安装包或验签证据；不会创建已发布下载记录。
