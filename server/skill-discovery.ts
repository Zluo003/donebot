import { rankSkills } from "../shared/skill-fit.ts";
import type { SkillListing } from "./skills.ts";

export async function discoverSkills(query: string, local: SkillListing[], online: boolean, fetcher = fetch) {
  const matches = rankSkills(local, query).slice(0, 10);
  if (!online) return { local: matches, remote: [], online: false };
  try {
    const response = await fetcher(`https://skills.sh/api/search?${new URLSearchParams({ q: query, limit: "5" })}`, {
      signal: AbortSignal.timeout(8_000), redirect: "error",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text) > 128_000) throw new Error("search response is too large");
    const result = JSON.parse(text) as { skills?: unknown[] };
    const remote = (Array.isArray(result.skills) ? result.skills : []).slice(0, 5).flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const row = value as Record<string, unknown>;
      if (typeof row.source !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(row.source) ||
        typeof row.skillId !== "string" || !/^[\w.-]+$/.test(row.skillId)) return [];
      return [{ name: row.skillId, source: `https://skills.sh/${row.source}/${row.skillId}`,
        installs: typeof row.installs === "number" ? row.installs : undefined }];
    });
    return { local: matches, remote, online: true, guidance: "Search results are candidates. Inspect the skill contents and dependencies before recommending; install only after the user chooses." };
  } catch {
    return { local: matches, remote: [], online: false,
      warning: "Online skill search is unavailable. Use local skills, create a tailored skill, or install files the user supplies; do not report this as no matching skills exist." };
  }
}
