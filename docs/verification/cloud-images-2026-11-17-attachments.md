# 2026-11-17 Cloud 已交付附件复用镜像

已发布 `linux/amd64` Cloud 服务镜像，包含已交付附件直接汇报、再次附加成功复用原文件的修复。
图片、视频、音频和文档覆盖普通 Bot、协调 Bot 和群聊；本次没有通过隐藏真正的工具失败消除提示。

- DoneBot 源码：`837b7f3db66e9263aeb5a5212729d179daae5878`。
- Cloud 构建及验证源码：`62be34b49165daa4b90196e20caefc5072969bc6`。
- [成功发布任务](https://github.com/Zluo003/DoneBot-Cloud/actions/runs/43938501354)（第 3 次执行）。
- [固定清单](cloud-images-2026-11-17-attachments-amd64.env)及[注册表、Linux 与服务启动证据](cloud-images-2026-11-17-attachments-amd64.json)。
- [当前推荐清单](https://github.com/Zluo003/DoneBot-Cloud/releases/download/cloud-images-amd64-current/registry-images.env)。

```dotenv
CLOUD_DONEBOT_IMAGE=ghcr.io/zluo003/donebot-cloud-service@sha256:aa3b8ff7a9e9fa6c51485fbfab8d8b934409106ec3dc43800d7c208d596ee9b9
CLOUD_DESKTOP_IMAGE=ghcr.io/zluo003/donebot-cloud-desktop@sha256:0e7c667f005ab00d33dc89c6271e4b207be6ff228359e1799ef6658f1120cebf
```

Cloud 已移除的是聊天网页和静态前端，聊天界面由客户端安装包提供；Bot 使用的浏览器和按需图形桌面仍保留。
当前节点仍要求 `CLOUD_DESKTOP_IMAGE`，发布流程同时构建、验证并发布配套桌面镜像。
本次修复位于服务镜像，不能把保留配套桌面误解为恢复云端聊天网页。

发布前在一次性 Ubuntu amd64 runner 完成真实双租户服务隔离、受控出网及图形桌面验证。
发布后匿名核对 GHCR manifest/config 的摘要、平台和完整源码 revision，并拉取发布服务镜像，
在无网络、只读根目录、UID 1001、临时数据目录中验证健康及手机状态接口 200、根路径 404、
静态前端不存在，以及编译服务包含附件复用、回传清单和手机续传实现。测试容器定向清理。
Bot/群聊附件行为的隔离场景与限制见 [附件交付验证](donebot-handoff-attachments.md)。

本次仅发布并更新推荐清单，未升级生产实例。现有节点需沿用 Cloud 仓库
`docs/deployment.md` 的受控维护升级流程，保留原盘、安装凭据和 deployment ID。
回退清单为此前的 `2026-11-17-resume-amd64.env`；不要删除用户数据、扩大已有磁盘或重建实例。
此 amd64 清单不适用于 ARM64 节点。
