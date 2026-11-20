# 双向委派文件

只使用临时 home/data 和脚本假引擎。测试自行启动、驱动和关闭真实隔离服务，不接触运行中的用户应用。

```sh
pnpm exec vitest run server/handoff-files.e2e.test.ts server/handoff-attachments.e2e.test.ts server/bot-artifacts.e2e.test.ts
pnpm exec vitest run server/host/handoff-files.test.ts server/host/handoff-inbox.test.ts server/host/handoff-attachments.test.ts server/bot-attachment.test.ts
pnpm exec vitest run server/workspace-backup-policy.test.ts server/workspace-backup-team-private.test.ts server/workspace-backup.test.ts
```

覆盖显式 files、正文引用、各类单聊/群聊委派和链式回传；检查结果会话的附件数量、下载字节、接收方 inbox、执行次数及返回提示。显式与正文引用同一文本文件时 MIME 编码参数不导致重复，另一个引用文件仍会送达。

复制期间取消、撤权、删除或改变私聊受众，不能启动工作或遗留新副本；被拒结果不跨受众传递。接收副本不可通过符号链接或 Windows junction 扩大读取权限。重传保留收件方编辑；失败续跑可重新告知结果。

团队加密导出剔除私聊文件记录及仅用于私聊的待发附件，保留共享待发任务。实际恢复重定位 ledger 路径与对象键，不覆盖本机名称密钥；过期清理不删除其他安装目录的文件。

跨成员本机节点、真实 Linux 隔离、Windows 原生和原生手机端需最终平台验收。当前测试不提交真实收费媒体请求。
