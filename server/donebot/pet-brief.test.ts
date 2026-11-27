import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PET_BRIEF_CONTEXT, petBriefPromptBlock } from "./pet-brief.ts";
import { createMoveFreeze, PET_PAGE } from "../move-freeze.ts";
import { serveStatic } from "../static-files.ts";

describe("desktop pet server support", () => {
  it("returns concise briefing prompt block only when petBrief is enabled", () => {
    expect(petBriefPromptBlock(false)).toBe("");
    expect(petBriefPromptBlock(undefined)).toBe("");
    expect(petBriefPromptBlock(true)).toBe(PET_BRIEF_CONTEXT);
    expect(PET_BRIEF_CONTEXT).toContain("桌面宠物");
    expect(PET_BRIEF_CONTEXT).toContain("coordinate_bots");
    expect(PET_BRIEF_CONTEXT).toContain("工作台");
    expect(PET_BRIEF_CONTEXT).not.toContain("已安排研究部处理");
  });

  it("serves /pet from pet.html and exempts /pet from move freeze redirect", () => {
    const dir = mkdtempSync(join(tmpdir(), "donebot-pet-static-"));
    try {
      writeFileSync(join(dir, "index.html"), "<html>index</html>");
      writeFileSync(join(dir, "pet.html"), "<html>pet-root</html>");
      writeFileSync(join(dir, "moved.json"), JSON.stringify({ cloud: "https://example.donebot.cn" }));

      let status = 0;
      let body = "";
      const res = {
        writeHead(code: number) { status = code; },
        end(chunk: Buffer | string) { body = String(chunk); },
      } as unknown as ServerResponse;

      expect(serveStatic(res, "/pet", dir)).toBe(true);
      expect(status).toBe(200);
      expect(body).toContain("pet-root");

      const freeze = createMoveFreeze({ dataDir: dir });
      expect(freeze.screen(PET_PAGE)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
