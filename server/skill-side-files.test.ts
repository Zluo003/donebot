import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { BotRecord } from "./store.ts";
import type { SkillListing } from "./skills.ts";
import type { SkillsLibraryHost } from "./host/skills-library.ts";

const dir = mkdtempSync(join(tmpdir(), "donebot-template-files-"));
vi.stubEnv("DONEBOT_DATA_DIR", dir);
const skills = await import("./skills.ts");
const library = await import("./skill-library.ts");
const { ownSkillFiles, librarySkillFiles } = await import("./skill-side-files.ts");
const { skillExport } = await import("./skill-export.ts");
const { prepareSkillFolder } = await import("./skill-folder.ts");
const { admitSkillFiles } = await import("../shared/skill-files.ts");
const md = "---\nname: report\ndescription: Report steps.\n---\nRun scripts/report.py.\n";
const script = "print('fixture')\n";
const bot = { id: "fixture", name: "Fixture" } as BotRecord;

afterAll(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

function install(id: string) {
  const result = skills.installSkill(id, "fixture", [{ path: "SKILL.md", content: md }, { path: "scripts/report.py", content: script }]);
  if ("error" in result) throw new Error(result.error);
  return skills.skillDirectory(id, "report", skills.readManifest(id).report!)!;
}

describe("stored template skill files", () => {
  it("reads only recorded files, checks integrity and refuses symlinks at every level", () => {
    const location = install("own");
    writeFileSync(join(location, "unlisted.txt"), "not shared");
    expect(ownSkillFiles("own", "report")?.map(file => ({ path: file.path, content: Buffer.from(file.content).toString() })))
      .toEqual([{ path: "scripts/report.py", content: script }]);
    writeFileSync(join(location, "scripts/report.py"), "changed\n");
    expect(ownSkillFiles("own", "report")).toBeNull();
    writeFileSync(join(location, "scripts/report.py"), script);
    const outside = join(dir, "outside.py");
    writeFileSync(outside, script);
    rmSync(join(location, "scripts"), { recursive: true });
    symlinkSync(dir, join(location, "scripts"), process.platform === "win32" ? "junction" : "dir");
    expect(ownSkillFiles("own", "report")).toBeNull();
    rmSync(join(location, "scripts"));
    mkdirSync(join(location, "scripts"));
    symlinkSync(outside, join(location, "scripts/report.py"));
    expect(ownSkillFiles("own", "report")).toBeNull();
  });

  it("carries learned references and the verified library copy without a directory walk", () => {
    const staged = skills.stageSkillWrite("learned", { action: "create", source: "learned:conversation", files: [
      { path: "SKILL.md", content: md }, { path: "references/guide.md", content: "# Guide\n" },
    ] });
    if ("error" in staged) throw new Error(staged.error);
    expect(skills.applyStagedSkillWrite("learned", staged.id, { expectedSha256: staged.sha256 })).not.toHaveProperty("error");
    expect(ownSkillFiles("learned", "report")).toEqual([{ path: "references/guide.md", content: "# Guide\n" }]);
    const root = library.skillsLibraryRoot();
    const added = library.installLibrarySkill({ name: "report", instructions: md, source: "fixture", files: [{ path: "scripts/report.py", content: Buffer.from(script), executable: false }], root });
    expect(added).not.toHaveProperty("error");
    expect(librarySkillFiles("report")?.map(file => Buffer.from(file.content).toString())).toEqual([script]);
    writeFileSync(join(library.librarySkillDirectory(root, "report"), "scripts/report.py"), "changed");
    expect(librarySkillFiles("report")).toBeNull();
  });

  it("keeps every admitted file at the existing storage gate without silent truncation", () => {
    const admitted = admitSkillFiles(["a/b/c.txt", "Docs/a.py", "docs/b.py", "data", "data/x", "run.sh"].map(path => ({ path, content: script })));
    const prepared = prepareSkillFolder([{ path: "SKILL.md", content: md }, ...admitted.files]);
    if ("error" in prepared) throw new Error(prepared.error);
    expect(prepared.skipped).toEqual([]);
    expect(prepared.files.map(file => file.path).sort()).toEqual(admitted.files.map(file => file.path).sort());
  });

  it("reports omitted files and refuses changed side files for explicit export", () => {
    let files: ReturnType<SkillsLibraryHost["readBotSkillFiles"]> = [
      { path: "scripts/report.py", content: script }, { path: "prod.env", content: "A=1" }, { path: "asset.png", content: new Uint8Array([0xff, 0]) },
    ];
    const host = skillExport({ listBotSkills: () => [{ name: "report", description: "Report steps.", source: "fixture", enabled: false } as SkillListing],
      readBotSkillFile: () => md, readBotSkillFiles: () => files });
    const result = host.collectTeamSkills([bot], "all");
    if (!result.ok) throw new Error(result.error);
    expect(result.skillsByBot.get(bot.id)?.[0]?.files).toEqual([{ path: "scripts/report.py", content: script }]);
    expect(result.skipped).toEqual([
      { part: "skills[report].files[asset.png]", reason: "skill_file_binary" },
      { part: "skills[report].files[prod.env]", reason: "skill_file_secret_name" },
    ]);
    expect(() => host.collectExportSkills([bot], ["report"])).toThrow("prod.env");
    files = null;
    expect(host.collectTeamSkills([bot], ["report"])).toMatchObject({ ok: false });
    expect(host.collectTeamSkills([bot], "all")).toMatchObject({ ok: true, skipped: [{ part: "skills[report]", reason: "skill_changed" }] });
    expect(() => host.collectExportSkills([bot], ["report"])).toThrow("changed files");
  });

  it("excludes bundled and local engine skills while retaining installed skills with display-only source names", () => {
    const host = skillExport({ listBotSkills: () => [
      { name: "find-skills", source: "builtin:find-skills", editable: false },
      { name: "native", origin: "native" }, { name: "project", origin: "project" },
      { name: "report", source: "builtin:report", editable: true },
    ] as SkillListing[], readBotSkillFile: () => md });
    expect(host.collectTeamSkills([bot], "all")).toMatchObject({ ok: true, available: ["report"] });
    expect(host.checkedExportSkillNames(["find-skills"], [bot])).toMatchObject({ ok: false });
    expect(host.collectExportSkills([bot], ["report"]).get(bot.id)).toHaveLength(1);
  });
});
