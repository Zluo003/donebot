# 手机附件分段续传

手机预览、保存和分享共用同一下载入口。本机和 Cloud 的消息附件每次读取 1 MiB，以消息授权、Range、If-Range 和强 ETag 校验每一段，完整下载后再读取一个字节复查版本。文件变化时重新获取完整版本，不拼接新旧内容。图片、视频、音频和文档使用相同逻辑。

已完成分段按账号、工作空间、Bot、会话、消息和路径保存。iOS 使用 LibraryNoCloud 文件和最后提交的清单，网页使用 IndexedDB 原子事务。中断最多重传当前未提交的分段；重启 App 后再次打开附件会读取断点。完整缓存提交成功才清理断点；退出账号取消传输并清除该账号的数据。

传输有字节进展时没有总时长限制。单次请求连续 180 秒没有进展会取消该流并自动重试，连续失败最多重试五次，之后显示可手动续传的提示。健康的工作空间连接不会因单个文件超时被关闭。进入后台或离线后等待恢复前台和网络，不承诺 iOS 挂起期间持续运行。界面显示字节进度、等待恢复或正在重连状态。播放和打开仍在完整文件下载后进行，手机单文件上限仍为 100 MiB。

没有 Range 或强版本校验的旧服务、外部服务使用完整下载兼容路径，这种服务中断时可能需要从头重试。外部链接不携带 DoneBot 凭据。鉴权、消息范围、文件根目录和账号撤销规则沿用原机制；401、403、404、413、协议和身份验证错误不会作为普通网络错误重试。

## 隔离验证

在 `DoneBot-Mobile` 运行：

```sh
pnpm test
pnpm ios:build
```

测试覆盖四种 MIME 的分段与重连、本机/Cloud 控制器、前后台切换、重启后恢复、账号隔离与退出、文件替换、最后一段期间变更、完整断点重新鉴权、超时进展与有界重试、弱 ETag/旧服务/空文件兼容、错误区间拒绝、原生磁盘提交中断和存储不足。

2026-11-17 手机端 15 个测试文件共 131 项通过，TypeScript、修改文件的 oxlint 和 iOS 模拟器构建通过；原生构建日志为手机项目 `.build-resumable-ios.log`。

在桌面仓库运行：

```sh
pnpm exec vitest run server/message-file-range.e2e.test.ts server/message-file.test.ts server/donebot/mobile-host.test.ts scripts/testing/file-size-ratchet.test.ts scripts/testing/index-route-ratchet.test.ts
pnpm exec tsc -p tsconfig.server.json --pretty false
```

新增端到端测试通过 `launchVerificationServer` 启动独立资料目录，真实 Bot 交付四类附件，再检查 206、Content-Range、If-Range、后缀范围、416、未授权路径和相同大小文件替换。没有访问用户正在运行的应用或资料。

在网关仓库运行完整中继夹具：

```sh
DONEBOT_MOBILE_PG_FIXTURE=1 DONEBOT_MOBILE_DESKTOP_ROOT=/Users/zluo/Dev/DoneBot DONEBOT_MOBILE_RELAY_ROOT=/Users/zluo/Dev/DoneBot-Relay go -C backend test -tags integration ./internal/mobilehub -run '^TestPostgres(Desktop|Cloud)MobileWorkflow$' -count=1 -v -timeout 180s
```

2026-11-17 本机与 Cloud 两个流程通过：真实临时 PostgreSQL 中枢、独立中继、Noise/yamux 手机源码和隔离运行服务。在图片、视频、音频、PDF 各自超过 2 MiB 的传输中，第二段接收超过 128 KiB 时主动关闭加密连接，重新申请连接描述符并建立新连接。同一非零偏移请求两次，第一段没有重新传输；最终字节与源文件一致并记录 SHA-256。证据在 `.omb-scratch/verify-evidence/mobile-hub/evidence.json`、`mobile-cloud/evidence.json` 的 `downloads`，包含偏移、断线和重连记录。

原版 `companion/test/e2e/sidecar.test.ts` 的旧夹具引用已不存在的仓库内 `relay/src/main.ts`，8 项未能启动；本轮使用上述独立 `DoneBot-Relay` 完整流程验证实际中继。另行运行的 origin、interop、消息路由和鉴权相关 82 项通过。

需要同时更新手机 App 和文件来源的桌面/Cloud 运行服务；网关和独立中继没有代码修改。隔离通过不代表已部署线上 Cloud 或已安装到真实手机。
