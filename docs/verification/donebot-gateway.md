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

2026-11-11 的专项运行结果为 23 个文件、427 项通过；Electron 网关测试 7 项通过。
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
