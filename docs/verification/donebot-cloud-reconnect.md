# DoneBot Cloud 续连、缓存与响应中断

自有 Cloud 通过本机已登录 DoneBot 账号取得一次性连接码。Electron 先检查已保存实例的现有 Cookie；有效时直接切换，过期时从本机 Cloud 适配取得新码，在同一 Electron Cookie 容器兑换后打开。该流程不再进入通用服务器配对确认框，不调用退出、凭据轮换或手机撤销接口。其他自有服务器的配对确认沿用原版。

本机请求在导航前复查账号；实例地址必须与网关返回的 HTTPS 地址及已保存 origin 一致。并发打开合并为一次授权请求，已被新选择取代的请求不再导航。桌面连接码请求至少保留 90 秒 JWT 有效期，避开主控拒绝不足 60 秒 JWT 的边界。主控的 Cookie 期限和账号/订阅验证规则保持原样。

用户停留在 Cloud 时，桌面主进程每 15 秒读取该实例 Cookie 的到期时间，剩余不超过 2 分钟时通过本机账号提前续期，只更新 Cookie，不导航、不刷新聊天页面、不重发消息。续期失败在下个周期重试；切回本地后停止续期，退出应用时取消定时器。现有主控单次浏览器登录会话最长 1 小时，并受网关 JWT 到期时间约束；客户端持续续期避免把这个登录期限变为使用时限，账号被撤销、实例停机和网络中断仍按实际结果处理。

会话结束页的“返回本地对话”调用桌面原有工作空间切换，不访问远端控制台；等待重连时仍可点击。已保存的 Cloud 再次选择时会自动恢复会话，探测请求被跳转或网络错误中断也会尝试通过本机账号重新连接；保存项及对话数据保留，不要求重新“添加 Cloud”。

Cloud 页面成功验证会话后，才读取该 origin 和身份下的 sessionStorage 缓存。缓存保留 Bot、部门、群聊、所选会话和每会话最近 80 条消息，最长 24 小时、最多约 2 MiB 字符；网络快照随后替换缓存。连接状态从断开开始，不恢复待发动作或重放消息。拒绝授权及退出会清除缓存。缓存不代表实例实际在线，也不能缩短冷启动容器的时间。

原版 HTTP 请求处理器的最外层错误出口增加已获用户授权的最小防护：响应已发送、完成或连接销毁时，关闭未完成响应，不再尝试输出第二份 JSON。日志仅保留方法、脱敏路径及固定格式错误码。生产崩溃日志未包含请求路径，不能据此断言某个接口是原始触发点。

## 隔离检查

```sh
node --test electron/donebot-cloud.node-test.mjs electron/donebot-cloud-keepalive.node-test.mjs electron/environments.node-test.mjs electron/workspace-navigation.node-test.mjs
node scripts/verify-donebot-cloud.mjs
pnpm exec vitest run server/donebot/http-failure.test.ts server/donebot-http-failure.e2e.test.ts server/donebot/cloud.test.ts src/donebot/CloudAccess.dom.test.ts src/donebot/CloudSession.dom.test.ts src/donebot/workspace-cache.test.ts --maxWorkers=1
pnpm typecheck
pnpm check:electron
pnpm test:packaged-server
```

Electron fixture 使用临时 HOME、独立 profile、回环 HTTPS 合成 Cloud 和真实 Chromium Cookie 容器；外部请求被阻止。覆盖首次连接、有效 Cookie 复用、会话过期自动续连及账号不匹配拒绝，证据目录由脚本打印。回环耗时不能作为公网延迟承诺。

持续续期专项：48 项 Electron Node 测试及结束页 DOM 检查通过；真实 Electron fixture 通过 preload 的本地返回按钮切换，再打开同一个保存项，并将真实 Cookie 改为 60 秒后到期，验证提前续期且页面保持原地址。证据位于临时目录 `donebot-cloud-reconnect-qogwip/receipt.json`。该加速到期检查不等同于多小时公网稳定性测试。

2026-11-15 本地结果：上述 5 文件 Vitest 共 28 项、3 文件 Electron Node 测试共 45 项通过，真实 Electron Cookie fixture、类型检查、437 模块 Electron 语法检查、修改文件 oxlint、前端/服务端构建及隔离打包服务 smoke 均通过。下载中断证据位于忽略目录 `.omb-scratch/verify-evidence/donebot-http-failure/result.json`；本次 Electron 证据目录为临时目录 `donebot-cloud-reconnect-L1kI7k`。相邻 Cloud 的 37 项测试及网关 `TestBrowser`、临时 PostgreSQL 会话专项也通过。

缓存 DOM 检查让新网络读取全部保持待定，验证真实 StoreProvider 立即显示缓存且没有自动发送写请求。HTTP E2E 使用既有隔离 launcher、合成网关和独立资料目录，下载合成媒体后主动断开，再检查真实服务健康及 Bot 列表；它检验一条可重现的中断路径，不识别生产崩溃的原始请求。

