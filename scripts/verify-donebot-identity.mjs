import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.versions.electron) {
  const dir = mkdtempSync(join(tmpdir(), "donebot-identity-"));
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, APPDATA: join(dir, "roaming"), LOCALAPPDATA: join(dir, "local") };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(import.meta.url), dir], { env, stdio: "inherit" });
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.equal(code, 0);
    console.log(`DoneBot identity evidence: ${dir}/receipt.json`);
  } finally { clearTimeout(timer); }
} else {
  const { app } = await import("electron");
  const { configureAppIdentity } = await import("../electron/app-identity.mjs");
  const dir = process.argv[2];
  const appData = join(dir, "app-data");
  const upstream = join(appData, "OpenMausBot");
  mkdirSync(upstream, { recursive: true });
  writeFileSync(join(upstream, "keep-me.txt"), "upstream profile");
  app.setPath("appData", appData);
  configureAppIdentity(app);
  const profile = join(appData, "DoneBot");
  assert.equal(app.getName(), "DoneBot");
  assert.equal(app.getPath("userData"), profile);
  assert.equal(app.getPath("sessionData"), profile);
  assert.equal(realpathSync(app.getPath("logs")), realpathSync(join(profile, "logs")));
  assert.equal(readFileSync(join(upstream, "keep-me.txt"), "utf8"), "upstream profile");
  writeFileSync(join(dir, "receipt.json"), JSON.stringify({ passed: true, name: app.getName(), userData: profile, sessionData: app.getPath("sessionData"), logs: app.getPath("logs"), upstreamPreserved: true }, null, 2));
  app.exit(0);
}
