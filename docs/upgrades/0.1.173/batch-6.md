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

## MCP 登录、刷新和命令环境

接入固定上游 b07a4de16、d5e6ee167、89bc1d346、a27236595、e8e97f8e8、50630c354、467f9fad7、06eb477c1、627e0c83f、2faa745e3、7a7f3b578、ecdb86325 和 76dc471a5。并发连接复用按 state 分派的回调监听；刷新结果只适用于发起时的授权记录，注销不等待远端撤销才删除本机令牌。刷新令牌发送前以 0600 文件持久标记，响应丢失或成功但无有效令牌时不重放，离线未连接、明确临时错误及协议允许的非轮换令牌仍可重试。仅在上游声明支持时请求 offline_access；手工 scope 不被改写。

命令服务器探测与聊天共用可写 npm 缓存选择。保留可写的既有缓存和服务器显式设置，仅在继承缓存不可写时使用进程复用的临时缓存；没有放宽环境凭据过滤。query_result 的保留名在所有分页过滤，本地工具替换参数作为通用 normalizer 能力接入；私有本地桌面及其文件工具仍未启用。

2026-11-21 验证：

- `/tmp/donebot-mcp-reliability-auth-final.log`：9 文件 / 319 项通过，覆盖 OAuth、刷新竞争/重启、发现、令牌文件、探测、聊天环境及登录组件。
- `/tmp/donebot-mcp-reliability-gate-final.log`：5 文件 / 102 项通过，覆盖真实子进程协议、分页冲突、环境与 schema。
- `/tmp/donebot-mcp-reliability-workflows.log`：3 文件 / 23 项隔离服务用例通过，其余 325 项由明确测试名过滤而未运行；包含聊天登录卡、成员个人 OAuth 与 MCP API。
- `/tmp/donebot-mcp-reliability-ui-final.log`：真实设置面板完成八项流程，包含阻止弹窗、粘贴回调、处理中取消重试、实际工具探测及退出登录取消；截图位于 `.omb-scratch/mcp-oauth-evidence/`。验证工具 socket 使用短临时目录，避免 macOS socket 路径上限。
- `/tmp/donebot-mcp-reliability-types.log`、`/tmp/donebot-mcp-reliability-lint.log`：类型和 lint 通过。

未访问真实 OAuth 账号或用户应用。npm 权限路径覆盖为单元环境与真实命令子进程测试，不替代真实 Linux 团队隔离。
