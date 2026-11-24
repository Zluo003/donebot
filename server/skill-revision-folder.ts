// Helpers for revising editable personal skills (both learned and installed)
// while keeping bundled non-reference files intact under hash-verified storage.
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  readNoFollow,
  SKILL_FOLDER_LIMITS,
  skillFileText,
  skillFolderDigest,
  writeSkillFolder,
} from "./skill-folder.ts";
import {
  directoryEntryState,
  entryExistsWithoutFollowing,
  isSkillReferencePath,
  learnedSkillDirectoryMatches,
  MAX_SKILL_REFERENCES,
  publishReviewedRevision,
  readReferenceFiles,
  skillReferencesSha256,
  STAGED_SKILL_FILE_MAX_BYTES,
} from "./skill-storage.ts";

export interface SkillRevisionEntry {
  source: string;
  sha256: string;
  importedAt: string;
  appliedStageId?: string;
  installId?: string;
  storageRevision?: string;
  referencesSha256?: string;
  files?: string[];
  filesSha256?: string;
  package?: unknown;
}

export interface PreservedSupportFile {
  path: string;
  content: Buffer;
  executable: boolean;
}

/** Personal skills (learned or installed from GitHub/marketplace/packages) are editable; org/builtin stay read-only. */
export function isSkillEntryEditable(entry: Pick<SkillRevisionEntry, "source" | "package">): boolean {
  return !entry.source.startsWith("builtin:") && !entry.source.startsWith("org:") && !entry.package;
}

function directoryIdentity(path: string): { dev: number; ino: number } | null {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() ? { dev: stat.dev, ino: stat.ino } : null;
  } catch {
    return null;
  }
}

function sameDirectoryIdentity(path: string, expected: { dev: number; ino: number }): boolean {
  const current = directoryIdentity(path);
  return current?.dev === expected.dev && current.ino === expected.ino;
}

function verifySkillMdHash(directory: string, sha256: string): boolean {
  try {
    const file = join(directory, "SKILL.md");
    if (!lstatSync(file).isFile()) return false;
    const bytes = readNoFollow(file);
    return bytes !== null && createHash("sha256").update(bytes).digest("hex") === sha256;
  } catch {
    return false;
  }
}

export function skillEntryDirectoryMatches(
  directory: string,
  entry: Pick<SkillRevisionEntry, "sha256" | "files" | "filesSha256" | "referencesSha256">,
): boolean {
  if (directoryEntryState(directory) !== "directory") return false;
  if (entry.filesSha256) {
    return verifySkillMdHash(directory, entry.sha256) &&
      skillFolderDigest(directory, entry.files ?? []) === entry.filesSha256;
  }
  return learnedSkillDirectoryMatches(directory, entry.sha256, entry.referencesSha256);
}

function splitFolderFiles(
  directory: string,
  entry: Pick<SkillRevisionEntry, "sha256" | "files" | "filesSha256" | "referencesSha256">,
): { editableRefs: Array<{ path: string; content: string }>; preserved: PreservedSupportFile[] } | null {
  if (!skillEntryDirectoryMatches(directory, entry)) return null;
  if (!entry.filesSha256) {
    if (!entry.referencesSha256) return { editableRefs: [], preserved: [] };
    const refs = readReferenceFiles(directory);
    return refs === null ? null : { editableRefs: refs, preserved: [] };
  }
  const editableRefs: Array<{ path: string; content: string }> = [];
  const preserved: PreservedSupportFile[] = [];
  for (const path of [...(entry.files ?? [])].sort()) {
    const full = join(directory, ...path.split("/"));
    let info;
    try {
      info = lstatSync(full);
    } catch {
      return null;
    }
    if (!info.isFile()) return null;
    const bytes = readNoFollow(full);
    if (bytes === null) return null;
    const executable = (info.mode & 0o100) !== 0;
    const text = isSkillReferencePath(path) && !executable && bytes.byteLength <= STAGED_SKILL_FILE_MAX_BYTES
      ? skillFileText(bytes)
      : null;
    if (text !== null && editableRefs.length < MAX_SKILL_REFERENCES) {
      editableRefs.push({ path, content: text });
    } else {
      preserved.push({ path, content: bytes, executable });
    }
  }
  return { editableRefs, preserved };
}

