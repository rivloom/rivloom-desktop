# ADR 0014：Linux x64 消费自有 runtime 的固定源码

- 状态：已在本地源码接入，未发布
- 日期：2026-09-19

## 问题

Windows 已消费 Rivloom runtime 的1.18.31固定源码，Linux此前仍使用官方1.18.25 npm二进制。两端引擎与共享SDK/plugin基线不同，runtime修正也无法覆盖Linux执行节点。

## 决策

Linux x64 使用与Windows相同的干净runtime提交9b07cf442a7eba60a6fe690f630251d23d24194a，原生编译glibc baseline ELF；SDK/plugin精确为1.18.31。新source lock是shared/engine-source-linux.json，独立于Windows产物。Linux runtime和desktop的原生CI分别构建、运行真实进程的合成模型检查，Linux CLI打包后重新验证归档内容和启动/重启/退出。

已有干净源码提交只包含Windows producer。新增Linux recipe放在runtime仓库rivloom/linux，desktop保存其四文件精确快照和逐文件摘要。外置recipe在隔离干净checkout上编译；来源记录明确区分已提交core和另行固定的构建脚本。此做法允许本地验证完整流程，不需要把未提交改动虚构成可远程获取的新提交，也不复制整份引擎源码进desktop。后续官方升级应同时核对两个平台的source lock、canonical recipe及其快照。

Linux产物含源码清单、manifest、smoke、校验文件、许可证和consumer构建记录；包、服务启动、解包和发行检查绑定这些文件。去掉官方Linux平台npm依赖，缺失或不匹配时明确失败。缓存不代表更新授权，也不绕过source lock。来源记录和哈希提供一致性检查，不等于第三方签名。

## 范围

本次仅x64；ARM64需独立原生构建/验证，不回退旧官方ARM64引擎。CLI控制权限、模型账号、数据目录、配对和任务语义保持既有实现。官网正式下载、更新清单和systemd配置不随本地接入改变；正式发行仍需另行授权并遵循现有验收与R2流程。
