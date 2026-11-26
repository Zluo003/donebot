import { BOT_PACKAGE_MAX_SKILLS } from "./bot-package.ts";
import type { SkillsLibraryHost } from "./host/skills-library.ts";
import type { ExportablePackageSkill, TeamExportSkip } from "./package-export.ts";
import { isSkillName, portableSkillSource } from "./skills.ts";
import type { BotRecord } from "./store.ts";
import { admitSkillFiles, skillFileRefusalWords } from "../shared/skill-files.ts";

/** The skill side of bot and team package export: which names may be exported, and each bot's exportable copies. */
export function skillExport(host: Pick<SkillsLibraryHost, "listBotSkills" | "readBotSkillFile"> & Partial<Pick<SkillsLibraryHost, "readBotSkillFiles">>) {
  const { readBotSkillFile } = host;
  const filesFor = (bot: BotRecord, name: string) => {
    const files = host.readBotSkillFiles ? host.readBotSkillFiles(bot, name) : [];
    return files === null ? null : admitSkillFiles(files);
  };
  const listBotSkills = (bot: BotRecord) => host.listBotSkills(bot).filter(skill => {
    const origin = (skill as { origin?: string }).origin;
    return origin !== "native" && origin !== "project" && !(skill.editable === false && skill.source === `builtin:${skill.name}`);
  });
  function checkedExportSkillNames(
    value: unknown,
    bots: readonly BotRecord[],
  ): { ok: true; names: string[] } | { ok: false; error: string } {
    if (value === undefined) return { ok: true, names: [] };
    if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !isSkillName(name))) {
      return { ok: false, error: "skillIds must be a list of exact imported skill names" };
    }
    const names = [...value] as string[];
    if (new Set(names).size !== names.length) return { ok: false, error: "skillIds must not contain duplicates" };
    if (names.length > BOT_PACKAGE_MAX_SKILLS) return { ok: false, error: `skillIds must contain at most ${BOT_PACKAGE_MAX_SKILLS} names` };
    const available = new Set(bots.flatMap((bot) => listBotSkills(bot).map((skill) => skill.name)));
    const unknown = names.find((name) => !available.has(name));
    if (unknown) return { ok: false, error: `skillIds contains unknown imported skill "${unknown}"` };
    return { ok: true, names };
  }

  function collectExportSkills(
    bots: readonly BotRecord[],
    names: readonly string[],
  ): ReadonlyMap<string, readonly ExportablePackageSkill[]> {
    const selected = new Set(names);
    const byBot = new Map<string, ExportablePackageSkill[]>();
    if (!selected.size) return byBot;
    for (const bot of bots) {
      const assigned: ExportablePackageSkill[] = [];
      for (const listing of listBotSkills(bot)) {
        if (!selected.has(listing.name)) continue;
        const instructions = readBotSkillFile(bot, listing.name);
        if (instructions === null) {
          throw new Error(`Skill "${listing.name}" changed or is unavailable and cannot be exported safely`);
        }
        const beside = filesFor(bot, listing.name);
        if (!beside) throw new Error(`Skill "${listing.name}" has changed files and cannot be exported safely`);
        if (beside.refused.length) throw new Error(`Skill "${listing.name}" cannot include ${beside.refused.map(file => `${file.path}, which ${skillFileRefusalWords(file.reason)}`).join("; ")}`);
        const source = portableSkillSource(listing.name, listing.source);
        const skill: ExportablePackageSkill = {
          name: listing.name,
          description: listing.description,
          ...(source ? { source } : {}),
          ...(listing.license ? { license: listing.license } : {}),
          ...(listing.compatibility ? { compatibility: listing.compatibility } : {}),
          instructions,
          ...(beside.files.length ? { files: beside.files } : {}),
        };
        assigned.push(skill);
      }
      if (assigned.length) byBot.set(bot.id, assigned);
    }
    return byBot;
  }

  function collectTeamSkills(
    bots: readonly BotRecord[],
    selection: unknown,
  ): { ok: true; all: boolean; skillsByBot: Map<string, ExportablePackageSkill[]>; skipped: TeamExportSkip[]; available: string[] } | { ok: false; error: string; available: string[] } {
    const all = selection === undefined || selection === "all";
    const available = [...new Set(bots.flatMap((bot) => listBotSkills(bot).map((skill) => skill.name)))].sort();
    if (!all && (!Array.isArray(selection) || selection.some((name) => typeof name !== "string" || !isSkillName(name)))) {
      return { ok: false, error: "skills must be \"all\" or a list of skill names", available };
    }
    const chosen = new Set(all ? available : selection as string[]);
    const unknown = [...chosen].find((name) => !available.includes(name));
    if (unknown) return { ok: false, error: `This team has no skill named "${unknown}"`, available };
    const skillsByBot = new Map<string, ExportablePackageSkill[]>();
    const skipped: TeamExportSkip[] = [];
    for (const bot of bots) {
      const assigned: ExportablePackageSkill[] = [];
      for (const listing of listBotSkills(bot)) {
        if (!chosen.has(listing.name)) continue;
        const instructions = readBotSkillFile(bot, listing.name);
        const beside = filesFor(bot, listing.name);
        if (instructions === null || beside === null) {
          if (!all) return { ok: false, error: `Skill "${listing.name}" changed or is unavailable and cannot be shared safely`, available };
          const part = `skills[${listing.name}]`;
          if (!skipped.some((skip) => skip.part === part)) skipped.push({ part, reason: "skill_changed" });
          continue;
        }
        for (const file of beside.refused) {
          const part = `skills[${listing.name}].files[${file.path}]`;
          if (!skipped.some(skip => skip.part === part)) skipped.push({ part, reason: `skill_file_${file.reason}` });
        }
        const source = portableSkillSource(listing.name, listing.source);
        assigned.push({
          name: listing.name,
          description: listing.description,
          ...(source ? { source } : {}),
          ...(listing.license ? { license: listing.license } : {}),
          ...(listing.compatibility ? { compatibility: listing.compatibility } : {}),
          instructions,
          ...(beside.files.length ? { files: beside.files } : {}),
          enabled: listing.enabled,
        });
      }
      if (assigned.length) skillsByBot.set(bot.id, assigned);
    }
    return { ok: true, all, skillsByBot, skipped, available };
  }

  return { checkedExportSkillNames, collectExportSkills, collectTeamSkills };
}