export function readEditableReferencesFromDirectory(
  directory: string,
  entry: Pick<SkillRevisionEntry, "sha256" | "files" | "filesSha256" | "referencesSha256">,
): Array<{ path: string; content: string }> | null {
  const split = splitFolderFiles(directory, entry);
  return split ? split.editableRefs : null;
}

export function entryReferencesSha256(
  directory: string | null,
  entry: Pick<SkillRevisionEntry, "sha256" | "files" | "filesSha256" | "referencesSha256">,
): string | undefined | null {
  if (entry.referencesSha256) return entry.referencesSha256;
  if (!entry.filesSha256) return undefined;
  if (!directory) return null;
  const refs = readEditableReferencesFromDirectory(directory, entry);
  if (refs === null) return null;
  return refs.length ? skillReferencesSha256([{ path: "SKILL.md", content: "" }, ...refs]) : undefined;
}

export interface SkillUpdateBase {
  baseSha256: string;
  baseAppliedStageId?: string;
  baseInstallId?: string;
  baseImportedAt?: string;
  baseFilesSha256?: string;
}

export function captureUpdateBase(entry: SkillRevisionEntry): SkillUpdateBase {
  return {
    baseSha256: entry.sha256,
    ...(entry.appliedStageId ? { baseAppliedStageId: entry.appliedStageId } : {}),
    ...(!entry.appliedStageId && entry.installId ? { baseInstallId: entry.installId } : {}),
    ...(!entry.appliedStageId && !entry.installId ? { baseImportedAt: entry.importedAt } : {}),
    ...(entry.filesSha256 ? { baseFilesSha256: entry.filesSha256 } : {}),
  };
}

export function baseRevisionMatches(existing: SkillRevisionEntry, expected: SkillUpdateBase): boolean {
  if (!isSkillEntryEditable(existing)) return false;
  if (existing.sha256 !== expected.baseSha256) return false;
  if ((existing.filesSha256 ?? undefined) !== (expected.baseFilesSha256 ?? undefined)) return false;
  if (expected.baseAppliedStageId !== undefined) return existing.appliedStageId === expected.baseAppliedStageId;
  if (existing.appliedStageId !== undefined) return false;
  if (expected.baseInstallId !== undefined) return existing.installId === expected.baseInstallId;
  return Boolean(expected.baseImportedAt && existing.importedAt === expected.baseImportedAt && !existing.installId);
}

const comparablePath = (path: string) => path.normalize("NFC").toLowerCase();

