# OpenMausBot agent notes

## 二次开发范围与授权规则

本项目基于 OpenMausBot 原版代码进行二次开发。主要范围为前端修改，以及将 AI 接入改为用户的统一网关提供，覆盖 jev、llm、图片、视频、音乐和 tts 模型。

1. 除前端和统一网关接入外，未经用户明确许可，禁止修改 OpenMausBot 原版代码。所有功能和机制沿用 OpenMausBot，能复用的原版代码必须复用。
2. 若需求必须修改上述范围之外的原版代码，必须先向用户解释修改原因、涉及范围和影响，并在得到用户明确许可后才能修改。不得将用户提出功能需求视为对范围外原版代码修改的自动授权。

这些用户规则适用于整个项目；更具体的目录指令不得放宽上述授权要求。

用户已明确授权删除 `enterprise/` 企业版功能代码，以及为 DoneBot 更名和与本机 OpenMausBot 共存所必需的应用身份、数据目录、协议、端口与更新来源修改。此授权不扩大其他原版功能代码的修改范围。DoneBot 不得自动迁移或接管 OpenMausBot 或 OpenGrokBot 的数据。

## 已批准的分批升级与团队协作

用户已批准以 OpenMausBot v0.1.173（799ebcd900309a9836162fdb766899cb68604abb）为固定目标逐模块升级，授权为该计划修改原版会话、协作、自动化、进程管理及团队机制，并适配本项目、donebot-api 和 DoneBot-Cloud。此授权扩展下述此前仅云桌面的范围，但不包含任务自动迁移、运行权交接、费用预算与上限、新语音供应商、网站发布托管、第三方 LLM 直连、原版商业服务或 enterprise 代码。

- 个人与团队复用 DoneBot 登录，身份、权限、数据和账单范围独立；团队使用独立 Cloud，不能接管个人 Cloud。成员明确启用本机执行，Bot 运行位置创建后固定。
- 共享会话由团队 Cloud 保存；私聊仅本人本机或团队 Cloud 执行。成员本机工具权限仍由持有人授予，管理员不得提升本机权限。离线不自动接管任务，事件和收费请求须幂等。
- 个人资料不自动上传，团队调用由 Owner 付款且不得向成员泄露其凭据。套餐资源、价格和保留期独立配置，配置完整前不得开售；个人 Cloud 规格及旧磁盘保持不变。
- 团队能力默认关闭，须客户端、网关及运行服务共同声明兼容。逐批验证后统一发布；网关（`/Users/zluo/Dev/donebot-api`）完成修改并通过验证后直接推送 `origin/main` 并打递增 `v*` tag 触发 GitHub Release 自动发布，不直接操作生产服务器。
- 固定基线、逐项去向及验收证据见 `docs/upgrades/0.1.173/README.md`，未验收项目不得记为完成。

## 自有云服务范围

用户已明确下线客户端云端图形桌面与私有本地桌面（`DONEBOT_CLOUD_DESKTOP_ENABLED = false`、`DONEBOT_PRIVATE_DESKTOP_ENABLED = false`），个人 DoneBot Cloud 改为纯服务运行模式（服务镜像内含内置 Chrome 浏览器，不依赖独立图形桌面容器）。

- Cloud 项目位于 `/Users/zluo/Dev/DoneBot-Cloud`。每用户个人云服务标准配置为 2 核 / 4 GiB 内存、新实例持久数据盘 20 GiB；已有较小磁盘沿用实际容量，不自动扩容、重建或格式化。
- 客户端工作位置保留 `自动 / 这台电脑（仅本机）/ 浏览器 / 关闭`，移除「云端桌面 / Boat」入口；Cloud 工作空间中的 Bot 可独立于本机 24 小时运行并使用云端内置浏览器。

## 统一网关与跨项目协作

