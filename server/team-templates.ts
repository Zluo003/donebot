import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, rmSync, type Stats } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { z } from "zod";

import { parsePackageDocument, packageSecretFindings } from "../shared/package-format.ts";
import { MANIFEST_NAMES, namedFolderFiles, readShareFolder, safeFolderPath, SHARE_FOLDER_MAX_BYTES, writeShareFolder, type ShareFolderFiles, type TemplateScope } from "../shared/share-folder.ts";
import { TEAM_TEMPLATE_SLUG, type TeamTemplate } from "../shared/team-templates.ts";
import { renameWithRetry, writeFileAtomic } from "./atomic.ts";
import { TEAM_FILES_TEMPLATES, TeamFilesError, type TeamFiles, type TeamFilesActor, type TeamTemplateMutationGuard } from "./host/team-files.ts";

const MAX_TEMPLATES = 500;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const TRANSACTION = "team-template-transaction.json";
const transactionName = z.string().uuid().transform(id => `team-template-${id}`);
const entrySchema = z.object({
  name: z.string().min(1).max(100), scope: z.enum(["bot", "department"]), tagline: z.string().max(200),
  release: z.string().min(1).max(100), revision: z.string().regex(/^[a-f0-9]{64}$/),
  addedBy: z.string().min(1).max(200), addedAt: z.number().int().nonnegative(),
}).strict();
const indexSchema = z.object({ v: z.literal(1), templates: z.record(z.string().regex(TEAM_TEMPLATE_SLUG), entrySchema).refine(entries => Object.keys(entries).length <= MAX_TEMPLATES) }).strict();
type Index = z.infer<typeof indexSchema>;
const journalSchema = z.object({
  v: z.literal(1), id: z.string().uuid(), slug: z.string().regex(TEAM_TEMPLATE_SLUG), operation: z.enum(["add", "remove"]),
  state: z.enum(["pending", "committed", "rolled_back"]), hadTarget: z.boolean(), hadPrevious: z.boolean(), before: indexSchema, after: indexSchema,
}).strict();
type Journal = z.infer<typeof journalSchema>;
const admin = { person: "template-recovery", admin: true };
const unavailable = () => new TeamFilesError(503, "unavailable", "The template library could not be read safely. Restore or repair it before publishing.");
const gone = () => new TeamFilesError(404, "not_found", "This template is no longer in the team's library.");
const fingerprint = (files: ShareFolderFiles) => createHash("sha256").update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, bytes]) => [path, createHash("sha256").update(bytes).digest("hex")]))).digest("hex");
const checkRevision = (entry: Index["templates"][string] | undefined, expected: string | null | undefined) => {
  if (expected !== undefined && (entry?.revision ?? null) !== expected) throw new TeamFilesError(409, "exists", "The template changed. Review its current version before publishing or removing it.");
};

function inspect(path: string): Stats | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new TeamFilesError(400, "link", "Templates never follow links.");
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function directory(path: string): boolean {
  const stat = inspect(path);
  if (stat && !stat.isDirectory()) throw unavailable();
  return stat !== null;
}

function syncDirectory(path: string): void {
  // Windows does not expose POSIX directory fsync through Node's fs API.
  if (process.platform === "win32") return;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function readBounded(path: string, limit: number): Buffer {
  const stat = inspect(path);
  if (!stat?.isFile() || stat.size > limit) throw unavailable();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const current = fstatSync(fd);
    if (!current.isFile() || current.ino !== stat.ino || current.dev !== stat.dev || current.size !== stat.size) throw unavailable();
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0, taken = 0;
    while ((taken = readSync(fd, bytes, count, bytes.length - count, null)) > 0) {
      count += taken;
      if (count > stat.size) throw unavailable();
    }
    const after = inspect(path);
    if (count !== stat.size || !after || after.ino !== stat.ino || after.dev !== stat.dev || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw unavailable();
    return bytes.subarray(0, count);
  } finally { closeSync(fd); }
}

function assertTree(path: string): void {
  if (!directory(path)) return;
  const pending = [path];
  let count = 0;
  while (pending.length) {
    const parent = pending.pop()!;
    for (const name of readdirSync(parent)) {
      if (++count > 20_000) throw unavailable();
      const child = join(parent, name), stat = inspect(child);
      if (stat?.isDirectory()) pending.push(child);
      else if (!stat?.isFile()) throw unavailable();
    }
  }
}

function readTemplateFolder(root: string): ShareFolderFiles {
  if (!directory(root)) throw gone();
  const files: ShareFolderFiles = {};
  let total = 0;
  const read = (path: string) => {
    if (safeFolderPath(path) !== path) throw unavailable();
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) if (!directory(join(root, ...parts.slice(0, i)))) throw unavailable();
    const file = join(root, path), bytes = readBounded(file, SHARE_FOLDER_MAX_BYTES - total);
    if (relative(realpathSync(root), realpathSync(file)).split(sep).join("/") !== path) throw unavailable();
    files[path] = bytes;
    total += bytes.length;
    return bytes;
  };
  for (const name of Object.values(MANIFEST_NAMES)) {
    if (!inspect(join(root, name))) continue;
    const manifest = read(name).toString("utf8");
    for (const path of namedFolderFiles(manifest)) if (!Object.hasOwn(files, path)) read(path);
  }
  const parsed = readShareFolder(files);
  if (parsed.kind !== "package") throw unavailable();
  return files;
}

