import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SKILL_FILE_MAX_BYTES } from "../shared/skill-md.ts";
import { createTeamPackageExport } from "./package-export.ts";
import { skillExport } from "./skill-export.ts";
import { fetchLocalSkill } from "./skill-import-local.ts";
import { portableSkillSource } from "./skills.ts";
import type { BotRecord } from "./store.ts";

const temporary: string[] = [];
const scratch = () => {
  const path = mkdtempSync(join(tmpdir(), "donebot-local-skill-"));
  temporary.push(path);
  return path;
};
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const instructions = "---\nname: report-check\ndescription: Check report totals.\n---\nRead references/checks.md.\n";

it("rejects sibling folders outside the conversation and limits attached access to the exact file", () => {
  const parent = scratch();
  const root = join(parent, "work");
  const sibling = join(parent, "work-other");
  mkdirSync(root);
  mkdirSync(sibling);
  const attached = join(sibling, "uploaded.md");
  const other = join(sibling, "other.md");
  writeFileSync(attached, instructions);
  writeFileSync(other, instructions);
  expect(fetchLocalSkill(attached, [root])).toHaveProperty("error");
  expect(fetchLocalSkill(sibling, [root])).toHaveProperty("error");
  expect(fetchLocalSkill(attached, [root], [attached])).toHaveProperty("skills");
  expect(fetchLocalSkill(other, [root], [attached])).toHaveProperty("error");
});

it.skipIf(process.platform === "win32")("preserves scripts, references and binary assets without following links or importing hidden credentials", () => {
  const root = scratch();
  const outside = scratch();
  writeFileSync(join(outside, "secret"), "private fixture");
  mkdirSync(join(root, "references"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "SKILL.md"), instructions);
  writeFileSync(join(root, "references", "checks.md"), "Check source totals.");
  writeFileSync(join(root, "scripts", "check.js"), "process.exit(0);\n");
  chmodSync(join(root, "scripts", "check.js"), 0o755);
  writeFileSync(join(root, "assets", "template.bin"), Buffer.from([0, 255, 1]));
  writeFileSync(join(root, ".env"), "token=fixture-only");
  symlinkSync(join(outside, "secret"), join(root, "secret-link"));
  const result = fetchLocalSkill(root, [root]);
  expect(result).toHaveProperty("skills");
  if ("error" in result) throw new Error(result.error);
  const skill = result.skills[0]!;
  expect(skill.source).toBe("local:report-check");
  expect(skill.files.map((file) => file.path).sort()).toEqual(["SKILL.md", "assets/template.bin", "references/checks.md", "scripts/check.js"]);
  expect(skill.files.find((file) => file.path === "assets/template.bin")?.content).toEqual(Buffer.from([0, 255, 1]));
  expect(skill.files.find((file) => file.path === "scripts/check.js")?.executable).toBe(true);
  expect(skill.skipped).toEqual(expect.arrayContaining([{ path: ".env", reason: "hidden" }, { path: "secret-link", reason: "link" }]));
});

it.skipIf(process.platform === "win32")("requires conversation scope and never reads a direct link to an outside file", () => {
  const root = scratch();
  const outside = scratch();
  const file = join(outside, "SKILL.md");
  writeFileSync(file, instructions);
  expect(fetchLocalSkill(file, [root])).toHaveProperty("error");
  symlinkSync(file, join(root, "SKILL.md"));
  expect(fetchLocalSkill(join(root, "SKILL.md"), [root])).toHaveProperty("error");
});

it.skipIf(process.platform === "win32")("allows exactly an attached file through a canonical parent alias without granting access to its siblings", () => {
  const root = scratch();
  const uploads = scratch();
  writeFileSync(join(uploads, "uuid-upload.md"), instructions);
  writeFileSync(join(uploads, "sibling.md"), instructions);
  const alias = join(root, "uploads-alias");
  symlinkSync(uploads, alias, "dir");
  const attached = [join(alias, "uuid-upload.md")];
  const result = fetchLocalSkill(join(uploads, "uuid-upload.md"), [], attached);
  expect(result).toHaveProperty("skills");
  if ("error" in result) throw new Error(result.error);
  expect(result.skills[0]?.files.map((file) => file.path)).toEqual(["SKILL.md"]);
  expect(fetchLocalSkill(join(uploads, "sibling.md"), [], attached)).toHaveProperty("error");
  expect(fetchLocalSkill(uploads, [], attached)).toHaveProperty("error");
});

it("rejects a missing or oversized entrypoint before reading its contents", () => {
  const root = scratch();
  expect(fetchLocalSkill(root, [root])).toHaveProperty("error");
  writeFileSync(join(root, "SKILL.md"), Buffer.alloc(SKILL_FILE_MAX_BYTES + 1));
  expect(fetchLocalSkill(root, [root])).toEqual({ error: expect.stringContaining("SKILL.md is larger") });
});

it("normalizes legacy absolute local skill sources during team package export while preserving side files", () => {
  expect(portableSkillSource("set-design", "/Users/dev/donebot-skill/set-design")).toBe("local:set-design");
  expect(portableSkillSource("set-design", "C:\\skills\\set-design")).toBe("local:set-design");
  expect(portableSkillSource("set-design", "~/skills/set-design")).toBe("local:set-design");
  expect(portableSkillSource("set-design", "file:///Users/dev/set-design")).toBe("local:set-design");
  expect(portableSkillSource("set-design", "owner/repo")).toBe("owner/repo");

  const bot = {
    id: "bot-set",
    name: "布景师",
    title: "影视美术",
    description: "负责影视空景布景设计",
    soul: "你是专业影视布景师，按照技能参考手册和脚本完成场景设计与校验。",
    section: "影视部",
    color: "orange",
  } as unknown as BotRecord;
  const setSkillMd = "---\nname: set-design\ndescription: 影视布景规范\n---\n按 references/guide.md 与 scripts/set-check.mjs 执行。\n";
  const exporter = skillExport({
    listBotSkills: () => [{
      name: "set-design",
      description: "影视布景规范",
      enabled: true,
      editable: true,
      source: "/Users/zluo/Dev/donebot-skill/set-design",
      sha256: "abc",
      importedAt: new Date().toISOString(),
      warnings: [],
      skippedFiles: [],
    }],
    readBotSkillFile: () => setSkillMd,
    readBotSkillFiles: () => [
      { path: "references/guide.md", content: "# 布景手册\n" },
      { path: "scripts/set-check.mjs", content: "console.log('ok');\n" },
    ],
  });

  const collected = exporter.collectTeamSkills([bot], "all");
  expect(collected.ok).toBe(true);
  if (!collected.ok) throw new Error(collected.error);
  expect(collected.skillsByBot.get(bot.id)?.[0]?.source).toBe("local:set-design");

  const exported = createTeamPackageExport({
    team: "影视部",
    name: "影视部",
    bots: [bot],
    groups: [],
    routines: [],
    published: null,
    skillsByBot: collected.skillsByBot,
    skillSelection: "all",
  });
  const entry = exported.document.package.skills?.entries[0];
  expect(entry?.source).toBe("local:set-design");
  expect(entry?.files?.map((file) => file.path).sort()).toEqual(["references/guide.md", "scripts/set-check.mjs"]);
});
