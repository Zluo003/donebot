# 2026-11-17 原生编程分组与现有 CLI 配置发布

已发布 `linux/amd64` API 专用服务和配套按需桌面镜像，包含 Codex／Claude Code
原生网关分组接入及 DoneBot 网关、自有订阅、“维持不变”三种来源选择。

- DoneBot 源码：`c541bda5fe4e05cc22b00e7a8f74fe6373f61af1`。
- Cloud 构建及验证源码：`5ea8bba375e4e1482645feb5b7669b97c6229fca`。
- [成功发布任务](https://github.com/Zluo003/DoneBot-Cloud/actions/runs/44040373800)。
- [固定清单](cloud-images-2026-11-17-native-coding-amd64.env)及[完整证据](cloud-images-2026-11-17-native-coding-amd64.json)。
- [当前推荐清单](https://github.com/Zluo003/DoneBot-Cloud/releases/download/cloud-images-amd64-current/registry-images.env)。

发布前真实 Linux 双租户隔离、受控出网和配套桌面检查通过；发布后匿名核对
两个 manifest/config 的摘要、平台和完整源码标签，并核对推荐清单与构建 artifact 一致。
从正式摘要拉取服务镜像，以无网络、只读根、UID 1001、临时数据盘和无宿主端口运行，
确认健康及手机状态 API 200、根路径 404、静态前端不存在，六个编程实例及其来源正确。
“维持不变”保留 CLI 模型与推理配置，不提供安装或授权变更入口；自定义端点和配置
仍被拒绝。此专项检查在 ARM Docker VM 上模拟 amd64，CI 隔离验证在原生 amd64 执行。

镜像专项检查未运行 npm 安装、真实订阅登录或付费模型。对话、来源切换、项目目录和
跨 Bot 委派的隔离验证见 [编程执行器](donebot-coding.md)。Codex 自有订阅登录
仅支持本机；Claude Code 登录需在对应执行环境独立授权。“维持不变”要求该执行环境
已有 CLI 及配置，不从个人电脑自动迁移配置或授权。

原生编程网关分组还依赖另行部署 `donebot-api e9b6b89`、执行
`268_donebot_coding_keys.sql`，并由管理员配置对应上游和模型白名单；新分组初始白名单为空。
本次没有部署网关，也没有升级现有生产 Cloud 实例。Cloud 服务保持 API 专用，
按需图形桌面独立提供。实例升级须按 Cloud 仓库维护流程保留数据盘、凭据和 deployment ID。
上一版镜像清单为 [编程执行器镜像](cloud-images-2026-11-17-coding-amd64.env)。

配套 DMG 为 `0.1.155`，Apple 芯片 arm64，未进行 Developer ID 签名或公证：

- 文件：`release/unsigned-arm64-0.1.155-c541bda/DoneBot-0.1.155-arm64.dmg`。
- 大小：`320010499` 字节。
- SHA-256：`21338b75df4ee2eb879e23657001b4756d2f16d6d1d9e89e49fe9f4c8f50888b`。

DMG 完整性、只读挂载、包内源码及 arm64 架构核对通过；打包后的服务、浏览器和
六种编程来源在隔离临时 HOME 中检查通过。DMG 本身未签名，Electron 应用仅有 ad hoc 签名。
构建信息及检查日志保存在同一 release 目录。
