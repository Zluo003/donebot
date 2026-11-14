# OpenMausBot agent notes

## 二次开发范围与授权规则

本项目基于 OpenMausBot 原版代码进行二次开发。主要范围为前端修改，以及将 AI 接入改为用户的统一网关提供，覆盖 jev、llm、图片、视频、音乐和 tts 模型。

1. 除前端和统一网关接入外，未经用户明确许可，禁止修改 OpenMausBot 原版代码。所有功能和机制沿用 OpenMausBot，能复用的原版代码必须复用。
2. 若需求必须修改上述范围之外的原版代码，必须先向用户解释修改原因、涉及范围和影响，并在得到用户明确许可后才能修改。不得将用户提出功能需求视为对范围外原版代码修改的自动授权。

这些用户规则适用于整个项目；更具体的目录指令不得放宽上述授权要求。

用户已明确授权删除 `enterprise/` 企业版功能代码，以及为 DoneBot 更名和与本机 OpenMausBot 共存所必需的应用身份、数据目录、协议、端口与更新来源修改。此授权不扩大其他原版功能代码的修改范围。DoneBot 不得自动迁移或接管 OpenMausBot 或 OpenGrokBot 的数据。

## 自有云桌面范围

用户已明确将本轮改造收窄为：在从 GitHub 恢复的代码上，用 DoneBot 自有云桌面替换 Boat。允许为此修改工作位置路由、桌面工具桥、查看代理及文件回传所必需的原版调用点，复用现有会话、工具执行和附件验证机制。此授权不包含团队同步、任务迁移、运行权交接或其他原版功能重构。

- Cloud 项目位于 `/Users/zluo/Dev/DoneBot-Cloud`。每用户标准配置合计 2 核 / 4 GiB，包含运行服务和图形桌面；持久存储最大 15 GiB，新实例运行盘 5 GiB、桌面资料盘 10 GiB。已有较小磁盘沿用实际容量，不自动扩容、重建或格式化。
- 私有本地桌面保持禁用。本地 Bot 使用云桌面时，其运行引擎仍在本机，须保持本机运行；只有 Cloud 工作空间中的 Bot 可独立于本机运行。不得把切换桌面描述为任务已迁移。
- 桌面入口接向自有服务，保留用户自有 VPS。桌面访问复用账号和实例归属验证，不转交网关凭据给桌面或第三方。

## 统一网关与跨项目协作

- 原版促销、赞助推荐、原版云服务购买/升级、Boat 接入、原版移动客户端下载和原版邮件订阅在 DoneBot 前端默认屏蔽，统一由 `src/donebot/services.ts` 管理。未来接入自有服务时不得自动恢复原版服务。保留本地功能、自有服务器连接及 DoneBot 网关。
- 统一网关地址：https://donebot.cn。
- 网关部署代码所在项目：`/Users/zluo/Dev/donebot-api`。
- 为完成前端与统一网关接入，必要时已获授权同时修改本项目和 `/Users/zluo/Dev/donebot-api` 的代码。修改网关项目之前须读取并遵循其适用的 `AGENTS.md`；此授权不放宽上述 OpenMausBot 原版代码的修改限制。
- LLM 只允许通过 DoneBot 统一网关接入，不开放第三方 LLM 的自定义密钥、CLI、MCP 或其他直连接入。第三方渠道例外仅限图片、视频、音频（含音乐）生成，不得扩大到 LLM。
- 统一网关是媒体生成的默认渠道，不是唯一渠道。允许用户安装、授权并使用第三方媒体 CLI、MCP 或技能；渠道优先级为本次明确指定、该 Bot 已保存的对应媒体偏好、统一网关。用户可通过自然语言要求保存默认渠道，复用原版长期指令/记忆机制，按图片、视频、音乐分别记录；一次性指定不覆盖默认。指定渠道不可用时如实报告，不静默切换或重复提交收费任务。复用原版安装、执行权限和安全凭据机制，DoneBot 网关凭据不得交给第三方。
- 内置网关媒体模型能力、原生参数、默认值和限制由 DoneBot 客户端登记；内置图片固定 Seedream 5.5，视频固定 Seedance 2.5，音乐固定 Suno v6。这些模型及参数限制不约束用户选择的第三方渠道。内置 Suno v6 仅提供纯音乐和带歌词歌曲生成，不开放歌词单独生成、翻唱、续写及参考编辑。本轮暂不优化 TTS。客户端到网关必须异步提交媒体任务，后台查询并回传原会话；TTS 沿用朗读流式接口。
- Seedance 2.5 有参考素材时默认全能参考模式（omni_reference_task_type=reference），单张图片也不自动视为首帧；无参考素材时使用文生视频。仅在用户明确要求时切换首帧、首尾帧、编辑或延长模式。
- donebot-api 基于 sub2api，只负责账号、鉴权、路由转发、计费、任务及回执等基础功能；不得接受语义需求后替客户端选模型、查询能力、规划或组装媒体请求。网关原生参数解析用于安全及计费，不替代客户端能力登记。
- 用户可按需提供临时测试账号和密码。账号、密码及其他测试凭据不得写入长期记忆或项目持久指令文件；需要时使用当前会话中提供的凭据，未提供时再向用户索取。

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.

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
