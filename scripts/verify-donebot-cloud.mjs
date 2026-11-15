import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { installDoneBotCloud } from "../electron/donebot-cloud.mjs";
import { installDoneBotCloudFrontend } from "../electron/donebot-cloud-frontend.mjs";
import { createDoneBotCloudKeepalive } from "../electron/donebot-cloud-keepalive.mjs";
import { createChromeRail } from "../electron/chrome-rail.mjs";
import { createLocalProfiles } from "../electron/local-profiles.mjs";
import { installCloudRail } from "../electron/cloud-rail.mjs";
import environments from "../electron/environments.cjs";

if (!process.versions.electron) {
  const { launchVerificationServer } = await import("./control-omb.ts");
  const fixture = await launchVerificationServer();
  const configured = await fetch(fixture.info.url + "/api/config", { method: "PATCH", headers: { "content-type": "application/json", origin: fixture.info.url }, body: JSON.stringify({ onboarding: { completedAt: new Date().toISOString(), version: 1, reelSeen: true } }) });
  assert.equal(configured.ok, true);
  const output = mkdtempSync(join(tmpdir(), "donebot-cloud-reconnect-")), home = join(output, "home");
  mkdirSync(home);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(output, "key.pem"), "-out", join(output, "cert.pem"), "-days", "1", "-subj", "/CN=cloud.localhost"], { stdio: "ignore" });
  const env = { ...process.env, HOME: home, USERPROFILE: home, DONEBOT_FRONTEND_FIXTURE: fixture.info.url };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(import.meta.url), output], { env, stdio: "inherit" });
  const watchdog = setTimeout(() => child.kill(), 45_000);
  const code = await new Promise(resolve => { child.once("error", () => resolve(1)); child.once("exit", resolve); });
  clearTimeout(watchdog);
  await fixture.close();
  console.log(`Cloud connection evidence: ${output}`);
  assert.equal(code, 0);
  assert.equal(JSON.parse(readFileSync(join(output, "receipt.json"))).passed, true);
  for (const name of ["home", "profile", "key.pem", "cert.pem"]) rmSync(join(output, name), { recursive: true, force: true });
} else {
  const { app, session, BrowserWindow, WebContentsView, ipcMain } = await import("electron");
  const output = process.argv[2];
  app.setPath("userData", join(output, "profile"));
  app.setPath("sessionData", join(output, "profile"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("ignore-certificate-errors");
  app.commandLine.appendSwitch("host-resolver-rules", "MAP *.cloud.localhost 127.0.0.1");
  app.on("window-all-closed", () => {});
  for (const channel of ["home:page", "update:offered"]) ipcMain.on(channel, event => { event.returnValue = false; });
  for (const channel of ["desktop-language:read", "desktop-analytics:read"]) ipcMain.on(channel, event => { event.returnValue = null; });
  ipcMain.handle("desktop:skin", () => {});
  ipcMain.handle("desktop:capabilities", () => ({
    host: { platform: process.platform, packaged: true, label: "Fixture", session: "unknown" },
    windowChrome: "native", screenPreview: { available: false, interaction: "none" },
    dictation: { available: false, engine: "none", onDevice: false, reasonCode: "remote-server" },
    localComputer: { available: false, support: "unsupported", enabled: false, status: "unavailable", reasonCode: "remote-server" },
  }));
  const id = "11861a47-7240-4f99-bf19-bd01d411596f";
  let valid = true, launches = 0, pairings = 0, requests = 0, owner = "101", code = "", win, localOrigin, phase = "startup";
  let state = { activeId: "local", environments: [] }, origin, holdAuth = null, failAuth = false, waitForPaint = false, rail;
  let apiOnly = false, realApi = false, staticRequests = 0;
  const builtUI = resolve("dist");
  const loadingViews = [], checks = [];
  const until = async check => {
    for (let n = 0; n < 200; n++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error("Timed out waiting for fixture condition");
  };
  const localHttp = createHttpServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end("<!doctype html><h1>Local conversations</h1>"); });
  const server = createServer({ key: readFileSync(join(output, "key.pem")), cert: readFileSync(join(output, "cert.pem")) }, (req, res) => {
    requests++;
    res.setHeader("x-donebot-cloud", "1"); res.setHeader("cache-control", "no-store");
    if (req.url === "/api/auth/pair") {
      let body = ""; req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        if (JSON.parse(body).code !== code || !code || req.headers.origin !== origin) return res.writeHead(401).end();
        code = ""; pairings++; valid = true;
        res.setHeader("set-cookie", "__Host-dbc_session=synthetic-session; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600");
        res.end('{"ok":true}');
      }); return;
    }
    const signedIn = valid && req.headers.cookie?.includes("__Host-dbc_session=synthetic-session");
    if (!signedIn) return res.writeHead(401).end('{}');
    if (req.url === "/api/auth/session") return res.end(JSON.stringify({ kind: "loopback", environmentId: id }));
    if (realApi && (req.url.startsWith("/api/") || req.url.startsWith("/.well-known/"))) {
      const target = new URL(process.env.DONEBOT_FRONTEND_FIXTURE);
      const proxy = httpRequest(new URL(req.url, target), { method: req.method, headers: { "content-type": req.headers["content-type"] ?? "application/json", origin: target.origin } }, upstream => {
        res.writeHead(upstream.statusCode, { ...upstream.headers, "x-donebot-cloud": "1" }); upstream.pipe(res);
      });
      proxy.on("error", () => res.destroy()); res.on("close", () => proxy.destroy()); req.pipe(proxy); return;
    }
    if (req.url === "/api/fixture/events") {
      res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: first\n\n");
      setTimeout(() => res.end("data: second\n\n"), 50); return;
    }
    if (req.url === "/api/fixture/file") {
      res.writeHead(206, { "content-type": "video/mp4", "content-range": "bytes 2-5/8" }); res.end("2345"); return;
    }
    if (req.url === "/api/fixture/upload") { req.pipe(res); return; }
    if (apiOnly) { staticRequests++; return res.writeHead(404).end(); }
    res.setHeader("content-type", "text/html"); res.end(`<!doctype html><title>Isolated Cloud</title><div id="root">${waitForPaint ? "" : "<h1>Cloud workspace</h1>"}</div>`);
  });
  const { WebSocketServer } = createRequire(import.meta.url)("ws");
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/api/fixture/socket" || !valid || req.headers.origin !== origin || !req.headers.cookie?.includes("__Host-dbc_session=synthetic-session")) return socket.destroy();
    sockets.handleUpgrade(req, socket, head, ws => ws.on("message", bytes => ws.send(bytes.toString())));
  });
  void app.whenReady().then(async () => {
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    await new Promise(resolve => localHttp.listen(0, "127.0.0.1", resolve));
    localOrigin = `http://127.0.0.1:${localHttp.address().port}`;
    origin = `https://${id}.cloud.localhost:${server.address().port}`;
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith(origin + "/") && !details.url.startsWith(origin.replace("https:", "wss:") + "/") && !details.url.startsWith(localOrigin + "/") && !details.url.startsWith("file://" + join(output, "ui") + "/") && !details.url.startsWith("file://" + builtUI + "/") && !details.url.startsWith("data:text/html;") && details.url !== "about:blank" });
    });
    win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      preload: fileURLToPath(new URL("../electron/preload.cjs", import.meta.url)), additionalArguments: [`--omb-local-origin=${localOrigin}`] } });
    const connection = installDoneBotCloud({ ipcMain, saved: () => state, persist: next => { state = environments.parseEnvironments(next); },
      guardLocal: (_name, handler) => (event, ...args) => { assert.equal(new URL(event.senderFrame.url).origin, localOrigin); return handler(event, ...args); },
      guardWorkspace: handler => (event, ...args) => { assert.equal(environments.workspaceSenderAllowed(event, win.webContents, state, localOrigin), true); return handler(event, ...args); },
      request: async path => {
        if (holdAuth) { const held = holdAuth; holdAuth = null; await held; }
        if (failAuth) throw new Error("Synthetic authorization failure");
        if (path === "/api/donebot/state") return Response.json({ authenticated: true, user: { id: owner } });
        launches++; code = "omb_pair_" + "a".repeat(43);
        return Response.json({ url: `donebot://pair?address=${encodeURIComponent(origin)}&token=${code}` });
      },
      fetch: (...args) => session.defaultSession.fetch(...args),
      cancelHome: () => {}, navigate: async target => { await win.loadURL(target); return true; },
      local: async () => { state = environments.withActive(state, "local"); await win.loadURL(localOrigin); },
      loading: { window: () => win, changed: () => rail?.refresh(), createView: options => {
        const view = new WebContentsView(options); loadingViews.push({ view, webContents: view.webContents }); return view;
      } },
    });
    rail = createChromeRail({ createView: options => new WebContentsView(options), preload: fileURLToPath(new URL("../electron/preload.cjs", import.meta.url)),
      args: () => [`--omb-local-origin=${localOrigin}`], url: () => localOrigin + "/rail", wanted: () => true, suppressed: connection.hidesRail });
    rail.install(ipcMain); rail.attach(win);
    await win.loadURL(localOrigin);
    win.showInactive();
    assert.equal(rail.shown(), true);
    const timings = {};
    phase = "first connection";
    let start = performance.now();
    let releaseAuth;
    holdAuth = new Promise(resolve => { releaseAuth = resolve; });
    waitForPaint = true;
    const first = connection.open({ id, accountId: "101" });
    assert.equal(rail.shown(), false);
    const loading = loadingViews.at(-1).webContents;
    await until(async () => !loading.isLoading() && await loading.executeJavaScript("Boolean(document.querySelector('.spinner'))"));
    assert.equal(await loading.executeJavaScript("typeof process"), "undefined");
    assert.equal(await loading.executeJavaScript("getComputedStyle(document.querySelector('.spinner')).animationName"), "spin");
    await loading.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    writeFileSync(join(output, "cloud-loading.png"), (await loading.capturePage()).toPNG());
    checks.push("loading animation covers pending authorization and hides native rail");
    releaseAuth();
    await until(() => win.webContents.getURL() === origin + "/" && !win.webContents.isLoading());
    assert.equal(loading.isDestroyed(), false);
    assert.equal(await win.webContents.executeJavaScript("document.getElementById('root').childElementCount"), 0);
    await win.webContents.executeJavaScript("document.getElementById('root').innerHTML='<h1>Cloud workspace</h1>'");
    await first; timings.firstMs = performance.now() - start;
    waitForPaint = false;
    await until(() => loading.isDestroyed());
    assert.equal(rail.shown(), false);
    assert.equal(await win.webContents.executeJavaScript("getComputedStyle(document.body).paddingLeft"), "0px");
    checks.push("loading stays through empty React root and gives Cloud the full width after render");
    assert.equal(pairings, 1); assert.equal(await win.webContents.executeJavaScript("document.querySelector('h1').textContent"), "Cloud workspace");
    phase = "live cookie reuse"; start = performance.now();
    await connection.open({ entry: state.environments[0] }); timings.reuseMs = performance.now() - start;
    assert.equal(launches, 1); assert.equal(pairings, 1);
    valid = false;
    phase = "expired cookie renewal"; start = performance.now();
    await connection.open({ entry: state.environments[0] }); timings.expiredMs = performance.now() - start;
    assert.equal(launches, 2); assert.equal(pairings, 2);
    const savedId = state.environments[0].id;
    phase = "return local";
    const returned = new Promise(resolve => win.webContents.once("did-finish-load", resolve));
    await win.webContents.executeJavaScript("void window.ogb.workspaces.returnLocal()", true);
    await returned;
    assert.equal(state.activeId, "local");
    assert.equal(await win.webContents.executeJavaScript("document.querySelector('h1').textContent"), "Local conversations");
    valid = false;
    phase = "reopen saved Cloud";
    await connection.select(state.environments[0]);
    assert.equal(state.activeId, savedId); assert.equal(state.environments.length, 1);
    assert.equal(await win.webContents.executeJavaScript("document.querySelector('h1').textContent"), "Cloud workspace");
    const keeper = createDoneBotCloudKeepalive({ entry: () => environments.activeEnvironment(state),
      expires: async target => (await session.defaultSession.cookies.get({ url: target, name: "__Host-dbc_session" }))[0]?.expirationDate * 1000,
      renew: connection.renew, interval: () => 1, clear: () => {},
    });
    keeper.start(); await new Promise(resolve => setImmediate(resolve));
    const cookie = (await session.defaultSession.cookies.get({ url: origin, name: "__Host-dbc_session" }))[0];
    await session.defaultSession.cookies.set({ url: origin, name: cookie.name, value: cookie.value, path: "/", secure: true, httpOnly: true, sameSite: "strict", expirationDate: Date.now() / 1000 + 60 });
    for (let attempt = 0; attempt < 100; attempt++) { await keeper.tick(); if (pairings === 4) break; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(pairings, 4); assert.equal(win.webContents.getURL(), origin + "/");
    assert.ok((await session.defaultSession.cookies.get({ url: origin, name: cookie.name }))[0].expirationDate * 1000 > Date.now() + 120_000);
    keeper.stop();
    phase = "cancel while connecting";
    await connection.select(undefined);
    state = environments.withActive(state, "local"); await win.loadURL(localOrigin); rail.refresh();
    let releaseCancel;
    holdAuth = new Promise(resolve => { releaseCancel = resolve; });
    const abandoned = connection.open({ entry: state.environments[0] });
    const cancelView = loadingViews.at(-1).webContents;
    await until(() => !cancelView.isLoading());
    await cancelView.executeJavaScript("document.getElementById('local').click()");
    await until(() => cancelView.isDestroyed());
    releaseCancel();
    assert.equal((await abandoned).outcome, "cancelled");
    assert.equal(state.activeId, "local"); assert.equal(rail.shown(), true);
    assert.equal(new URL(win.webContents.getURL()).origin, localOrigin);
    checks.push("native loading-page return cancels old selection without later Cloud navigation");
    phase = "failure and retry";
    failAuth = true;
    await assert.rejects(connection.open({ entry: state.environments[0] }), /Synthetic/);
    const failed = loadingViews.at(-1).webContents;
    await until(async () => !failed.isLoading() && await failed.executeJavaScript("document.body.hasAttribute('data-failed')"));
    assert.equal(await failed.executeJavaScript("document.getElementById('retry').hidden"), false);
    writeFileSync(join(output, "cloud-loading-failed.png"), (await failed.capturePage()).toPNG());
    failAuth = false;
    await failed.executeJavaScript("document.getElementById('retry').click()");
    await until(() => state.activeId !== "local" && new URL(win.webContents.getURL()).origin === origin && loadingViews.at(-1).webContents.isDestroyed());
    checks.push("failed connection shows retry and the native retry button restores Cloud");
    phase = "workspace creation disabled";
    let created = 0;
    const local = createLocalProfiles({ canCreate: () => false, registry: { create: () => { created++; } }, home: () => "local" });
    const handlers = new Map();
    installCloudRail({ ipcMain: { handle: (key, handler) => handlers.set(key, handler) }, guard: f => f, trusted: () => true,
      places: () => [], local, add: { choices: () => ({}) }, account: () => null, targets: () => [] });
    assert.equal((await handlers.get("workspaces:places")({})).add.local, false);
    assert.throws(() => handlers.get("workspaces:local-new")({}, "Forbidden"));
    const main = readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
    const creation = main.slice(main.indexOf('ipcMain.handle("environments:create",'), main.indexOf('ipcMain.handle("environments:pick-dir",'));
    vm.runInNewContext(creation, { ipcMain: { handle: (key, handler) => handlers.set(key, handler) }, localWorkspaceOnly: (_name, f) => f, environmentsState: state });
    assert.equal(handlers.get("environments:create")({}).error, "disabled");
    assert.equal(created, 0);
    checks.push("rail capability and both workspace creation IPC paths refuse creation");
    phase = "bundled frontend with API-only Cloud";
    apiOnly = true;
    const ui = join(output, "ui"); mkdirSync(join(ui, "assets"), { recursive: true });
    writeFileSync(join(ui, "index.html"), '<!doctype html><div id="root"></div><script type="module" src="/assets/client.js"></script>');
    writeFileSync(join(ui, "assets", "client.js"), `const session = await fetch('/api/auth/session').then(r => r.json()); document.getElementById('root').innerHTML = '<h1>Bundled client ' + session.environmentId + '</h1>';`);
    const stopFrontend = installDoneBotCloudFrontend({ session: session.defaultSession, directory: ui, origins: () => [origin] });
    const before = requests;
    await connection.open({ entry: state.environments[0] });
    assert.equal(await win.webContents.executeJavaScript("document.querySelector('h1').textContent"), `Bundled client ${id}`);
    assert.equal(requests - before, 2);
    assert.equal((await session.defaultSession.fetch(origin + "/assets/not-in-client.js")).status, 404);
    assert.equal((await session.defaultSession.fetch(origin + "/api/auth/session")).status, 200);
    assert.equal(await win.webContents.executeJavaScript("fetch('/api/fixture/events').then(r=>r.text())"), "data: first\n\ndata: second\n\n");
    assert.deepEqual(await win.webContents.executeJavaScript("fetch('/api/fixture/file', {headers:{Range:'bytes=2-5'}}).then(async r=>[r.status,r.headers.get('content-range'),await r.text()])"), [206, "bytes 2-5/8", "2345"]);
    assert.equal(await win.webContents.executeJavaScript("fetch('/api/fixture/upload',{method:'POST',body:'upload contents'}).then(r=>r.text())"), "upload contents");
    assert.equal(await win.webContents.executeJavaScript("new Promise((resolve,reject)=>{const ws=new WebSocket(location.origin.replace('https:','wss:')+'/api/fixture/socket'); ws.onopen=()=>ws.send('encrypted transport fixture'); ws.onmessage=e=>{resolve(e.data);ws.close()};ws.onerror=()=>reject(new Error('WebSocket failed'))})"), "encrypted transport fixture");
    valid = false;
    assert.equal((await session.defaultSession.fetch(origin + "/api/auth/session")).status, 401);
    await connection.open({ entry: state.environments[0] });
    checks.push("bundled UI and dynamic imports stay local; Cloud receives only authenticated API requests");
    checks.push("SSE, WebSocket, range responses and uploads preserve origin and Cookie; expired session still refused");
    stopFrontend();
    phase = "production client with isolated API-only runtime";
    realApi = true;
    const stopBuiltFrontend = installDoneBotCloudFrontend({ session: session.defaultSession, directory: builtUI, origins: () => [origin] });
    await connection.open({ entry: state.environments[0] });
    await until(async () => await win.webContents.executeJavaScript("Boolean(document.querySelector('#root').childElementCount)"));
    assert.equal((await session.defaultSession.fetch(origin)).headers.get("x-donebot-frontend"), "desktop");
    assert.equal(staticRequests, 0);
    await until(async () => await win.webContents.executeJavaScript("!document.querySelector('[data-app-loading]') && document.body.innerText.includes('Fixture Starter')"));
    assert.equal(await win.webContents.executeJavaScript("document.body.innerText.includes('此页面出错了') || document.body.innerText.includes('认识 DoneBot')"), false);
    writeFileSync(join(output, "bundled-cloud.png"), (await win.webContents.capturePage()).toPNG());
    writeFileSync(join(output, "bundled-cloud-text.txt"), await win.webContents.executeJavaScript("document.body.innerText"));
    checks.push("production bundled client renders against isolated real runtime with no Cloud frontend requests");
    stopBuiltFrontend();
    owner = "202";
    await assert.rejects(connection.open({ entry: state.environments[0] }), /账号/);
    const receipt = { passed: true, checks: [...checks, "real-electron-cookie-jar", "reuse-live-session", "automatic-expired-session-renewal", "native-return-local", "reopen-saved-cloud-without-add", "proactive-cookie-renewal-without-navigation", "account-isolation"], timings, requests, launches, pairings, syntheticCloud: true, liveDataTouched: false };
    writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt));
  } catch (error) { console.error(phase, error); process.exitCode = 1; }
  finally { win?.destroy(); for (const socket of sockets.clients) socket.terminate(); sockets.close(); server.closeAllConnections(); localHttp.closeAllConnections(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => localHttp.close(resolve))]); app.exit(process.exitCode ?? 0); }
  });
}
