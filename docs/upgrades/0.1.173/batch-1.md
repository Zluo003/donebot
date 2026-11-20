# 批次 1：运行稳定性

固定来源为上游 `6d9138b677d2cb0616d7043727a96f369a17f52b`、`d4108c8b05acde6537cb1edff83ccea61a42f4e6`、`f8a2b5034f54c69bba0c0256103eb6a3fea8c65c`、`92cedf056588e31c47260a520adf0e69fe8d8c13`、`9620d6b11e216d6b74cd2666d9d9c79d6988b2bc`，以及 `1b10f047b179eeb0e1c59e1dfe17ae0e110bec68` 的历史分页部分。

接入 cgroup 内存与进程准入、生成进程失败分类、浏览器启动准入、空闲引擎回收、限定次数退避重启、驱动级错误作用域、缓存和线程映射回收、延迟合并保存、增量 Bot frame、SQLite 游标分页和停滞诊断。桌面管理的运行服务保持既有准入行为；资源不足不触发收费模型备用。权限、引擎会话和用户操作仍同步落盘；仅可丢失的统计与结束状态允许延后保存。未导入上游完整性能采集及其他运行时重构。

2026-11-20 隔离验证记录：

- `pnpm lint`、`pnpm typecheck` 通过。
- 自有网关、媒体、Cloud、价格、推理分离回归：58 个文件、624 项通过，日志 `/tmp/donebot-custom-regression3.log`。
- 进程、浏览器及健康检查：7 个文件、341 项通过、1 项跳过，日志 `/tmp/donebot-browser-stability-tests.log`。
- 崩溃、重启及缓存：9 个文件、217 项通过、2 项跳过，日志 `/tmp/donebot-crash-tests3.log`。
- 保存、注册表、分页、frame、备份相关套件：原 321 项通过，发现的两项问题已修复并分别重跑通过，日志 `/tmp/donebot-store-stability-tests.log`、`/tmp/donebot-store-stability-retry.log`、`/tmp/donebot-thread-frames-final.log`。
- `node --experimental-strip-types scripts/control-omb.ts launch`：临时 home/data、假引擎，doctor 通过；合成 Bot 完成一轮，只有一条答复及摘要，usage turns=1。结果为 `/tmp/donebot-stability-fixture-{bot,send,wait,messages}2.json`。仅停止本次 launcher，退出 0。
- `node --experimental-strip-types scripts/verify-workspace-backup.ts`：两套一次性服务导出恢复，ID、对话、附件、技能和个人资料保留，源凭据排除，目标凭据不变，恢复后继续对话，安全副本保留，临时目录清理完成。日志 `/tmp/donebot-stability-backup-workflow2.log`。

持久工作流证据目录为 `/var/folders/wf/gs6jc_rd4qd_6_1jmqjkg1jh0000gn/T/donebot-verification-evidence/`，聊天日志 `server-1795160113755-48012.log`，备份证据 `server-1795160329629-48874.log.workspace-backup.json`。

上述结果不证明真实 Linux 资源压力、Windows、生产镜像或在线更新；这些仍由批次 8 资格验证覆盖。没有修改生产网关、真实账号或现有实例。
