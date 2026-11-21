# 批次 4：聊天与 Bot 管理

本批进行中。已接入流式回复、按消息编号合并、Markdown 增量呈现、选择器及分帧状态更新、长历史窗口、选区与滚动恢复、群聊流式渲染。压缩、重新开始、分叉和批量管理继续实施，不能将本批记为完成。

固定来源：6c95a78a1、b692f4709、3824568a8、9d101a632、585e6fcba、51d24a81f，以及目标版本的 transcript-window、transcript-follow、transcript-selection、use-transcript-viewport、message-history 等工具模块。服务器新增单 Bot 查询先执行成员可见性和会话受众收窄，再读取历史。保留 DoneBot Cloud 缓存、菜单、媒体及团队访问限制。未引入网站托管及真实第三方模型直连验证。

2026-11-20 验证：

- `pnpm lint`、`pnpm typecheck` 通过。
- 改动涉及的 55 个测试文件、1680 项通过，包含消息编号、流式渲染、群聊、长历史、选区、滚动、状态选择器、已读合并、单 Bot 权限及驱动协议。日志 `/tmp/donebot-chat-batch4-tests.log`。
- 自有网关、媒体、设置及驱动回归 65 文件中 64 文件通过；发现团队发现响应兼容错误，补充防护后对应 2 文件 9 项通过。其余 1125 项无失败。日志 `/tmp/donebot-chat-protected-regression.log`、`/tmp/donebot-team-ui-compat.log`。兼容修复独立提交 `37d9cb2`。
- `node --experimental-strip-types scripts/verify-live-reply.ts --cadence 32:15 --out /tmp/donebot-live-reply-0173` 启动五套临时 home/data 的真实服务和浏览器，81 场景通过，4 个非 Claude 的 steer 场景按引擎能力跳过。逐帧检查重复文本、合并错误、已显示内容消失、思考混入正文、结束后残留流式行及控制台错误，覆盖停止、重连、切换会话和双 Bot 群聊。结果、截图和逐帧证据在 `/tmp/donebot-live-reply-0173/`，日志 `/tmp/donebot-live-reply-workflow.log`。

上述证据使用仓库假引擎和合成内容，不替代真实模型、真实团队多设备和平台验收。团队新能力仍关闭。


暂停子批已接入，来源 a72a3f134、9f0492254、f71e1762b。Bot、部门及全部暂停持久保存，入口仅 Owner/Admin；新消息、自动化、委派、群聊及记忆维护遵守暂停，恢复全部不清除独立暂停。部门重命名跟随，新增/移动 Bot 刷新暂停状态。保留原版停止逻辑，补齐原版遗漏的活动群聊中断和 dispatch 前检查。实时配置保留暂停字段；简洁及高级菜单、侧栏和自动化展示暂停。

暂停子批验证（2026-11-20）：

- 12 文件 402 项中 401 项通过；唯一失败是未改动的两处技能卡片 `Target bot` 英文未本地化（`server-lines.test.ts`），后续独立修复已将两处目标 Bot 标题接入会话语言，未新增豁免。其余 11 文件全部通过。日志 `/tmp/donebot-pause-final-tests.log`。
- 真实临时 home/data 服务使用挂起假引擎，4 个流程通过：停止单 Bot、部门暂停及改名、全部暂停与新增 Bot/恢复/停止全部、活动群聊中断与恢复。日志 `/tmp/donebot-pause-room.log`。此前界面 10 文件 326 项通过，新增群聊流程随后单独验证。
- `scripts/verify-donebot-teams.ts` 重新运行通过：Member 对暂停及停止接口得到 403，Owner 可读取；未签名 loopback 及跨团队拒绝继续通过。日志 `/tmp/donebot-pause-team-auth.log`。
- `pnpm lint`、`pnpm typecheck`、`node scripts/generate-locale.mjs --check` 通过。中文新增全部暂停相关文案及占位符检查通过。

