# DoneBot 的开源边界与本机隔离

DoneBot 基于 OpenMausBot 的 Apache-2.0 开源版本。`enterprise/` 中的 10 个文件已删除；开源核心中的可选加载接口、授权判断、共享工作区拒绝访问机制保留，不通过绕过授权来启用企业功能。`LICENSE`、`NOTICE` 和第三方许可证保留原文。

## 应用身份

| 项目 | DoneBot |
| --- | --- |
| 产品及安装包名称 | DoneBot |
| 应用 ID | `com.donebot.app` |
| URL 协议 | `donebot://` |
| CLI | `server/donebot.ts`，npm 包命令 `donebot` |
| 业务数据 | `~/.donebot`；命名环境使用独立的 `.donebot-*` 目录 |
| 桌面配置和 Chromium 缓存 | 系统应用数据目录下的 `DoneBot/` |
| 桌面日志 | 桌面配置目录下的 `logs/` |
| macOS 语音助手 | `DoneBot Speech.app`，独立 bundle ID |
| 服务端口 | `18899`，桌面回退 `28899`、`38899` |
| 默认 webhook 端口 | `18900` |
| 手机连接与控制端口 | `18910`、`18911` |
| 桌面客户端中继端口 | `18898`，回退 `28898`、`38898` |
| 手机隧道内部网关端口 | `18912` |
| Vite 开发端口 | `5299` |
| 本地 Compose HTTP 端口 | `18880` |
| 配置环境变量 | `DONEBOT_*` |
| 后台服务 | `donebot.service`、`com.donebot.serve` |
| Linux 容器 AppArmor 配置 | `donebot-home-narrow` |
| 会议助手目录 | `~/.donebot-meet` |
| Fleet 系统用户前缀及站点目录 | `dbt-`、`/etc/caddy/donebot.d` |
| 云启动标记及边缘证书目录 | `.donebot-cloud-home.json`、`.donebot-edge/` |
| 同步下载临时文件后缀 | `.donebot-sync-<随机值>` |

DoneBot 不读取原版的 `OMB_*`、`OPENMAUSBOT_*` 或 `OGB_PORT` 作为数据目录、服务器地址或端口配置，也不自动移动 `~/.openmausbot`、`~/.opengrokbot`。全局说话快捷键默认关闭，可在设置中选择开启。

应用图标、网站图标和 macOS 安装背景使用 DoneBot 标识。机器人头像、工具和任务机制继续复用原版实现。内部类型、工具名、备份格式中的兼容性标记，以及必要的上游文档和第三方下载地址不作为本机应用身份使用。

模型进程内部的 `OPENMAUSBOT_CODEX_*`、`OPENMAUSBOT_CHATGPT_TOKEN`、`OPENMAUSBOT_COMPANY_API_KEY`、`OPENMAUSBOT_LOCAL_*`、`OPENMAUSBOT_QWEN_*` 保留原约定，以维持它们与服务端 `DONEBOT_*` 秘密变量之间的安全边界。它们不决定应用身份或数据目录。手机凭据的加密上下文及固定互操作向量也保留原格式。同步扫描忽略原版 `.omb-sync-*` 临时文件，只将 DoneBot 自己的临时文件交给清理流程。

## 打包与更新

构建服务时会清除残留的 `dist-server/enterprise`；npm 打包遇到该目录会拒绝继续。桌面配置 `publish: null`，没有 `app-update.yml` 时不启动自动更新。服务端更新检查没有 DoneBot 更新源时不发起请求。部署更新脚本也需要显式配置 DoneBot 的镜像仓库及更新频道，避免将上游发行版用作 DoneBot 更新。

DoneBot 尚未配置自己的公开发行渠道。引用上游文档和外部服务的地址保留原协议，不将未实现的 API 地址猜测为 `donebot.cn` 的路径。本地 Compose 的基础镜像可先从当前开源源码构建：

```sh
docker build --target server -t donebot-core:local .
docker compose up --build
```

