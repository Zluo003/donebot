# 批次 4：聊天与 Bot 管理

本批进行中。已接入流式回复、按消息编号合并、Markdown 增量呈现、选择器及分帧状态更新、长历史窗口、选区与滚动恢复、群聊流式渲染。压缩、重新开始、分叉、暂停和批量管理继续实施，不能将本批记为完成。

固定来源：6c95a78a1、b692f4709、3824568a8、9d101a632、585e6fcba、51d24a81f，以及目标版本的 transcript-window、transcript-follow、transcript-selection、use-transcript-viewport、message-history 等工具模块。服务器新增单 Bot 查询先执行成员可见性和会话受众收窄，再读取历史。保留 DoneBot Cloud 缓存、菜单、媒体及团队访问限制。未引入网站托管及真实第三方模型直连验证。

2026-11-20 验证：

- `pnpm lint`、`pnpm typecheck` 通过。
- 改动涉及的 55 个测试文件、1680 项通过，包含消息编号、流式渲染、群聊、长历史、选区、滚动、状态选择器、已读合并、单 Bot 权限及驱动协议。日志 `/tmp/donebot-chat-batch4-tests.log`。
- 自有网关、媒体、设置及驱动回归 65 文件中 64 文件通过；发现团队发现响应兼容错误，补充防护后对应 2 文件 9 项通过。其余 1125 项无失败。日志 `/tmp/donebot-chat-protected-regression.log`、`/tmp/donebot-team-ui-compat.log`。兼容修复独立提交 `37d9cb2`。
- `node --experimental-strip-types scripts/verify-live-reply.ts --cadence 32:15 --out /tmp/donebot-live-reply-0173` 启动五套临时 home/data 的真实服务和浏览器，81 场景通过，4 个非 Claude 的 steer 场景按引擎能力跳过。逐帧检查重复文本、合并错误、已显示内容消失、思考混入正文、结束后残留流式行及控制台错误，覆盖停止、重连、切换会话和双 Bot 群聊。结果、截图和逐帧证据在 `/tmp/donebot-live-reply-0173/`，日志 `/tmp/donebot-live-reply-workflow.log`。

上述证据使用仓库假引擎和合成内容，不替代真实模型、真实团队多设备和平台验收。团队新能力仍关闭。
