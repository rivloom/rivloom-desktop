# ADR-0008：统一 Rivloom 发行名称与身份

日期：2026-09-06。状态：决策已确认，实现与本次云端验收分别记录。

用户要求安装包、GitHub Release 和官网统一使用 Rivloom。本决策替代 [ADR-0007](0007-public-preview-downloads.md) 中对外使用独立 Preview 身份和 `previews/` 对象路径的部分，保留其验证门禁与私有源码边界。

下一版为 0.1.4，采用现有 `desktop` profile、`com.rivloom.desktop` 和 `Rivloom_<版本>_x64-setup.exe`。发布普通 GitHub Release，创建、发布和复用均要求 `prerelease:false`；`make_latest:false` 保留，避免晚完成的旧构建抢占 GitHub Latest。公开下载契约使用 `rivloom-download`、`releases/latest.json` 和 `releases/v<版本>-<源码前12位>-<artifactID>/` 不可变目录。旧 Preview 记录不能被改名后当作新发行证明。

同一源码 CI、原始 artifact ID、runtime 一致性与真实安装证明仍是前置条件。安装测试只接受没有既有 Rivloom 安装或进程的 GitHub 托管 Windows runner，保护旧 Preview 注册表键，所有测试数据和安装文件使用独立目录。R2 同步仍须先验证真实 Release 和附件，再匿名完整下载核对大小与 SHA-256；版本文件不覆盖，latest 通过源码先后与条件写入防止回退，通过公开回读后才调用 Pages `main` Hook。

旧 Preview 安装、数据、Release 与对象保留，不自动迁移、合并或删除。安装包仍未签名，Tauri updater 未接入；名称统一不改变签名或安全更新的验收要求。源码仓库继续私有，公开存储仅承载明确发布的文件与有限元数据。

R2 桶与下载域名已创建，但长期凭据和 Pages Hook 尚未获授权或接通，桌面与官网的公开下载开关均保持关闭。本决策不声称本次 0.1.4 云端构建、普通 Release 或公开下载已成功；实际结果以 [CI](../CI.md)、[RELEASING](../RELEASING.md) 和[交接摘要](../WEBSITE-HANDOFF.md) 的对应证据为准。
