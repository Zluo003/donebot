# 自有手机中枢隔离验证

手机项目位于同级 `DoneBot-Mobile`，网关位于 `donebot-api`。账号、安装凭据、数据库、中继和桌面资料均使用合成夹具，不连接线上 DoneBot。

## 完整工作流

在网关项目运行：

```sh
DONEBOT_MOBILE_PG_FIXTURE=1 DONEBOT_MOBILE_DESKTOP_ROOT=/Users/zluo/Dev/DoneBot DONEBOT_MOBILE_RELAY_ROOT=/Users/zluo/Dev/DoneBot-Relay go -C backend test -tags integration ./internal/mobilehub -count=1 -v -timeout 150s
```

需要本机 `initdb`、`pg_ctl`、Node 24、两个前端项目及独立 `DoneBot-Relay` 项目的依赖。测试只启动自己创建的临时 PostgreSQL 集群（Unix socket，不监听 TCP），结束时关闭并移除该集群。它不接受现有数据库 DSN。

网关集成测试启动真实 `mobilehub.Service` 与迁移 265、266，HTTP 外层使用合成身份；JWT/API Key 的正式路由继承检查另外由网关路由测试覆盖。桌面脚本通过 `launchVerificationServer` 启动原版隔离资料目录，连接该网关夹具与 `DoneBot-Relay` 独立服务，测试通过 `DONEBOT_MOBILE_RELAY_ROOT` 显式提供中继源码目录。中继通过独立节点凭据从真实 Service 获取接入策略；手机运行正式 Noise / yamux 代码，`relay1.donebot.cn` 在夹具内映射到回环反向代理，保留 `/v1/phone` 等原路径与 `capacitor://localhost` Origin。

检查电脑和手机分别登记、工作空间只有中继连接后才在线、节点策略与独立域名入口、工作空间归属、首次授权摘要须由桌面自动确认、不可替换已登记的主机身份、原版 client 会话、部门和群聊列表、历史读取、Bot / 群聊发送与原会话回复及已读、通知事件去重、无正文通知、退出后的会话撤销。未付费或已过期 Cloud 不进入列表，已开通但尚未启动连接器的 Cloud 显示离线。

列表和历史响应必须经过 `DoneBot-Mobile/src/core/contracts.ts` 的正式校验，且列表须包含原版自动创建的主协调 Bot，其 `defaultBot` 为 `{}`。不能只检查加密传输返回成功，以免真实字段与手机数据契约不兼容仍被漏过。

手机设置与自动化工作读取 `/api/routines`、`/api/webhooks`、`/api/app-triggers`、`/api/connectors/connected`。定时工作复用原版 PATCH 路由，但手机入口只接受严格的 `{enabled: boolean}`；应用事件与外部事件使用新增的 POST `/:id/enabled` 路由，按原版可见 Bot 范围验证后交给原版管理器更新。手机没有创建、删除、试运行或内容修改入口。已连接应用只读取原版公共状态和账号别名，不读取凭据。

完整工作流使用手机正式自动化 schema 读取真实列表，关闭再开启定时工作与 webhook，并回查原版持久记录，证明指令内容不变；携带额外内容字段的变更必须被拒绝。应用事件的 enable-only 更新、隐藏 Bot 和严格布尔验证由 `server/app-triggers.test.ts` 覆盖，另由 `server/routes/webhooks.test.ts`、`server/request-auth.test.ts` 与 `server/donebot/mobile-host.test.ts` 检查对应路由边界。

结果保留在 `.omb-scratch/verify-evidence/mobile-hub/evidence.json`；其中包含 `wait`、消息、通知 payload 和该次桌面日志路径。脚本关闭自己启动的桌面、中继和测试网关。

## Cloud 安装凭据

网关 `TestPostgresCloudMobileWorkflow` 使用同一个完整工作流，但在临时 PostgreSQL 中建立真实 Cloud 实例归属及有效订阅，并将安装标记为 `donebot-cloud`。运行服务只读取合成安装凭据，没有用户 JWT；工作空间须作为 `cloud` 在线，不能混入桌面设备列表。

```sh
DONEBOT_MOBILE_PG_FIXTURE=1 DONEBOT_MOBILE_DESKTOP_ROOT=/Users/zluo/Dev/DoneBot DONEBOT_MOBILE_RELAY_ROOT=/Users/zluo/Dev/DoneBot-Relay go -C backend test -tags integration ./internal/mobilehub -run '^TestPostgresCloudMobileWorkflow$' -count=1 -v -timeout 150s
```

