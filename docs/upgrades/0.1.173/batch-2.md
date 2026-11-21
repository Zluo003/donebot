# 批次 2：团队身份和套餐

身份、团队 Cloud 订阅和成员代理已接入，执行授权与客户端工作空间继续实施；本批尚未整体验收。

网关新增默认关闭的团队、邀请、成员角色和发现接口。UUID 幂等创建、邮箱绑定邀请、Owner 不可降权或移除、Admin 仅管理 Member、版本化撤权和邀请重放保护均在服务端执行。独立团队套餐保存运行服务、桌面、存储、共享配额、保留期及价格；启用前检查完整性。个人套餐和实例约束保持独立。

客户端仅在网关声明兼容身份能力时显示团队管理。安装凭据不能管理账号或团队；页面不展示所有者密钥、个人余额或账单。未来团队运行服务通过固定公钥验证请求签名，复用原版成员受众、私聊、记忆和作用域；没有签名的 loopback 请求不能读取团队数据或创建管理员配对。

2026-11-20 验证：

- 一次性 PostgreSQL 17 身份测试通过，涵盖两个团队、多角色、邀请错误邮箱/过期/撤销/重放、成员降权及移除、禁止更改 Owner。日志 `/tmp/donebot-team-postgres-tests.log`。
- 网关 HTTP 边界测试通过：缺失登录、默认关闭、伪造 owner/payer、超大或多段 JSON、伪造查询和身份头。日志 `/tmp/donebot-team-api-boundaries.log`。
- 客户端及运行鉴权 4 文件 80 项通过。日志 `/tmp/donebot-team-auth-tests.log`。独立的团队 DOM 测试覆盖默认隐藏、移除确认及迟到响应。
- `node --experimental-strip-types scripts/verify-donebot-teams.ts` 启动两套独立真实服务和合成网关，通过团队创建/发现/成员移除、字段注入拒绝；运行服务验证成员身份、私有账单屏蔽、跨团队拒绝、未签名 loopback 和配对拒绝。日志 `/tmp/donebot-teams-workflow.log`；工作流证据保存在打印的 `.teams.json`。
- `pnpm lint`、`pnpm typecheck` 通过；后台前端 typecheck 和定向 ESLint 通过。

上述不证明团队购买、Cloud worker 成员代理、团队计费和跨设备执行已可用。这些能力保持关闭，后续记录其验证结果。

## 团队 Cloud 订阅与节点（2026-11-20）

团队实例复用 Cloud 订阅、余额事务和资金事件台账，个人实例的唯一约束保留，团队按 team_id 独立唯一。Owner 购买，Admin/Member 无付费权限；购买时固定资源、价格和保留期快照，修改套餐不改变已购买规格。个人 Cloud 接口和安装凭据接口不能返回团队实例或 Owner 凭据。数据库约束防止更换归属或购买快照。

成员代理在网关重新确认登录、角色和成员版本，以 Ed25519 签名绑定实际成员、团队、实例、方法和完整请求 URI。HTTP、WebSocket、资源和备份入口均检查该授权；普通成员不能读写整个实例的备份。网关每三秒复查长连接，撤权后关闭。请求签名最长十秒，不能用于另一条路径或修改 query。

worker 和 agent 须显式启用 `CLOUD_TEAMS_ENABLED=1`，并固定网关公钥。只有镜像声明 `donebot.teams.v1`、agent 健康且网关也开启团队能力，节点才声明协议；旧节点和降级节点不领取团队启动命令或运行租约。团队初始化只接收固定信任根和购买资源，不创建个人安装凭据或 Owner 管理员会话。宿主机保存不可由租户修改的规格，拒绝把个人卷或容器转成团队实例。团队磁盘按购买值创建，已有较小磁盘不扩容。

团队运行服务强制等待原版 bot-box 自检通过，要求 namespace 沙箱、seccomp 和凭据代理。自检未完成、失败或不支持时 health 返回 503，聊天、群聊、后台模型调用和 Bot 进程均拒绝执行；个人环境不改变。镜像安装 bubblewrap/socat，但不放宽宿主 Docker 安全选项以绕过检查。

验证证据：