export function publishSkillRevision(
  dirs: { state: string; ensureSkillsRoot: () => string | null },
  stageId: string,
  sourceDir: string,
  existing: SkillRevisionEntry,
  preparedFiles: Array<{ path: string; content: string }>,
  sha256: string,
  referencesSha256: string | undefined,
): { storageRevision: string; files?: string[]; filesSha256?: string; referencesSha256?: string } {
  const split = splitFolderFiles(sourceDir, existing);
  if (!split) throw new Error("the installed skill changed while preparing the update");
  if (split.preserved.length === 0) {
    const storageRevision = publishReviewedRevision(dirs, stageId, preparedFiles, sha256, referencesSha256);
    return { storageRevision, ...(referencesSha256 ? { referencesSha256 } : {}) };
  }

  const preservedKeys = new Set(split.preserved.map((file) => comparablePath(file.path)));
  const referenceFiles = preparedFiles.slice(1).map((file) => {
    if (preservedKeys.has(comparablePath(file.path))) {
      throw new Error(`reference path "${file.path}" collides with a bundled skill file`);
    }
    return { path: file.path, content: Buffer.from(file.content, "utf8"), executable: false };
  });
  const beside = [...split.preserved, ...referenceFiles].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (beside.length + 1 > SKILL_FOLDER_LIMITS.files) {
    throw new Error(`updated skill exceeds the ${SKILL_FOLDER_LIMITS.files}-file limit`);
  }
  const totalBytes = Buffer.byteLength(preparedFiles[0]!.content, "utf8") + beside.reduce((sum, f) => sum + f.content.byteLength, 0);
  if (totalBytes > SKILL_FOLDER_LIMITS.bytes) {
    throw new Error(`updated skill exceeds the ${SKILL_FOLDER_LIMITS.bytes / (1024 * 1024)}MB folder limit`);
  }
  const paths = beside.map((file) => file.path);

  const state = dirs.state;
  mkdirSync(state, { recursive: true, mode: 0o700 });
  if (directoryEntryState(state) !== "directory") {
    throw new Error("the protected skill state path is not a real directory");
  }
  const preparedRoot = join(state, "reviewed-revisions");
  const preparedRootState = directoryEntryState(preparedRoot);
  if (preparedRootState === "unsafe") throw new Error("the protected revision path is not a real directory");
  if (preparedRootState === "missing") mkdirSync(preparedRoot, { mode: 0o700 });

  const revision = createHash("sha256").update(stageId).digest("hex");
  const prepared = join(preparedRoot, revision);
  let filesSha256: string | null = null;
  const temporary = join(preparedRoot, `.prepare-${revision}-${randomUUID()}`);
  try {
    writeSkillFolder(temporary, preparedFiles[0]!.content, beside);
    filesSha256 = skillFolderDigest(temporary, paths, { remember: false });
    if (!filesSha256 || !skillEntryDirectoryMatches(temporary, { sha256, files: paths, filesSha256 })) {
      throw new Error("the protected reviewed bytes do not match the approval card");
    }
    if (entryExistsWithoutFollowing(prepared)) {
      if (directoryEntryState(prepared) !== "directory") {
        throw new Error("the protected reviewed revision is not a real directory");
      }
      rmSync(prepared, { recursive: true, force: true });
    }
    renameSync(temporary, prepared);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }

  const root = dirs.ensureSkillsRoot();
  if (!root) throw new Error("the workspace skills path must be a real directory, not a symlink or file");
  const rootIdentity = directoryIdentity(root);
  if (!rootIdentity) throw new Error("the workspace skills path changed during update");
  const revisions = join(root, ".revisions");
  const revisionsState = directoryEntryState(revisions);
  if (revisionsState === "unsafe") throw new Error("the skill revisions path is not a real directory");
  if (revisionsState === "missing") mkdirSync(revisions, { mode: 0o700 });
  const revisionsIdentity = directoryIdentity(revisions);
  if (!revisionsIdentity) throw new Error("the skill revisions path could not be created safely");

  const target = join(revisions, revision);
  const expectedTarget = { sha256, files: paths, filesSha256 };
  if (skillEntryDirectoryMatches(target, expectedTarget)) {
    try {
      rmSync(prepared, { recursive: true, force: true });
    } catch {}
    return { storageRevision: revision, files: paths, filesSha256 };
  }
  if (entryExistsWithoutFollowing(target)) {
    throw new Error("the reviewed revision path already exists with different content");
  }
  if (!sameDirectoryIdentity(root, rootIdentity) || !sameDirectoryIdentity(revisions, revisionsIdentity)) {
    throw new Error("the workspace skills path changed during update");
  }
  renameSync(prepared, target);
  if (
    !sameDirectoryIdentity(root, rootIdentity) ||
    !sameDirectoryIdentity(revisions, revisionsIdentity) ||
    !skillEntryDirectoryMatches(target, expectedTarget)
  ) {
    throw new Error("the reviewed revision changed while it was being published");
  }
  return { storageRevision: revision, files: paths, filesSha256 };
}

export function removeSkillRevisionDir(
  root: string | null,
  revision: string,
  entry: Pick<SkillRevisionEntry, "sha256" | "files" | "filesSha256" | "referencesSha256">,
): void {
  if (!root) return;
  const revisions = join(root, ".revisions");
  if (directoryEntryState(revisions) !== "directory") return;
  const directory = join(revisions, revision);
  if (!skillEntryDirectoryMatches(directory, entry)) return;
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {}
}

export function retirePreviousSkillStorage(
  root: string | null,
  existingDir: string | null,
  entry: Pick<SkillRevisionEntry, "storageRevision" | "sha256" | "files" | "filesSha256" | "referencesSha256">,
): void {
  if (entry.storageRevision) {
    removeSkillRevisionDir(root, entry.storageRevision, entry);
    return;
  }
  if (!existingDir || !skillEntryDirectoryMatches(existingDir, entry)) return;
  try {
    rmSync(existingDir, { recursive: true, force: true });
  } catch {}
}
