# 自有手机中枢隔离验证

手机项目位于同级 `DoneBot-Mobile`，网关位于 `donebot-api`。账号、安装凭据、数据库、中继和桌面资料均使用合成夹具，不连接线上 DoneBot。

## 完整工作流

在网关项目运行：

```sh
DONEBOT_MOBILE_PG_FIXTURE=1 DONEBOT_MOBILE_DESKTOP_ROOT=/Users/zluo/Dev/DoneBot DONEBOT_MOBILE_RELAY_ROOT=/Users/zluo/Dev/DoneBot-Relay go -C backend test -tags integration ./internal/mobilehub -count=1 -v -timeout 150s
```

需要本机 `initdb`、`pg_ctl`、Node 24、两个前端项目及独立 `DoneBot-Relay` 项目的依赖。测试只启动自己创建的临时 PostgreSQL 集群（Unix socket，不监听 TCP），结束时关闭并移除该集群。它不接受现有数据库 DSN。

网关集成测试启动真实 `mobilehub.Service` 与迁移 265、266，HTTP 外层使用合成身份；JWT/API Key 的正式路由继承检查另外由网关路由测试覆盖。桌面脚本通过 `launchVerificationServer` 启动原版隔离资料目录，连接该网关夹具与 `DoneBot-Relay` 独立服务，测试通过 `DONEBOT_MOBILE_RELAY_ROOT` 显式提供中继源码目录。中继通过独立节点凭据从真实 Service 获取接入策略；手机运行正式 Noise / yamux 代码，`relay1.donebot.cn` 在夹具内映射到回环反向代理，保留 `/v1/phone` 等原路径与 `capacitor://localhost` Origin。

检查电脑和手机分别登记、工作空间只有中继连接后才在线、节点策略与独立域名入口、工作空间归属、首次授权须由桌面确认、不可替换已登记的主机身份、原版 client 会话、列表和历史读取、发送与原会话回复、通知事件去重、无正文通知、退出后的会话撤销。未付费或已过期 Cloud 不进入列表，已开通但尚未启动连接器的 Cloud 显示离线。

结果保留在 `.omb-scratch/verify-evidence/mobile-hub/evidence.json`；其中包含 `wait`、消息、通知 payload 和该次桌面日志路径。脚本关闭自己启动的桌面、中继和测试网关。

## 其他检查

```sh
pnpm exec vitest run server/sessions.test.ts server/donebot/mobile-host.test.ts
pnpm exec tsc -p tsconfig.server.json --pretty false
pnpm --dir ../DoneBot-Relay check
pnpm --dir ../DoneBot-Relay test
```

网关 `TestDoneBotMobileSessionUsesOriginalRefreshFamily` 覆盖原版 refresh family 撤销和账号密码安全版本变化；`TestAPNsSignsAndSeparatesEnvironments` 验证 ES256 签名、APNs topic、失效 token 与临时失败处理。发送目标为内存 HTTP transport，没有向 Apple 发出推送。

`TestPostgresRelayManagement` 覆盖节点创建、独立凭据、轮换、容量策略、停用、健康过期、最多 4 个启用节点及优先地址；`TestPostgresDevicePresenceAndRelayStatus` 覆盖归属隔离、中继未配置时登记手机、后台状态和撤销会话过滤。中继项目 `test/management.test.ts` 用真实 WebSocket 证明 1 台电脑加 2 个会话为 5 条 WebSocket、容量限制、停用不影响已有连接、Origin 白名单、网关不可用时中继仍监听，以及策略恢复后自动接入。

真实蜂窝网络、线上多副本网关、真实 Cloud 节点和 Apple 后台通知不由这些夹具证明。公网启用方式见网关 `docs/donebot-mobile.md`。
