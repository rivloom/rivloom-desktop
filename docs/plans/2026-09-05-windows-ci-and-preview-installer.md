# Windows CI 修复与最新预览安装包

**Goal:** 修复或用证据定位当前 GitHub Windows CI 失败，补齐可追溯的自动预览打包流程，交付包含正式蓝色品牌和最新界面的 Windows x64 `.exe` 安装器。

**Architecture:** 保留现有 Tauri、官方 OpenCode、Windows DPAPI 和业务协议。测试在新建隔离目录中运行；安装包使用独立的 `com.rivloom.conversationpreview` 标识，源码提交、云端检查、候选文件与安装验证分别记录。候选包不自动提升为公开正式发行或 updater 频道。

**Tech Stack:** Node 24.19.0、TypeScript、Windows PowerShell/DPAPI、GitHub Actions Windows 2022、Rust 1.98.1、Tauri 2/NSIS。

## 授权与起点

2026-09-05 用户在两仓库推送授权后，要求处理 GitHub CI/CD 并确认形成可安装的 exe。本轮继续处理 CI、构建及隔离安装验证，不改变用户已安装客户端、真实节点身份、任务数据或模型凭据。

起点 `7c5a3f4dd0773a569327ea4f6097cd1999883080` 的三个自动工作流已运行：10 jobs 中 5 成功、5 失败。构建、引擎端口、权限、模型设置、Session 崩溃恢复通过；失败是长短路径比较、DPAPI 身份保护、mDNS 本机节点为空和 UDP 超时。DPAPI 底层原因尚未确认；mDNS 此次错误早于历史 verified 断言，不预设为同一故障。原始结果见 `.data/verification/desktop-visual-ci-7c5a3f4/summary.json`。

## 执行步骤

1. 核对并修复 `tests/security.test.ts` 的路径预期：验证普通目录被接受且返回正确的规范路径；保留有效性和安全边界，不修改产品行为来适配测试。
2. 在独立数据和非敏感探针中对比正常 Windows 环境与 `scripts/ci-workspace.ts` 的受限测试环境。必要时为云端添加有限诊断，记录进程状态和耗时，不记录私钥、密文或凭据。用实际错误决定修复，不通过明文身份、跳过断言或任意延时掩盖失败。
3. 复查协议、Node P0、mDNS 和 UDP 的首错。保留测试条件、真实网络栈、精确测试选择和失败传播；发现与密钥保护故障分开验证。
4. 完成最小改动和适用本地检查后推送 Git，按精确提交复核三个云端工作流。对新增失败继续定位，保留已发生的失败证据。
5. 更新 `.github/workflows/windows-candidate.yml` 的自动触发与提交绑定，构建独立预览 NSIS 候选包，并上传安装器与有限清单。保留 runtime/版本/许可校验和失败记录，候选构建不得冒充其他 CI 或发行验收通过。
6. 对最终候选检查文件长度、SHA-256、签名状态、原始品牌素材、版本/标识和 runtime 一致性。在受控隔离环境验证安装、启动及卸载/数据保留；确认安装脚本只针对预览产品及自己的进程/目录，必要时使用干净云 runner 完成。
7. 保存最新安装包和核验记录，更新交接文档，提交推送并核对最终云端结果。明确区分安装预览、正式签名发行和应用内更新。

## 完成标准

- 用户能拿到包含最新界面的真实 Windows x64 `.exe` 安装器及对应源码提交。
- 自动检查与候选构建状态可追溯，不把失败、跳过或未执行写成通过。
- 最终文件经过内容与安装验证；原正式安装、数据和旧包保留。
- 官网现有页面、统计、隐私与生产部署设置不在本轮修改范围内。

## 已完成的 CI 修复

`32bdc10` 的受限诊断证明本次云端错误卡在 Add-Type，正常继承环境完成 DPAPI 往返。`dd92730` 仅在系统变量白名单加入 `PSModulePath` 后，三份云工作流 10/10 jobs 成功；四台独立 runner 的单变量反向对照再次复现 Add-Type 超时。路径回归、真实协议、Node P0、纯 mDNS 与 UDP 均通过，生产保护机制和产品功能未改。旧失败和正反证据独立保留，详见 [实际验证](../VERIFICATION.md)。

自动候选流程在构建前要求同仓库 main push、同一完整 SHA 的三份 CI 最新 run/attempt 全部成功；打包、安装和产物交付仍由该候选的独立报告核对。

候选流程已接入独立安装、启动、重启与卸载检查，以及仅限 GitHub 托管 Windows runner 的 WebView2 前置准备。原生启动器同样保留系统 `PSModulePath`，避免其清空环境后重现已查明的 PowerShell 模块发现问题；生产身份加密实现未改。安装报告在元数据恢复后写入当前候选目录，并绑定完整源码 SHA 和安装器哈希。

推送前验证：19/19 CI helper 与安装保护合成测试通过，TypeScript、Vite、actionlint 和两份 PowerShell 语法检查通过。合成测试不执行安装或访问注册表；新候选的真实原生构建和安装验收须继续在云端完成。

首个自动候选 `30426b7` 的基础 CI 再次 10/10 成功，[候选运行 33966800706](https://github.com/rivloom/rivloom-desktop/actions/runs/33966800706) 完成原生/NSIS 编译（9 分 42 秒）、构建前后 runtime 检查与源码绑定。安装前置脚本因 runner 同时存在 setup-node 和预装 Node，把多条 Get-Command 结果拼成一个命令而失败，尚未执行安装。现改为按 PATH 顺序只选择第一份 Node；失败记录保留，下一次候选仍须完成全部安装检查才能交付。
