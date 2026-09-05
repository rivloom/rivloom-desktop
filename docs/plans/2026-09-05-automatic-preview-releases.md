# Automatic Preview Releases Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 推送 main 后，在全部 CI、构建和隔离安装验收通过时，自动把对应安装包发布到 rivloom/rivloom-desktop 的 GitHub Releases。

**Architecture:** 沿用已验证的候选构建，在同一工作流增加依赖候选成功的独立发布 job。构建保持只读权限；发布 job 只接收当前运行明确输出的 artifact ID，复核源码、安装报告和文件摘要后，创建 Preview 草稿、上传两份附件、检查完整性，最后发布。

**Tech Stack:** GitHub Actions、Node.js 24.19.0 原生模块、GitHub REST API、现有 Windows Preview NSIS 与验证清单。

---

## Task 1: 发布校验与幂等上传

**Files:**
- Create: `scripts/ci-preview-release.ts`
- Test: `scripts/ci-preview-release.test.ts`

1. 编写合成候选和模拟 GitHub 接口测试，覆盖验证失败时零写入、附件冲突、上传中断保留草稿、重试续传、已发布结果复用和标签指向错误。
2. 只使用 Node 原生模块，避免发布 job 安装或执行额外依赖。读取当前候选的八份文件，核对完整源码 SHA、产品、CI、安装、runtime 与安装器字节；测试不运行安装器或访问真实发布接口。
3. 校验 artifact ID 来自当前工作流，名称绑定候选源码与原构建运行。标签使用 `preview-v<version>-<sha12>-<artifactID>`；发布步骤重试复用同一标签，重新构建有独立产物编号。
4. 上传经过核验的原始安装器字节和 `SHA256SUMS.txt`。先创建预发布草稿，全部附件名称、大小、摘要正确后才发布。禁止删除或覆盖已存在的附件，遇到冲突明确失败。
5. 记录有限的发布状态、链接、源码和摘要，并将 Release 链接写入 GitHub job summary；不改变已有构建、安装报告中的历史状态。

## Task 2: 工作流接入

**Files:**
- Modify: `.github/workflows/windows-candidate.yml`
- Modify: `package.json`

1. 候选上传步骤输出 artifact ID，新增 `needs: candidate` 的发布 job。
2. 仅发布 job 获得 `contents: write`，保留 `actions: read`；checkout 指向候选实际 SHA，关闭 Git 凭据持久化。API token 只显式传给发布脚本步骤。
3. 固定官方 download-artifact action，按当前运行的明确 artifact ID 下载；保持完整 CI 与实际安装验收为前置依赖。
4. CI selftest 纳入新增发布测试。发布失败时保留有限报告；重跑失败 job 可以续接同一候选。

## Task 3: 文档、验证与真实发布

**Files:**
- Modify: `docs/CI.md`
- Modify: `docs/RELEASING.md`

1. 说明 main push 自动创建未签名 Preview Release，PR 不发布；说明发布重试与重新构建的标签区别，以及当前私有仓库的下载权限。
2. 执行新增测试与 CI helper 自检、TypeScript、actionlint 和差异检查，并独立审查写权限与失败处理。
3. 提交并推送到 main，核对同一提交的全部 CI、候选构建、安装检查和自动发布 job 真正成功。
4. 检查新 Release 已发布、附件完整、标签指向精确源码；从 Release 下载 exe 并核对其与验收候选的 SHA-256 和字节数一致。

当前自动化继续发布独立 Preview 内测包，不增加签名服务、正式升级包或客户端 updater。已有手工预发布 `preview-v0.1.3-2ac60df` 保持原有文件。

## 本地验证记录

2026-09-05：全部 25 项 CI helper 自检通过（包含 6 组新增发布测试），TypeScript、四份 workflow 的 actionlint、修改代码的格式和差异检查通过。发布校验器也已读取上一轮真实构建与安装验收的八份文件，确认原安装器字节和摘要兼容；该检查没有执行安装器或调用发布接口。独立审查未发现剩余修改项。云端首发以推送后的实际工作流和 Release 结果为准。
