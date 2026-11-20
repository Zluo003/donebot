# Webhook 过滤与会话连续性

运行真实服务隔离测试：

```sh
pnpm exec vitest run server/webhook-continuity.e2e.test.ts server/webhook-restart.e2e.test.ts
```

测试通过 `launchRestartableServer` / `launchVerificationServer` 创建临时 home、data 和回环端口，仅安装假引擎。`runControlOmb` 创建 Bot，真实 HTTP 接口配置 Webhook 并接收投递。不访问用户应用或真实网关。

检查顺序：不匹配事件留下 ignored 记录且不创建运行；匹配后产生结果；同一 data 重启后重复投递返回原 runId；后续投递在原会话继续并取得前次结果；删除执行会话后新建；关闭续跑后新建；手动运行可绕过过滤。脚本证据必须恰好出现五次预定执行。

第二个测试在运行入队持久化后、Webhook 投递回执保存前中断进程。重启后完成该运行，重放同 deliveryId 返回原运行，不创建第二条。

保留测试输出的日志和 `.continuity.json` / `.webhook-restart.json`，内含运行记录、脚本执行及聊天证据。UI、撤销、解析与工具目录回归见 `server/webhook-requests.test.ts`、`server/webhook-payload-filter.test.ts`、`server/routine-same-conversation.test.ts` 及 `src/components/automations/{automations,app-events}.test.ts`。


群聊直接投递的回执还须核对实际提交目的地：

```sh
pnpm exec vitest run server/host/webhook-room-post.test.ts server/webhooks.test.ts server/webhook-room-post.e2e.test.ts
```

准备音频期间切换房间会话，返回真正写入的 threadId；同 deliveryId 在重启或触发器改指后仍返回原目的地，不能多发消息或重复合成。旧格式回执继续可读。真实 HTTP 流程使用临时 home、合成 TTS 和假引擎，检查重试返回 threadId 且没有 runId，不访问真实账号。
