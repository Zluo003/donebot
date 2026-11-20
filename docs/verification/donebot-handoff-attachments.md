# Bot 对话与群聊附件交付

所有服务验证使用 `launchVerificationServer` 的独立端口、临时 HOME 和数据目录，
仅连接脚本化引擎或 loopback 合成网关，不使用正在运行的用户应用、账号或资料。

```sh
pnpm exec vitest run server/handoff-attachments.e2e.test.ts server/host/handoff-attachments.test.ts server/donebot-media-coordination.e2e.test.ts server/runtime-coordinator.test.ts server/donebot/media-followup.test.ts --maxWorkers=2
pnpm exec vitest run server/reused-attachment.e2e.test.ts server/reused-attachment.test.ts server/drivers/openai-chat.test.ts src/components/FailedTurnRow.partial.test.ts --maxWorkers=2
pnpm exec vitest run server/direct-coordination.e2e.test.ts server/crossed-handoffs.e2e.test.ts server/voice-notes.e2e.test.ts server/bot-attachment.test.ts server/host/turn-attachments.test.ts scripts/testing/file-size-ratchet.test.ts --maxWorkers=2
pnpm typecheck
```

`server/handoff-attachments.e2e.test.ts` 使用普通部门 Bot，验证直接对话、群聊到直接对话、
直接对话到群聊、群聊到群聊、同群对话、多级转派，以及包含同群对话的多级转派。
执行者通过真实 `attach_file` 返回 PNG、MP4、MP3、PDF。接收会话必须只有一份各类附件，
每个文件都通过真实的消息文件下载接口校验 MIME 和完整字节。派发次数、执行次数和
接收者续作输入也被断言，不能靠额外派发一次“复制文件”来通过测试。

派发已有附件的场景验证源会话中明确引用的四类文件会进入执行 Bot 的直接对话或群聊，
执行者的输入包含可用路径和 MIME，且不会把输入附件重复当作新产物返回。
群消息场景通过真实 `post_to_room` 从直接对话和另一个群发布四类附件；下载字节一致，
随后群内另一个 Bot 收到这些文件的上下文。群消息保持原有 Bot 来源，不自动唤醒其他成员。

`server/donebot-media-coordination.e2e.test.ts` 对异步图片、视频和音乐分别验证完成与服务重启：
生成 Bot 收到实际回执后，文件进入请求会话；请求 Bot 的续作输入包含交付清单，
原会话和请求会话的消息下载结果逐字节一致，每个任务只有一次收费生成提交。
图片另有失败和停止场景，停止后迟到产物只留在原会话，不再唤醒请求者。

媒体回执、跨 Bot 回传清单、附件工具描述与工作目录提示均明确：已交付的文件直接汇报，
无需再次复制或附加；新建或编辑后的文件才需要附加。`server/reused-attachment.e2e.test.ts`
用隔离网关驱动实际 Chat Completions 和 Responses 引擎，在普通 Bot 直接对话和同群对话
中收到 PNG、MP4、MP3、PDF 后，故意连续再次附加 12 次。工具全部成功返回已有附件回执，
不消耗新附件名额，不新增文件消息，也不更改已有文件名；原始四份文件仍可逐字节下载，
任务只派发一次并且不出现失败或“部分完成”。脚本化调用用于验证服务容错，不代表真实模型
必定遵循交付提示。
每个场景的 fixture URL、日志路径、等待结果和完整消息记录保存在
`.omb-scratch/verify-evidence/attachment-reuse/`，fixture 退出时删除临时用户数据并保留日志。

异步媒体验证还让生成 Bot 在完成或重启后的媒体回执中再次附加原始图片、视频或音频，
验证通过原有生成任务和消息归属检查复用产物，不复制附件或再次生成。
`server/reused-attachment.test.ts` 验证缺失文件、软链接逃逸、未交付的兄弟文件、其他会话、原始源路径、
预览图片，以及打开期间停止或移除附件的拒绝。复用权限仅来自当前活动对话的已有附件；
没有开放整个应用数据目录。工作目录内已有文件无需在当前轮次创建，相关回归位于
`server/bot-attachment.test.ts`。实际工具失败的提示沿用原有引擎和 UI 测试。

`server/host/handoff-attachments.test.ts` 验证任务归属立即落盘、其他 Bot／历史任务隔离、同字节去重、
重复交付幂等、生成产物与手动附件去重、共享一次执行结果、同群多级回传、停止、
权限撤回、私聊范围、链接越界和软链接逃逸。只有已附上的文件可以传递；派发文字中的
任意私有文件路径不会获得读取权限。附件复制失败会明确返回交付失败并保留原文件，
不会宣称成功或重新生成。`server/runtime-coordinator.test.ts` 还验证共享结果交付完成前不会唤醒请求者。

`server/direct-coordination.e2e.test.ts` 覆盖原有协调、停止和消息排队行为；顶层会话保持原完成
Promise，以免附件包装推迟完成而让排队消息失去唤醒。`server/voice-notes.e2e.test.ts` 验证群发附件
仍可和原有语音留言一起工作。`server/bot-attachment.test.ts` 覆盖 Office、CSV 等其他受支持类型的保存。

合成视频和音频用于证明异步生命周期、文件传输和访问约束，不证明真实供应商可用性、
媒体播放质量，或真实模型的汇报措辞。
