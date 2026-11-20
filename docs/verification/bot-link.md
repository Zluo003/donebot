# 本机与个人 Cloud 协作

只在临时 home/data、合成账号和假引擎中验证，不连接真实 Cloud 或用户应用。

```sh
pnpm exec vitest run server/bot-link/link.test.ts server/bot-link/address.test.ts server/host/bot-link-host.test.ts server/room-routing-members.test.ts src/donebot/BotLink.dom.test.ts src/donebot/CloudAccess.dom.test.ts src/components/RoomFarMembers.dom.test.ts
pnpm exec vitest run server/bot-link.e2e.test.ts server/store.test.ts server/runtime/runtime.test.ts server/bot-moves.test.ts
node --test electron/donebot-bot-link.node-test.mjs
node --experimental-strip-types scripts/verify-bot-link.mjs
```

双端流程启动两套真实服务，单独配对所有者与 link 会话，运行两个位置的假引擎。检查相互委派、文件往返、结果确认与重放、取消、离线拒绝新工作、重连补传、备份不等待常驻同步，以及远端 Bot 不能在本地被修改、创建自动化或执行。运行位置保持固定，不搬移已有会话。

原生流程加载真实 Cloud 设置组件、preload 和主进程控制器。Cloud 授权提供方使用临时 HTTPS、合成 HttpOnly Cookie；本机连接状态写入临时真实运行服务。检查默认关闭、明确开启、关闭清理、账号变化及重载不恢复授权；页面中不能出现连接凭据。脚本输出保留的 receipt、截图目录和运行服务日志，退出后清理临时 home、钥匙和数据。

原生流程的账号快照和 HTTPS Cloud 发行方是合成的；它不验证真实 Cloud DNS、部署、在线计费、安装后的 DMG 或物理手机。双向拨号由上述两套真实 HTTP 服务测试证明，HTTPS 与 Cookie 行为由原生流程分别证明。团队执行不使用个人连接授权。

协议协商头为 `x-donebot-bot-link`，level 1/2 兼容固定上游帧格式。`x-omb-background`、`x-omb-cloud-power` 保留既有原版电源协议名称，避免后台配对唤醒休眠实例；它们不授予身份或执行权限。
