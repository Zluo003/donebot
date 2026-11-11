# OpenMausBot agent notes

## 二次开发范围与授权规则

本项目基于 OpenMausBot 原版代码进行二次开发。主要范围为前端修改，以及将 AI 接入改为用户的统一网关提供，覆盖 jev、llm、图片、视频、音乐和 tts 模型。

1. 除前端和统一网关接入外，未经用户明确许可，禁止修改 OpenMausBot 原版代码。所有功能和机制沿用 OpenMausBot，能复用的原版代码必须复用。
2. 若需求必须修改上述范围之外的原版代码，必须先向用户解释修改原因、涉及范围和影响，并在得到用户明确许可后才能修改。不得将用户提出功能需求视为对范围外原版代码修改的自动授权。

这些用户规则适用于整个项目；更具体的目录指令不得放宽上述授权要求。

用户已明确授权删除 `enterprise/` 企业版功能代码，以及为 DoneBot 更名和与本机 OpenMausBot 共存所必需的应用身份、数据目录、协议、端口与更新来源修改。此授权不扩大其他原版功能代码的修改范围。DoneBot 不得自动迁移或接管 OpenMausBot 或 OpenGrokBot 的数据。

## 统一网关与跨项目协作

- 统一网关地址：https://donebot.cn。
- 网关部署代码所在项目：`/Users/zluo/Dev/donebot-api`。
- 为完成前端与统一网关接入，必要时已获授权同时修改本项目和 `/Users/zluo/Dev/donebot-api` 的代码。修改网关项目之前须读取并遵循其适用的 `AGENTS.md`；此授权不放宽上述 OpenMausBot 原版代码的修改限制。
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
