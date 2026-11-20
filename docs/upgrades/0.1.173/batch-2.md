# 批次 2：团队身份和套餐

身份基础已接入，团队 Cloud 购买、成员代理和执行授权继续实施；本批尚未整体验收。

网关新增默认关闭的团队、邀请、成员角色和发现接口。UUID 幂等创建、邮箱绑定邀请、Owner 不可降权或移除、Admin 仅管理 Member、版本化撤权和邀请重放保护均在服务端执行。独立团队套餐保存运行服务、桌面、存储、共享配额、保留期及价格；启用前检查完整性。个人套餐和实例约束保持独立。

客户端仅在网关声明兼容身份能力时显示团队管理。安装凭据不能管理账号或团队；页面不展示所有者密钥、个人余额或账单。未来团队运行服务通过固定公钥验证请求签名，复用原版成员受众、私聊、记忆和作用域；没有签名的 loopback 请求不能读取团队数据或创建管理员配对。

2026-11-20 验证：

- 一次性 PostgreSQL 17 身份测试通过，涵盖两个团队、多角色、邀请错误邮箱/过期/撤销/重放、成员降权及移除、禁止更改 Owner。日志 `/tmp/donebot-team-postgres-tests.log`。
- 网关 HTTP 边界测试通过：缺失登录、默认关闭、伪造 owner/payer、超大或多段 JSON、伪造查询和身份头。日志 `/tmp/donebot-team-api-boundaries.log`。
- 客户端及运行鉴权 4 文件 80 项通过。日志 `/tmp/donebot-team-auth-tests.log`。独立的团队 DOM 测试覆盖默认隐藏、移除确认及迟到响应。
- `node --experimental-strip-types scripts/verify-donebot-teams.ts` 启动两套独立真实服务和合成网关，通过团队创建/发现/成员移除、字段注入拒绝；运行服务验证成员身份、私有账单屏蔽、跨团队拒绝、未签名 loopback 和配对拒绝。日志 `/tmp/donebot-teams-workflow.log`；工作流证据保存在打印的 `.teams.json`。
- `pnpm lint`、`pnpm typecheck` 通过；后台前端 typecheck 和定向 ESLint 通过。

上述不证明团队购买、Cloud worker 成员代理、团队计费和跨设备执行已可用。这些能力保持关闭，后续记录其验证结果。
