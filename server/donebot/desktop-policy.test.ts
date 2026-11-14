import { describe, expect, it } from "vitest";
import { effectiveCloudBackend } from "../../shared/cloud-backend.ts";

describe("DoneBot cloud desktop routing", () => {
  it("routes unset and saved Boat selections to DoneBot without rewriting profiles", () => {
    for (const saved of [undefined, "box", "donebot"] as const) expect(effectiveCloudBackend(saved, true)).toBe("donebot");
    expect(effectiveCloudBackend("vps", true)).toBe("vps");
  });
  it("preserves upstream backend selection outside DoneBot", () => {
    expect(effectiveCloudBackend(undefined, false)).toBe("box");
    expect(effectiveCloudBackend("box", false)).toBe("box");
    expect(effectiveCloudBackend("vps", false)).toBe("vps");
  });
});
