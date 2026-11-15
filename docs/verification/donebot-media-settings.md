# 默认媒体模型、Muse 与备用派发验证

使用临时 HOME、临时工作区、loopback 合成网关与脚本化 LLM；不访问生产账号，
不提交真实收费任务，不操作用户运行中的桌面或 Cloud 实例。

```sh
pnpm exec vitest run server/donebot/media-settings.e2e.test.ts server/donebot/media-providers.e2e.test.ts server/donebot-media-selection.e2e.test.ts --maxWorkers=1
pnpm exec vitest run server/donebot/media-fallback.test.ts server/donebot/media-approval.test.ts server/donebot/media-confirmation.test.ts server/donebot/media-preferences.test.ts server/donebot/muse-capabilities.test.ts server/donebot/media-guidance.test.ts server/donebot/media-routes.test.ts src/donebot/MediaSettings.dom.test.ts --maxWorkers=1
pnpm typecheck
```

`server/donebot/media-settings.e2e.test.ts` 启动真实隔离服务，通过 `/api/donebot/media-settings` 读取
启用模型、拒绝错误账号与未启用选择、保存图片和视频的首选／备用。原版 control 工具
创建 Bot、发送消息并等待；真实工具链提交 Muse，模拟其明确失败后只派发一次
Seedance 备用，校验先写失败说明、两份幂等键不同且视频附件回到原会话。另以真实
`/api/threads/{id}/respond` 验证：图片告知后继续且没有二次确认卡；视频告知后保持
一份生成请求，允许后才提交备用，拒绝后不提交。已有 Full Access 的视频不再确认。
证据写入
`.omb-scratch/verify-evidence/donebot-media-settings/result.json`。

第三方专项验证原版 profile 保存渠道偏好、工作目录 CLI 产物、MCP 成功与失败，
不改一次性指定后的长期偏好，不开放 LLM 直连。默认 Seedream 专项继续验证无需
能力发现、重复调用复用工作、异步查询和原会话图片交付。

备用单元覆盖首选与备用收据保留、重启、最多一次备用、创建前备用校验、参考文件
保留和变更拒绝、确认卡恢复与拒绝、等待中新增免确认授权、停止等待、会话删除、账号变化、取消，以及 uncertain、结算中、
下载 409 时继续原任务。Muse 参数专项覆盖 4／10 秒边界与非法时长、720p、比例、
参考图片数、音视频参考拒绝、edit／extend 拒绝。设置组件 DOM 检查四个下拉、按媒体
类型过滤、明确保存、账号绑定、停用值保留和错误反馈。

确认恢复专项从临时 SQLite 读取已有工作，在第一次后台轮询之前允许回答原确认卡；
同时检查拒绝、停止等待、账号退出、撤销工具选择及已授权免确认后的明确拒绝。

2026-11-15 扩展检查发现 `scripts/testing/index-route-ratchet.test.ts` 在改动前的
`97e3eae` 已不通过：`path === "/` 有 85 处，基线为 84；本轮改动前后均为 85。
本轮设置路由位于独立模块，未增加入口文件的路径判断或放宽该校验。

这些检查证明接线、参数边界和本地恢复；不证明线上供应商质量、真实延迟、价格、
退款／补扣金额或第三方模型是否理解自然语言偏好。生产开通与部署要求见
[使用说明](../donebot-media-models.md)。