export function createTeamTemplates(dataDir: string, files: TeamFiles, now: () => number = Date.now) {
  const share = join(dataDir, "share"), indexFile = join(share, "team-library.json"), journalFile = join(share, TRANSACTION);
  const root = join(files.root(), TEAM_FILES_TEMPLATES);
  const ensureShare = () => {
    mkdirSync(share, { recursive: true, mode: 0o700 });
    if (!directory(share) || realpathSync(share) !== join(realpathSync(dataDir), "share")) throw unavailable();
    syncDirectory(dataDir);
    syncDirectory(files.root());
  };
  const readIndex = (): Index => {
    if (!inspect(indexFile)) return { v: 1, templates: {} };
    try { return indexSchema.parse(JSON.parse(readBounded(indexFile, MAX_INDEX_BYTES).toString("utf8"))); }
    catch { throw unavailable(); }
  };
  const write = (path: string, value: unknown) => {
    writeFileAtomic(path, JSON.stringify(value), { mode: 0o600 });
    syncDirectory(dirname(path));
  };
  const move = (from: string, to: string) => {
    if (inspect(to)) throw unavailable();
    renameWithRetry(from, to);
    syncDirectory(dirname(from));
    if (dirname(from) !== dirname(to)) syncDirectory(dirname(to));
  };
  const clean = (journal: Journal) => {
    const staged = join(share, transactionName.parse(journal.id));
    if (directory(staged)) rmSync(staged, { recursive: true });
    syncDirectory(share);
    rmSync(journalFile, { force: true });
    syncDirectory(share);
  };
  const recover = () => {
    if (!inspect(journalFile)) return;
    let journal: Journal;
    try { journal = journalSchema.parse(JSON.parse(readBounded(journalFile, MAX_INDEX_BYTES * 2 + 4096).toString("utf8"))); }
    catch { throw unavailable(); }
    const staged = join(share, transactionName.parse(journal.id));
    const target = join(root, journal.slug), previous = `${target}.previous`, incoming = join(staged, "incoming"), current = join(staged, "current"), older = join(staged, "previous");
    if (journal.state === "pending") {
      if (!directory(staged)) throw unavailable();
      const installed = journal.operation === "add" && !directory(incoming);
      if (journal.hadTarget && !directory(current) && directory(previous) && (!directory(target) || installed)) move(previous, current);
      if (installed) move(target, incoming);
      if (directory(current)) move(current, target);
      if (directory(older)) move(older, previous);
      write(indexFile, journal.before);
      journal.state = "rolled_back";
      write(journalFile, journal);
    }
    const state = journal.state;
    clean(journal);
    return state;
  };
  const enter = (actor: TeamFilesActor, change: (guard: TeamTemplateMutationGuard) => void) => {
    files.templateMutation(actor, guard => {
      try {
        ensureShare();
        recover();
        guard.recovered();
      } catch (error) { guard.unavailable(); throw error; }
      change(guard);
    });
  };
  enter(admin, () => {
    // The data-directory lease permits one writer; directories without a journal were never committed.
    for (const name of readdirSync(share)) {
      if (/^team-template-[a-f0-9-]{36}$/.test(name) && directory(join(share, name))) rmSync(join(share, name), { recursive: true });
      if (/^(?:team-library\.json|team-template-transaction\.json)\.[0-9]+\.[a-f0-9-]{36}\.tmp$/.test(name) && inspect(join(share, name))?.isFile()) rmSync(join(share, name));
    }
    syncDirectory(share);
    readIndex();
  });
  const transact = (slug: string, incomingFiles: ShareFolderFiles | null, update: (before: Index, hadTarget: boolean) => Index | null, actor: TeamFilesActor, assertAllowed: () => void) => {
    enter(actor, guard => {
      assertAllowed();
      const target = join(root, slug), previous = `${target}.previous`;
      assertTree(target); assertTree(previous);
      const hadTarget = directory(target), hadPrevious = directory(previous);
      const before = readIndex(), next = update(before, hadTarget);
      if (!next) return;
      const after = indexSchema.parse(next);
      const bytes = Object.values(incomingFiles ?? {}).reduce((sum, value) => sum + Buffer.byteLength(value), 0);
      if (Object.values(incomingFiles ?? {}).some(value => Buffer.byteLength(value) > files.uploadMax)) throw new TeamFilesError(413, "too_large", "A template file exceeds the team's file limit.");
      guard.assertRoom(bytes, hadTarget ? `templates/${slug}.previous` : undefined);
      const journal: Journal = { v: 1, id: randomUUID(), slug, operation: incomingFiles ? "add" : "remove", state: "pending", hadTarget, hadPrevious, before, after };
      const staged = join(share, transactionName.parse(journal.id));
      mkdirSync(staged, { mode: 0o700 });
      let committed = false;
      try {
        if (incomingFiles) {
          const incoming = join(staged, "incoming");
          mkdirSync(incoming, { mode: 0o700 });
          for (const [path, value] of Object.entries(incomingFiles)) {
            if (safeFolderPath(path) !== path) throw unavailable();
            mkdirSync(dirname(join(incoming, path)), { recursive: true, mode: 0o700 });
            writeFileAtomic(join(incoming, path), value, { mode: 0o600 });
          }
          const pending = [incoming], directories: string[] = [];
          while (pending.length) {
            const dir = pending.pop()!; directories.push(dir);
            for (const name of readdirSync(dir)) if (directoryOrFile(join(dir, name))) pending.push(join(dir, name));
          }
          directories.reverse().forEach(syncDirectory);
          readTemplateFolder(incoming);
        }
        syncDirectory(staged);
        assertAllowed();
        guard.assertRoom(bytes, hadTarget ? `templates/${slug}.previous` : undefined);
        write(journalFile, journal);
        if (hadTarget && hadPrevious) move(previous, join(staged, "previous"));
        if (hadTarget) move(target, join(staged, "current"));
        if (incomingFiles) move(join(staged, "incoming"), target);
        if (hadTarget) move(join(staged, "current"), previous);
        assertAllowed();
        write(indexFile, after);
        journal.state = "committed";
        write(journalFile, journal);
        committed = true;
        clean(journal);
      } catch (error) {
        try {
          if (inspect(journalFile)) committed = recover() === "committed" || committed;
          else { rmSync(staged, { recursive: true, force: true }); syncDirectory(share); }
        } catch { guard.unavailable(); throw unavailable(); }
        if (committed) return;
        throw error;
      }
    });
  };
  const assertSlug = (slug: string) => { if (!TEAM_TEMPLATE_SLUG.test(slug)) throw gone(); };
  return {
    list(): TeamTemplate[] {
      let result: TeamTemplate[] = [];
      enter(admin, () => { result = Object.entries(readIndex().templates).filter(([slug]) => directory(join(root, slug))).map(([slug, entry]) => ({ slug, ...entry })).sort((a, b) => b.addedAt - a.addedAt); });
      return result;
    },
    add(slug: string, document: unknown, scope: TemplateScope, actor: TeamFilesActor, assertAllowed: () => void = () => undefined, expectedRevision?: string | null): { template: TeamTemplate; replaced: boolean } {
      assertSlug(slug); assertAllowed();
      if (!actor.admin) throw new TeamFilesError(403, "forbidden", "Only an administrator can publish templates.");
      const parsed = parsePackageDocument(document, { trust: "file" });
      if (scope !== "bot" && scope !== "department" || packageSecretFindings(parsed).length) throw new TeamFilesError(400, "bad_path", "Review the template scope and remove private credentials before publishing.");
      const incoming = writeShareFolder(parsed, scope);
      readShareFolder(incoming);
      let replaced = false;
      let entry = entrySchema.parse({ name: parsed.package.name, scope, tagline: parsed.package.tagline, release: parsed.package.release, revision: fingerprint(incoming), addedBy: actor.person, addedAt: now() });
      transact(slug, incoming, (before, hadTarget) => {
        checkRevision(before.templates[slug], expectedRevision);
        replaced = Boolean(before.templates[slug]);
        const existing = before.templates[slug];
        if (existing?.revision === entry.revision && hadTarget) {
          let unchanged = false;
          try { unchanged = fingerprint(readTemplateFolder(join(root, slug))) === entry.revision; } catch {}
          if (unchanged) { entry = existing; return null; }
        }
        if (!replaced && Object.keys(before.templates).length >= MAX_TEMPLATES) throw new TeamFilesError(409, "exists", "The team library holds at most 500 templates. Remove one first.");
        return { v: 1, templates: { ...before.templates, [slug]: entry } };
      }, actor, assertAllowed);
      return { template: { slug, ...entry }, replaced };
    },
    files(slug: string): ShareFolderFiles {
      assertSlug(slug);
      let result: ShareFolderFiles = {};
      enter(admin, () => {
        const entry = readIndex().templates[slug];
        if (!entry) throw gone();
        result = readTemplateFolder(join(root, slug));
        if (fingerprint(result) !== entry.revision) throw new TeamFilesError(409, "exists", "The published template files changed. Ask an administrator to review and publish them again.");
      });
      return result;
    },
    remove(slug: string, actor: TeamFilesActor, assertAllowed: () => void = () => undefined, expectedRevision?: string): void {
      assertSlug(slug); assertAllowed();
      if (!actor.admin) throw new TeamFilesError(403, "forbidden", "Only an administrator can remove templates.");
      transact(slug, null, before => {
        if (!before.templates[slug]) throw gone();
        checkRevision(before.templates[slug], expectedRevision);
        const templates = { ...before.templates }; delete templates[slug];
        return { v: 1, templates };
      }, actor, assertAllowed);
    },
  };
}

function directoryOrFile(path: string): boolean {
  const stat = inspect(path);
  if (!stat?.isFile() && !stat?.isDirectory()) throw unavailable();
  return stat.isDirectory();
}

export type TeamTemplates = ReturnType<typeof createTeamTemplates>;
