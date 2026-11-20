# 默认媒体模型、Muse 与备用派发验证

使用临时 HOME、临时工作区、loopback 合成网关与脚本化 LLM；不访问生产账号，
不提交真实收费任务，不操作用户运行中的桌面或 Cloud 实例。

```sh
pnpm exec vitest run server/donebot/media-settings.e2e.test.ts server/donebot/media-providers.e2e.test.ts server/donebot-media-selection.e2e.test.ts --maxWorkers=1
pnpm exec vitest run server/donebot/seedance-modes.e2e.test.ts --maxWorkers=1
pnpm exec vitest run server/donebot/unified-media.test.ts server/donebot/media-fallback.test.ts server/donebot/media-approval.test.ts server/donebot/media-confirmation.test.ts server/donebot/media-preferences.test.ts server/donebot/muse-capabilities.test.ts server/donebot/media-guidance.test.ts server/donebot/media-routes.test.ts src/donebot/MediaSettings.dom.test.ts --maxWorkers=1
pnpm typecheck
```

`server/donebot/media-settings.e2e.test.ts` 启动真实隔离服务，通过 `/api/donebot/media-settings` 读取
启用模型、拒绝错误账号与未启用选择、保存图片和视频的首选／备用。原版 control 工具
创建 Bot、发送消息并等待；Gemini 工具链以同一公共 schema 提交 Muse→Flash、
Flash→Seedance 2.5 两种首备组合，模拟首选明确失败后只派发一次备用，校验先写失败说明、两份幂等键不同且视频附件回到原会话。另以真实
`/api/threads/{id}/respond` 验证：图片告知后继续且没有二次确认卡；视频告知后保持
一份生成请求，允许后才提交备用，拒绝后不提交。已有 Full Access 的视频不再确认。
证据写入
`.omb-scratch/verify-evidence/donebot-media-settings/result.json`。

第三方专项验证原版 profile 保存渠道偏好、工作目录 CLI 产物、MCP 成功与失败，
不改一次性指定后的长期偏好，不开放 LLM 直连。默认 Seedream 专项继续验证无需
能力发现、重复调用复用工作、异步查询和原会话图片交付。

统一协议专项覆盖 Muse／Seedance／Flash 共用输入形状、首尾帧角色、图片参考／编辑、
未知字段及不支持模式拒绝。备用单元覆盖首选与备用收据保留、重启、最多一次备用、
创建前备用校验、备用不接受 1080p 或视频参考时首选仍正常提交、参考文件
保留和变更拒绝、确认卡恢复与拒绝、等待中新增免确认授权、停止等待、会话删除、账号变化、取消，以及 uncertain、结算中、
下载 409 时继续原任务。Muse 参数专项覆盖 4／10 秒边界与非法时长、720p、比例、
参考图片数、音视频参考拒绝、edit／extend 拒绝。设置组件 DOM 检查四个下拉、按媒体
类型过滤、明确保存、账号绑定、停用值保留和错误反馈。

确认恢复专项从临时 SQLite 读取已有工作，在第一次后台轮询之前允许回答原确认卡；
同时检查拒绝、停止等待、账号退出、撤销工具选择及已授权免确认后的明确拒绝。

Seedance 模式专项在一个隔离真实服务中创建独立会话，覆盖 2.0、2.0 Fast、2.0 Mini、
2.5 和 2.5 Flash 各六种场景：文生、单图参考、双图参考、明确图生、明确首帧、
明确首尾帧，共 30 个场景。检查模式指导到达 LLM、统一请求的 `mode`／角色／MP4
完整保留、每场景只提交一次、轮询下载后视频附件回到原会话；参考 WebP 上传
核对原始文件名、MIME、字节数和 SHA-256，并检查重复内容复用上传。
证据位于 `.omb-scratch/verify-evidence/seedance-modes/result.json`。
LLM 输出是脚本化参数，这证明工具和传输接线，不证明真实模型必定理解用户意图。

2026-11-15 扩展检查发现 `scripts/testing/index-route-ratchet.test.ts` 在改动前的
`97e3eae` 已不通过：`path === "/` 有 85 处，基线为 84；本轮改动前后均为 85。
本轮设置路由位于独立模块，未增加入口文件的路径判断或放宽该校验。

这些检查证明接线、参数边界和本地恢复；不证明线上供应商质量、真实延迟、价格、
退款／补扣金额或第三方模型是否理解自然语言偏好。生产开通与部署要求见
[使用说明](../donebot-media-models.md)。

## 统一协议的网关配套验证

协议与新模型适配指引位于 donebot-api 仓库的 `docs/donebot/media-protocol.md`、
`docs/donebot/media-model-adapter-guide.md`。网关测试使用内存 mock，覆盖别名到原生参数转换、
持久协议标记恢复、统一图片／视频结果、拆层元数据保留、普通 Key 的任务包装及归属拒绝；
不访问真实供应商。网关先部署，客户端随后发布。

## 2026-11-18 统一协议回归记录

- 客户端协议、首备、工具指导与路由，加上慢推理 notice 的聊天／状态／侧栏过滤：8 个测试文件、143 项通过。
- `server/donebot/media-settings.e2e.test.ts`：6 项通过；临时 HOME／工作区中启动真实服务和 Gemini 工具传输，loopback 合成网关创建任务并返回原会话附件，没有真实收费调用。运行证据保存在上述 result.json，含 fixture 的独立日志路径。
- `pnpm typecheck` 通过。
- 网关 service／handler 专项命令通过，包含普通 Key 图片创建→统一结果→越权拒绝、普通 Key 视频创建→查询→下载等待→越权拒绝、持久任务协议标记恢复与图层元数据。
- 本记录不表示生产网关或已安装桌面已更新，不证明真实供应商接受了请求。

## 2026-11-19 Seedance 提交回归记录

- 先用 Flash＋双图参考＋`output_format=mp4` 重现网关 `DONEBOT_MEDIA_INVALID`；目录校验遗漏输出格式白名单和枚举，在转发上游前拒绝了合法请求。修复后同一回归通过。
- 客户端 10 个测试文件、149 项通过，包括 Seedance 模式专项的 30 个隔离会话场景、图片／第三方媒体接线和首选／备用确认流程；`pnpm typecheck` 与改动 TypeScript 文件的 oxlint 检查通过。
- 网关 service、handler、middleware、routes 四个包的专项通过，命令为适配指南的最少回归；覆盖五个 Seedance 型号、公开 ID／自定义别名、格式、参考角色、非法参数、幂等、任务恢复、归属和结算。
- WebP 上传的文件名、MIME、字节数及 SHA-256 与原始合成素材一致；没有新增转码。
- 全部使用脚本化 LLM 和假上游，不提交真实收费任务。这是本地接线验收，不表示生产已经部署，也不证明真实模型的语义遵循或供应商生成结果。
