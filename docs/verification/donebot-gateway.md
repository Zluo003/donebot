# DoneBot 统一网关验证

所有账号、密码、token、验证码、模型响应及生成产物使用合成 fixture。
服务由原版 `launchVerificationServer` 启动，使用临时 HOME、数据目录、独立端口；
fake gateway 仅监听 IPv4 loopback。不要把命令中的 fixture URL 替换成用户正在使用的应用。

## 自动检查

在仓库根目录执行：

```sh
pnpm exec vitest run server/donebot/ server/donebot.e2e.test.ts server/tts/tts.test.ts server/routes/tts.test.ts server/routes/tts-openai.test.ts server/agent-tool-policy.test.ts --maxWorkers=1
node --test electron/donebot-auth.node-test.mjs electron/donebot-credentials.node-test.mjs
pnpm build
pnpm lint
node scripts/generate-locale.mjs --check
pnpm test:packaged-server
```

此前 2026-11-11 的专项运行结果为 23 个文件、427 项通过；Electron 网关测试 7 项通过。
其他检查通过。这里记录的是相关专项及打包检查，不代表再次执行了原项目的全部测试。

最终原版回归批次为 14 个文件、577 项通过：

```sh
pnpm exec vitest run \
  server/harness/registry.test.ts \
  server/drivers/openai-chat.test.ts \
  server/drivers/openai-chat-tools.test.ts \
  server/drivers/openai-chat-local-model.test.ts \
  server/drivers/openai-chat-safety-floor.test.ts \
  server/drivers/chat-mcp-tools.test.ts \
  server/drivers/agents-catalog-wire.test.ts \
  server/drivers/agents-call.test.ts \
  server/drivers/tool-scope-coverage.test.ts \
  shared/tool-scope.test.ts \
  server/routes/threads-attachment-clear.test.ts \
  server/routes/threads-tool-output.test.ts \
  server/message-file.test.ts \
  server/agent-tool-policy.test.ts --maxWorkers=1
```

## 浏览器流程

```sh
node --experimental-strip-types scripts/verify-donebot-auth-ui.ts
```

打开它打印的 `previewUrl`。该入口使用真实 React 登录组件和真实服务端路由，所有外部
调用均到本次创建的 fake gateway。退出预览时向前台 launcher 发送 Ctrl-C，它负责清理
自己启动的服务器及临时数据。

合成账号邮箱为 `fixture@example.invalid`，密码可使用任意至少六位的测试字符串。
验证码为 `123456`；邀请字段可填写任意非空测试文本。先检查注册的密码不一致提示，
再检查验证码发送、倒计时、注册成功、模型目录、退出、找回密码与重新登录。

需要二次验证流程时，另行启动：

```sh
DONEBOT_FIXTURE_2FA=1 node --experimental-strip-types scripts/verify-donebot-auth-ui.ts
```

输入错误动态验证码应保留验证界面，输入 `123456` 后应显示模型目录。
分别检查桌面宽度和 390 × 844 移动视口。已核验的截图：

- [`donebot-login-desktop.png`](../../output/playwright/donebot-login-desktop.png)
- [`donebot-register-mobile.png`](../../output/playwright/donebot-register-mobile.png)

## 端到端覆盖

媒体选型回归（隔离服务器、合成 Gemini 响应与 Seedream 异步任务）：

```sh
pnpm exec vitest run server/donebot-media-selection.e2e.test.ts --maxWorkers=1
```

验证客户端固定图片 `seedream-5-5`、视频 `seedance-2-5`、音乐 `suno`（v6）。
正常生成工具不接受 model 参数，客户端注入固定 ID，并在首次 LLM 请求中提供原生参数
schema。网关只提供开放模型 ID 与价格，不提供媒体能力；能力查询工具不进入正常
LLM 工具集，不要求先查目录或读第二轮参数。参考编辑使用 Seedream generation 的
`image_urls`；图层拆分支持 `max_images=2..100` 与可选 OCR。

