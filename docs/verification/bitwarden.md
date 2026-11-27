# Bitwarden 隔离验证

只使用临时 home/data、合成账号及独立 fake `bw` 子进程。不得连接真实用户密码库或在真实应用内测试连接、断开。

## 自动回归

```sh
pnpm exec vitest run server/host/bitwarden-cli.test.ts server/host/bitwarden-vault.test.ts server/bot-logins.test.ts server/bot-logins-bitwarden.test.ts server/routes/logins.test.ts server/routes/vault.test.ts server/vault-store.test.ts server/system-prompt.test.ts src/components/SettingsPrimitives.test.ts src/components/VaultSettings.test.ts src/components/settings/SettingsDialog.test.ts server/workspace-backup.test.ts scripts/testing/no-bitwarden-dependency.test.ts server/bitwarden-workflow.e2e.test.ts
pnpm exec vitest run server/vault/mcp-keys.test.ts server/workspace-backup-policy.test.ts server/browser/chrome/install.test.ts
pnpm exec tsc -b
pnpm exec tsc -p tsconfig.server.json
node scripts/generate-locale.mjs --check
```

覆盖固定下载大小/摘要、进程环境隔离、错误信息脱敏、名称歧义、各类字段、会话过期、连接替换、取消和撤权竞态。真实加密存储和 MCP 缓存流程验证重启后的引用及重连后的失效。磁盘保存失败不能留下候选账号的元数据或解锁会话。

`server/bitwarden-workflow.e2e.test.ts` 启动真实临时服务，安装独立 fake CLI，通过真实路由和注入的 `request_credential` 工具完成连接、引用、重启、断开。公共响应、服务日志和引擎转录不得包含合成凭据 canary。测试写出 `*.bitwarden.json` 证据，并在结束时清理临时数据和子进程。

2026-11-21：主回归 14 文件 / 201 项通过，1 项因大小写不敏感文件系统跳过；相邻回归 3 文件 / 53 项通过。类型、定向 lint 和 16 个语言目录校验通过。日志为 `/tmp/donebot-bitwarden-regression-final.log`、`/tmp/donebot-bitwarden-adjacent-final.log` 和 `/tmp/donebot-bitwarden-{client-types,server-types,lint,i18n}-final.log`。

## 实际界面

```sh
node --experimental-strip-types scripts/verify-bitwarden.ts
```

使用输出的 `previewUrl`，仅此隔离页面可用合成账号 `user.fixture`、合成 API key `fake-client-key` 和合成主密码 `fake-master`。Ctrl-C 清理服务和临时数据。界面挂载真实 VaultSettings，API 使用上述临时服务，账户工具仍为 fake 进程。

2026-11-21，独立 Chromium 会话完成：

- 错误主密码显示固定提示；提交即清空三个凭据字段，响应失败后仍为空；成功连接仅列只读名称和站点。
- 刷新及断开；断开后列表清空。拦住 POST，先让 DELETE 到达真实服务，再释放 POST；待界面恢复可用后，服务返回 connected=false，登录和密钥数量均为 0。
- Tab 在对话框内，Escape 关闭对话框并回到打开按钮；嵌套窗口的键盘边界另有 DOM 回归。
- 390 × 844 的浅色和深色界面宽度均为 390，无横向溢出。截图位于 `output/playwright/bitwarden/`，已人工检查；无产品控制台错误，早期错误仅为 favicon 404 和预期的错误密码 400。

本次命名浏览器及临时 fixture 已关闭。真实 Bitwarden 联网账号、Windows CLI、团队连接和打包 Electron 尚未验收；不能将 fake 成功视为这些环境已经通过。
