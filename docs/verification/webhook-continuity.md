# Webhook 过滤与会话连续性

运行真实服务隔离测试：

```sh
pnpm exec vitest run server/webhook-continuity.e2e.test.ts server/webhook-restart.e2e.test.ts
```

测试通过 `launchRestartableServer` / `launchVerificationServer` 创建临时 home、data 和回环端口，仅安装假引擎。`runControlOmb` 创建 Bot，真实 HTTP 接口配置 Webhook 并接收投递。不访问用户应用或真实网关。

检查顺序：不匹配事件留下 ignored 记录且不创建运行；匹配后产生结果；同一 data 重启后重复投递返回原 runId；后续投递在原会话继续并取得前次结果；删除执行会话后新建；关闭续跑后新建；手动运行可绕过过滤。脚本证据必须恰好出现五次预定执行。

第二个测试在运行入队持久化后、Webhook 投递回执保存前中断进程。重启后完成该运行，重放同 deliveryId 返回原运行，不创建第二条。

保留测试输出的日志和 `.continuity.json` / `.webhook-restart.json`，内含运行记录、脚本执行及聊天证据。UI、撤销、解析与工具目录回归见 `server/webhook-requests.test.ts`、`server/webhook-payload-filter.test.ts`、`server/routine-same-conversation.test.ts` 及 `src/components/automations/{automations,app-events}.test.ts`。
