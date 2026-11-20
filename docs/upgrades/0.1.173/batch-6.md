# 批次 6：设置、Apps、技能与文件

本批继续实施；以下只记录已验证的子项。

## GitHub／skills.sh 技能导入

接入固定上游 558047fff、8ed728be7、1f08f4912 和 92585043f。skill_manage 新增 import，把单个远端技能转为受审核的 create；SKILL.md 和至多八个 references/<topic>.md 进入原有扫描、32 KiB 单文件限制、名字冲突、审批和 Undo 机制。脚本及其它文件不进入该方式，摘要明确列出遗漏文件。

保留 DoneBot 既有 skill_import：默认只预览，明确安装时保留整个受验证文件夹（包括脚本、资源），以禁用状态安装，不执行脚本。两种接口均在下载结束后复查任务是否仍有效、技能设置和当前管理权限；共享同一下载预算和任务取消信号。直接应用政策保持原版：本机可直接应用并撤销，非主人驱动的 Cloud 会话须主人确认；本轮没有增加额外本机审批。

原版策略在下载后重新读取审批来源和卡片容量，避免下载期间的变化失效。真实个人 Cloud 访客测试在其它请求填满八张卡后拒绝第九张；错误审核哈希不安装，正确哈希只安装卡片展示的正文和参考文件。未接入模板脚本、私库连接及团队共享配额。

2026-11-21 验证：

- `/tmp/donebot-skill-import-regression-complete.log`：7 文件 / 377 项通过。包含取消前与取消中下载、单个及多技能源、路径/大小限制、扫描/审批/Undo、技能工具和原始/打包工具目录一致性。
- `/tmp/donebot-skill-import-workflow-cloud.log`：6 项真实隔离服务流程通过。覆盖本机撤销、下载中关闭技能功能（两接口）、移除管理权限、停止任务取消上游下载、完整文件夹禁用导入，以及实际重启成个人 Cloud 后的访客卡片容量与精确字节审批。
- `/tmp/donebot-skill-import-workflow.log` 中既有 bot-skill-setup fixture 通过，保留 Chief 与专家技能目录、完整本地技能文件、跨 Bot 管理和撤销。
- `/tmp/donebot-skill-import-types-final.log`、`/tmp/donebot-skill-import-lint-final.log`、`/tmp/donebot-skill-import-i18n.log`：类型、lint、16 个语言目录校验通过。

工具目录仅技能 profile 增加 267 字节；预算基线不变，2% 约束继续通过。未访问真实 GitHub、网关或用户数据。这些测试不替代跨节点团队与平台验收。