合成 Gemini 在首次工具调用直接提交 Seedream；第二次相同调用复用本地任务，付费
POST 总数为1。聊天结束时任务仍在 processing，由后台查询 `/v1/tasks/{id}`；
完成后投递原会话 PNG 附件。记录保存在
`.omb-scratch/verify-evidence/donebot-media-selection/result.json`，包含 LLM 请求数量、
提交体及隔离服务器日志路径。首次固定模型接入的客户端专项为21个文件、353项通过，构建、服务端类型检查和 lint 通过。
隔离检查中，脚本化 LLM 共3次请求、能力查询0次、
生图提交1次。这证明调用链和任务去重，不是实际 Gemini 延迟或线上付费生图验收。

客户端检查参数、参考图格式/字节数及引用数量；参考媒体的像素、编解码、帧率、
时长与上游人像授权仍由上游校验，不能把登记的限制当作已完成全本地解码校验。
完整限制、官方来源和客户端开放范围见
[媒体能力与输入限制](donebot-media-capabilities.md)。Suno v6 仅开放纯音乐和带歌词
歌曲，固定 custom=true/version=v6/auto_lyrics=false；不开放单独歌词、翻唱或续写。
参考视频通过模型策略允许到 200 MiB；网关已有显式上传配置仍需单独核对。
本轮没有改原版聊天调度、记忆、MAX_STEPS 或重复调用保护；不能据此承诺任何
LLM 都不会再次出现别的工具空转。

网关配置、已移除 Intent API、5.5 输入参考图和图层计费约定见
`/Users/zluo/Dev/donebot-api/docs/donebot/v4/media-intent-api.md`。
生产启用前须在网关配置5.5上游账号、输出两档及每张输入参考图价格，并开放固定
媒体模型。视频公开 ID `seedance-2-5` 映射至同模型上游
`doubao-seedance-2-5-260628`。客户端会忽略其它图片、视频和音乐模型，网关不会自动
删除旧账号/价格或历史任务；停用旧模型由管理员配置。

第一条用例通过原版 control 工具创建 Bot、设置模型、发言及等待，确认 Messages、
Responses、Gemini 和 Chat Completions 的原生文本协议能调用工作区工具及原 agents 工具；
图片生成和同会话编辑、视频、音乐均只提交一次生成请求，结果通过会话附件投递。
同时验证回执、范围下载、跨账号与跨会话拒绝、语音转 WAV、禁止模型密钥绕过，
以及退出后不再发送模型请求。

第二条用例先为两个线程固定不同于 Bot 默认值的模型，再并发发送消息，变更 Bot
默认模型并退出、重新登录，确认已固定模型保留。消息断言只检查各自存储分支，
允许原版记忆机制正常向同一 Bot 的后续提示词召回历史。

生产编译入口忽略 `DONEBOT_UPSTREAM_FIXTURE` 与 `DONEBOT_FIXTURE_ORIGIN`；
测试来源替换只对 `NODE_ENV=test` 下的 TypeScript 源码入口生效。

线上公开设置在当前环境连接超时，尚未验证真实登录、安全验证码或付费生成，
也未执行生产部署。重新联网后需在另建的隔离应用环境中完成线上验收。

## 输入限制及 Suno 两种模式回归

2026-11-11 按官方文档补齐三种媒体模型的登记后，运行：

```sh
pnpm exec vitest run server/donebot/ server/donebot.e2e.test.ts server/donebot-media-selection.e2e.test.ts --maxWorkers=1
pnpm build
pnpm lint
```

结果：21 个文件、355 项测试通过；构建、前后端类型检查和 lint 通过。隔离流程检查
33 MiB 会话工作目录视频引用的读取和上传、纯音乐与带歌词歌曲各一次异步提交，
并等待各自的新消息附件，验证歌词原文和 vocal_gender 未被转发层改写。媒体选型
fixture 仍为首轮直接提交、能力查询 0 次、图片付费 POST 1 次。
引用上传与两种歌曲提交体、隔离服务器日志路径保存在
`.omb-scratch/verify-evidence/donebot-model-limits/result.json`。
网关 config/service/handler 的 Asset、DoneBotStorage 及 APIMartSunoNative 专项测试通过，
证明默认上传容量和显式旧限制保留、歌曲原生字段透传。未部署或进行线上付费生成。
