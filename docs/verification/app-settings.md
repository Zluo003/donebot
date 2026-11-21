# 对话内修改设置

使用隔离服务、合成模型和临时 home/data，不操作用户应用：

```sh
pnpm exec vitest run server/app-settings/host.test.ts server/app-settings-workflow.e2e.test.ts
pnpm exec vitest run server/drivers/agents-call.test.ts server/drivers/agents-catalog-wire.test.ts server/drivers/agents-bridge-wire.test.ts src/components/ApprovalCard.app-settings.test.ts
```

工作流通过既有 `launchVerificationServer` 和 `runControlOmb` 启动、发送并等待真实回合。fake engine 经实际 agents MCP 调用 `app_settings`；配置更新使用与设置界面相同的 `/api/config` 校验、保存和广播。日志与 HTTP/MCP 证据保存到测试输出指明的临时路径，退出时只关闭自身服务。

覆盖中文查找、显式工作区作用域、设备改名、账户/价格只能指路、凭据字段不可读、修改回执、重复撤销、手动编辑冲突、未知字段、伪造 Bot、无当前人类请求的回合拒绝，以及实际服务重启后的配置和回执保留。单元测试另覆盖团队/访客/自动化、排队取消、持久化前撤权、并发修改/撤销、每回合十次上限及写入失败。DOM 测试覆盖中英文回执、原会话撤销请求、冲突提示及成员无撤销入口。

当前白名单包括语言、设备名称、群聊回复超时、MCP 调用超时和每 Bot 并发会话。默认值与限制来自现有配置；超时和并发的界面位置是通用 → 更多设置 → 限额。查询不会暴露原始配置、账户凭据或模型密钥。写入仅允许本人发起且仍有效的个人会话，团队及托管共享工作区只读。配置真正提交前再次检查请求和旧值，避免等待期间的取消、撤权或手动编辑被覆盖。

撤销快照与固定上游一样保留在进程内；重启后保存值与回执仍在，旧回执的撤销返回 409 并提示从设置页修改，不猜测原值。窗口外观、Bot 专用设置、设置卡片与团队共享设置尚未纳入本切片。未验证打包 Electron、物理手机或真实 Linux 团队执行。
