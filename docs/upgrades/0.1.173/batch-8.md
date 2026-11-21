# 批次 8：整体回归与发布候选

本批进行中，未达到发布条件。团队能力和执行开关仍默认关闭，未发布镜像或操作生产服务。

2026-11-21 的团队结算切片通过 PostgreSQL/HTTP/race、生产转发和用量记录定向回归、全部 Go 包编译，以及客户端四文件 104 项、类型和 lint。证据见 [模型验证](../../verification/donebot-team-models.md)。最新持久待结算恢复的中断与并发验证已通过；该夹具没有完整生产调度或真实 Linux 团队执行，不能代替本批验收。

## Linux 实际镜像隔离（2026-11-21）

从提交 `e91d40d6e4d6d9f97770c923dde728fd6cd314b1` 的 `git archive` 构建 `Dockerfile` 的 `cloud-service`、`linux/arm64` 目标，未使用工作目录中单独保留的 0.1.3 版本修改或用户资料。镜像本地 digest 为 `sha256:90dc85500b02d012bf3a319bf525e16a51b3ed6c93914097a463e6d57bcafe54`；这是隔离验证镜像，不是已发布的生产镜像。

`scripts/verify-team-linux.mjs` 在临时 tmpfs 中启动真实打包服务，使用合成 Ed25519 成员和团队；只读根文件系统、UID 1001、全部 capability 移除、no-new-privileges、CPU/内存/进程限制保持不变。无外部网络、用户目录挂载或真实网关凭据。单次脚本会记录镜像身份、完整容器日志及结构化 receipt，并只清理其自身容器。

当前 Docker Desktop 29.2.1 的 Linux aarch64 环境返回 `box=off, reason=userns-refused`。真实服务 `/api/health` 返回 503 / ready=false，合成 Owner 聊天提交返回 503、Bot 保持未执行；无凭据和其他团队的读取返回 401，个人账号接口返回 403。最终证据 `/tmp/donebot-team-linux-verification.log`，receipt 目录见日志。初次脚本把 wire 中省略的 idle/busy 字段当作显式 false 导致断言失败；修正 fixture 后在新容器重测。

这证明隔离不可用时拒绝执行，不证明文件、进程、网络、凭据恶意探测通过，也不证明团队端到端执行可用。不得增加容器特权或关闭 seccomp 绕过。需要支持现有安全配置下用户命名空间的真实 Linux 环境继续验收；其余客户端及跨项目工作可继续。

复测命令、退出码和范围见 [验证配方](../../verification/donebot-team-models.md)。Windows、物理手机、跨成员本机、生产供应商用量链、压力恢复及旧版在线升级仍待完整验收。


## 团队账单恢复专项（2026-11-21）

网关真实 HTTP/一次性 PostgreSQL/race 见 `/tmp/donebot-team-pending-race.log`。保存后扣账前中断、真实子进程提交后 exit(42)、八路恢复、日志写入失败回滚、个人平台额度不变及缓存重试均通过；恢复没有再次调用模型。个人用量和平台额度的带 unit 标签回归、全部 Go 包编译及客户端结算兼容复测另有记录，详见模型验证。供应商用量观察或首次保存前退出仍须对账，禁止以重发模型请求处理。该项不改变整体未达到发布条件的状态。