`deploy/install.sh` 在未配置 DoneBot 发行源时会在检查或安装前拒绝继续。自有镜像可通过 `DONEBOT_INSTALL_IMAGE` 指定，配合 `DONEBOT_INSTALL_SOURCE` 指定本仓库的文件来源；公开发行后可配置 `DONEBOT_INSTALL_IMAGE_REPOSITORY`、`DONEBOT_INSTALL_RELEASES_URL` 和 `DONEBOT_INSTALL_REPOSITORY_FILES`。它不再默认安装上游镜像或下载上游部署脚本。源码中保留的上游云服务接口不代表 DoneBot 已部署对应服务。

## 验证与恢复

遵循 `docs/verification/README.md`，只对临时 HOME、临时数据目录和仓库假引擎执行验证。

- `server/legacy-migration.test.ts` 创建两份模拟的原版数据，检查 DoneBot 新建自己的目录、忽略原版环境变量且保留原版文件。
- `node scripts/verify-donebot-identity.mjs` 使用真实 Electron 的启动前 API，在临时应用数据目录下检查名称、配置、缓存和日志路径，保留模拟的原版桌面配置。它不打开完整桌面应用。
- `pnpm test:packaged-server` 检查离开源码和 node_modules 后的服务启动、CLI、代理路径、备份与权限边界。
- `node --experimental-strip-types scripts/control-omb.ts launch` 启动隔离假引擎服务；后续 `control:omb` 操作必须指定它打印的 URL。

企业适配器专用的两组集成测试在 `enterprise/` 不存在时跳过。开源版本、可选加载接口及拒绝访问的测试继续运行。

验证覆盖源码构建、类型检查、lint、多语言一致性、真实 Electron 的启动前路径、隔离假引擎对话，以及离开源码后的服务端打包运行。工具目录的 28 种配置保留相同工具名；完整工具描述仅修改品牌文字，AppArmor 权限内容仅修改配置身份。

本次核验记录（2026-11-11）：

| 检查 | 结果 |
| --- | --- |
| 完整 Vitest 回归首次执行 | 34,074 项通过；46 项失败及 1 个套件加载错误，随后逐项处理 |
| 失败文件复测 | 除下述 Docker 本机环境用例外，28 个文件、1,162 项全部通过 |
| Electron Node 测试 | 2,027 项通过，10 项跳过；最终同步隔离专项另有 33 项通过 |
| 辅助端口及连接专项 | 199 项通过，2 项跳过 |
| 控制平面 | 170 项通过 |
| Composio broker | 121 项通过 |
| 最终构建、类型检查、lint、多语言检查 | 通过 |
| 最终打包服务测试 | 14 个代理入口、CLI、加密备份、信任边界及启动清理通过 |
| npm 包文件检查 | 1,804 个文件；无企业目录，包含 LICENSE、NOTICE、LICENSING.md |
| 最终隔离对话 | 新建机器人、发送、等待 settled、读取假引擎回复通过；OSS、空企业功能列表、DoneBot 品牌正确 |

`scripts/docker-image.test.ts` 的版本查询用例在本机仍失败：Node 子进程获得的 npm 版本结果与测试替身不同。发布工作流的版本查询步骤和该测试块均与修改前逐字一致；通过 Python 启动的隔离 shell 执行同一脚本，成功查询及失败回退两种情况都通过。本次没有为此修改原版的版本查询实现。完整回归未在所有修正后再执行一遍，因此这里明确记录完整首次执行及失败文件复测，而不将其描述为一次全绿运行。

对应证据位于下述快照目录中的 `vitest-full.log`、`full-failures-rechecked.log`、`docker-baseline-proof.json`、`docker-shell-verified.json`、`final-build-results.json` 和 `fixture-final-evidence.json`。最终对话的临时进程已停止，临时业务数据已清理。

没有生成或安装签名桌面发行包，也没有启动用户的 OpenMausBot 或修改其数据。完整桌面交互、麦克风、全局快捷键、Windows/Linux 安装及实际两款应用同时安装运行，尚未作手工验收。自有手机应用、云服务、签名证书及发行频道也未部署；保留上游外部链接不代表 DoneBot 已拥有对应服务。

修改前源码快照及核验日志位于工作区之外的 `/Users/zluo/Dev/donebot-before-oss-rebrand-ad5agmex/`。其中 `source.tar.gz` 可用于逐文件恢复；不要直接覆盖整个工作区，以免覆盖后续修改。当前工作区文件最初均未被 Git 跟踪，因此本次未创建提交或将用户文件加入暂存区。
