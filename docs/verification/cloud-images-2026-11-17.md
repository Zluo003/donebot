# 2026-11-17 Cloud 附件交付与手机续传镜像

已发布 `linux/amd64` 运行服务和配套桌面镜像，包含 Bot/群聊之间图片、视频、音频及文档交付，以及手机消息附件的 Range、If-Range 和文件版本校验。手机端持久断点、自动重连与前后台恢复需同时安装包含 `d68d78d` 的新版 App，具体验证见 [手机续传记录](mobile-file-resume.md)。

- DoneBot 源码：`cf7f37aecbb859016385180b3c160e17fe2da393`。
- Cloud 构建及验证源码：`6512e06d0a20e0eece0beee3f83287056f72d186`。
- [成功发布任务](https://github.com/Zluo003/DoneBot-Cloud/actions/runs/43927364247)。
- [固定镜像清单](cloud-images-2026-11-17-amd64.env)及[注册表与 Linux 验证证据](cloud-images-2026-11-17-amd64.json)。
- [当前推荐清单](https://github.com/Zluo003/DoneBot-Cloud/releases/download/cloud-images-amd64-current/registry-images.env)已与本次 artifact 的清单和发布 manifest 核对一致。

```dotenv
CLOUD_DONEBOT_IMAGE=ghcr.io/zluo003/donebot-cloud-service@sha256:66df94f6261f737b7bc3863c929c80ca1d8188826a05bb3cbe4520961c6513a6
CLOUD_DESKTOP_IMAGE=ghcr.io/zluo003/donebot-cloud-desktop@sha256:36899535b6ebc25eed7b9e90303e164d01a6b7392c24a181949aeb215a9d3234
```

发布前在一次性 Ubuntu amd64 中完成双租户运行服务隔离、受控出网和实际图形桌面检查，包括持久化、跨租户访问拒绝、文件下载、备份恢复及桌面升级保留数据。发布后匿名读取两个 GHCR manifest/config，核对 SHA-256、平台和完整源码 revision；无需用户登录即可拉取。

另拉取已发布服务镜像，在无网络、只读根目录、UID 1001 和临时数据中启动：健康与手机状态接口 200、根路径 404、静态前端不存在，并检查编译服务包含分段校验和 Bot 附件交付代码。测试容器结束后已定向删除，未连接生产数据。

已有节点继续采用 Cloud 仓库 `docs/deployment.md` 的受控维护升级流程：备份、记录实际旧摘要、停止 worker/agent，再用新清单准备升级，保留原盘、安装凭据和 deployment ID。镜像保持 API 专用，实例根路径 404 为预期行为；桌面仍需 0.1.154 或后续兼容版本。ARM64 节点不能使用本次 amd64 清单。

本轮已发布镜像并更新推荐清单，没有升级生产实例或安装手机 App。手机源码隔离测试不代表真实设备或公网长期传输已验收。
