// Only manifest-listed files whose captured bytes still match the reviewed digest may leave the skill directory.
import { join } from "node:path";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";

import { readNoFollow, skillFolderDigest } from "./skill-folder.ts";
import { librarySkillDirectory, readSkillLibraryIndex, skillsLibraryRoot } from "./skill-library.ts";
import { readManifest, readSkillReferences, skillDirectory } from "./skills.ts";

/** The files, or null when they no longer match what came in. */
export type StoredSkillFiles = Array<{ path: string; content: string | Uint8Array }> | null;

function listedFiles(dir: string | null, paths: readonly string[] | undefined, sha256: string | undefined): StoredSkillFiles {
  if (!paths?.length) return [];
  if (!dir || !sha256 || skillFolderDigest(dir, paths) !== sha256) return null;
  const files: Array<{ path: string; content: Uint8Array }> = [];
  const captured = createHash("sha256");
  try {
    for (const path of [...paths].sort()) {
      const full = join(dir, ...path.split("/"));
      const bytes = readNoFollow(full);
      if (bytes === null) return null;
      const info = lstatSync(full);
      if (!info.isFile()) return null;
      captured.update(`${path}\0${(info.mode & 0o100) !== 0 ? "x" : "-"}\0${createHash("sha256").update(bytes).digest("hex")}\n`);
      files.push({ path, content: new Uint8Array(bytes) });
    }
  } catch {
    return null;
  }
  return captured.digest("hex") === sha256 ? files : null;
}

/** A bot's own skill: an import's files, or a learned skill's reviewed references. */
export function ownSkillFiles(botId: string, name: string): StoredSkillFiles {
  const entry = readManifest(botId)[name];
  if (!entry) return [];
  if (entry.files?.length) return listedFiles(skillDirectory(botId, name, entry), entry.files, entry.filesSha256);
  return entry.referencesSha256 ? readSkillReferences(botId, name) : [];
}

/** A skill of the organization's library on this server. */
export function librarySkillFiles(name: string, root: string = skillsLibraryRoot()): StoredSkillFiles {
  const entry = readSkillLibraryIndex(root)[name];
  return entry ? listedFiles(librarySkillDirectory(root, name), entry.files, entry.filesSha256) : [];
}
