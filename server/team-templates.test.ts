import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import * as atomic from "./atomic.ts";
import { createTeamFiles, type TeamFiles } from "./host/team-files.ts";
import { createTeamTemplates } from "./team-templates.ts";
import { teamTemplateFixture as fixtureDocument } from "./testing/team-template-fixture.ts";
import { readShareFolder, writeShareFolder } from "../shared/share-folder.ts";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const admin = { person: "admin", admin: true }, member = { person: "member", admin: false };
const allocate = () => { const root = mkdtempSync(join(tmpdir(), "donebot-team-templates-")); roots.push(root); return root; };
function setup(cap = 100_000, uploadMax = cap) {
  const root = allocate(), files = createTeamFiles({ dataDir: root, cap, uploadMax });
  return { root, files, library: createTeamTemplates(root, files, () => 100) };
}
const packageAt = (files: ReturnType<typeof writeShareFolder>) => {
  const folder = readShareFolder(files);
  if (folder.kind !== "package") throw new Error("not a package");
  return folder.document;
};
const bytes = (release = "1.0.0") => Object.values(writeShareFolder(fixtureDocument(release), "bot")).reduce((sum, data) => sum + Buffer.byteLength(data), 0);

it("publishes parsed files, keeps one previous version, and revalidates every import", () => {
  const { root, files, library } = setup();
  expect(library.list()).toEqual([]);
  expect(library.add("helper", fixtureDocument(), "bot", admin)).toMatchObject({ replaced: false, template: { slug: "helper", addedBy: "admin", addedAt: 100 } });
  expect(packageAt(library.files("helper"))).toEqual(fixtureDocument());
  expect(readFileSync(join(root, "team-files/templates/helper/skills/report/scripts/report.py"), "utf8")).toContain("TEMPLATE_SCRIPT_MUST_NOT_RUN");
  library.add("helper", fixtureDocument("2.0.0"), "bot", admin);
  expect(readFileSync(join(root, "team-files/templates/helper.previous/bot.md"), "utf8")).toContain("1.0.0");
  expect(files.used()).toBe(bytes() + bytes("2.0.0"));
  library.add("helper", fixtureDocument("3.0.0"), "bot", admin);
  expect(files.used()).toBe(bytes("2.0.0") + bytes("3.0.0"));
  expect(readdirSync(join(root, "team-files/templates"))).toEqual(["helper", "helper.previous"]);
  library.remove("helper", admin);
  expect(library.list()).toEqual([]);
  expect(() => library.files("helper")).toThrowError(expect.objectContaining({ status: 404 }));
  expect(files.used()).toBe(bytes("3.0.0"));
  library.add("helper", fixtureDocument("4.0.0"), "bot", admin);
  expect(readFileSync(join(root, "team-files/templates/helper.previous/bot.md"), "utf8")).toContain("3.0.0");
  writeFileSync(join(root, "team-files/templates/helper/bot.md"), "not a template");
  expect(() => library.files("helper")).toThrow();
  expect(readdirSync(join(root, "share"))).toEqual(["team-library.json"]);
});

it("refuses members, unsafe slugs, invalid documents, and invalid scope before creating template data", () => {
  const { root, library } = setup();
  expect(() => library.add("helper", fixtureDocument(), "bot", member)).toThrowError(expect.objectContaining({ status: 403 }));
  expect(() => library.remove("helper", member)).toThrowError(expect.objectContaining({ status: 403 }));
  for (const slug of ["../helper", "a/b", "Helper", "", "a".repeat(49)]) {
    expect(() => library.add(slug, fixtureDocument(), "bot", admin)).toThrowError(expect.objectContaining({ status: 404 }));
  }
  expect(() => library.add("helper", {}, "bot", admin)).toThrow();
  expect(() => library.add("helper", fixtureDocument(), "other" as never, admin)).toThrow();
  expect(readdirSync(join(root, "team-files/templates"))).toEqual([]);
});

it("counts current and retained templates, reclaims only the replaced previous version, and invalidates usage", () => {
  const size = bytes(), { library, files } = setup(size * 2);
  library.add("helper", fixtureDocument(), "bot", admin);
  expect(files.used()).toBe(size);
  library.add("helper", fixtureDocument("2.0.0"), "bot", admin);
  expect(files.full()).toBe(true);
  expect(() => library.add("other", fixtureDocument(), "bot", admin)).toThrowError(expect.objectContaining({ status: 507 }));
  library.add("helper", fixtureDocument("3.0.0"), "bot", admin);
  library.remove("helper", admin);
  expect(files.used()).toBe(size);
});

