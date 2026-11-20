import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { clientUpdateFeed } from "./client-update-feed.mjs";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const { PublishManager } = builderRequire("app-builder-lib/out/publish/PublishManager.js");
const { Platform } = builderRequire("app-builder-lib");
const config = parse(readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8"));

for (const [platform, arch, target] of [["darwin", "arm64", "dmg"], ["darwin", "arm64", "zip"], ["win32", "x64", "nsis"]]) {
  test(`${platform} ${target} embeds a DoneBot update feed even with --publish never`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "donebot-update-package-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const appInfo = { updaterCacheDirName: "donebot-updater", channel: null };
    let afterPack;
    const packager = {
      config,
      appInfo,
      platform: platform === "darwin" ? Platform.MAC : Platform.WINDOWS,
      platformSpecificBuildOptions: config[platform === "darwin" ? "mac" : "win"],
      info: { config, appInfo },
      expandMacro: (value, targetArch) => value.replaceAll("${arch}", targetArch),
      getResourcesDir: () => directory,
      onAfterPack: (callback) => { afterPack = callback; },
      onArtifactCreated() {},
    };
    const manager = new PublishManager(packager, { publish: "never" });
    assert.equal(manager.isPublish, false);
    await afterPack({ packager, appOutDir: directory, electronPlatformName: platform, arch: arch === "arm64" ? 3 : 1, targets: [{ name: target }] });
    const feed = parse(readFileSync(join(directory, "app-update.yml"), "utf8"));
    assert.deepEqual(feed, { ...clientUpdateFeed(platform, arch), updaterCacheDirName: "donebot-updater" });
  });
}
