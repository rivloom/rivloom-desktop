# Rivloom Release Name Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 下一版以 Rivloom 名称和正式应用身份构建、发布及展示，去掉对外 Preview 标记，同时如实保留未签名与手动更新说明。

**Architecture:** 使用现有 desktop / com.rivloom.desktop 配置和 0.1.4 版本；原候选与安装证据门禁一并切换身份。发布普通 GitHub Release，独立的严格公开下载记录绑定新的 releases 路径。旧 Preview 安装、数据、Release 与对象保持原状，不自动迁移或误认成普通发行。

**Tech Stack:** 现有 Tauri、Node.js 24、PowerShell、GitHub Actions、R2 S3 同步和独立 Astro / Cloudflare Pages 官网。

---

### Task 1: 版本与候选身份

- 更新 package.json/package-lock.json、Cargo.toml/Cargo.lock、tauri.conf.json 与 UI 版本到 0.1.4。
- 修改 scripts/ci-candidate.ts 及测试，要求 desktop/com.rivloom.desktop、Rivloom 安装器和 ci-v<version> 标签。
- 将当前 Preview 候选安装验收改为 ci-desktop-install-smoke 三文件，保护旧 Preview 元数据；仅在没有已有正式安装的 GitHub 托管 runner 执行真实安装，保留本机安全边界。
- 原有 desktop-install-smoke 旧升级回归入口及开发 Preview 工具保持可用，不复用其名字或证据。

### Task 2: 普通 Release 与公开文件

- ci-preview-release 改名 ci-release，发布与复用均要求 prerelease=false、新 tag/name/body、正式候选及安装证明；保留精确附件摘要核验和重试。
- 新 download-record 只接受 rivloom-download、desktop/com.rivloom.desktop、Rivloom_<version>_x64-setup.exe 和 releases 不可变路径，拒绝旧 Preview。
- R2 同步更新到 releases/latest.json，保留匿名完整下载哈希、条件写入与源码先后防回退；签名/updater 状态仍为 unsigned/not-configured。
- GitHub make_latest 继续 false，避免额外引入未受顺序保护的 Latest 提升。官网使用自己的受保护清单选择新版。

### Task 3: 工作流与官网

- 更新 windows-candidate.yml 的正式 profile、名称、标签入口、脚本、证据路径与 artifact 名，候选/发布/同步仍使用同次原始 artifact ID。
- 官网同步新契约、新快照路径和 Rivloom 下载文案，移除对外 Preview 标签；正式 stable/beta 签名契约保持原要求。
- 官网新增源码受控 publicDownloadsEnabled；本次 false，先部署品牌文案，待下载凭据与真实清单接通后显式启用。启用后的生产 404/错误一律阻止新部署，不能因干净 checkout 清空已发布下载。

### Task 4: 验证与交付

- 运行相关 Node helper tests、TypeScript/构建、PowerShell AST、工作流 actionlint；官网 npm test/build 与桌面/手机页面复核。
- 提交并推送两个独立仓库；核对真实 CI、原生候选安装验收和新的普通 GitHub Release。
- Cloudflare 持续访问凭据仍待此前单独授权，本次不创建凭据；准确区分已完成的名称/发布变更和未接通的官网安装包同步。