it("refuses stale publication and removal, and notices valid but unreviewed file edits", () => {
  const { root, library } = setup();
  const first = library.add("helper", fixtureDocument(), "bot", admin, undefined, null).template;
  expect(() => library.add("helper", fixtureDocument("2.0.0"), "bot", admin, undefined, null)).toThrowError(expect.objectContaining({ status: 409 }));
  const second = library.add("helper", fixtureDocument("2.0.0"), "bot", admin, undefined, first.revision).template;
  expect(second.revision).not.toBe(first.revision);
  expect(() => library.remove("helper", admin, undefined, first.revision)).toThrowError(expect.objectContaining({ status: 409 }));
  expect(() => library.add("helper", fixtureDocument("3.0.0"), "bot", admin, undefined, first.revision)).toThrowError(expect.objectContaining({ status: 409 }));
  writeFileSync(join(root, "team-files/templates/helper/bot.md"), writeShareFolder(fixtureDocument("3.0.0"), "bot")["bot.md"]!);
  expect(() => library.files("helper")).toThrowError(expect.objectContaining({ status: 409 }));
  library.remove("helper", admin, undefined, second.revision);
});

it("does not replace the retained version when the exact same publication is confirmed twice", () => {
  const { root, library, files } = setup();
  library.add("helper", fixtureDocument(), "bot", admin);
  const second = library.add("helper", fixtureDocument("2.0.0"), "bot", admin).template;
  const repeated = library.add("helper", fixtureDocument("2.0.0"), "bot", { person: "another-admin", admin: true }, undefined, second.revision);
  expect(repeated.template).toEqual(second);
  expect(files.used()).toBe(bytes() + bytes("2.0.0"));
  expect(readFileSync(join(root, "team-files/templates/helper.previous/bot.md"), "utf8")).toContain("1.0.0");
});

it("respects single-file limits and unrelated uploads' byte reservations", async () => {
  const { root, library, files } = setup(bytes() + 5);
  const held = new PassThrough(), uploading = files.upload("", "other.txt", held, 6, member);
  try {
    expect(() => library.add("helper", fixtureDocument(), "bot", admin)).toThrowError(expect.objectContaining({ status: 507 }));
  } finally { held.end("123456"); await uploading; }
  expect(readdirSync(join(root, "team-files/templates"))).toEqual([]);
  const small = setup(100_000, 20);
  expect(() => small.library.add("helper", fixtureDocument(), "bot", admin)).toThrowError(expect.objectContaining({ status: 413 }));
});

it("does not race active uploads to the template tree, including case aliases", async () => {
  const { library, files } = setup();
  for (const name of ["templates", "Templates"]) {
    if (!existsSync(join(files.root(), name))) files.folder(name, admin);
    const held = new PassThrough(), uploading = files.upload(name, "pending", held, 1, admin);
    try { expect(() => library.add("helper", fixtureDocument(), "bot", admin)).toThrowError(expect.objectContaining({ status: 409 })); }
    finally { held.end("a"); await uploading; }
  }
  library.add("helper", fixtureDocument(), "bot", admin);
});

it("rolls back when permission is revoked immediately before or after the directory swaps", () => {
  const { root, library } = setup();
  library.add("helper", fixtureDocument(), "bot", admin);
  for (const stopAt of [3, 4]) {
    let checks = 0;
    expect(() => library.add("helper", fixtureDocument("2.0.0"), "bot", admin, () => {
      if (++checks === stopAt) throw new Error("revoked");
    })).toThrow("revoked");
    expect(packageAt(library.files("helper")).package.release).toBe("1.0.0");
    expect(readdirSync(join(root, "team-files/templates"))).toEqual(["helper"]);
    expect(readdirSync(join(root, "share"))).toEqual(["team-library.json"]);
  }
});