- `/tmp/donebot-team-node-full-pg.log`：一次性 PostgreSQL 17 完整 Cloud 数据库测试通过，包含并发幂等购买、独立实例、快照续费/保留期、成员代理撤权、节点升级/降级/禁用和过期拒绝。
- `/tmp/donebot-cloud-team-all.log`：Cloud 全部 45 项通过；其中真实 HTTP/WebSocket 的合成网关→worker→agent→合成运行服务链路验证成员身份、凭据不转发、资源和备份权限、租约撤销关闭连接。
- `/tmp/donebot-team-isolation-unit.log`：5 文件 28 项通过，另有一个平台相关测试跳过；服务端 TypeScript 和 lint 通过。
- `/tmp/donebot-team-isolation-workflow.log`：两个临时 home/data 的真实 DoneBot 服务通过身份、角色和接口验证；本机不具备 Linux 隔离时，实际发送请求返回 503，未启动 fake engine。该项证明拒绝执行，不证明 Linux 隔离已经通过。

此时仍只协商 `identity`，不开放 `cloud_access`。团队网关执行凭据、付款归属、客户端工作空间切换、跨设备执行和真实 Linux 恶意探测尚未完成，不得开启团队正式入口。当前本机 Docker daemon 未启动；真实镜像验证仍属后续验收。

## 团队设备与执行授权基础（2026-11-21）

网关迁移 273 固定任务付款人、发起和执行成员、设备、授权版本、会话受众及请求哈希；五分钟令牌只存哈希。设备仅持有人启用，授权管理员可以撤销。心跳通过真实安装凭据识别设备，个人余额为零仍可报告；改名保留在线状态，禁用后重新启用不能恢复旧授权。八路并发受理仅一次，uncertain 和完成状态不能再次派发。仅有可信服务方法，没有向客户端开放任意发行授权的接口。

一次性 PostgreSQL、真实 HTTP 与 race 验证见 `/tmp/donebot-team-execution-final.log`；既有 Cloud 数据库流程应用新迁移后通过，见 `/tmp/donebot-team-execution-cloud-migration.log`。全部 Go 包编译通过，见 `/tmp/donebot-team-execution-compile-all.log`。网关接口、身份来源、回滚和未完成边界见相邻项目 `docs/donebot/team-execution.md`。

这些是授权和账单归属的基础记录，尚未接入供应商调用及实际扣费，不宣称团队执行完成。客户端节点和工作空间切换、可信协调器、模型请求适配与真正 Linux 隔离继续实施，能力保持关闭。

## 协调器身份与运行代次（2026-11-21）

网关迁移 274 固定执行所属协调实例及运行代次。协调器凭据由受信 worker 领取，Cloud agent 加密保存并原子写入容器私有 `/run`，成员代理及任务环境不取得该凭据。独立协调器 HTTP 接口拒绝普通 JWT、安装凭据、跨实例和伪造身份；申请及受理时均重新核验代次和节点启用状态。正文、日志和凭据检测增加团队 token 识别，bot-box 环境继续拒绝协调器文件设置。

真实 HTTP/PostgreSQL/race 日志 `/tmp/donebot-team-coordinator-accepted-http.log`；Cloud 51 项验证 `/tmp/donebot-team-coordinator-accepted-cloud.log`；现有订阅与代理回归 `/tmp/donebot-team-coordinator-pg.log`；客户端脱敏及沙箱规则 3 文件 50 项 `/tmp/donebot-team-coordinator-redaction.log`。尚未打通规范会话到模型派发及计费，真实 Linux 隔离也未验收，团队能力继续关闭。

## 团队计费身份与模型目录（2026-11-21）

网关迁移 275 为各团队绑定独立内部计费 Key，付款账号由有效 Owner 记录导出。普通 Key 接口不能鉴权、读取或修改该凭据，停用后不自动重建。成员和协调器各有独立目录接口，复用既有启用模型及人民币定价，并使用团队目录范围；不返回 Owner 个人余额或凭据。真实 HTTP 撤权与 PostgreSQL 并发、不可变归属验证通过，日志为 `/tmp/donebot-team-models-http.log`、`/tmp/donebot-team-billing-pg.log`、`/tmp/donebot-team-billing-tests.log`；全部 Go 包编译通过。

此项尚未打通供应商派发、实际扣费或运行服务目录消费，团队执行及账单隔离不得宣称完成；能力继续关闭。
