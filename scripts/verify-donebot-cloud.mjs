import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDoneBotCloudConnection } from "../electron/donebot-cloud.mjs";

if (!process.versions.electron) {
  const output = mkdtempSync(join(tmpdir(), "donebot-cloud-reconnect-")), home = join(output, "home");
  mkdirSync(home);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(output, "key.pem"), "-out", join(output, "cert.pem"), "-days", "1", "-subj", "/CN=cloud.localhost"], { stdio: "ignore" });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(import.meta.url), output], { env, stdio: "inherit" });
  const watchdog = setTimeout(() => child.kill(), 45_000);
  const code = await new Promise(resolve => { child.once("error", () => resolve(1)); child.once("exit", resolve); });
  clearTimeout(watchdog);
  console.log(`Cloud connection evidence: ${output}`);
  assert.equal(code, 0);
  assert.equal(JSON.parse(readFileSync(join(output, "receipt.json"))).passed, true);
  for (const name of ["home", "profile", "key.pem", "cert.pem"]) rmSync(join(output, name), { recursive: true, force: true });
} else {
  const { app, session, BrowserWindow } = await import("electron");
  const output = process.argv[2];
  app.setPath("userData", join(output, "profile"));
  app.setPath("sessionData", join(output, "profile"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("ignore-certificate-errors");
  app.commandLine.appendSwitch("host-resolver-rules", "MAP *.cloud.localhost 127.0.0.1");
  app.on("window-all-closed", () => {});
  const id = "11861a47-7240-4f99-bf19-bd01d411596f";
  let valid = true, launches = 0, pairings = 0, requests = 0, owner = "101", code = "", win;
  let state = { activeId: "local", environments: [] }, origin;
  const server = createServer({ key: readFileSync(join(output, "key.pem")), cert: readFileSync(join(output, "cert.pem")) }, (req, res) => {
    requests++;
    res.setHeader("x-donebot-cloud", "1"); res.setHeader("cache-control", "no-store");
    if (req.url === "/api/auth/pair") {
      let body = ""; req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        if (JSON.parse(body).code !== code || !code || req.headers.origin !== origin) return res.writeHead(401).end();
        code = ""; pairings++; valid = true;
        res.setHeader("set-cookie", "__Host-dbc_session=synthetic-session; Path=/; HttpOnly; Secure; SameSite=Strict");
        res.end('{"ok":true}');
      }); return;
    }
    const signedIn = valid && req.headers.cookie?.includes("__Host-dbc_session=synthetic-session");
    if (!signedIn) return res.writeHead(401).end('{}');
    if (req.url === "/api/auth/session") return res.end(JSON.stringify({ kind: "loopback", environmentId: id }));
    res.setHeader("content-type", "text/html"); res.end("<!doctype html><title>Isolated Cloud</title><h1>Cloud workspace</h1>");
  });
  void app.whenReady().then(async () => {
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `https://${id}.cloud.localhost:${server.address().port}`;
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith(origin + "/") && details.url !== "about:blank" });
    });
    win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const connection = createDoneBotCloudConnection({ saved: () => state,
      request: async path => {
        if (path === "/api/donebot/state") return Response.json({ authenticated: true, user: { id: owner } });
        launches++; code = "omb_pair_" + "a".repeat(43);
        return Response.json({ url: `donebot://pair?address=${encodeURIComponent(origin)}&token=${code}` });
      },
      fetch: (...args) => session.defaultSession.fetch(...args),
      remember: target => { state = { activeId: "cloud", environments: [{ id: "cloud", name: "DoneBot Cloud", origin, donebotCloud: { id: target.id, accountId: target.accountId } }] }; },
      activate: async target => { await win.loadURL(target); return true; },
    });
    const timings = {};
    let start = performance.now();
    await connection.open({ id, accountId: "101" }); timings.firstMs = performance.now() - start;
    assert.equal(pairings, 1); assert.equal(await win.webContents.executeJavaScript("document.querySelector('h1').textContent"), "Cloud workspace");
    start = performance.now();
    await connection.open({ entry: state.environments[0] }); timings.reuseMs = performance.now() - start;
    assert.equal(launches, 1); assert.equal(pairings, 1);
    valid = false;
    start = performance.now();
    await connection.open({ entry: state.environments[0] }); timings.expiredMs = performance.now() - start;
    assert.equal(launches, 2); assert.equal(pairings, 2);
    owner = "202";
    await assert.rejects(connection.open({ entry: state.environments[0] }), /账号/);
    const receipt = { passed: true, checks: ["real-electron-cookie-jar", "reuse-live-session", "automatic-expired-session-renewal", "account-isolation"], timings, requests, launches, pairings, syntheticCloud: true, liveDataTouched: false };
    writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt));
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { win?.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); app.exit(process.exitCode ?? 0); }
  });
}
