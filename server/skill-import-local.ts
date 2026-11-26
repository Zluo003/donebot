import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readFileNoFollow } from "./imported-skills.ts";
import { parseSkillMd, SKILL_FILE_MAX_BYTES } from "../shared/skill-md.ts";
import type { FetchedSkill } from "./skill-fetch.ts";
import { planSkillFolder, skillFilePathProblem, type FolderEntry } from "./skill-folder.ts";

/** Local imports may read only the current conversation's file roots or exact attached files. */
export function fetchLocalSkill(source: string, roots: string[], attachedFiles: string[] = []): { skills: FetchedSkill[] } | { error: string } {
  try {
    const requested = resolve(source);
    const real = realpathSync(requested);
    const inside = roots.some((root) => {
      try {
        const rel = relative(realpathSync(root), real);
        return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
      } catch { return false; }
    });
    const attached = attachedFiles.some((file) => {
      try { return realpathSync(file) === real; } catch { return false; }
    });
    if (!inside && !attached) return { error: "The skill must be in this conversation's working files or attached to this conversation." };
    const info = lstatSync(requested);
    if (info.isSymbolicLink()) return { error: "A local skill cannot be a symbolic link." };
    const folder = info.isDirectory() ? real : dirname(real);
    const entries: FolderEntry[] = [];
    if (info.isFile()) {
      entries.push({ path: "SKILL.md", kind: "file", size: info.size });
    } else if (info.isDirectory() && inside) {
      const walk = (at: string) => {
        for (const entry of readdirSync(join(folder, at), { withFileTypes: true })) {
          if (entries.length >= 1_000) throw new Error("The skill folder is too large; provide a specific smaller skill folder.");
          const path = at ? `${at}/${entry.name}` : entry.name;
          const kind = entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "folder" : "file";
          if (kind === "file" && !entry.isFile()) continue;
          const stat = lstatSync(join(folder, path));
          entries.push({ path, kind, size: stat.size, executable: Boolean(stat.mode & 0o111) });
          if (kind === "folder" && !skillFilePathProblem(path, true)) walk(path);
        }
      };
      walk("");
    } else return { error: "Provide a SKILL.md file or a skill folder." };
    const planned = planSkillFolder(entries);
    const entrypoint = planned.take.find((entry) => entry.path === "SKILL.md");
    if (!entrypoint) return { error: "The skill folder has no SKILL.md." };
    if (entrypoint.size > SKILL_FILE_MAX_BYTES) return { error: `SKILL.md is larger than ${SKILL_FILE_MAX_BYTES / 1024}KB` };
    const files = planned.take.map((entry) => {
      const path = info.isFile() ? real : join(folder, entry.path);
      if (realpathSync(path) !== path) throw new Error("A skill file changed while it was being read; try again.");
      const content = readFileNoFollow(path);
      if (!content || content.length !== entry.size) throw new Error("A skill file changed while it was being read; try again.");
      return { path: entry.path, content, executable: Boolean(entry.executable) };
    });
    const skillMdFile = files.find((file) => file.path === "SKILL.md");
    const parsedSkill = skillMdFile ? parseSkillMd(skillMdFile.content.toString("utf8")) : null;
    const portableName = parsedSkill && !("error" in parsedSkill) ? parsedSkill.name : basename(folder).trim();
    const portableSource = portableName ? `local:${portableName}` : "local";
    return { skills: [{ source: portableSource, files, skipped: planned.skipped }] };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The local skill could not be read." };
  }
}
