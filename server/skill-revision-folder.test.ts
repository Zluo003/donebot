import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { ownSkillFiles } from "./skill-side-files.ts";
import {
  applyStagedSkillWrite,
  installOrgSkill,
  installSkill,
  listSkills,
  readSkillFile,
  readSkillReferences,
  rejectStagedSkillWrite,
  removeSkill,
  setSkillEnabled,
  stageSkillWrite,
  undoSkillWrite,
} from "./skills.ts";
import { workspaceDir } from "./workspace.ts";

const SKILL = (name: string, description = "Useful procedure.", body = "1. Do step one.\n") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}`;

describe("revising installed skills while preserving bundled files", () => {
  let bot: string;

  beforeEach(() => {
    bot = `skill-rev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  });

  afterEach(() => {
    rmSync(workspaceDir(bot), { recursive: true, force: true });
    rmSync(join(DATA_DIR, "skill-state", bot), { recursive: true, force: true });
  });

  it("allows updating an installed multi-file skill, preserves bundled scripts/assets & executable bits, and supports lossless undo", () => {
    const initialMd = SKILL("deploy-check", "Original deploy check.", "1. Run scripts/check.py\n");
    const installed = installSkill(bot, "github.com/acme/skills/deploy-check", [
      { path: "SKILL.md", content: initialMd },
      { path: "scripts/check.py", content: "#!/usr/bin/env python3\nprint('ok')\n", executable: true },
      { path: "assets/schema.json", content: '{"strict":true}\n' },
      { path: "references/rules.md", content: "# Rules\nAlways verify staging.\n" },
    ]);
    expect(installed).toMatchObject({
      name: "deploy-check",
      enabled: false,
      editable: true,
      files: ["assets/schema.json", "references/rules.md", "scripts/check.py"],
    });
    expect(setSkillEnabled(bot, "deploy-check", true)).toMatchObject({ enabled: true, editable: true });

    const originalFolder = join(workspaceDir(bot), "skills", "deploy-check");
    expect(existsSync(join(originalFolder, "scripts", "check.py"))).toBe(true);

    const updatedMd = SKILL("deploy-check", "Tailored deploy check.", "1. Run scripts/check.py --fast\n2. Read references/edge-cases.md\n");
    const staged = stageSkillWrite(bot, {
      action: "update",
      targetName: "deploy-check",
      source: "learn:conversation",
      files: [
        { path: "SKILL.md", content: updatedMd },
        { path: "references/edge-cases.md", content: "# Edge Cases\nSkip legacy region.\n" },
      ],
    });
    if ("error" in staged) throw new Error(staged.error);
    expect(staged.files.map(f => f.path)).toEqual(["SKILL.md", "references/edge-cases.md", "references/rules.md"]);

    const applied = applyStagedSkillWrite(bot, staged.id, {
      expectedSha256: staged.sha256,
      expectedReferencesSha256: staged.referencesSha256 ?? null,
    });
    if ("error" in applied) throw new Error(applied.error);
    expect(applied).toMatchObject({
      name: "deploy-check",
      description: "Tailored deploy check.",
      enabled: true,
      editable: true,
      files: ["assets/schema.json", "references/edge-cases.md", "references/rules.md", "scripts/check.py"],
    });
    expect(readSkillFile(bot, "deploy-check")).toBe(updatedMd);
    expect(existsSync(originalFolder)).toBe(false);

    const linkedDir = realpathSync(join(workspaceDir(bot), ".agents", "skills", "deploy-check"));
    const scriptPath = join(linkedDir, "scripts", "check.py");
    expect(readFileSync(scriptPath, "utf8")).toBe("#!/usr/bin/env python3\nprint('ok')\n");
    if (process.platform !== "win32") {
      expect((lstatSync(scriptPath).mode & 0o100) !== 0).toBe(true);
    }
    expect(readFileSync(join(linkedDir, "assets", "schema.json"), "utf8")).toBe('{"strict":true}\n');
    expect(readSkillReferences(bot, "deploy-check")?.map(r => r.path)).toEqual([
      "references/edge-cases.md",
      "references/rules.md",
    ]);

    const sideFiles = ownSkillFiles(bot, "deploy-check");
    expect(sideFiles?.map(f => f.path)).toEqual([
      "assets/schema.json",
      "references/edge-cases.md",
      "references/rules.md",
      "scripts/check.py",
    ]);

    // Idempotent replay with the same stage id succeeds.
    expect(applyStagedSkillWrite(bot, staged.id, {
      expectedSha256: staged.sha256,
      expectedReferencesSha256: staged.referencesSha256 ?? null,
    })).toMatchObject({ name: "deploy-check", enabled: true, editable: true });

    // Lossless undo restores SKILL.md, original source, and original references while keeping scripts/assets intact.
    const undone = undoSkillWrite(bot, {
      stagedId: staged.id,
      name: "deploy-check",
      action: "update",
      previous: {
        skillMd: initialMd,
        source: "github.com/acme/skills/deploy-check",
        references: [{ path: "references/rules.md", content: "# Rules\nAlways verify staging.\n" }],
      },
    });
    expect(undone).toEqual({ undone: true });
    expect(readSkillFile(bot, "deploy-check")).toBe(initialMd);
    expect(listSkills(bot)[0]).toMatchObject({
      name: "deploy-check",
      source: "github.com/acme/skills/deploy-check",
      enabled: true,
      editable: true,
      files: ["assets/schema.json", "references/rules.md", "scripts/check.py"],
    });
    const restoredDir = realpathSync(join(workspaceDir(bot), ".agents", "skills", "deploy-check"));
    expect(readFileSync(join(restoredDir, "scripts", "check.py"), "utf8")).toBe("#!/usr/bin/env python3\nprint('ok')\n");
    expect(readFileSync(join(restoredDir, "assets", "schema.json"), "utf8")).toBe('{"strict":true}\n');
    expect(existsSync(join(restoredDir, "references", "edge-cases.md"))).toBe(false);
  });

  it("blocks replay when an imported skill is removed and reinstalled with identical bytes", () => {
    const initialMd = SKILL("same-bytes-import", "Original.");
    installSkill(bot, "github.com/acme/same-bytes-import", [
      { path: "SKILL.md", content: initialMd },
      { path: "scripts/tool.sh", content: "echo hi\n", executable: true },
    ]);
    const stale = stageSkillWrite(bot, {
      action: "update",
      targetName: "same-bytes-import",
      files: [{ path: "SKILL.md", content: SKILL("same-bytes-import", "Stale update.") }],
    });
    if ("error" in stale) throw new Error(stale.error);
    expect(rejectStagedSkillWrite(bot, stale.id)).toEqual({ rejected: true });
    expect(removeSkill(bot, "same-bytes-import")).toEqual({ removed: true });

    installSkill(bot, "github.com/acme/same-bytes-import", [
      { path: "SKILL.md", content: initialMd },
      { path: "scripts/tool.sh", content: "echo hi\n", executable: true },
    ]);
    const stagedPath = join(DATA_DIR, "skill-state", bot, "staged.json");
    writeFileSync(stagedPath, `${JSON.stringify({ writes: { [stale.id]: stale } }, null, 2)}\n`);
    expect(applyStagedSkillWrite(bot, stale.id, { expectedSha256: stale.sha256 })).toMatchObject({
      error: expect.stringContaining("changed after this update was proposed"),
    });
    expect(readSkillFile(bot, "same-bytes-import")).toBe(initialMd);
  });

  it("keeps org-managed skills read-only and refuses reserved source prefixes", () => {
    const orgSkill = installOrgSkill(bot, "org:team-policy", SKILL("org-policy", "Org policy."), {
      installId: "a".repeat(32),
      key: "org-policy",
      release: "1.0.0",
      r: "b".repeat(64),
      w: "c".repeat(64),
    });
    expect(orgSkill).toMatchObject({ name: "org-policy", enabled: true, editable: false });
    expect(stageSkillWrite(bot, {
      action: "update",
      targetName: "org-policy",
      files: [{ path: "SKILL.md", content: SKILL("org-policy", "Tampered.") }],
    })).toMatchObject({ error: expect.stringContaining("cannot be rewritten") });

    installSkill(bot, "github.com/acme/user-skill", [{ path: "SKILL.md", content: SKILL("user-skill", "Original.") }]);
    expect(stageSkillWrite(bot, {
      action: "update",
      targetName: "user-skill",
      source: "org:spoofed",
      files: [{ path: "SKILL.md", content: SKILL("user-skill", "Updated.") }],
    })).toMatchObject({ error: expect.stringContaining("reserved") });
  });
});
