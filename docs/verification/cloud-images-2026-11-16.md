# 2026-11-16 Cloud API 专用镜像与客户端交付

DoneBot 0.1.153 桌面共用安装包中的聊天界面；Cloud 仅提供 API、SSE、WebSocket 和附件。
本次包含黑白电脑连线云端加载页、保存项自动续连、缓存及返回本地、Cloud 中隐藏工作空间栏和禁止创建工作空间；
同时包含 Muse 最长 10 秒、图片预处理和附件预算整理。手机附件传输与交互的配套修改位于 DoneBot-Mobile。

## 已发布镜像

- DoneBot 源码：`cf396bc1a526a908f0a302f8d51cd26151240271`。
- Cloud 构建与验证源码：`dd79356cfd90c91b7a9f5d8fb160720a8ed80eba`。
- 平台：`linux/amd64`，不用于 ARM64 节点。
- [成功发布任务](https://github.com/Zluo003/DoneBot-Cloud/actions/runs/43751282354)。
- [不可变镜像清单](cloud-images-2026-11-16-amd64.env)和[注册表及 Linux 验证记录](cloud-images-2026-11-16-amd64.json)。

[当前推荐清单](https://github.com/Zluo003/DoneBot-Cloud/releases/download/cloud-images-amd64-current/registry-images.env)
已刷新并与本页两个摘要核对一致。发布不替换生产实例，不要求上传更新包。
旧镜像保留用于现有实例及受控回滚，部署目标以当前清单为准。

## 升级顺序

1. 先安装 DoneBot 0.1.153 或后续兼容版本。旧客户端依赖 Cloud 网页，无法使用 API 专用镜像。
2. 节点代码包含 Cloud `dd79356` 或后续版本；按原维护流程备份，记录实际旧服务和桌面摘要，使用旧配置停止 worker 和 agent。
3. 将当前清单的两个值合入原 `agent.env`，保留其它配置。逐实例运行 `prepare-upgrade` 和 `prepare-desktop-upgrade`，传入实际旧摘要，保留原盘、凭据、实例及 deployment ID。
4. 恢复 agent、worker。核对实际容器的镜像和完整 revision、原有 Bot/消息/文件，并检查健康与手机状态；有账号凭据的实例应达到 `authenticated=true`、`registered=true`、`relay=connected`。

完整维护命令沿用[此前的受控升级步骤](cloud-images-2026-11-15.md#在线升级已有节点)，其中目标镜像必须换成本页当前清单。
新镜像的 `/api/health` 返回 `static=false`；`GET /` 返回 404 是预期行为，不能用根页面判断故障。
网关控制台、Bot 的浏览器及专属图形桌面保留。先前已具备的 agent 意外退出恢复仍由节点执行，镜像不能替代节点更新。

## 验证与边界

真实一次性 Ubuntu amd64 环境中，双租户服务隔离、受控出网、桌面、文件下载、持久化和备份恢复检查通过后才发布。
匿名核对两镜像的 manifest/config 摘要、平台和 revision 通过。另拉取已发布服务镜像，使用无网络、只读根目录、
UID 1001 和临时数据容器启动，确认健康 API、手机状态路由、无 `/app/dist/index.html`、图片 worker 存在及根路径 404。

本地完整 Electron Node 检查 2053 项通过、10 项跳过；源码与媒体路由检查 106 项通过、3 项待办；
类型、lint、16 种语言目录和打包服务 smoke 通过。真实 Electron 隔离 fixture 验证安装包前端连接 API 专用 Cloud、
API/SSE/WS/Range/上传、Cookie 复用及续期、返回本地与重试。图片隔离用例证明原图保留、模型收到 JPEG、
文字整理后仍可按稳定 ID 重读，未重新提交生成。细节见[Cloud 连接](donebot-cloud-reconnect.md)和[附件上下文](donebot-image-context.md)。

手机端 12 文件 90 项测试、构建、Capacitor 同步及 iOS 真机目标编译通过。独立浏览器 fixture 验证持续视频流、
相机/图库/本地 PDF 入口、纵向菜单、全屏视频、电脑/Cloud 切换及左边缘返回。开发签名 IPA 已生成，
真实相机硬件、系统分享目标、APNs 送达及公网长期稳定性尚需设备验收。

[全量上游 CI](https://github.com/Zluo003/donebot/actions/runs/43751027429) 未全部通过：部分原版 fixture 未登录 DoneBot，
创建 Bot 被拒绝，后续断言失败；macOS approval smoke 同样未取得 Bot。相关默认网关登录要求早于本轮修改，
本次不改动生产鉴权来通过这些测试。上述专项和镜像发布检查均独立通过，不代表全量 CI 已通过。

DMG 使用 Developer ID 签名，未执行公证；IPA 为开发签名，未发布 App Store/TestFlight。
本次只推送 DoneBot；相邻仓库部署文档留在本地。生产节点与用户数据未变更。
