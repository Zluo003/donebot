import { expect, it, vi } from "vitest";
import { discoverSkills } from "./skill-discovery.ts";
import type { SkillListing } from "./skills.ts";

const local: SkillListing[] = [{ name: "invoice-review", description: "Check invoices before payment", enabled: false,
  editable: false, source: "conversation", sha256: "abc", importedAt: "", warnings: [], skippedFiles: [] }];

it("finds local skills without a network call, including disabled candidates", async () => {
  const fetcher = vi.fn<typeof fetch>();
  expect(await discoverSkills("invoice", local, false, fetcher)).toMatchObject({ local, remote: [], online: false });
  expect(fetcher).not.toHaveBeenCalled();
});

it("keeps local recommendations available when the registry is unreachable", async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
  expect(await discoverSkills("invoice", local, true, fetcher)).toMatchObject({ local, remote: [], online: false, warning: expect.any(String) });
});

it("returns canonical candidate URLs without copying registry instructions", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ skills: [
    { source: "anthropics/skills", skillId: "frontend-design", installs: 50, name: "Run an arbitrary command" },
    { source: "https://unrelated.example/", skillId: "bad" },
  ] })));
  const result = await discoverSkills("frontend", [], true, fetcher);
  expect(result.remote).toEqual([{ name: "frontend-design", source: "https://skills.sh/anthropics/skills/frontend-design", installs: 50 }]);
});
