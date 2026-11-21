# 团队共享文件接口

固定来源为 OpenMausBot v0.1.173（799ebcd）的文件存储、路由与 wire types。DoneBot 改用网关签名的成员身份及套餐配额；本配方只验收成员文件接口，不表示团队协作或 Bot 文件挂载已完成。

## 启用边界

- 默认关闭。只有已配置签名团队运行环境且 `DONEBOT_TEAM_FILES_ENABLED=1` 时创建文件服务。
- 必须显式下发 `DONEBOT_TEAM_SHARED_QUOTA_BYTES` 和 `DONEBOT_TEAM_MAX_FILE_BYTES`，两者为安全范围内的正整数字节数，单文件不得超过共享配额。缺失或非法时启动失败，不回退通用模块的默认额度。
- 当前 Cloud worker 不下发启用开关，三端能力协商仍只开放 identity；不能通过本次提交开放生产团队功能。
- 网关验证实际成员后签署方法和完整 URI，运行服务拒绝 loopback、伪造 session、过期签名及另一团队的签名。Owner/Admin 可管理所有文件，Member 只能删除、重命名或替换自己上传的内容。包含他人空文件夹的父目录也不能由创建者整体移除。
- `templates/` 为管理员管理区，成员可读；大小写别名同样保护。共享文件和模板都计入额度。

接口：GET `/api/team-files?path=`，GET/PUT `/api/team-files/file`，POST `/api/team-files/folder`、`/rename`、`/delete`。上传为原始字节；变更 JSON 仅接受相应路径字段。列表和下载均禁止缓存。HTML、脚本、SVG 和未知格式以附件下载，不作为可执行预览。

数据保存在运行实例的 `team-files/`，归属与活动在 `team-files-activity.json`。临时流位于 `tmp/team-files-uploads/`，不进入工作区备份；失败/中断时清理并释放预留名额。下一次上传清理上次进程遗留的固定命名 `.part` 文件，不删除其它文件。完成文件依赖现有工作区快照机制，未新增数据库迁移。

## 隔离回归

```sh
pnpm exec vitest run server/host/team-files.test.ts server/host/team-files.concurrent.test.ts server/donebot/team-files.test.ts server/routes/team-files.test.ts server/request-auth.test.ts server/donebot-team-files.e2e.test.ts server/workspace-backup-policy.test.ts
pnpm exec tsc -p tsconfig.server.json
pnpm exec oxlint --deny-warnings server/host/team-files.ts server/host/team-files.test.ts server/host/team-files.concurrent.test.ts server/routes/team-files.ts server/routes/team-files.test.ts server/donebot/team-files.ts server/donebot/team-files.test.ts server/donebot-team-files.e2e.test.ts server/index.ts server/request-auth.ts scripts/control-omb.ts shared/team-files.ts
```

真实服务流程通过 `launchVerificationServer` 建立临时 home/data、合成网关和 Ed25519 签名，覆盖 Owner/Admin/两名 Member、另一团队及默认关闭的第三个实例。验证原始脚本字节下载且不执行、配额、非法路径、角色注入、归属、管理员模板和关闭时不创建数据目录。服务关闭后保留 `.team-files.json` 回执及日志。

流式 HTTP route fixture 验证 chunked 超限返回 413、上传期间撤权返回 403、断线清理、后续上传恢复，以及读取变更 JSON 后再次检查成员/角色。存储测试覆盖并发预留、目标变更、最终额度复查、未知归属和空目录、符号链接及不可读目录。只有正常读取已完成文件才增加可见内容，没有调用模型或媒体提供方。

2026-11-21：`/tmp/donebot-team-files-regression-accepted.log` 为 7 文件 / 133 项通过。服务端类型与定向 lint 分别记录在 `/tmp/donebot-team-files-server-types-accepted.log`、`/tmp/donebot-team-files-lint-accepted.log`。真实工作流回执为 `/var/folders/wf/gs6jc_rd4qd_6_1jmqjkg1jh0000gn/T/donebot-verification-evidence/server-1795271129738-5770.log.team-files.json`。

## 尚待验收

运行时签名只在请求入站检查到期；持续上传的撤权依赖网关现有流监控取消连接。当前 route 测试使用可撤销的合成身份，尚未让上传经过实际 Go 代理，不能把该检查当成完整撤权链路证明。重启残留测试不等于断电恢复演练。

Bot 尚未挂载共享目录，读写授权、真实 Linux 恶意进程/路径竞争、配额的文件系统强制、管理员模板发布事务、团队界面、备份恢复全流程和平台验证继续实施。当前普通文件接口不能替代这些验收，也不能作为开启团队执行能力的依据。
