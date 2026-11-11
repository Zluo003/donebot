import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { authChallengeConfiguration, authChallengeHTML, authChallengeProof, createDoneBotAuthChallenge, installDoneBotAuth } from "./donebot-auth.mjs";

test("validates the configured vendor and projects only its bounded verification fields", () => {
  assert.deepEqual(authChallengeConfiguration({}), { provider: "none" });
  assert.throws(() => authChallengeConfiguration({ turnstile_enabled: true }), /尚未配置/);
  assert.throws(() => authChallengeConfiguration({ turnstile_enabled: true, tencent_captcha_enabled: true }), /配置冲突/);
  const tencent = authChallengeConfiguration({ tencent_captcha_enabled: true, tencent_captcha_app_id: "fixture", tencent_captcha_region: "intl" });
  assert.equal(tencent.region, "intl");
  assert.deepEqual(authChallengeProof(tencent, { tencent_captcha_ticket: "ticket", tencent_captcha_randstr: "random", access_token: "must-not-cross" }), { tencent_captcha_ticket: "ticket", tencent_captcha_randstr: "random" });
  assert.equal(authChallengeProof(tencent, { tencent_captcha_ticket: "trerror_failure", tencent_captcha_randstr: "random" }), null);
  assert.equal(authChallengeProof({ provider: "turnstile" }, { turnstile_token: "x".repeat(8193) }), null);
  assert.ok(!authChallengeHTML({ provider: "turnstile", siteKey: "</script><script>unsafe" }).includes("</script><script>unsafe"));
});

function fixture() {
  const windows = [], sessions = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: handler => { this.popup = handler; }, executeJavaScript: async () => this.result ?? {} });
      windows.push(this);
    }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    close() { this.destroyed = true; this.emit("closed"); }
    static fromWebContents(contents) { return windows.find(window => window.webContents === contents); }
  }
  const session = { fromPartition(name) {
    const partition = Object.assign(new EventEmitter(), {
      name, protocol: { handle: async (_scheme, handler) => { partition.handler = handler; }, unhandle: () => { partition.unhandled = true; } },
      setPermissionCheckHandler: handler => { partition.permissionCheck = handler; }, setPermissionRequestHandler: handler => { partition.permissionRequest = handler; },
      webRequest: { onBeforeRequest: handler => { partition.before = handler; } }, fetch: async () => new Response("vendor"),
      clearStorageData: async () => { partition.cleared = true; }, clearCache: async () => {},
    }); sessions.push(partition); return partition;
  } };
  return { BrowserWindow, session, windows, sessions };
}

test("runs captcha in a disposable sandbox, denies unrelated requests, and cleans up on cancel", async () => {
  const f = fixture(), owner = new f.BrowserWindow({}), challenge = createDoneBotAuthChallenge(f);
  const pending = challenge.verify({ provider: "turnstile", siteKey: "fixture" }, owner);
  await new Promise(resolve => setImmediate(resolve));
  const window = f.windows[1], partition = f.sessions[0];
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.preload, undefined);
  assert.equal(window.popup().action, "deny"); assert.equal(partition.permissionCheck(), false);
  let blocked;
  partition.before({ url: "https://evil.example.test/" }, value => { blocked = value.cancel; }); assert.equal(blocked, true);
  partition.before({ url: "https://challenges.cloudflare.com/turnstile/v0/api.js" }, value => { blocked = value.cancel; }); assert.equal(blocked, false);
  assert.equal((await partition.handler({ url: "https://donebot.cn/api/v1/auth/me" })).status, 403);
  const page = await partition.handler({ url: window.url }); assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
  owner.close(); assert.equal(await pending, null); assert.equal(window.isDestroyed(), true); assert.equal(partition.unhandled, true); assert.equal(partition.cleared, true);
});

test("accepts only vendor proof and closes the temporary window after verification", async () => {
  const f = fixture(), owner = new f.BrowserWindow({}), challenge = createDoneBotAuthChallenge(f);
  const pending = challenge.verify({ provider: "turnstile", siteKey: "fixture" }, owner);
  await new Promise(resolve => setImmediate(resolve));
  f.windows[1].result = { proof: { turnstile_token: "fixture-proof", refresh_token: "must-not-cross" } };
  assert.deepEqual(await pending, { turnstile_token: "fixture-proof" });
  assert.equal(f.windows[1].isDestroyed(), true);
});

test("uses the fixed gateway and validates the main-window caller before and after settings fetch", async () => {
  const f = fixture(), handlers = new Map(); let checks = 0, request;
  installDoneBotAuth({ ...f, app: new EventEmitter(), ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, localOnly: (_name, fn) => fn,
    requireMainWindowSender: () => { checks++; }, fetch: async (url, options) => { request = { url, options }; return Response.json({ code: 0, data: {} }); } });
  const result = await handlers.get("donebot-auth:verify")({ sender: {} }, { origin: "https://evil.example.test" });
  assert.deepEqual(result, { ok: true, proof: {} }); assert.equal(checks, 2);
  assert.equal(request.url, "https://donebot.cn/api/v1/settings/public"); assert.equal(request.options.credentials, "omit"); assert.equal(request.options.redirect, "error");
});
