# ADR-0007：Preview Release 与官网下载同步

日期：2026-09-05。状态：实施中；云端资源配置与验收另行记录。

用户要求官网随 Release 自动提供新版下载。当前桌面和官网仓库均为私有；已发布 Preview 安装包约 73 MB，而 Pages 单个静态文件上限为 25 MiB。官网目前只有要求签名的正式 stable/beta 发行契约。

采用专用 Cloudflare R2 下载桶和 `downloads.rivloom.com`，桌面 Release 成功后上传同一份已验收文件，再更新独立 Preview 清单并调用官网 Pages main 部署钩子。官网保持静态站，从固定公开清单构建版本卡片。Preview 明确未签名，无客户端自动更新；正式频道仍受其原签名要求约束。

相比把私人 GitHub 凭据放入网站下载代理，R2 镜像不要求访客登录，也不依赖每次下载都读取私有 GitHub。相比跨仓库提交或 dispatch，Pages 钩子不需要额外 GitHub 写权限。代价是新增 R2 存储与请求计费资源、桶范围上传凭据和部署钩子管理。

文件路径不可变，上传冲突失败；公开回读哈希正确后才更新清单。清单使用条件更新并比较源码先后，避免并行构建倒退版本。同步或官网构建失败时保留现有可用下载。只开放专用下载桶，不改变任一源码仓库的可见性。

官方依据：[Pages 文件限制](https://developers.cloudflare.com/pages/platform/limits/)、[R2 公开域名](https://developers.cloudflare.com/r2/buckets/public-buckets/)、[R2 桶范围凭据](https://developers.cloudflare.com/r2/api/tokens/)、[Pages 部署钩子](https://developers.cloudflare.com/pages/configuration/deploy-hooks/)、[GitHub token 的触发限制](https://docs.github.com/en/actions/concepts/security/github_token)。
