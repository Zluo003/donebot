import { z } from "zod";
import { fitsOnOneLine } from "../bot-profile.ts";
import { hasTeamAuthority, outsideDepartmentReason } from "../peer-roster.ts";
import { redactSecretsInText } from "../redact.ts";
import {
  SECTION_CONTEXT_MAX_BYTES,
  readSectionContext,
  sectionContextKey,
  sectionContextLabel,
  writeSectionContext,
} from "../section-context.ts";
import type { BotRecord, GroupRecord } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

const sectionKey = (section?: string): string => section?.trim() || "";

/** Only dispatch inside the internal capability gate. Lets System/Department Coordinators manage shared instructions. */
export function createInternalDepartmentInstructionsRoutes(deps: {
  sender(): BotRecord | null;
  ownsThread(botId: string): boolean;
  readInternalBody(): Promise<unknown>;
  sections(): readonly string[];
  bots(): readonly BotRecord[];
  groups(): readonly GroupRecord[];
}): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (method !== "POST" || path !== "/api/internal/department-instructions") return PASS;
    const chief = deps.sender();
    if (!chief || chief.hidden || !chief.chiefOfStaff) {
      return json(res, 403, { error: "Only the System Coordinator or a Department Coordinator can manage department shared instructions" });
    }
    if (!deps.ownsThread(chief.id)) {
      return json(res, 403, { error: "Source conversation no longer belongs to the coordinator" });
    }
    const parsed = z.object({
      action: z.enum(["read", "set", "append"]),
      section: z.string().trim().max(60).optional(),
      text: z.string().optional(),
    }).strict().safeParse(await deps.readInternalBody());
    if (!parsed.success) return json(res, 400, { error: "Invalid department shared instructions request" });
    const targetSection = parsed.data.section !== undefined
      ? sectionContextKey(parsed.data.section)
      : sectionContextKey(chief.section);
    if (targetSection && !fitsOnOneLine(targetSection)) {
      return json(res, 400, { error: "Department name must fit on one line" });
    }
    if (targetSection && redactSecretsInText(targetSection) !== targetSection) {
      return json(res, 400, { error: "Department name cannot contain credentials" });
    }
    const exists = targetSection === ""
      || deps.sections().includes(targetSection)
      || deps.bots().some((bot) => !bot.hidden && sectionKey(bot.section) === targetSection)
      || deps.groups().some((group) => sectionKey(group.section) === targetSection);
    if (!exists) return json(res, 404, { error: `Department ${JSON.stringify(targetSection)} does not exist yet` });
    if (!hasTeamAuthority(chief, targetSection)) {
      return json(res, 403, { error: outsideDepartmentReason(chief, { section: targetSection }) });
    }
    const label = sectionContextLabel(targetSection);
    const current = readSectionContext(targetSection);
    if (parsed.data.action === "read") {
      const text = current?.text ?? "";
      return json(res, 200, {
        section: targetSection,
        label,
        text,
        bytes: Buffer.byteLength(text, "utf8"),
        updatedAt: current?.updatedAt ?? null,
        maxBytes: SECTION_CONTEXT_MAX_BYTES,
      });
    }
    if (typeof parsed.data.text !== "string") {
      return json(res, 400, { error: `action=${parsed.data.action} requires text` });
    }
    const clean = redactSecretsInText(parsed.data.text);
    if (parsed.data.action === "append" && !clean.trim()) {
      return json(res, 400, { error: "action=append requires non-empty text" });
    }
    const nextText = parsed.data.action === "append"
      ? [current?.text.trimEnd(), clean.trim()].filter(Boolean).join("\n\n")
      : clean;
    if (Buffer.byteLength(nextText, "utf8") > SECTION_CONTEXT_MAX_BYTES) {
      return json(res, 400, { error: `Shared instructions for ${JSON.stringify(label)} exceed ${SECTION_CONTEXT_MAX_BYTES / 1000}KB` });
    }
    const saved = writeSectionContext(targetSection, nextText);
    const finalText = saved?.text ?? "";
    return json(res, 200, {
      ok: true,
      section: targetSection,
      label,
      text: finalText,
      bytes: Buffer.byteLength(finalText, "utf8"),
      updatedAt: saved?.updatedAt ?? null,
      maxBytes: SECTION_CONTEXT_MAX_BYTES,
    });
  };
}