- 原版促销、赞助推荐、原版云服务购买/升级、Boat 接入、原版移动客户端下载和原版邮件订阅在 DoneBot 前端默认屏蔽，统一由 `src/donebot/services.ts` 管理。未来接入自有服务时不得自动恢复原版服务。保留本地功能、自有服务器连接及 DoneBot 网关。
- 统一网关地址：https://donebot.cn。
- 网关部署代码所在项目：`/Users/zluo/Dev/donebot-api`。
- 为完成前端与统一网关接入，必要时已获授权同时修改本项目和 `/Users/zluo/Dev/donebot-api` 的代码。修改网关项目之前须读取并遵循其适用的 `AGENTS.md`；此授权不放宽上述 OpenMausBot 原版代码的修改限制。
- LLM 只允许通过 DoneBot 统一网关接入，不开放第三方 LLM 的自定义密钥、CLI、MCP 或其他直连接入。第三方渠道例外仅限图片、视频、音频（含音乐）生成，不得扩大到 LLM。
- 统一网关是媒体生成的默认渠道，不是唯一渠道。允许用户安装、授权并使用第三方媒体 CLI、MCP 或技能；渠道优先级为本次明确指定、该 Bot 已保存的对应媒体偏好、统一网关。用户可通过自然语言要求保存默认渠道，复用原版长期指令/记忆机制，按图片、视频、音乐分别记录；一次性指定不覆盖默认。指定渠道不可用时如实报告，不静默切换或重复提交收费任务。复用原版安装、执行权限和安全凭据机制，DoneBot 网关凭据不得交给第三方。
- 内置网关媒体模型能力、原生参数、默认值和限制由 DoneBot 客户端登记；图片、视频首选与备用由用户在设置中从账号实际启用且客户端已支持的模型中选择，音乐固定 Suno v6。保留已记忆的第三方媒体渠道优先于设置首选与备用；明确失败后，Bot 先告知失败原因和将使用的备用模型，图片无需再次确认，视频需用户确认，已有免确认授权时不重复确认；最多派发一次备用，结果不确定或结算、下载等待不能重提生成。这些模型及参数限制不约束用户选择的第三方渠道。内置 Suno v6 仅提供纯音乐和带歌词歌曲生成，不开放歌词单独生成、翻唱、续写及参考编辑。本轮暂不优化 TTS。客户端到网关必须异步提交媒体任务，后台查询并回传原会话；TTS 沿用朗读流式接口。
- Seedance 2.5 有参考素材时默认全能参考模式（omni_reference_task_type=reference），单张图片也不自动视为首帧；无参考素材时使用文生视频。仅在用户明确要求时切换首帧、首尾帧、编辑或延长模式。
- donebot-api 基于 sub2api，负责账号、鉴权、路由转发、计费、任务及回执。图片和视频统一使用 `donebot.media.v1` 异步协议，由客户端登记能力、选模型、填写显式模式和参数、管理备用，网关确定性转换为上游格式。网关不得根据自然语言替客户端选模型、查询能力或规划生成；原生参数解析不替代客户端能力登记。音乐和第三方媒体渠道沿用各自协议。
- 用户可按需提供临时测试账号和密码。账号、密码及其他测试凭据不得写入长期记忆或项目持久指令文件；需要时使用当前会话中提供的凭据，未提供时再向用户索取。

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.

## 打包默认

除非用户明确指定其他方式，macOS 打包只生成 Apple 芯片（arm64）的未签名 DMG，不执行 Developer ID 签名或公证，也不生成 Intel 或 ZIP 安装包。`pnpm package:mac` 遵循此默认。

## Comments

Write a comment only for what the code cannot say:

- a license or attribution notice;
- a fact forced by something outside this code (a vendor, CLI, OS, browser,
  Electron or protocol behaviour), with its version when it has one;
- the doc comment of a public contract: the wire types in `shared/`, the
  driver interface, the preload bridge, `config.json` fields people edit;
- a link to an upstream issue;
- a security invariant or a known open risk.

Do not narrate what the next line does, restate a name, record history ("used
to", "no longer", PR or issue numbers, plan or slice names: git has it), point
at other files, draw banners or leave commented-out code. When our own code
needs a paragraph to explain a surprise, change the code instead: a better
name, a type, an extracted function, one shared helper. A rule ("never X",
"must match Y") belongs in a type, a test or a lint rule. Never suppress a lint
rule that guards correctness; fix the code.

More specific `AGENTS.md` files override this note within their directories.
