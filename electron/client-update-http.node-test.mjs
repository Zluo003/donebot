import assert from "node:assert/strict";
import { once, EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clientUpdateFeed } from "./client-update-feed.mjs";

test("the shipped Mac updater detects a newer gateway release over HTTP and rejects an equal version", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "donebot-update-http-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const artifact = "/api/v1/client/releases/0.1.1/macos-arm64/DoneBot-0.1.1-arm64.zip";
  const requests = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://fixture.invalid").pathname;
    requests.push(path);
    if (path === "/api/v1/client/updates/macos-arm64/latest-mac.yml") {
      response.end(`version: "0.1.1"\nfiles:\n  - url: "${artifact}"\n    sha512: "fixture-sha512"\n    size: 123\npath: "${artifact}"\nsha512: "fixture-sha512"\n`);
    } else {
      response.writeHead(404).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const { NodeHttpExecutor } = builderRequire("builder-util/out/nodeHttpExecutor");
  const config = join(directory, "app-update.yml");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const feed = clientUpdateFeed("darwin", "arm64", origin);
  writeFileSync(config, `provider: generic\nurl: ${feed.url}\nupdaterCacheDirName: donebot-updater\n`);
  for (const version of ["0.1.0", "0.1.1"]) {
    const native = new EventEmitter();
    const originalLoad = Module._load;
    Module._load = (name, ...args) => name === "electron" ? { autoUpdater: native } : originalLoad(name, ...args);
    let updater;
    try {
      const { MacUpdater } = require("./vendor/electron-updater.cjs");
      updater = new MacUpdater(null, {
        version, isPackaged: true, appUpdateConfigPath: config,
        userDataPath: directory, baseCachePath: directory, whenReady: () => Promise.resolve(),
      });
    } finally {
      Module._load = originalLoad;
    }
    t.after(() => native.removeAllListeners());
    updater.httpExecutor = new NodeHttpExecutor();
    updater.logger = { info() {}, warn() {}, error() {}, debug() {} };
    updater.autoDownload = false;
    updater.setFeedURL(feed);
    const result = await updater.checkForUpdates();
    assert.equal(result.isUpdateAvailable, version === "0.1.0");
    assert.equal(result.updateInfo.version, "0.1.1");
    assert.equal(result.downloadPromise ?? null, null);
    if (result.isUpdateAvailable) {
      const resolved = updater.updateInfoAndProvider.provider.resolveFiles(result.updateInfo);
      assert.equal(resolved[0].url.href, origin + artifact);
    }
  }
  assert.deepEqual(requests, Array(2).fill("/api/v1/client/updates/macos-arm64/latest-mac.yml"));
  t.diagnostic("isolated gateway HTTP feed: 0.1.0 detects 0.1.1 with the correct ZIP URL; 0.1.1 reports no newer release; no installer or live app was touched");
});