## 发布组件

- 桌面客户端：自动续连、已保存 Cloud 入口及内容缓存需要新版客户端。
- Cloud 运行服务镜像：使用 `cloud-service` API 专用目标，包含 HTTP 响应中断防护、Muse 最长 10 秒能力与附件上下文整理；桌面使用安装包内的前端，不再等待云端 HTML／JS；发布新摘要后按 Cloud 节点文档保留数据升级实际容器。
- DoneBot-Cloud 节点：更新 agent/worker，才能检查容器实际状态并恢复意外退出的运行服务；仅更新容器镜像不包含节点恢复逻辑。
- donebot-api：静态资源缓存优化需更新网关。仅成功 GET 的带版本 hash JS/CSS/woff2 允许浏览器私有缓存；HTML、API、附件、错误及带查询参数的响应仍为 no-store。前置代理不启用共享缓存。

手机和桌面可以同时连接同一 Cloud；桌面续连不注销手机。上述变更不要求更新手机 App 或独立手机中继。当前 `c7b31ef` 的 amd64 双镜像已发布，摘要与 Linux 证据见[发布记录](cloud-images-2026-11-15.md)。发布不等于生产节点已升级或实际实例已恢复。

## Cloud 切换加载页与工作空间入口

自有 Cloud 连接开始即覆盖显示独立加载页，依次提示登录校验、安全连接及聊天内容加载；页面完成导航后，仍等待 React 根节点产生内容再撤下。等待超过 8 秒显示耗时提示，用户随时可以返回本地对话。实际连接失败显示重试按钮；新选择、返回本地及退出会清理旧加载页，旧请求不能再次导航。提前续期 Cookie 不显示加载页。Windows 加载页保留窗口控制按钮。

Cloud 连接期间及 Cloud 为当前工作位置时，原生工作空间竖栏与其显示按钮不可用，聊天页面恢复全部宽度。顶部原有本地／Cloud 下拉菜单继续用于切换。本机新建 workspace 的菜单、竖栏及设置入口关闭；`workspaces:local-new` 和旧 `environments:create` IPC 也拒绝创建。已有 workspace 的保存项及访问能力保留。

`node scripts/verify-donebot-cloud.mjs` 使用真实 Electron、独立 profile、临时 HOME 与回环合成服务，覆盖授权等待动画、页面空根节点等待、竖栏消失及完整宽度、原生返回按钮取消、失败后原生重试按钮、两条创建 IPC 拒绝，以及原有 Cookie 续连。2026-11-15 证据：临时目录 `donebot-cloud-reconnect-1wNeVc/receipt.json`，含加载和失败页面截图。60 项 Node 检查、20 项 DOM／大小限制检查、类型及 Electron 语法检查通过。该检查不连接生产 Cloud，不测公网耗时或 Windows 物理按钮交互。

本次加载页和工作空间入口变更由桌面 Electron 控制，不要求重新发布 Cloud 镜像。Bot 表情仍以原有字符串名称传递；手机端已同步桌面的表情校验与名称映射，需要重新构建安装手机 App。Cloud 服务接口、网关与中继协议未变，不因这项手机兼容修复重建已有实例。


## 本地前端连接 Cloud（2026-11-16）

Electron 使用安装包内 `ui/` 的 HTML、脚本、样式和字体，通过原 Cloud HTTPS origin 打开。
API、SSE、WebSocket、附件上传及 Range 下载继续使用远端实例及其原有 Cookie，
不把云实例接口代理到本地 Bot。仅已保存并验证的自有 Cloud origin 可用这层前端映射，
未知本地资源返回 404，API 请求通过原生网络发送。Cloud 镜像 `cloud-service` 不包含 `dist/`；
通用自托管 `server` 目标仍提供网页。先安装新版桌面客户端，再升级 API 专用 Cloud 镜像；
旧客户端依赖云端页面，无法打开 API 专用镜像。手机原本使用 API，无此依赖。

加载页采用黑白 `d.` 标记、电脑与云端连线动画；返回本地、取消、重试和隐藏工作空间栏保留。
`node scripts/verify-donebot-cloud.mjs` 在真实 Electron 隔离 profile 中验证安装包前端与 API
专用 Cloud 的组合：本地资源命中、API／SSE／WebSocket、Range 下载、上传、缓存、Cookie
复用及过期续连、本地返回、等待页取消与失败重试均通过。回执目录：临时目录
`donebot-cloud-reconnect-fgSQfN/receipt.json`，不代表公网延迟或长期在线测试。

完整 Electron 检查中，Cloud 入口 mock、preload 接口列表和已禁用创建工作空间的断言已同步。
图片处理和上下文预算的隔离验证见[附件上下文](donebot-image-context.md)。
