import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installDoneBotBotLink } from "../electron/donebot-bot-link.mjs";

const id = "11861a47-7240-4f99-bf19-bd01d411596f";
const snapshot = account => ({ account_id: account, email: "fixture@example.invalid", balance_cents: "10000", connection_available: true,
  plan: { enabled: true, monthly_price: "100", retention_days: 7 }, operations: [],
  instance: { id, actual: "running", desired: "running", subscription_state: "active", paid_until: "2099-01-01", auto_renew: true } });

if (!process.versions.electron) {
  const { launchVerificationServer } = await import("./control-omb.ts");
  const { mountPreview } = await import("./testing/preview-fixture.ts");
  const fixture = await launchVerificationServer({});
  let preview;
  const output = mkdtempSync(join(tmpdir(), "donebot-bot-link-native-"));
  try {
    preview = await mountPreview(fixture, { entry: "/scripts/testing/bot-link-preview.tsx", route: "/__bot-link.html", title: "Personal Cloud collaboration fixture", logLevel: "error",
      extraRoutes: [{ path: "/api/donebot/cloud", method: "GET", handler: (_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(snapshot("101"))); } }] });
    mkdirSync(join(output, "home"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(output, "key.pem"), "-out", join(output, "cert.pem"), "-days", "1", "-subj", "/CN=cloud.localhost"], { stdio: "ignore" });
    const env = { ...process.env, HOME: join(output, "home"), USERPROFILE: join(output, "home"), DONEBOT_LINK_FIXTURE_URL: fixture.info.url, DONEBOT_LINK_PREVIEW: preview.previewUrl };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(import.meta.url), output], { env, stdio: "inherit" });
    const timer = setTimeout(() => child.kill(), 60_000);
    const code = await new Promise(resolve => { child.once("error", () => resolve(1)); child.once("exit", resolve); });
    clearTimeout(timer);
    console.log(JSON.stringify({ output, logPath: fixture.info.logPath, code }));
    assert.equal(code, 0);
    assert.equal(JSON.parse(readFileSync(join(output, "receipt.json"))).passed, true);
  } finally {
    await preview?.close(); await fixture.close();
    for (const name of ["home", "profile", "key.pem", "cert.pem"]) rmSync(join(output, name), { recursive: true, force: true });
  }
} else {
  const { app, session, BrowserWindow, ipcMain } = await import("electron");
  const output = process.argv[2], localUrl = process.env.DONEBOT_LINK_FIXTURE_URL, page = process.env.DONEBOT_LINK_PREVIEW;
  const localOrigin = new URL(page).origin;
  app.setPath("userData", join(output, "profile")); app.setPath("sessionData", join(output, "profile"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("ignore-certificate-errors");
  app.commandLine.appendSwitch("host-resolver-rules", "MAP *.cloud.localhost 127.0.0.1");
  app.on("window-all-closed", () => {});
  let owner = "101", preference = null, controller, win, origin, pairings = 0, revoked = 0;
  const calls = [], checks = [];
  const server = createServer({ key: readFileSync(join(output, "key.pem")), cert: readFileSync(join(output, "cert.pem")) }, (req, res) => {
    assert.equal(req.headers.origin, origin);
    assert.match(req.headers.cookie ?? "", /__Host-dbc_session=synthetic-link-session/);
    assert.equal(req.headers["x-omb-background"], "1");
    if (req.method === "DELETE") { revoked++; return res.end('{"ok":true}'); }
    assert.equal(req.method, "POST"); assert.equal(req.url, "/api/bot-link/pair");
    let body = ""; req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const value = JSON.parse(body); assert.equal(typeof value.computer.id, "string"); pairings++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ token: "synthetic-link-grant-never-render", place: { id: "cloud-1", name: "DoneBot Cloud" } }));
    });
  });
  const request = async (path, init = {}) => {
    calls.push({ path, method: init.method ?? "GET" });
    if (path === "/api/donebot/state") return Response.json({ authenticated: !!owner, user: { id: owner } });
    if (path === "/api/donebot/cloud") return Response.json(snapshot(owner));
    return fetch(localUrl + path, { ...init, headers: { ...init.headers, origin: localUrl } });
  };
  const until = async check => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error("Timed out waiting for personal collaboration UI");
  };
  void app.whenReady().then(async () => {
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `https://${id}.cloud.localhost:${server.address().port}`;
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: ![localOrigin, origin].some(base => details.url.startsWith(base + "/")) && !details.url.startsWith("data:") && details.url !== "about:blank" }));
    await session.defaultSession.cookies.set({ url: origin, name: "__Host-dbc_session", value: "synthetic-link-session", secure: true, httpOnly: true, path: "/", sameSite: "strict" });
    for (const channel of ["home:page", "update:offered", "home:updating", "desktop-analytics:read"]) ipcMain.on(channel, event => { event.returnValue = false; });
    ipcMain.on("desktop-language:read", event => { event.returnValue = "zh-CN"; });
    ipcMain.handle("desktop-analytics:set", () => {});
    ipcMain.handle("desktop:skin", () => {});
    win = new BrowserWindow({ show: false, width: 960, height: 820, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      preload: fileURLToPath(new URL("../electron/preload.cjs", import.meta.url)), additionalArguments: [`--omb-local-origin=${localOrigin}`] } });
    const guardLocal = (_name, handler) => (event, ...args) => {
      assert.equal(event.sender, win.webContents); assert.equal(event.senderFrame, win.webContents.mainFrame); assert.equal(new URL(event.senderFrame.url).origin, localOrigin);
      return handler(event, ...args);
    };
    controller = installDoneBotBotLink({ ipcMain, guardLocal, request, fetch: (...args) => session.defaultSession.fetch(...args),
      saved: () => ({ environments: [{ origin, donebotCloud: { id, accountId: "101" } }] }), pref: { read: () => preference, write: value => { preference = value; } }, renew: async () => { throw new Error("Unexpected session renewal"); }, watchMs: 2 ** 30 });
    const js = code => win.webContents.executeJavaScript(code, true);
    const checked = value => js(`document.querySelector('[role=switch]')?.getAttribute('aria-checked') === '${value}' && !document.querySelector('[role=switch]').disabled`);
    await win.loadURL(page);
    await until(() => checked(true));
    assert.equal(pairings, 1); assert.equal((await (await request("/api/bot-link")).json()).on, true);
    assert.equal(await js("document.body.innerText.includes('synthetic-link-grant')"), false);
    assert.equal(await js("typeof process"), "undefined");
    checks.push("real Cloud panel, preload and main auto-enable personal collaboration without exposing grant");
    writeFileSync(join(output, "collaboration-enabled.png"), (await win.webContents.capturePage()).toPNG());
    await js("document.querySelector('[role=switch]').click()");
    await until(() => checked(false));
    assert.equal((await (await request("/api/bot-link")).json()).on, false);
    assert.equal(preference.enabled, false);
    await win.loadURL(page); await until(() => checked(false));
    checks.push("explicit off switch stops disposable runtime and persists across reload");
    await js("document.querySelector('[role=switch]').click()"); await until(() => checked(true));
    owner = "202";
    assert.equal((await controller.state()).enabled, false);
    assert.equal((await (await request("/api/bot-link")).json()).on, false);
    checks.push("account change revokes standing runtime immediately");
    writeFileSync(join(output, "receipt.json"), JSON.stringify({ passed: true, checks, pairings, revoked, calls,
      limitations: "Production Cloud settings panel, preload and native controller; disposable real local runtime; synthetic account snapshot and TLS Cloud issuer. Runtime two-way dialing/replay is separately verified by server/bot-link.e2e.test.ts. No live account, installed app, DNS changes, or production Cloud." }, null, 2));
    console.log("Personal collaboration native workflow passed");
    controller.close(); win.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); app.exit(0);
  } catch (cause) {
    console.error(cause); if (win && !win.isDestroyed()) writeFileSync(join(output, "failure.txt"), await win.webContents.executeJavaScript("document.body.innerText"));
    controller?.close(); win?.destroy(); server.closeAllConnections(); server.close(); app.exit(1);
  }
  }).catch(cause => { console.error(cause); app.exit(1); });
}
