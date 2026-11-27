import { isAbsolute } from "node:path";

import { buildCoordinatorSkillFindPayload } from "../host/coordinator-departments.ts";
import { discoverSkills } from "../skill-discovery.ts";
import { fetchSkillFromSource } from "../skill-fetch.ts";
import { skillImportSummary } from "../skill-folder.ts";
import { fetchLocalSkill } from "../skill-import-local.ts";
import { installSkill, parseSkillMd, type SkillListing } from "../skills.ts";
import type { BotRecord } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** Only dispatch inside the internal capability gate. Handles `/api/internal/skills/find` and `/api/internal/skills/import`. */
export function createInternalSkillImportRoutes(deps: {
  sender: BotRecord;
  threadId: string;
  skillAuthoring: boolean;
  skillAuthoringEnabled(): boolean;
  ownsThread(botId: string, threadId: string): boolean;
  readInternalBody(): Promise<Record<string, unknown>>;
  requireActive(): void;
  skillTarget(from: BotRecord, requested: unknown): BotRecord | { error: string };
  listBotSkills(bot: BotRecord): SkillListing[];
  messageFileRoots(botId: string, threadId: string): string[];
  attachedPaths(threadId: string): string[];
  signal: AbortSignal;
}): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (method !== "POST" || (path !== "/api/internal/skills/find" && path !== "/api/internal/skills/import")) return PASS;
    if (!deps.skillAuthoringEnabled() || !deps.skillAuthoring) return json(res, 403, { error: "skill authoring is not enabled for this turn" });
    const from = deps.sender;
    const threadId = deps.threadId;
    if (!deps.ownsThread(from.id, threadId)) return json(res, 403, { error: "source conversation does not belong to sender" });
    const body = await deps.readInternalBody();
    const target = deps.skillTarget(from, body.bot_id);
    if ("error" in target) return json(res, 403, target);
    if (path.endsWith("/find")) {
      if (typeof body.query !== "string" || !body.query.trim() || body.query.length > 300 || (body.online !== undefined && typeof body.online !== "boolean")) return json(res, 400, { error: "query must contain 1–300 characters and online must be a boolean" });
      const result = await discoverSkills(body.query.trim(), deps.listBotSkills(target), body.online !== false);
      deps.requireActive();
      if (!deps.skillAuthoringEnabled()) return json(res, 403, { error: "skill authoring is not enabled in Settings" });
      const current = deps.skillTarget(from, target.id);
      if ("error" in current) return json(res, 403, current);
      return json(res, 200, { botId: target.id, botName: target.name, ...buildCoordinatorSkillFindPayload(from, target, result) });
    }
    if (typeof body.source !== "string" || !body.source.trim() || body.source.length > 2000 || (body.preview !== undefined && typeof body.preview !== "boolean")) return json(res, 400, { error: "source must be a skill URL or local path, and preview must be a boolean" });
    const source = body.source.trim();
    const roots = deps.messageFileRoots(from.id, threadId);
    const attached = deps.attachedPaths(threadId);
    const fetched = isAbsolute(source) ? fetchLocalSkill(source, roots, attached) : await fetchSkillFromSource(source, fetch, deps.signal);
    deps.requireActive();
    if (!deps.skillAuthoringEnabled()) return json(res, 403, { error: "skill authoring is not enabled in Settings" });
    const current = deps.skillTarget(from, target.id);
    if ("error" in current) return json(res, 403, current);
    if ("error" in fetched) return json(res, 422, fetched);
    const summaries = fetched.skills.map((skill) => {
      const text = skill.files.find((file) => file.path === "SKILL.md")?.content.toString("utf8") ?? "";
      const parsed = parseSkillMd(text);
      return { source: skill.source, ...(skill.github ? { github: skill.github } : {}),
        error: "error" in parsed ? parsed.error : undefined,
        description: "error" in parsed ? undefined : parsed.description, skill_md: text,
        ...skillImportSummary("error" in parsed ? "invalid" : parsed.name, skill.files, skill.skipped) };
    });
    if (body.preview !== false) return json(res, 200, { botId: target.id, botName: target.name, preview: true, skills: summaries });
    if (fetched.skills.length !== 1) return json(res, 422, { error: "Select one specific skill folder or skills.sh skill URL before installing.", skills: summaries });
    const skill = fetched.skills[0]!;
    const name = summaries[0]!.name;
    if (summaries[0]!.error) return json(res, 422, { error: summaries[0]!.error });
    if (name && deps.listBotSkills(current).some((entry) => entry.name === name && entry.source.startsWith("builtin:"))) return json(res, 409, { error: "This skill is built into the Chief and cannot be replaced." });
    const installed = installSkill(current.id, skill.source, skill.files, skill.github);
    if ("error" in installed) return json(res, 422, installed);
    return json(res, 201, { botId: current.id, botName: current.name, installed, enabled: false,
      imported: skillImportSummary(installed.name, skill.files, skill.skipped),
      summary: `Imported ${installed.name} into ${current.name}, disabled. Enable it with skill_manage using this same bot_id.` });
  };
}
