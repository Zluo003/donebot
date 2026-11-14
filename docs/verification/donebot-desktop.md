# DoneBot 自有云桌面

本轮仅替换 Boat 工作位置，不同步团队、Bot、soul、skill、记忆或任务。引擎及会话仍留在所选工作空间。本机 Bot 使用云桌面时本机须保持运行；Cloud 工作空间中的 Bot 可独立运行。

## 隔离验证

```sh
node --experimental-strip-types scripts/verify-donebot-desktop.ts
```

脚本启动两个临时运行服务、合成网关和桌面，挂载真实 ComputerPanel 并驱动 Chrome。检查同一 Bot 和原会话的工具调用、命令执行各一次、桌面文件成为原会话可下载附件、无 Boat/私有桌面入口、真实 noVNC 画布和退出后查看连接撤销。所有凭据均为合成数据，结束仅清理本脚本的子进程和临时目录，证据路径由脚本输出。

此 fixture 的桌面和 LLM 为模拟实现，不证明真实 Linux 桌面、真实模型能力或生产部署。Linux 桌面另执行相邻 DoneBot-Cloud 的[桌面验证脚本](https://github.com/Zluo003/DoneBot-Cloud/blob/main/scripts/verify-desktop.mjs)，仅限显式标记的一次性 Linux 环境。

## 代码边界

`server/donebot/desktop-*` 实现自有桌面的固定协议桥，`src/donebot/DesktopPanel.tsx` 提供入口。原版调用点仅增加工作位置映射、原生 CUA 工具挂载、查看目标和附件导出。已有 Boat 配置在 DoneBot 模式下映射到自有 Cloud，不重写保存的数据；VPS 继续使用原版路径。

客户端经网关既有实例代理访问 Cloud 的固定桌面接口；JWT 留在服务端。Cloud 使用每用户 Unix socket 连接受限桌面，不开放宿主 Docker socket、任意实例、镜像、挂载或宿主命令参数。桌面操作使用唯一编号关联异步回执，丢失响应不自动重复副作用；本地、Cloud、查看者争用同一桌面控制权，中断结果需要核对。

## 部署

须同时部署本轮 DoneBot runtime 镜像和 DoneBot-Cloud agent，并配置经过核验的图形桌面镜像。现有发布摘要不会自动包含本轮源码。新实例运行盘 5 GiB、桌面盘 10 GiB，合计最大 15 GiB；已有较小磁盘保留原容量。配置与真实 Linux 验证见相邻 Cloud 项目的部署文档。

## 本轮结果（2026-11-14）

DoneBot 59 项针对性测试、Cloud 28 项测试、类型检查、lint、server bundle 与前端构建通过。上述双 runtime + Chrome fixture 通过，合成证据留在 `/var/folders/wf/gs6jc_rd4qd_6_1jmqjkg1jh0000gn/T/donebot-desktop-evidence-N0vK4j`。

相邻 Cloud 项目的 `docs/verification/desktop-scope-2026-11-14.json` 另记录本轮真实 Debian 13 ARM64 桌面、硬配额和 systemd 验证；无生产账号、真实 LLM、镜像发布、生产部署或 DMG 验收。
