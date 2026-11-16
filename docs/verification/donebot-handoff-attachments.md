# Bot 对话与群聊附件交付

所有服务验证使用 `launchVerificationServer` 的独立端口、临时 HOME 和数据目录，
仅连接脚本化引擎或 loopback 合成网关，不使用正在运行的用户应用、账号或资料。

```sh
pnpm exec vitest run server/handoff-attachments.e2e.test.ts server/host/handoff-attachments.test.ts server/donebot-media-coordination.e2e.test.ts server/runtime-coordinator.test.ts server/donebot/media-followup.test.ts --maxWorkers=2
pnpm exec vitest run server/direct-coordination.e2e.test.ts server/crossed-handoffs.e2e.test.ts server/voice-notes.e2e.test.ts server/bot-attachment.test.ts server/host/turn-attachments.test.ts scripts/testing/file-size-ratchet.test.ts --maxWorkers=2
pnpm typecheck
```

`handoff-attachments.e2e.test.ts` 使用普通部门 Bot，验证直接对话、群聊到直接对话、
直接对话到群聊、群聊到群聊、同群对话、多级转派，以及包含同群对话的多级转派。
执行者通过真实 `attach_file` 返回 PNG、MP4、MP3、PDF。接收会话必须只有一份各类附件，
每个文件都通过真实的消息文件下载接口校验 MIME 和完整字节。派发次数、执行次数和
接收者续作输入也被断言，不能靠额外派发一次“复制文件”来通过测试。

派发已有附件的场景验证源会话中明确引用的四类文件会进入执行 Bot 的直接对话或群聊，
执行者的输入包含可用路径和 MIME，且不会把输入附件重复当作新产物返回。
群消息场景通过真实 `post_to_room` 从直接对话和另一个群发布四类附件；下载字节一致，
随后群内另一个 Bot 收到这些文件的上下文。群消息保持原有 Bot 来源，不自动唤醒其他成员。

`donebot-media-coordination.e2e.test.ts` 对异步图片、视频和音乐分别验证完成与服务重启：
生成 Bot 收到实际回执后，文件进入请求会话；请求 Bot 的续作输入包含交付清单，
原会话和请求会话的消息下载结果逐字节一致，每个任务只有一次收费生成提交。
图片另有失败和停止场景，停止后迟到产物只留在原会话，不再唤醒请求者。

`handoff-attachments.test.ts` 验证任务归属立即落盘、其他 Bot／历史任务隔离、同字节去重、
重复交付幂等、生成产物与手动附件去重、共享一次执行结果、同群多级回传、停止、
权限撤回、私聊范围、链接越界和软链接逃逸。只有已附上的文件可以传递；派发文字中的
任意私有文件路径不会获得读取权限。附件复制失败会明确返回交付失败并保留原文件，
不会宣称成功或重新生成。`runtime-coordinator.test.ts` 还验证共享结果交付完成前不会唤醒请求者。

`direct-coordination.e2e.test.ts` 覆盖原有协调、停止和消息排队行为；顶层会话保持原完成
Promise，以免附件包装推迟完成而让排队消息失去唤醒。`voice-notes.e2e.test.ts` 验证群发附件
仍可和原有语音留言一起工作。`bot-attachment.test.ts` 覆盖 Office、CSV 等其他受支持类型的保存。

合成视频和音频用于证明异步生命周期、文件传输和访问约束，不证明真实供应商可用性、
媒体播放质量，或真实模型的汇报措辞。
