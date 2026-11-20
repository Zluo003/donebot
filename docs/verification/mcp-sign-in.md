# MCP sign-in from another computer

Run the focused unit tests and API tests:

```sh
pnpm exec vitest run server/mcp-oauth.test.ts server/mcp-oauth-discovery.test.ts server/mcp-oauth-store.test.ts server/mcp-probe.test.ts src/lib/mcp-sign-in.test.ts src/components/McpServersPanel.test.ts
pnpm exec vitest run server/index.test.ts -t 'MCP OAuth|OAuth URL MCP'
```

Run the real MCP settings panel against a disposable fake-engine workspace:

```sh
node --experimental-strip-types scripts/verify-mcp-sign-in.ts
```

The fixture uses `launchVerificationServer` and the existing isolated Vite
preview. It runs Doctor against that exact server, creates one synthetic MCP
server, and pairs an admin browser. It never contacts the user's running app,
reads their OAuth credentials, or signs into a real provider.

The browser tools follow the existing `control-omb ui` setup: set
`DONEBOT_AGENT_BROWSER_PATH` and `AGENT_BROWSER_EXECUTABLE_PATH` to reuse installed
binaries, or let the fixture install the pinned tools. Set
`DONEBOT_UI_EVIDENCE_DIR` to choose the screenshots directory (default:
`.omb-scratch/mcp-oauth-evidence`).

The fixture verifies:

- A proxied admin session can start a flow.
- A blocked popup still leaves the reopen button and paste-back instructions.
- An invalid URL shows an error without consuming the pending flow.
- A delayed token exchange keeps the submit button disabled and spinning,
  preserves the pasted URL, and shows the result after the provider responds.
- Cancelling during that exchange immediately enables a new sign-in, whose
  paste form stays usable before the cancelled request settles.
- Pasting the fake provider's redirect completes the real PKCE exchange.
- The signed-in MCP server returns tools on Test.
- Logging out cancels the next pending flow and closes its listener.

The synthetic OAuth provider speaks loopback HTTP. A fixture-only route
substitutes an HTTPS approval link in the start response so the renderer's
HTTPS-only link check remains intact. Browser popups are deliberately blocked;
the fixture obtains the fake provider's redirect without following it and
pastes it through the real UI. This proves the headless completion flow, not
compatibility with a particular live OAuth provider.

Unit/API tests additionally cover owner isolation, replay, duplicate parameters,
wrong origins/ports/paths/states/issuers, expiry, cancellation during registration
or code exchange, and the existing automatic loopback callback.

## 0.1.173 登录与刷新回归

批次证据见 `docs/upgrades/0.1.173/batch-6.md`。新增刷新竞争测试为
`server/mcp-oauth-refresh-races.test.ts`，验证旧请求不覆盖重新登录、
退出后不复活、发送标记跨重启保留、网络未连接可重试、成功但无有效令牌
不重放，以及非轮换服务器的后续刷新。命令环境和分页保留名测试位于
`server/mcp-environment.test.ts`、`server/mcp-gate.test.ts` 和
`server/mcp-tool-schema.test.ts`。设置面板 fixture 为浏览器代理创建并清理
短 socket 临时目录，不使用用户浏览器或用户凭据。

`server/mcp-ownership.e2e.test.ts` 用两个合成 Bot 和同一 loopback OAuth 服务，
验证并发登录、每 Bot 挂载、其它 Bot 管理操作的拒绝及删除后的令牌清理。
公开新增 MCP 保持共享默认，专用归属由管理员的已有编辑接口设置。
