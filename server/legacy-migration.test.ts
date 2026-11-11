import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir } from "./testing/cleanup.ts";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => removeTempDir(home))); });

describe("DoneBot data isolation", () => {
  it("creates its own data without reading, renaming or modifying upstream data or environment overrides", () => {
    const home = mkdtempSync(join(tmpdir(), "donebot-isolation-"));
    homes.push(home);
    const upstream = [".openmausbot", ".opengrokbot"];
    for (const name of upstream) {
      mkdirSync(join(home, name));
      writeFileSync(join(home, name, "config.json"), "upstream config must remain untouched");
      writeFileSync(join(home, name, "keep-me.txt"), name);
    }
    const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
      'const { DATA_DIR, ensureDirs } = await import("./server/config.ts"); ensureDirs(); console.log(DATA_DIR);'], {
      cwd: new URL("..", import.meta.url),
      env: {
        HOME: home, USERPROFILE: home,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        OMB_DATA_DIR: join(home, ".openmausbot"),
        OPENMAUSBOT_URL: "http://127.0.0.1:8799",
      },
      encoding: "utf8", timeout: 20_000,
    });
    expect(output.trim()).toBe(join(home, ".donebot"));
    expect(existsSync(join(home, ".donebot", "events"))).toBe(true);
    expect(existsSync(join(home, ".donebot", "native"))).toBe(true);
    for (const name of upstream) {
      expect(readFileSync(join(home, name, "config.json"), "utf8")).toBe("upstream config must remain untouched");
      expect(readFileSync(join(home, name, "keep-me.txt"), "utf8")).toBe(name);
    }
    expect(existsSync(join(home, ".donebot", "keep-me.txt"))).toBe(false);
  });
});
