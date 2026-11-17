# 2026-11-17 Cloud Bot 产物列表镜像

已发布 `linux/amd64` Cloud 服务镜像，包含 Bot 产物列表接口、任务显示名称、
单聊及群聊汇报关联和四类文件预览下载。客户端使用包含 `d128b95` 的安装包。

- DoneBot 源码：`d128b95b79ffc36a978229f0166b297fbab4a9e8`。
- Cloud 构建及验证源码：`bcd5425fd05c3e8a7aab57975f9a4a1ce54cb835`。
- [成功发布任务](https://github.com/Zluo003/DoneBot-Cloud/actions/runs/44011099571)。
- [固定镜像清单](cloud-images-2026-11-17-artifacts-amd64.env)及[完整发布证据](cloud-images-2026-11-17-artifacts-amd64.json)。
- [当前推荐清单](https://github.com/Zluo003/DoneBot-Cloud/releases/download/cloud-images-amd64-current/registry-images.env)。

```dotenv
CLOUD_DONEBOT_IMAGE=ghcr.io/zluo003/donebot-cloud-service@sha256:20b557dc49f6ef68df0d3a3d23d81000d6eec4abdaab5e851e62a3c35d2a0a48
CLOUD_DESKTOP_IMAGE=ghcr.io/zluo003/donebot-cloud-desktop@sha256:4c3df98fb1ececb8c9128d158bea0b8d201699f2f00ad919be6b7486032dfd5d
```

发布前完成一次性 Ubuntu amd64 真实双租户运行隔离、受控出网和配套图形桌面检查。
发布后匿名核对注册表 manifest/config 摘要、平台及完整源码标签；拉取正式服务镜像，
在无网络、只读根、UID 1001、临时资料盘和无宿主端口的容器内验证健康及手机状态
接口 200、根路径 404、静态前端不存在。合成单聊与群聊汇报共 8 个文件，验证
产物接口 200、任务名称、分页、原消息来源、图片/视频/音频/文档的 Range 预览、
完整下载字节及伪造路径拒绝。专项检查未在容器中调用模型或播放真实媒体；
实际派发与浏览器播放验证见 [Bot 产物检查](bot-artifacts.md)。

Cloud 聊天网页保持移除；Bot 使用的工具浏览器和按需图形桌面仍保留。
本次只发布镜像并更新推荐清单，未升级生产实例。已有节点应沿用 Cloud 仓库
`docs/deployment.md` 的受控升级流程，保留原盘、凭据及 deployment ID，
升级后核对实际运行容器的源码 revision 与产物接口。回退镜像清单为
`cloud-images-2026-11-17-attachments-amd64.env`；不删除或回退用户数据。
