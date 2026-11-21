# 团队模型身份与派发

团队能力和模型执行默认关闭。本配方只验证合成网关与隔离资料，不开启生产团队执行。

```sh
pnpm exec vitest run server/donebot/team-model-gateway.test.ts server/donebot/team-runtime.test.ts server/donebot/llm-driver.test.ts server/donebot/llm-protocol.test.ts server/donebot/gateway.test.ts server/workspace-backup-policy.test.ts
pnpm exec vitest run server/workspace-backup.test.ts
pnpm exec vitest run server/donebot/team-requests.test.ts server/donebot/team-model-gateway.test.ts server/channel-queue.test.ts server/steer-queue.test.ts server/drain-coalescing-golden.test.ts server/chat-followups.test.ts server/queue-dispatch-failure.test.ts server/runtime-coordinator.test.ts server/runtime/runtime.test.ts
node --experimental-strip-types scripts/verify-donebot-teams.ts
pnpm exec tsc --noEmit -p tsconfig.server.json
pnpm lint
```

模型测试使用临时 data、生成的签名公钥和 loopback 原生模型模拟器；没有真实账号、安装凭据、供应商或收费请求。验证签名会话的实际成员和原始版本、队列恢复、私聊受众、模型目录、原生请求哈希、凭据头隔离、八路并发和响应丢失。真实驱动验证思考与正文分离，并在团队请求结果不确定时禁止通用重试。

每个原生模型操作由不可变会话绑定及轮次导出 UUID v5；本地派发记录丢失或回滚也使用原编号。网关保留原始执行记录，已经受理的调用只能查询，不能重派。成员来源与派发记录放在私有 `donebot-team-execution/`，备份不携带，恢复保留目标原有记录。来源缺失、版本变化或运行代次不匹配时拒绝执行。

`verify-donebot-teams.ts` 启动两个临时 home/data 的真实服务，验证身份与 HTTP 权限。若本机不能通过 Linux 隔离自检，必须验证聊天返回 503 且未启动引擎；这只证明拒绝执行，不能记作真实 Linux 隔离或团队成功执行验收。

2026-11-21：六文件 149 项通过，日志 `/tmp/donebot-team-runtime-model-final.log`。备份完整测试原有 51 项通过、一项平台跳过，新增备份恢复断言修正后单独通过，日志 `/tmp/donebot-team-backup-authority.log`。服务端类型和 lint 通过；隔离 HTTP 流程日志 `/tmp/donebot-team-model-workflow.log`。

群聊及委派的身份传递已接入：群聊保留原始用户消息，逐轮回复和目标步骤导出子操作；委派保留原成员、版本及受众，不能从私聊扩大到共享会话。协调器任务绑定不可改写，重复委派沿用原绑定。持久化身份失败时仅拒绝新入队且未执行的委派，不取消其他任务。

直接和群聊队列在写入队列前保存私有成员来源，合并时同时核对成员及权限版本；恢复后仍按原顺序分别处理。真实临时 SQLite Runtime 跨两次崩溃验证 `executions - restarts`：崩溃重跑保留同一操作，回答问题、正常继续和子任务结果唤醒分别取得新操作。响应丢失后重跑只查原执行，模拟供应商计数不增加。

2026-11-21：九文件 283 项通过，日志 `/tmp/donebot-team-lineage-final-tests.log`；新增仅拒绝未执行委派的恢复测试后，相关三文件 130 项通过，日志 `/tmp/donebot-team-lineage-admission.log`。最终服务端类型和 lint 通过，日志 `/tmp/donebot-team-lineage-final-{types,lint}.log`。这些是临时队列、真实磁盘协调器及合成原生网关测试，未证明真实 Linux 团队 HTTP 成功执行。

会话压缩的工具外文本调用现在携带原始成员及独立子操作。自动压缩绑定本次派发和实际折叠到的消息；手动压缩从经过验证的点击者建立独立控制动作，不能继承最后发言者或请求正文伪造的身份。闲置团队压缩没有活动成员来源时只用已有本地摘录摘要。辅助调用响应丢失、重启及本地主回复同为第零轮时都不会混用操作或再次派发。