it("restores both current and previous after an index write fails", () => {
  const { root, library } = setup();
  library.add("helper", fixtureDocument(), "bot", admin); library.add("helper", fixtureDocument("2.0.0"), "bot", admin);
  const write = atomic.writeFileAtomic;
  let failed = false;
  vi.spyOn(atomic, "writeFileAtomic").mockImplementation((path, data, options) => {
    if (!failed && path.endsWith("team-library.json")) { failed = true; throw new Error("disk full"); }
    return write(path, data, options);
  });
  expect(() => library.add("helper", fixtureDocument("3.0.0"), "bot", admin)).toThrow("disk full");
  expect(packageAt(library.files("helper")).package.release).toBe("2.0.0");
  expect(readFileSync(join(root, "team-files/templates/helper.previous/bot.md"), "utf8")).toContain("1.0.0");
});

it("blocks ordinary template reads and writes if recovery cannot complete, then recovers on restart", async () => {
  const { root, files, library } = setup();
  library.add("helper", fixtureDocument(), "bot", admin);
  const write = atomic.writeFileAtomic;
  vi.spyOn(atomic, "writeFileAtomic").mockImplementation((path, data, options) => {
    if (path.endsWith("team-library.json")) throw new Error("disk unavailable");
    return write(path, data, options);
  });
  expect(() => library.add("helper", fixtureDocument("2.0.0"), "bot", admin)).toThrowError(expect.objectContaining({ status: 503 }));
  expect(() => files.list("templates", member)).toThrowError(expect.objectContaining({ status: 503 }));
  expect(() => files.remove("templates", admin)).toThrowError(expect.objectContaining({ status: 503 }));
  vi.restoreAllMocks();
  const recovered = createTeamTemplates(root, files);
  expect(packageAt(recovered.files("helper")).package.release).toBe("1.0.0");
  expect(files.list("templates", member).entries).toHaveLength(1);
});

it("refuses linked manifests, skill parents, previous folders, metadata and corrupt indexes", () => {
  for (const target of ["team-files/templates/helper/bot.md", "team-files/templates/helper/skills", "team-files/templates/helper.previous", "share/team-library.json"]) {
    const { root, library } = setup();
    library.add("helper", fixtureDocument(), "bot", admin);
    const path = join(root, target);
    rmSync(path, { recursive: true, force: true });
    symlinkSync(root, path);
    expect(() => target.endsWith("previous") ? library.add("helper", fixtureDocument(), "bot", admin) : library.files("helper")).toThrow();
  }
  const { root, files } = setup();
  writeFileSync(join(root, "share/team-library.json"), "broken");
  expect(() => createTeamTemplates(root, files)).toThrowError(expect.objectContaining({ status: 503 }));
  expect(readFileSync(join(root, "share/team-library.json"), "utf8")).toBe("broken");
});