2026-11-15 该检查通过，证据位于 `.omb-scratch/verify-evidence/mobile-cloud/evidence.json`。包含安装凭据鉴权、Cloud 在线、加密连接、单聊/群聊、媒体回传、自动化开关与退出撤销。网关、中继和模型均使用隔离夹具，不能据此声称线上 Cloud 已部署或恢复。

同日构建的 `donebot-cloud-service:mobile-automation-20261115-amd64` 在无网络、只读根目录、UID `1001:1001`、临时资料盘的独立 Docker 容器启动成功，健康检查和 `/api/donebot/mobile/status` 均为 200。未提供安装凭据时状态为 `authenticated=false`、`relay=off`，该检查仅证明编译后的镜像包含手机连接器。构建来源、镜像导出与启动证据保存在本机 `release/cloud-mobile-20261115/`，未发布或部署。已有 Cloud 需按相邻 Cloud 项目的镜像升级流程保留数据重建运行容器，更新桌面 DMG 不会更新 Cloud。

随后以固定提交 `75704dddf140e27aa319de0c0baef7d54d366ebf` 通过 GitHub Actions 重新构建、验证并发布 x64 运行服务和图形桌面镜像，供节点直接在线拉取。正式摘要、Linux 证据及保留数据的在线升级步骤见 [本日发布记录](cloud-images-2026-11-15.md)；正式发布与上述离线候选是不同产物。

## 其他检查

```sh
pnpm exec vitest run server/sessions.test.ts server/donebot/mobile-host.test.ts
pnpm exec tsc -p tsconfig.server.json --pretty false
pnpm --dir ../DoneBot-Relay check
pnpm --dir ../DoneBot-Relay test
```

网关 `TestDoneBotMobileSessionUsesOriginalRefreshFamily` 覆盖原版 refresh family 撤销和账号密码安全版本变化；`TestAPNsSignsAndSeparatesEnvironments` 验证 ES256 签名、APNs topic、失效 token 与临时失败处理。发送目标为内存 HTTP transport，没有向 Apple 发出推送。

`TestPostgresRelayManagement` 覆盖节点创建、独立凭据、轮换、容量策略、停用、健康过期、最多 4 个启用节点及优先地址；`TestPostgresDevicePresenceAndRelayStatus` 覆盖归属隔离、中继未配置时登记手机、后台状态和撤销会话过滤。独立中继的管理测试用真实 WebSocket 证明 1 台电脑加 2 个会话为 5 条 WebSocket、容量限制、停用不影响已有连接、Origin 白名单、网关不可用时中继仍监听，以及策略恢复后自动接入。

真实蜂窝网络、线上多副本网关、真实 Cloud 节点和 Apple 后台通知不由这些夹具证明。公网启用方式见网关 `docs/donebot-mobile.md`。

## 手机上传图片进入模型输入（2026-11-15）

网关目录的 `input_modalities` 是可选字段。统一网关接入不再把该字段缺失判定为不支持图片，沿用原版 driver 的图片输入能力；所有网关模型均按支持多模态输入处理，不按模型名称过滤。手机上传、桌面保存与原会话附件机制保持复用。

- `server/donebot/llm-driver.test.ts` 与 `server/donebot/catalog.test.ts` 共 44 项通过。新增 messages、gemini、responses、chat 四种接口的回归检查，逐字节核对图片的原生请求内容。
- 临时 PostgreSQL 中枢、独立中继与原版隔离运行服务的 Desktop / Cloud 工作流均通过。完整上传流程在修复前观测到模型请求中的图片输入为 0，修复后为 1，`input_image.image_url` 与上传 PNG 的 data URL 完全一致；1056 字节图片的 SHA-256 为 `557deecf584802cc55e56286a0a2190ec51891b6943e0cfd8529c287c0457bd1`。
- 原图输入证据保存在 `.omb-scratch/verify-evidence/mobile-hub/evidence.json` 与 `mobile-cloud/evidence.json` 的 `modelImageInput`；修复前后日志为 `.omb-scratch/mobile-image-before.log` 与 `mobile-image-after.log`。模型服务使用合成响应，验证不代表真实收费模型已经识别图片。
- 修改文件的 oxlint、`pnpm package:prepare`、构建目录与安装包内服务的隔离冒烟、DMG 完整性校验均通过。安装包中的 1567 个服务文件与本次构建逐字节一致，并确认包内网关接入不含可选模态字段的图片门控；安装包 SHA-256 与验证结果保存在产物目录的 `SHA256SUMS`、`verification.json`。

此修复需要更新桌面或 Cloud 运行服务。手机 App、网关和中继无需为这次图片输入修复重新打包。新的本机 arm64 桌面测试包在 `release/mobile-input-20261115/`，未发布，未替换正在运行的桌面程序，也未部署 Cloud。