2026-11-21：相关六文件 114 项通过，日志 `/tmp/donebot-team-helper-final-units.log`；真实原生驱动连接 loopback 合成网关，验证原成员版本、正文摘要及响应丢失后供应商计数不增加。个人隔离服务的完整压缩流程 11 项通过，日志 `/tmp/donebot-team-helper-compaction-workflow.log`，包含停止、重启、分支和附件保留。服务端类型及定向 lint 通过，日志 `/tmp/donebot-team-helper-final-{types,lint}.log`。这不等于真实团队 HTTP 成功执行，Linux 隔离阻塞仍存在。

桌面选择续跑从实际先前派发编号导出独立操作，严格匹配 Bot、会话、受众和运行代次。合成网关验证主回复与续跑分别受理，续跑响应丢失后查询不重提。三文件 135 项通过，日志 `/tmp/donebot-team-continuation-units.log`；个人隔离服务桌面选择 6 项通过、41 项按名称未运行，日志 `/tmp/donebot-team-continuation-workflow-final.log`，包含停止、失败、关闭、手动选择和新消息压过旧续跑。该上游夹具最初误入真实网关模式，已限定 `NODE_ENV=test` 和 `DONEBOT_UPSTREAM_FIXTURE=1`，未改变产品网关限制。类型及定向 lint 通过，日志 `/tmp/donebot-team-continuation-{types,lint}.log`。未证明真实 Linux 团队成功执行。

定时跟进在 pending 记录落盘之前保存原派发的私有成员绑定，并固定任务内容、条件、时间、时区、会话及请求人。唤醒校验原受众和运行代次，不使用最后发言者或普通记录中的身份作为授权；缺失私有来源、记录改写或版本变化均拒绝。唤醒轮次可继续安排下一次跟进，重复 tick 和响应丢失沿用同一操作；启动中断仍按既有规则不重跑。

2026-11-21：`/tmp/donebot-team-check-back-units.log` 四文件 51 项通过，包含真实磁盘调度器和 loopback 合成网关，验证私聊、重启、八路 tick、后续排期、成员撤权、来源缺失、任务改写、运行代次变化和响应丢失。`/tmp/donebot-team-check-back-workflow.log` 两文件 3 项真实隔离服务流程通过，验证个人 Ask 工具调用、到点自动续跑、取消及上游 Team fixture 的私聊隔离；该 Team fixture 不等于 DoneBot 签名团队模型成功执行。服务端类型与定向 lint 通过，日志 `/tmp/donebot-team-check-back-{types,lint}.log`。

其他卡片续跑、辅助模型、周期及事件自动化、媒体、终态及生产供应商用量链、跨成员本机和真实 Linux 恶意隔离尚未完成；不得由这些测试推断可上线。

## 团队结算回执与结束状态

2026-11-21：客户端接受独立的 `settled` 结算状态，保留旧服务的 `recorded`。合成网关验证 completed 和 uncertain 均可返回人民币结算金额，重启后只查原执行，不重提。`/tmp/donebot-team-settlement-client-full.log` 四文件 33 项通过，服务端类型与定向 lint 分别见 `/tmp/donebot-team-settlement-types.log`、`/tmp/donebot-team-settlement-lint.log`。

网关一次性 PostgreSQL、真实 HTTP 与生产转发/RecordUsage 流程验证并发派发、幂等扣费、付款归属、结算回执、清理日志后查询及异常响应，race 通过，日志 `/tmp/donebot-team-settlement-race.log`。该流程使用明确选择的合成供应商账号，未运行生产处理器的完整调度选路。raw Chat 的结束证明与费用分别保存；其它协议继续 uncertain。计费队列溢出不丢团队任务，但尚无进程崩溃后待结算恢复，不能开启生产团队执行。

## 真实 Linux 镜像复测

用带有完整 `org.opencontainers.image.revision` 和 `cn.donebot.teams.protocol=donebot.teams.v1` 标签的本地 Cloud service 镜像执行：

```sh
node scripts/verify-team-linux.mjs --image LOCAL_IMAGE
```

脚本只使用精确 image ID，不拉取镜像；容器无外网，资料位于 tmpfs。返回 0 仅代表隔离自检和成员 HTTP 边界通过，尚未执行团队模型任务；返回 2 代表隔离不可用并验证真实聊天拒绝执行，不能当作隔离验收通过；返回 1 代表验证失败。stdout 指向完整日志及 receipt。没有公开网络的正向 egress 验证，不替代最终真实 Linux 全项恶意探测。

2026-11-21 的 arm64 镜像构建及 `userns-refused` 拒绝执行证据见 [批次 8](../upgrades/0.1.173/batch-8.md)。
