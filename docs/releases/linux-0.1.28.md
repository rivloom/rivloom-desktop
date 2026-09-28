# Rivloom Linux 0.1.28

Linux x64 无界面节点同步至 0.1.28，修复模型请求可能早于事件流就绪的时序问题。断线后恢复观察，不重复提交任务；短回复结束后保留原 3 秒窗口内输出采样。

桌面主界面速率入口的同排布局用于 Windows 桌面。统计仍只涵盖本机执行的模型调用，输入采用近 60 秒新确认用量平均值，输出采用近 3 秒文本与推理增量估算值；未知数据不填假 0。

固定核心保持 `1.18.31-rivloom.9b07cf442a7e`，SDK/plugin `1.18.31`，Node.js `24.19.0`。节点协议和用户数据格式不变。Linux 继续手动停止节点、更换程序并保留数据目录，ARM64 暂不发布。

正式发行、公开完整下载和隔离运行已完成，见[整版验收](0.1.28-verification.md)。源码 [d5b71cd9f637dd89ea237acb91f3575084e57805](https://github.com/rivloom/rivloom-desktop/commit/d5b71cd9f637dd89ea237acb91f3575084e57805)；[正式归档](https://downloads.rivloom.com/releases/linux/linux-v0.1.28-d5b71cd9f637-36416520559/Rivloom_0.1.28_linux_x64.tar.gz) 157183595 字节，SHA-256 `fe20730e8955277ef05607076252435614736d4ec5d57e8d1b079384ef426121`。安装与更新方式见 [Linux 使用说明](../LINUX.md)，校验和不等同于数字签名。
