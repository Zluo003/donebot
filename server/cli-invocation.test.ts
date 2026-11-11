import { describe, expect, it } from "vitest";

import { cliCommand, cliPrefix } from "./cli-invocation.ts";

describe("cliPrefix", () => {
  it("prints commands the way the CLI was started", () => {
    expect(cliPrefix({}, "/home/me/.npm/_npx/1a2b/node_modules/donebot/dist-server/donebot.js")).toBe("npx donebot");
    expect(cliPrefix({ npm_command: "exec" }, "/repo/node_modules/vitest/vitest.mjs"), "another tool run by npx").toBe("donebot");
    expect(cliPrefix({ npm_lifecycle_event: "omb" }, "/repo/server/donebot.ts")).toBe("pnpm omb");
    expect(cliPrefix({ DONEBOT_CLI_PREFIX: "docker compose exec omb donebot" }, "/app/dist-server/donebot.js")).toBe("docker compose exec omb donebot");
    expect(cliPrefix({}, "/usr/lib/node_modules/donebot/dist-server/donebot.js")).toBe("donebot");
    expect(cliCommand("pair", {}, "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\9\\node_modules\\donebot\\x.js")).toBe("npx donebot pair");
  });
});
