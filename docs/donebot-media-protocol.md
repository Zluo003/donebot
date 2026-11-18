# 客户端图片／视频统一协议与模型登记

网关对下游统一使用 `donebot.media.v1`。完整 HTTP 契约和上游接入清单分别位于
**donebot-api 仓库**的 `docs/donebot/media-protocol.md`、`docs/donebot/media-model-adapter-guide.md`。
本文记录客户端侧接线；增加字段、模式或模型时必须同步网关契约和两仓库测试。

## 协议边界

| 类型 | 创建 | 查询 | 结果 |
| --- | --- | --- | --- |
| 图片 | `POST /v1/images/generations/async` | `GET /v1/images/tasks/{id}` | `result.data[]` 中的 URL／内嵌图片及可选 layer 元数据 |
| 视频 | `POST /v1/videos` | `GET /v1/videos/{id}` | `GET /v1/videos/{id}/content` |

客户端始终发同一种结构，不按供应商拼 `content`、`image_urls`、`reference_images`、
`omni_reference_task_type`；这些字段由网关适配。所有图片模式都走同一个创建入口。
音乐沿用 Suno 原生异步格式，TTS 仍走朗读流式接口；第三方 CLI／MCP／技能不受此协议约束。

## 工具参数与线上请求的差别

LLM 图片／视频工具只填写一次 `parameters`，首选和备用来自设置。示例：

```json
{
  "parameters": {
    "mode": "reference",
    "prompt": "保持图片1主体，镜头缓慢前推",
    "duration": 6,
    "resolution": "720p",
    "aspect_ratio": "16:9",
    "output_format": "mp4",
    "references": [{"type":"image","role":"reference","url":{"local_path":"/allowed/reference.png"}}]
  }
}
```

客户端添加 `protocol`、所选 `model`，按原会话文件权限读取并上传素材，线上 HTTPS 请求为：

```json
{
  "protocol": "donebot.media.v1",
  "model": "seedance-2-5-flash",
  "mode": "reference",
  "prompt": "保持图片1主体，镜头缓慢前推",
  "duration": 6,
  "resolution": "720p",
  "aspect_ratio": "16:9",
  "output_format": "mp4",
  "references": [{"type":"image","role":"reference","url":"https://assets.example.invalid/reference.png"}]
}
```

`local_path` 仅是工具内部值，不能发给网关；HTTPS 示例地址为占位符。
工具不再要求 `fallback_parameters`／`fallback_operation`／`fallback_reason`，也不需要先查询能力。
旧工具入口和旧任务为兼容仍保留原生处理分支，不应再生成新的双原生参数计划。

## 能力与模式

- 图片：`text`、`reference`、`edit`，仅登记支持拆层的型号开放 `layers`。
- 视频：`text`、`reference`、`first_frame`、`first_last_frame`、`edit`、`extend`，逐型号开放。
- 普通参考全部使用 `role=reference`；首帧／尾帧分别用 `first_frame`／`last_frame`，类型只能是 image，不能混用。编辑／延长需要视频参考。
- 所有 Seedance 有参考默认 `reference`，一张或两张图都不按数量自动转首帧／首尾帧；无素材使用 `text`。一张图且明确要求“图生视频 / image-to-video / i2v”或首帧，才用 `first_frame`；两张图且明确指定首尾帧，才用 `first_last_frame`。Muse 只有文生和图片参考，不接音视频参考、编辑或延长。
- 素材保留模型支持的原始格式，包括 WebP；不强制转 JPG，不通过改文件名伪装格式。
- Seedance 2.5 的自动时长编辑未开放；Flash 的编辑／延长未开放。不能因为协议有 edit 就宣称所有模型可编辑。
- 视频工具要求整数时长、输出分辨率；发送前默认 6 秒、720p，Muse 比例默认 16:9，Seedance adaptive。字段必须在该型号登记范围内。
- 图片使用 `prompt`、`size`、`resolution`、`count`、`output_format`、`references` 和 `options`。拆层 count 不是层数；透明背景、尺寸等继续复用专用校验。
- options 仅收该型号已登记的扩展控制；不能借 options 绕过公共协议或塞入原生参考数组。流式生成不开放。

## 首选、备用与异步恢复

同一份参数分别按首选和备用能力校验。备用不能接收同规格或同一批素材时，记录
`fallback_unavailable`，首选仍可提交；不能悄悄少传图、忽略参考视频、降低分辨率或缩短时长。

仅明确失败才进入备用。先告知原因和备用型号；图片不再确认，视频需确认，已有明确免确认授权时除外。
最多派发一次备用，每次有独立持久化幂等键，保留原任务 ID 和收据。
`uncertain`、断网超时、429／5xx、结算等待和下载 409 都继续原任务，不能重提收费生成。

客户端保存 adapter 和协议参数，重启继续查询同一个任务；后台产物回到原会话。
`generation_status=completed` 只表示生成结束，外层 `status=processing` 时仍需等交付／结算。
停止等待不代表取消上游或退款。

## 新模型登记位置

1. `server/donebot/capabilities.ts`、型号专用 `*-capabilities.ts`：输入输出、模式、限制、默认值、文件策略、来源和日期。官网能力与当前上游接线能力分开。
2. `registeredMediaAdapters` 和 `server/donebot/media-registry.ts`：接口、类型及本地支持；选项只取账号实际启用模型与本地登记的交集。
3. `server/donebot/unified-media.ts`、`media-model-schema.ts`：统一 schema、枚举和 options；不为型号新增供应商 HTTP 字段。
4. `server/donebot/media-assets.ts`：继续复用原会话权限和上传、指纹；型号文件策略不能扩大读取范围。
5. `media-fallback.ts`、`media.ts`：备用兼容和确认；不可通过改变原请求来迁就备用。
6. 新请求使用 `donebot.media.images.v1`／`donebot.media.videos.v1`。供应商注册 adapter 仍用于能力来源和旧任务；不批量改写历史任务。

网关侧同时完成公开 ID／原生规格映射、确定性参数转换、结果归一、账号分组和价格配置。
先部署网关，再发布桌面客户端／Cloud 运行服务；仅登记名字不会让新模型可用。

## 验证

遵循[隔离验证规范](verification/README.md)，不操作用户正在运行的应用或付费账号。

```sh
pnpm typecheck
pnpm exec vitest run server/donebot/unified-media.test.ts \
  server/donebot/media-guidance.test.ts server/donebot/media-routes.test.ts \
  server/donebot/media-fallback.test.ts server/donebot/media-settings.e2e.test.ts \
  server/donebot/seedance-modes.e2e.test.ts --maxWorkers=1
```

必须证明真实工具 schema→隔离网关→异步轮询→原会话交付；至少覆盖跨供应商首备、
不兼容备用不阻断首选、图片无需二次确认、视频允许／拒绝／撤销确认、幂等与重启恢复。
详见[媒体设置验证配方](verification/donebot-media-settings.md)。隔离通过不代表线上已经部署或供应商已真实验收。
