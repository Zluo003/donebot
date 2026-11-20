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

- 12 文件 402 项中 401 项通过；唯一失败是未改动的两处技能卡片 `Target bot` 英文未本地化（`server-lines.test.ts`），已记录留待设置/技能子批修复，无新增豁免。其余 11 文件全部通过。日志 `/tmp/donebot-pause-final-tests.log`。
- 真实临时 home/data 服务使用挂起假引擎，4 个流程通过：停止单 Bot、部门暂停及改名、全部暂停与新增 Bot/恢复/停止全部、活动群聊中断与恢复。日志 `/tmp/donebot-pause-room.log`。此前界面 10 文件 326 项通过，新增群聊流程随后单独验证。
- `scripts/verify-donebot-teams.ts` 重新运行通过：Member 对暂停及停止接口得到 403，Owner 可读取；未签名 loopback 及跨团队拒绝继续通过。日志 `/tmp/donebot-pause-team-auth.log`。
- `pnpm lint`、`pnpm typecheck`、`node scripts/generate-locale.mjs --check` 通过。中文新增全部暂停相关文案及占位符检查通过。

这些测试不替代批次 8 的真实 Linux、Windows、手机及多执行节点验收。