const crashScript = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const [root, moduleUrl, filesUrl, document, stop, operation] = process.argv.slice(1);
const { createTeamFiles } = await import(filesUrl);
const { createTeamTemplates } = await import(moduleUrl);
const files = createTeamFiles({ dataDir: root, cap: 100000, uploadMax: 100000 });
let library;
if (operation !== 'recover') library = createTeamTemplates(root, files);
const events = [];
for (const name of ['renameSync', 'fsyncSync', 'rmSync']) {
  const original = fs[name];
  fs[name] = (...args) => {
    const value = original(...args);
    events.push([name, typeof args[0] === 'string' ? args[0].slice(root.length) : 'fd', typeof args[1] === 'string' ? args[1].slice(root.length) : '']);
    if (events.length === Number(stop)) process.exit(77);
    return value;
  };
}
syncBuiltinESMExports();
if (operation === 'recover') createTeamTemplates(root, files);
else if (operation === 'remove') library.remove('helper', {person:'admin',admin:true});
else library.add('helper', JSON.parse(document), 'bot', {person:'admin',admin:true});
process.stdout.write(JSON.stringify(events));
`;
function child(root: string, stop = 0, operation = "add") {
  return spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", crashScript,
    root, pathToFileURL(join(import.meta.dirname, "team-templates.ts")).href,
    pathToFileURL(join(import.meta.dirname, "host/team-files.ts")).href, JSON.stringify(fixtureDocument("3.0.0")), String(stop), operation],
  { encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH, NODE_NO_WARNINGS: "1" } });
}

it.each(["add", "remove"])("recovers a real process exit after every filesystem commit checkpoint during %s", operation => {
  const { root: baseline, library } = setup();
  library.add("helper", fixtureDocument(), "bot", admin); library.add("helper", fixtureDocument("2.0.0"), "bot", admin);
  writeFileSync(join(baseline, "team-files/unrelated.txt"), "preserved");
  const probe = allocate(); cpSync(baseline, probe, { recursive: true });
  const finished = child(probe, 0, operation);
  expect(finished.status, finished.stderr).toBe(0);
  const events = JSON.parse(finished.stdout) as string[][];
  expect(events.length).toBeGreaterThan(12);
  for (let checkpoint = 1; checkpoint <= events.length; checkpoint++) {
    const root = allocate(); cpSync(baseline, root, { recursive: true });
    const crashed = child(root, checkpoint, operation);
    expect(crashed.status, `checkpoint ${checkpoint}: ${crashed.stderr}`).toBe(77);
    const files: TeamFiles = createTeamFiles({ dataDir: root, cap: 100_000, uploadMax: 100_000 });
    const recovered = createTeamTemplates(root, files);
    const listed = recovered.list();
    if (listed.length) {
      const release = packageAt(recovered.files("helper")).package.release;
      expect(listed[0]?.release).toBe(release);
      expect(["2.0.0", ...(operation === "add" ? ["3.0.0"] : [])]).toContain(release);
      expect(readFileSync(join(root, "team-files/templates/helper.previous/bot.md"), "utf8")).toContain(release === "2.0.0" ? "1.0.0" : "2.0.0");
    } else {
      expect(operation).toBe("remove");
      expect(existsSync(join(root, "team-files/templates/helper"))).toBe(false);
      expect(readFileSync(join(root, "team-files/templates/helper.previous/bot.md"), "utf8")).toContain("2.0.0");
    }
    expect(readFileSync(join(root, "team-files/unrelated.txt"), "utf8")).toBe("preserved");
    expect(readdirSync(join(root, "share"))).toEqual(["team-library.json"]);
    createTeamTemplates(root, files);
  }
  console.info(JSON.stringify({ operation, crashedAndRecoveredCheckpoints: events.length }));
}, 90_000);

it("can itself crash at every rollback checkpoint and still recover the original versions", () => {
  const { root: baseline, library } = setup();
  library.add("helper", fixtureDocument(), "bot", admin); library.add("helper", fixtureDocument("2.0.0"), "bot", admin);
  const probe = allocate(); cpSync(baseline, probe, { recursive: true });
  const finished = child(probe);
  expect(finished.status, finished.stderr).toBe(0);
  const events = JSON.parse(finished.stdout) as string[][];
  const beforeCommit = events.findIndex(event => event[0] === "renameSync" && event[2] === "/share/team-library.json") + 1;
  expect(beforeCommit).toBeGreaterThan(0);
  const interrupted = allocate(); cpSync(baseline, interrupted, { recursive: true });
  expect(child(interrupted, beforeCommit).status).toBe(77);
  const recoveryProbe = allocate(); cpSync(interrupted, recoveryProbe, { recursive: true });
  const recovery = child(recoveryProbe, 0, "recover");
  expect(recovery.status, recovery.stderr).toBe(0);
  const checkpoints = (JSON.parse(recovery.stdout) as string[][]).length;
  expect(checkpoints).toBeGreaterThan(12);
  for (let checkpoint = 1; checkpoint <= checkpoints; checkpoint++) {
    const root = allocate(); cpSync(interrupted, root, { recursive: true });
    const crashed = child(root, checkpoint, "recover");
    expect(crashed.status, `rollback ${checkpoint}: ${crashed.stderr}`).toBe(77);
    const files = createTeamFiles({ dataDir: root, cap: 100_000, uploadMax: 100_000 });
    const recovered = createTeamTemplates(root, files);
    expect(packageAt(recovered.files("helper")).package.release).toBe("2.0.0");
    expect(readFileSync(join(root, "team-files/templates/helper.previous/bot.md"), "utf8")).toContain("1.0.0");
    expect(readdirSync(join(root, "share"))).toEqual(["team-library.json"]);
  }
  console.info(JSON.stringify({ operation: "rollback", crashedAndRecoveredCheckpoints: checkpoints }));
}, 90_000);
