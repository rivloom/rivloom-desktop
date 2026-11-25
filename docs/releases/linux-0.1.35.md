# Rivloom Linux x64 0.1.35

正式源码 [`a21de5befa48436d84bf54f36c71914b4bccd1aa`](https://github.com/rivloom/rivloom-desktop/commit/a21de5befa48436d84bf54f36c71914b4bccd1aa)（相对 Windows 0.1.35 发布提交 `0dac0fe` 仅增加公开验证文档，运行时与服务端代码完全一致），随包核心保持 `1.18.33-rivloom.655285f835f8`，SDK/plugin 保持 1.18.33，Node.js 保持 24.19.0。同步知识库按需读取记录、会话上下文沉淀能力与既有传输/退出修复；无 GUI 执行节点继续按 [Linux 使用说明](../LINUX.md) 手动升级。

[同源 Linux CI](https://github.com/rivloom/rivloom-desktop/actions/runs/45556764906)（`build (x64, ubuntu-22.04)`，artifact `14996098627`）与 [独立发行](https://github.com/rivloom/rivloom-desktop/actions/runs/45557446033)（`verify`、`publish`、`website-download` 3/3）均在 attempt 1 成功。正式 Release 为 [`linux-v0.1.35-a21de5befa48-45556764906`](https://github.com/rivloom/rivloom-desktop/releases/tag/linux-v0.1.35-a21de5befa48-45556764906)（ID `457711865`）。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| [Rivloom_0.1.35_linux_x64.tar.gz](https://downloads.rivloom.com/releases/linux/linux-v0.1.35-a21de5befa48-45556764906/Rivloom_0.1.35_linux_x64.tar.gz) | 157,271,519 | `83d68347dd91aff63752203d5be830fd83771e6c0c9a0cb0486af2718d4a46b7` |
| [SHA256SUMS.txt](https://downloads.rivloom.com/releases/linux/linux-v0.1.35-a21de5befa48-45556764906/SHA256SUMS.txt) | 98 | `531317f7696e3b24ce11ed02b1346d0cc977eaefb08495b2ef675ba0e5a80759` |

已从公开地址匿名流式下载完整 157,271,519 字节压缩包与 98 字节校验文件，核对 SHA-256、`releases/linux/latest.json`、GitHub Release 附件及线上中英文下载页（`https://rivloom.com/download/` 与 `https://rivloom.com/en/download/`）完全一致。原生打包、全文件树核验、启动/重启/SIGTERM 与身份边界验证在 Ubuntu 22.04 x64 云端 CI 阶段完成；本次未在本机 WSL 重新解压运行。

运行基线仍为内核至少 4.18、glibc 2.30、libstdc++ 6.0.25。Alpine/musl、32 位与 ARM64 暂不发布；真实模型、实体多机和跨版本升级矩阵未纳入本轮，校验和不等于数字签名。完整发行记录见 [0.1.35 发行验收](0.1.35-verification.md)，本轮 R2 清理审计见 [0.1.35 R2 保留审计](0.1.35-r2-retention.md)。
