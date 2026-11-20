# 异步媒体回执与协调回报

所有服务验证均由 `launchVerificationServer` 创建临时 HOME、数据目录和独立端口，
只连接 loopback 合成网关，使用脚本化模型，不访问生产账号或提交收费生成。

```sh
pnpm exec vitest run server/donebot-media-coordination.e2e.test.ts server/donebot-media-selection.e2e.test.ts server/donebot/media-followup.test.ts server/runtime-coordinator.test.ts --maxWorkers=2
pnpm exec vitest run server/default-bot.test.ts server/default-bot.e2e.test.ts src/components/MausBotWelcome.test.ts --maxWorkers=2
pnpm exec vitest run server/donebot.e2e.test.ts server/donebot/media-settings.e2e.test.ts server/direct-coordination.e2e.test.ts --maxWorkers=2
pnpm typecheck
```

`server/donebot-media-coordination.e2e.test.ts` 通过真实 `coordinate_bots` 派发画图：
多宝的模型走 Responses，画布的模型走 Chat Completions。画布提交媒体后结束模型调用，
协调任务保留媒体任务 ID 并等待，派发者收不到提前完成的回报。
成功或失败回执交付后，画布收到一轮包含实际任务 ID、状态和产物的续作输入，
再经原版协调机制向多宝回报。断言仅有一份图片生成请求，画布只增加一轮模型调用，
多宝的续作输入包含画布的实际回执和已交付附件路径。
图片、视频、音乐均验证完成与重启恢复后的实际附件下载字节一致；跨普通 Bot、
群聊及多级转派的完整附件验证见 [Bot 对话与群聊附件交付](donebot-handoff-attachments.md)。

停止场景在媒体等待期间停止多宝：迟到的图片仍可回到原画布会话，但不会再次唤醒
画布或多宝。重启场景停止并重启同一临时服务，重新登录同一合成账号，检查等待 ID
保留、恢复前没有模型调用，完成后沿同一路径回报且没有重复生成。
无桌面凭据桥的 headless 夹具登录态只保存在内存，重新登录是该夹具的明确步骤。

`server/donebot/media-followup.test.ts` 检查同一派发中的多个任务、生成 Bot／会话／派发 ID 隔离、
账号切换时不泄露产物和错误、登录恢复前保持等待，以及回执处理标记的持久化。
`server/runtime-coordinator.test.ts` 检查续作 ID 经 SQLite 重启后保留、等待时不执行模型、
一次恢复、停止、正常上报以及媒体提交不被当作完成通知。

`server/default-bot.e2e.test.ts` 通过真实语言 presence 接口验证：中文显示“多宝”，
非中文显示 DoneBot，自定义名称保留。默认 Bot 单元验证还覆盖中文地区标签、
启动时选用的语言和隐藏状态保留。欢迎面板空名称使用当前界面语言的默认名。

这些验证证明服务接线、任务生命周期和隔离约束；不证明线上供应商可用性、
真实生成耗时、画面质量，或真实模型是否给出合适的汇报措辞。
