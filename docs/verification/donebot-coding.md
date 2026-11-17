# DoneBot 编程执行器

设置 → AI／模型服务 → 编程执行器中，Codex 和 Claude Code 各有两个入口：

| 执行器实例 | 模型请求与计费 |
| --- | --- |
| `donebot-codex` | DoneBot 账号目录中支持 Responses、工具调用的 GPT 模型 |
| `donebot-claude` | DoneBot 账号目录中支持 Messages、工具调用的 Claude 模型 |
| `donebot-codex-subscription` | 独立的官方 ChatGPT 登录与该账号原生目录；仅本机支持 |
| `donebot-claude-subscription` | 独立的 Claude Code 订阅登录与原生模型目录 |

安装按钮复用应用自己的 npm 安装目录、版本选择和并发安装保护，要求运行主机有
Node.js／npm。不会使用 sudo，不修改个人 CLI 登录目录。未提供自定义 LLM 密钥或
第三方端点。网关模型为空时不会偷偷使用订阅账号；订阅未登录时不会改走网关。

对话顶部的模型菜单可以切换执行器、模型及计费来源。切换保留原对话，并清除旧执行器
的恢复游标，用现有对话重建新会话，不重新执行已完成操作。运行中的任务沿用原版
停止／切换规则。Bot 默认和单条对话的选择仍独立；不会全局修改所有 Bot。

资料库中的工作目录可以选主机上已有的外部项目目录；“在文件夹中开启新对话”固定
该对话的项目目录。已有对话保持原来固定的目录，切换项目宜开启新对话。Bot 可按原版
执行权限创建项目子目录。协调任务沿用 `in_my_folder`、房间目录和返回机制。Cloud
路径属于服务器，不能直接填写本机路径；本机 Bot 使用云桌面也不会迁移编程执行器。

网关模式的 CLI 仅收到随机的回环代理令牌，代理绑定账号及安装身份，所有模型调用经
`requestForScope` 继续使用原版账号撤销、并发和账务机制。退出账号立即撤销代理并停止
执行器；重新登录同一账号也会更换令牌。订阅身份与网关身份使用独立目录，保留个人
CLI 配置。未更改原生工具审批，访客受限回合不能使用这些执行器。安装等待期间的
Stop 会阻止安装结束后启动任务。

## 自动验证

```sh
pnpm exec vitest run server/donebot/coding-proxy.test.ts server/donebot/coding-drivers.test.ts shared/donebot-coding.test.ts server/routes/instances.test.ts server/donebot/credential-policy.test.ts --maxWorkers=1
pnpm exec vitest run server/donebot-coding.e2e.test.ts --maxWorkers=1
pnpm exec vitest run src/donebot/CodingSettings.dom.test.ts src/components/EngineSetup.test.ts src/lib/simple-model-menu.test.ts src/lib/engine-rail.test.ts src/components/local-model-probe.test.ts src/components/ModelPickerFull.test.ts --maxWorkers=1
pnpm typecheck
pnpm lint
pnpm i18n:check
```

E2E 使用 `launchVerificationServer`、专属临时 HOME、回环合成网关及仓库拥有的假 CLI。
原生 Claude／Codex 驱动启动这些假 CLI，验证：四个入口及实际计费来源标签、同一对话
多次切换、外部项目目录、订阅与网关环境隔离、协调 Bot 委派编程任务并收到结果、
拒绝自定义端点和网关模式登录。证据（动作、会话结果、日志路径）写入忽略目录
`.omb-scratch/verify-evidence/donebot-coding/result.json`，结束后删除临时服务数据及项目。

代理专项测试通过真实回环 HTTP 验证 Responses／Messages 流、令牌与模型校验、Origin
拒绝、上游敏感头剥离、账号变化、撤销及客户端断开后取消上游。驱动专项覆盖安装中
Stop、同账号退出重登、跨账号目录更换、原生审批转发和订阅登录对象保留。设置 DOM
测试实际挂载安装组件并点击安装按钮，确认不会要求用户提供 API Key。

2026-11-17 的原生回归批次：`codex.test.ts`、`claude.test.ts`、
`chatgpt-plan-auth.test.ts`、`claude-auth.test.ts`、`claude-login-auth.test.ts`、
`simple-model-menu.test.ts` 及 `donebot.e2e.test.ts`，共 631 项通过、1 项跳过。
测试没有调用生产模型、真实付费账户或个人 CLI；不证明真实订阅登录、上游模型兼容性
或 npm 发布包下载在用户网络中的可达性。发布前仍需用测试账号做真实 CLI 冒烟。
