# 团队模型身份与派发

团队能力和模型执行默认关闭。本配方只验证合成网关与隔离资料，不开启生产团队执行。

```sh
pnpm exec vitest run server/donebot/team-model-gateway.test.ts server/donebot/team-runtime.test.ts server/donebot/llm-driver.test.ts server/donebot/llm-protocol.test.ts server/donebot/gateway.test.ts server/workspace-backup-policy.test.ts
pnpm exec vitest run server/workspace-backup.test.ts
node --experimental-strip-types scripts/verify-donebot-teams.ts
pnpm exec tsc --noEmit -p tsconfig.server.json
pnpm lint
```

模型测试使用临时 data、生成的签名公钥和 loopback 原生模型模拟器；没有真实账号、安装凭据、供应商或收费请求。验证签名会话的实际成员和原始版本、队列恢复、私聊受众、模型目录、原生请求哈希、凭据头隔离、八路并发和响应丢失。真实驱动验证思考与正文分离，并在团队请求结果不确定时禁止通用重试。

每个原生模型操作由不可变会话绑定及轮次导出 UUID v5；本地派发记录丢失或回滚也使用原编号。网关保留原始执行记录，已经受理的调用只能查询，不能重派。成员来源与派发记录放在私有 `donebot-team-execution/`，备份不携带，恢复保留目标原有记录。来源缺失、版本变化或运行代次不匹配时拒绝执行。

`verify-donebot-teams.ts` 启动两个临时 home/data 的真实服务，验证身份与 HTTP 权限。若本机不能通过 Linux 隔离自检，必须验证聊天返回 503 且未启动引擎；这只证明拒绝执行，不能记作真实 Linux 隔离或团队成功执行验收。

2026-11-21：六文件 149 项通过，日志 `/tmp/donebot-team-runtime-model-final.log`。备份完整测试原有 51 项通过、一项平台跳过，新增备份恢复断言修正后单独通过，日志 `/tmp/donebot-team-backup-authority.log`。服务端类型和 lint 通过；隔离 HTTP 流程日志 `/tmp/donebot-team-model-workflow.log`。

群聊、委派、自动化、媒体、终态及生产供应商用量链、跨成员本机和真实 Linux 恶意隔离尚未完成；不得由这些测试推断可上线。