这些测试不替代批次 8 的真实 Linux、Windows、手机及多执行节点验收。

技能卡片本地化回归修复：`server-lines.test.ts` 与 `skill-switch-host.test.ts` 2 文件 17 项通过，lint、typecheck、16 语言目录检查通过。日志 `/tmp/donebot-skill-card-locale-tests.log`。

上下文子批已接入，来源 07f46461e、aa683cd4e、f2e6c73c2、198b84350。输入框面板展示上下文、手动压缩和重新开始；压缩记录提供新建会话入口。摘要提前写入，等待、停止和失败后的重试沿用上游状态机。原生压缩仅用于引擎声明支持的路径；统一网关引擎继续使用原有 side-job 摘要和回放，不恢复直连入口。上下文类别仅在引擎确实提供分类数据时显示，不估算为实测。

上下文子批验证（2026-11-20）：

- 9 文件 386 项单元/组件测试通过，日志 `/tmp/donebot-context-unit-tests.log`。
- 4 文件 22 项真实隔离服务流程通过，覆盖手动压缩、重新开始、原生/摘要后备、自动提前摘要、等待与停止、重启和群聊，日志 `/tmp/donebot-context-e2e-tests.log`。
- 10 文件 247 项相关保护回归通过，包含网关驱动、团队认证、摘要/上下文/回放和群聊，日志 `/tmp/donebot-context-protected-tests.log`。
- 真实浏览器临时 home/data 流程通过：打开面板、点击压缩、重复压缩锁定、重新开始、再次重新开始锁定和 Escape 关闭。脚本 `/tmp/donebot-context-ui.mts`，结果 `/tmp/donebot-context-ui.json`、截图 `/tmp/donebot-context-ui.png`，日志 `/tmp/donebot-context-ui.log`。所有 fixture 已关闭。
- lint、typecheck、16 语言目录检查通过，新增入口与面板已有中文。

消息分叉、批量设置和工具权限继承仍在实施；本批尚未完成。

## 消息分叉

移植固定上游的独立分叉、历史复制和侧栏面板，以及后续权限继承、发送回滚、卡片作答、搜索焦点、逐会话已读及渲染选择器修复。使用 `store-forks.ts`、`task-record.ts`、`fork-request.ts`、`fork-panel.ts` 和 `read-visible.ts` 的最终实现；保留 DoneBot 当前未开放的 Bot API 权限边界，不引入上游 opt-in 的 acts-as-owner 功能。

分叉只复制用户实际可见的活动历史，保留附件引用、显式无目录、模型选择和有效权限；新的线程独立保存，不复制引擎会话、不自动运行。运行中来源、DM 及越权来源不能分叉。注册失败清理已复制历史。双面板分别处理流、乐观发送、失败回滚、审批卡及未读。窄屏关闭侧栏分叉。

- `pnpm exec vitest run server/fork-tasks.test.ts src/state/fork-panel.test.ts src/state/read-visible.test.ts src/lib/chat-find.test.ts src/components/ChatFindBar.fork.test.ts src/state/store.test.ts server/host/room-reads.test.ts`：7 文件 / 267 测试通过。
- `server/fork-api.e2e.test.ts` 和 `server/request-auth.test.ts`：2 文件 / 68 测试通过；真实隔离服务验证分叉发送、历史与图片下载、删除来源后继续、群聊分叉和未读定位。初测发现群聊切换遗漏读取该线程，已修复并通过复测。
- 真实浏览器：`/tmp/donebot-fork-ui.mts`；证据 `/tmp/donebot-fork-ui.json`、`/tmp/donebot-fork-ui.png`、`/tmp/donebot-fork-ui.log`。通过消息菜单分叉、侧栏发送、原线程不变、查找焦点、手机宽度关闭面板。fixture 日志 `server-1795174812421-97256.log`，运行后精确停止并清理临时数据。
- 类型检查、lint、16 语言目录校验通过。旧线程、独立权限及删除权限回归 5 文件 / 52 项通过，日志 `/tmp/donebot-fork-regression.log`。旧批量删除夹具补齐 JSON 对象、隔离假引擎环境及临时目录，未放宽产品网关限制。


