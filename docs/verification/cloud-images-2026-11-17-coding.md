# 2026-11-17 Cloud 编程执行器镜像

已发布 `linux/amd64` API 专用服务和配套按需桌面镜像，包含 Codex／Claude Code
编程执行器、DoneBot 网关与自有订阅来源选择及切换，与提交 `1339d9a` 的 DMG 配套。

- DoneBot 源码：`1339d9acae44311b29e1dc9f196a6591ad571adc`。
- Cloud 构建及验证源码：`e8fcf21559d6e228fb884a7d055b0884336f507d`。
- [成功发布任务](https://github.com/Zluo003/DoneBot-Cloud/actions/runs/44026237249)。
- [固定清单](cloud-images-2026-11-17-coding-amd64.env)及[完整证据](cloud-images-2026-11-17-coding-amd64.json)。
- [当前推荐清单](https://github.com/Zluo003/DoneBot-Cloud/releases/download/cloud-images-amd64-current/registry-images.env)。

```dotenv
CLOUD_DONEBOT_IMAGE=ghcr.io/zluo003/donebot-cloud-service@sha256:ac18863b290327d0ee3316d0d4f9f202f04f56111659918b66448f3924213348
CLOUD_DESKTOP_IMAGE=ghcr.io/zluo003/donebot-cloud-desktop@sha256:a852d4f05126f86147e519d10fc42cc48da2034cc6eb14c57b919372e5a6c1d5
```

发布前真实 Linux 双租户隔离、受控出网和配套桌面检查通过；发布后匿名核对
两个 manifest/config 的摘要、平台和完整源码标签，并核对推荐清单与构建 artifact 一致。
从正式摘要拉取服务镜像，以无网络、只读根、UID 1001、临时数据盘和无宿主端口运行，
确认健康及手机状态 API 200、根路径 404、静态前端不存在；四个受管理编程实例均有
安装入口且计费来源正确，自定义端点、配置及网关实例订阅登录操作返回 403。

镜像专项检查未运行 npm 安装、真实订阅登录或付费模型。实际对话切换、外部项目目录、
停止和跨 Bot 委派的隔离验证见 [编程执行器](donebot-coding.md)。Codex 自有订阅登录
沿用原版限制，仅支持本机；Cloud 可使用 DoneBot 网关，Claude Code 登录须在对应
Cloud 环境独立授权。CLI 安装和订阅授权不从个人电脑自动迁移。

Cloud 聊天网页保持移除，Bot 按需图形桌面仍独立提供。本次仅发布镜像，未替换
生产实例；已有节点须按 Cloud 仓库 `docs/deployment.md` 维护流程保留原盘、凭据和
deployment ID 升级。回退清单为 `cloud-images-2026-11-17-artifacts-amd64.env`，
不回退或删除用户数据。
