# Automatic Website Downloads Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** GitHub Preview Release 发布后，自动把同一份已验收安装包提供给官网访客，并更新官网版本、下载入口和 SHA-256。

**Architecture:** 延续私有桌面仓库和独立 Astro / Cloudflare Pages 官网。发布成功后的独立同步 job 将安装包及校验文件写入专用 R2 桶的不可变路径，核验匿名下载后更新 Preview 清单，再调用官网 main 的部署钩子。官网生产构建读取公开清单并显示独立的未签名 Preview 卡片。

**Tech Stack:** GitHub Actions、Node.js 24 原生模块、R2 S3 API、Cloudflare Pages Deploy Hook、Astro、现有发行校验与 UI。

## Task 1: 公开 Preview 契约

- 新增 `scripts/preview-download-record.ts` 及测试，在两个仓库保留一致的纯校验契约。
- 清单绑定版本、完整源码 SHA、Release tag/ID、原工作流与 artifact ID、两份文件的固定公开路径/大小/摘要、未签名状态和安装/公开下载检查。
- 官网正式 stable/beta 契约保持其签名要求；Preview 独立消费，不提升为正式升级包。

## Task 2: Release 到公开下载存储

- 新增只在已验证发布成功后运行的同步脚本和 job，显式下载同一候选与发布报告。
- 使用专用桶范围的 S3 Object Read & Write 凭据；Pages 部署钩子仅指向官网 main，不需要跨仓库 GitHub token。
- 原文件以 `previews/<tag>/<filename>` 保存，存在冲突则停止。匿名回读并核对哈希之后才更新 `previews/latest.json`。
- latest 更新使用条件写入和源码先后检查，避免旧构建覆盖新版本；异常保持原有效清单。清单短缓存/不缓存，安装包使用不可变缓存。
- 最后触发官网构建，记录有限结果，错误不得泄露凭据或部署钩子。

## Task 3: 官网构建与页面

- 在官网独立工作区修改下载数据载入、Preview 卡片、页面检查、相关说明和测试。
- 生产 Pages 构建读取固定公开清单；404、网络失败或非法清单使新部署失败并保留现站。离线构建无记录时保持空状态，不发布虚假下载按钮。
- 保留无账号静态网站、现有统计/收录/品牌、独立仓库与 Pages Git 集成。
- 运行测试、Astro 类型/构建/链接检查，检查桌面与手机下载页。

## Task 4: 配置与端到端验证

- 核实 R2 开通状态、专用桶、downloads.rivloom.com、桶范围凭据及 Pages main 部署钩子；需要用户操作的实际账单或凭据授权在实现可评审后集中说明。
- 提交两个仓库代码，部署网站代码，触发本次已发布 Preview 的存储同步，确认无需 GitHub 登录的真实下载与安装候选字节一致。
- 推送后验证 Release 发布与网站同步路径、实际 Pages 成功部署及官网显示。未完成的云端步骤须如实记录，不以本地测试替代。