## 批量设置与工具权限继承

接入 aaceb557d、20b48d310、05717a0b1、1339ad21b 的实现及固定目标的输入错误说明。一次最多修改 40 个 Bot，创建不超过 8 个；`soulAppend` 合并追加、保留原文并固定版本，禁止通过追加触发原文凭据脱敏重写。MCP 列表校验名称及实际归属，应用前重查；Undo 恢复未限定列表时删除字段，保留已有会话模型和权限。撤销创建前检查所有目标的桌面接管状态，生命周期删除也遵守接管限制。委派返回 Chief 或发给自己时，在读取来源权限前拒绝自我继承，避免递归读取与提权。权限审计包含工具选择及连接授权。

DoneBot 适配：沿用普通资料/模型设置在各权限级别直接应用的既有行为；MCP 是新增工具授权，只有 Full access 可直接应用并提供 Undo，其他级别等待用户审批。未复制已禁用的私有本地桌面或上游共享 VM 模块；接管检查复用 DoneBot 自有桌面控制状态。工具目录快照同步此前已存在的媒体附件与技能字段，逐项审查后更新 28 个 profile 的实际字节基线，2% 增量限制保持。

2026-11-20 验证：

- `/tmp/donebot-bulk-workflow-final.log`：8 文件 / 199 项通过，含真实隔离服务“两个 Bot 批量追加 → MCP 列表 → Undo”、设置/删除原流程、权限审计、原始及打包工具目录字节一致性。
- `/tmp/donebot-bulk-followup.log`：5 文件 / 284 项通过，含 Store 持久化、重载、MCP 继承列表恢复、团队共享设置的成员身份。旧团队夹具补充 `NODE_ENV=test` 和 `DONEBOT_UPSTREAM_FIXTURE=1`，仅在临时 home/data 的源码假引擎服务生效，不放宽正式网关限制。
- `/tmp/donebot-bulk-protected.log`：9 文件 / 287 项通过，含真实 MCP 挂载、全权限与审批、请求鉴权、部门权限、批量 UI 设置、Full access 在写入前失效时取消 MCP 变更。
- `/tmp/donebot-bulk-final-types.log`、`/tmp/donebot-bulk-final-lint.log`：typecheck 和 lint 通过。

本批的本机聊天管理子项已接入；团队工作空间切换、跨成员本机工具边界及真实 Linux 验证仍依赖后续批次，未宣称整批最终验收。

## 团队连续目标的步骤身份

连续目标每个已受理步骤使用独立模型操作，忙碌拒绝前的重试沿用同一步；绑定固定原请求成员、权限版本、Bot、会话、受众及运行代次。重启不改变同一步编号，后来发言的其他成员不能替换原身份。目标编号的持久绑定不能跨会话或 Bot 复用。团队目标停用外层失败自动重试，防止响应丢失后以新步骤绕过原调用的幂等记录；个人目标沿用原版一次失败重试。

2026-11-21 验证：

- `/tmp/donebot-team-goal-workflow-final.log`：4 文件 / 57 项通过，包含真实目标循环和原生驱动连接 loopback 网关，首步忙碌后重试、第二步响应丢失、重启只查询原执行；供应商恰好受理两次，没有第三步。
- `/tmp/donebot-team-goal-personal-workflows.log`：3 文件 / 24 项真实隔离服务流程通过，覆盖个人单聊/群聊目标、原有失败重试、取消、排队、等待、自动化及回合上限。旧夹具显式限定测试模式与假引擎，不修改产品网关限制。
- `/tmp/donebot-team-goal-types-final.log`、`/tmp/donebot-team-goal-lint-final.log`：服务端类型及定向 lint 通过。

仍未通过真实 Linux 团队 HTTP 成功执行及跨成员设备验收；能力继续关闭。
