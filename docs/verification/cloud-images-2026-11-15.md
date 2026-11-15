# 2026-11-15 Cloud 在线镜像更新（x64）

新版运行服务与图形桌面镜像已发布到 GHCR，可由 Cloud 节点直接在线拉取，不需要上传离线包。本次使用固定 DoneBot 源码 `6c314340414e11006b62939a99c9967bc48f5b60`，包含 HTTP 响应中断防护、Cloud 页面内容缓存，以及此前的手机连接器、媒体/附件、群聊和自动化开关。图形桌面镜像从同一源码流程重新构建。节点退出自动恢复属于 Cloud agent/worker，须另行部署节点源码 `682308ad059f3d81d4334dd3b96586db7608930e` 或后续版本；更新镜像不能替代节点代码更新。

- [成功的发布任务](https://github.com/Zluo003/DoneBot-Cloud/actions/runs/43704284577)
- [可合入 agent.env 的镜像配置](cloud-images-2026-11-15-recovery-amd64.env)
- [发布清单与验证记录](cloud-images-2026-11-15-recovery-amd64.json)

## 统一部署入口

[当前推荐版本清单](https://github.com/Zluo003/DoneBot-Cloud/releases/download/cloud-images-amd64-current/registry-images.env) 是后续部署的固定入口，包含同一次成功验证发布的两个不可变摘要。下载清单后将两个值合入原有配置，不执行下载内容，也不覆盖完整 `agent.env`。当前清单已发布；后续自动刷新清单的 Cloud 工作流改动仍需由用户推送。

新发布不会自动升级已有实例。旧镜像仅供现有实例重建及受控回滚，确认各节点、停止实例和回滚保留期均不再引用后再清理；不能每次发布立即删除全部旧镜像。部署判断读取当前清单，不能按包列表或历史文件猜测最新版本。

## 固定镜像摘要

```dotenv
CLOUD_DONEBOT_IMAGE=ghcr.io/zluo003/donebot-cloud-service@sha256:da47aaaf3e6a67b9e0a00714fc166cc1e6d16b8815e14d8a1f49bc9f7e5eadca
CLOUD_DESKTOP_IMAGE=ghcr.io/zluo003/donebot-cloud-desktop@sha256:5d13bfa2c236850e9739d9a77a3ffe68482e6b3e0f047f623a413b7bbbda48c6
```

平台为 `linux/amd64`，不要用于 ARM64 节点，也不要改成可变 `latest`。这些是实际注册表摘要，可匿名拉取；不是之前离线包的本地 image ID。

## 确认实际运行版本

历史 `2026-11-14-amd64.env` 中的镜像不是本次目标。历史清单与节点配置相同，只能说明它们一致，不能证明节点已升级。以本页完整新摘要核对运行容器的 `Config.Image`，并核对实际镜像的 `org.opencontainers.image.revision`：

| 项目 | 旧版 | 本次新版 |
| --- | --- | --- |
| 运行镜像摘要开头 | `ad2a1b3a2461` | `da47aaaf3e6a6` |
| 同次桌面镜像摘要开头 | `90c798940628` | `5d13bfa2c236` |
| DoneBot 源码 | `75704dd` | `6c31434` |

实际容器仍为 `ad2a1b3a…` / `75704dd` 时尚未包含本次崩溃防护；更早的 `dcdf3074…` / `9455c9f` 还缺少手机连接器。以实际容器镜像为准，拉取镜像或修改配置均不能证明升级完成。

## 给节点 AI 的更新指令

```text
请按这份文档更新本节点的 DoneBot Cloud 运行服务和图形桌面镜像。先下载当前推荐清单，核对 x86_64 架构、当前部署、已有实例和实际旧镜像值；更新 Cloud 节点 agent/worker 至 682308ad059f3d81d4334dd3b96586db7608930e 或后续版本，在线拉取清单中的两个固定摘要。允许维护期间短暂停机，按原项目 maintenance.mjs 的受控流程升级，保留实例、数据盘、安装凭据、deployment ID 和密钥。不要重新开通套餐或手动强删容器。完成后核对镜像、原有数据以及 mobile/status 的 registered=true、relay=connected，报告结果但不输出密钥。本文发布完成不代表节点已更新。
```

## 在线升级已有节点

逐节点操作。先在管理后台暂停新分配并按现有流程完成数据及完整 agent 状态备份，记录 `/etc/donebot-cloud/agent.env` 中实际旧的两个镜像值。准备阶段可先拉取新镜像，不中断运行服务：

```sh
sudo docker pull ghcr.io/zluo003/donebot-cloud-service@sha256:da47aaaf3e6a67b9e0a00714fc166cc1e6d16b8815e14d8a1f49bc9f7e5eadca
sudo docker pull ghcr.io/zluo003/donebot-cloud-desktop@sha256:5d13bfa2c236850e9739d9a77a3ffe68482e6b3e0f047f623a413b7bbbda48c6
```

确认拉取完成并用 `docker image inspect` 核对两镜像的 `linux/amd64` 平台及源码 revision。随后在维护窗口使用旧配置依次停止 worker 和 agent：

```sh
sudo systemctl stop donebot-cloud-worker
sudo systemctl stop donebot-cloud-agent
```

服务名和工程目录按实际安装调整。必须确认 agent 的 ExecStopPost 成功，运行服务与图形桌面容器已停止；不要在停止旧服务前修改镜像环境值，以免旧容器规格检查失败。

此后才把本文两个 `CLOUD_*_IMAGE` 值合入原有 `agent.env`，保留其他配置。对后台列出的每个已有实例分别执行，替换实例 UUID 和刚记录的实际旧镜像值：

```sh
sudo /usr/bin/node --env-file=/etc/donebot-cloud/agent.env /opt/donebot-cloud/src/maintenance.mjs prepare-upgrade INSTANCE_UUID PREVIOUS_SERVICE_IMAGE
sudo /usr/bin/node --env-file=/etc/donebot-cloud/agent.env /opt/donebot-cloud/src/maintenance.mjs prepare-desktop-upgrade INSTANCE_UUID PREVIOUS_DESKTOP_IMAGE
```

用户本次确认的旧运行镜像为 `ghcr.io/zluo003/donebot-cloud-service@sha256:dcdf3074795048f8ed5cd55928d7bff77499e49041aaa2673de292ee0f6492ac`。同次历史发布的桌面镜像为 `ghcr.io/zluo003/donebot-cloud-desktop@sha256:13ffc989e7c2b9f46fb0be91107126238630dfe81287149fdada33b2c5fc5e5e`，仍需以节点实际配置为准。

维护命令只移除通过归属和完整规格核对的已停止容器，保留卷、磁盘、网络和凭据，不主动启动实例。失败时保持停机并检查错误，不以 `docker rm -f` 绕过校验。

准备成功后恢复 agent 和 worker，由主控有效租约恢复运行服务；图形桌面在下次使用时按需创建：

```sh
sudo systemctl start donebot-cloud-agent
sudo systemctl start donebot-cloud-worker
```

按 `deployment-id`、实例 UUID 和 `cn.donebot.cloud.*` 标签确认对应的运行容器，核对实际镜像为新摘要。在该明确归属的容器内读取状态，`SERVICE_CONTAINER_NAME` 替换为确认后的完整名称：

```sh
sudo docker exec SERVICE_CONTAINER_NAME curl --fail --silent --show-error http://127.0.0.1:18899/api/health
sudo docker exec SERVICE_CONTAINER_NAME curl --fail --silent --show-error http://127.0.0.1:18899/api/donebot/mobile/status
```

应返回健康状态，并看到 `authenticated=true`、`registered=true`、`relay=connected`。在手机刷新 Cloud，读取原有 Bot 和消息，并验证桌面查看后再恢复新分配。仅修改配置或重启旧容器不会更新已有容器的镜像。

Cloud 需访问网关及下发中继节点的公网 HTTPS/WSS 443；若中继或网关与 Cloud 节点同机，按 Cloud 部署文档配置显式公网 HTTPS 例外。无需向手机开放 18080。状态接口 404 表示尚未运行新镜像；未认证检查安装凭据；`problem=unavailable` 检查手机中枢配置；`relay=connecting` 检查 WSS、DNS、TLS 和出网。

## 验证边界

发布前在一次性 Ubuntu amd64 runner（Docker 28.0.4、Node 24.18.0、nftables 1.0.9）通过真实双租户运行隔离、受控出网及图形桌面验证，全部通过后才推送 GHCR。本轮另通过 HTTP 中断、Cookie 续连和缓存相关 28 项 Vitest、45 项 Electron Node 测试、真实 Electron Cookie fixture、类型检查、构建及隔离打包服务 smoke；Cloud 节点 37 项测试通过。公开注册表清单与镜像配置的摘要、平台、源码标签已匿名核对。

本记录不代表生产节点已部署或手机线上连接已恢复。升级需短暂停机；数据 schema 的回滚须结合升级前备份，不能仅切回旧镜像保证恢复。
