import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { createTeamFiles, TeamFilesError } from "./team-files.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const alice = { person: "alice", admin: false }, bob = { person: "bob", admin: false }, admin = { person: "admin", admin: true };
const body = (text: string) => Readable.from([Buffer.from(text)]);
function setup(cap = 64, uploadMax = 32) {
  const root = mkdtempSync(join(tmpdir(), "donebot-team-files-")); roots.push(root);
  return { root, files: createTeamFiles({ dataDir: root, cap, uploadMax }) };
}

it("reserves quota across overlapping uploads and releases it after completion or rejection", async () => {
  const { root, files } = setup(40, 32), held = new PassThrough();
  const first = files.upload("", "a", held, 30, alice);
  await expect(files.upload("", "b", body("b".repeat(20)), 20, bob)).rejects.toMatchObject({ status: 507 });
  held.end("a".repeat(30)); await first;
  await files.upload("", "b", body("b".repeat(10)), 10, bob);
  expect(files.used()).toBe(40);
  expect(readdirSync(join(root, "tmp/team-files-uploads"))).toEqual([]);
  files.remove("a", alice);
  await expect(files.upload("", "bad", body("bad"), 5, alice)).rejects.toMatchObject({ code: "incomplete" });
  await files.upload("", "a", body("a".repeat(30)), 30, alice);
  expect(files.used()).toBe(40);
});

it("rejects competing writes and folder moves until an upload finishes", async () => {
  const { files } = setup(), held = new PassThrough();
  files.folder("shared", alice);
  const first = files.upload("shared", "report", held, 2, alice);
  await expect(files.upload("shared", "report", body("bb"), 2, bob)).rejects.toMatchObject({ status: 409 });
  expect(() => files.remove("shared", admin)).toThrow(TeamFilesError);
  expect(() => files.rename("shared", "other", admin)).toThrow(TeamFilesError);
  held.end("aa"); await first;
  expect(files.list("shared", bob).entries[0]?.owner).toBe("alice");
});

it("rechecks authorization after receiving bytes and leaves no file when revoked", async () => {
  const { root, files } = setup(), held = new PassThrough();
  let live = true;
  const upload = files.upload("", "private", held, 2, alice, () => {
    if (!live) throw new TeamFilesError(403, "forbidden", "revoked");
  });
  live = false; held.end("aa");
  await expect(upload).rejects.toMatchObject({ status: 403 });
  expect(files.list("", admin).entries).toEqual([]);
  expect(readdirSync(join(root, "tmp/team-files-uploads"))).toEqual([]);
  await files.upload("", "private", body("aa"), 2, alice);
});

it("does not replace a destination changed while its body was arriving", async () => {
  const { root, files } = setup(), held = new PassThrough();
  await files.upload("", "report", body("old"), 3, alice);
  const upload = files.upload("", "report", held, 3, alice);
  writeFileSync(join(root, "team-files/report"), "someone else's newer result");
  held.end("new");
  await expect(upload).rejects.toMatchObject({ status: 409 });
  expect(readFileSync(join(root, "team-files/report"), "utf8")).toBe("someone else's newer result");
});

it("refuses final quota overflow when another writer changes the folder", async () => {
  const { root, files } = setup(32, 32), held = new PassThrough();
  const upload = files.upload("", "report", held, 20, alice);
  writeFileSync(join(root, "team-files/external"), "x".repeat(20));
  held.end("a".repeat(20));
  await expect(upload).rejects.toMatchObject({ status: 507 });
  expect(existsSync(join(root, "team-files/report"))).toBe(false);
});

it("does not let a folder's creator move or delete another member's empty folder", () => {
  const { files } = setup();
  files.folder("shared", alice); files.folder("shared/bob", bob);
  expect(files.mayRemove("shared", alice)).toBe(false);
  expect(() => files.rename("shared", "renamed", alice)).toThrow(TeamFilesError);
  expect(() => files.remove("shared", alice)).toThrow(TeamFilesError);
  files.rename("shared", "renamed", admin);
  expect(files.list("renamed", bob).entries[0]?.owner).toBe("bob");
});

it("treats prototype property names as ordinary owned filenames", async () => {
  const { root, files } = setup();
  for (const name of ["__proto__", "constructor", "toString"]) await files.upload("", name, body("a"), 1, alice);
  files.reload();
  expect(files.list("", bob).entries).toHaveLength(3);
  for (const name of ["__proto__", "constructor", "toString"]) {
    expect(files.mayRemove(name, bob)).toBe(false); files.remove(name, alice);
  }
  expect(JSON.parse(readFileSync(join(root, "team-files-activity.json"), "utf8")).owners).toEqual({});
});

it("rejects a replaced root and validates paths at the storage boundary", async () => {
  const { root, files } = setup();
  mkdirSync(join(root, "outside"));
  symlinkSync(join(root, "outside"), join(root, "team-files"));
  await expect(files.upload("", "secret", body("x"), 1, admin)).rejects.toMatchObject({ code: "link" });
  expect(readdirSync(join(root, "outside"))).toEqual([]);
  rmSync(join(root, "team-files"));
  await expect(files.upload("../outside", "secret", body("x"), 1, admin)).rejects.toMatchObject({ code: "bad_path" });
  await expect(files.upload("", "../secret", body("x"), 1, admin)).rejects.toMatchObject({ code: "bad_path" });
  for (const path of ["../outside", "/outside", "a//b"]) expect(() => files.list(path, admin)).toThrow(TeamFilesError);
});

it("removes only owned interrupted upload files when the service next writes", async () => {
  const { root, files } = setup();
  const staging = join(root, "tmp/team-files-uploads");
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "a1b2c3d4e5f60708.part"), "interrupted");
  writeFileSync(join(staging, "leave-me.txt"), "unrelated");
  await files.upload("", "new", body("a"), 1, alice);
  expect(readdirSync(staging)).toEqual(["leave-me.txt"]);
});

it("refuses a staging parent redirected outside its private data folder", async () => {
  const { root, files } = setup();
  mkdirSync(join(root, "outside"));
  symlinkSync(join(root, "outside"), join(root, "tmp"));
  await expect(files.upload("", "report", body("a"), 1, alice)).rejects.toMatchObject({ code: "link" });
  expect(readdirSync(join(root, "outside"))).toEqual([]);
});

it("protects the template library with every filesystem's case rules", async () => {
  const { files } = setup();
  for (const path of ["templates", "Templates", "TEMPLATES"]) {
    expect(() => files.folder(path, alice)).toThrow(TeamFilesError);
    await expect(files.upload("", path, body("a"), 1, alice)).rejects.toMatchObject({ status: 403 });
  }
});

it("keeps a folder list usable without granting deletion of a planted link", () => {
  const { root, files } = setup();
  files.folder("shared", alice);
  symlinkSync(root, join(root, "team-files/shared/link"));
  expect(files.mayRemove("shared", alice)).toBe(false);
  expect(files.list("", alice).entries).toMatchObject([{ name: "shared" }]);
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("refuses quota decisions when part of the folder cannot be inspected", async () => {
  const { root, files } = setup();
  files.folder("blocked", alice);
  const path = join(root, "team-files/blocked");
  chmodSync(path, 0);
  try {
    await expect(files.upload("", "new", body("a"), 1, alice)).rejects.toMatchObject({ status: 503, code: "unavailable" });
    expect(existsSync(join(root, "team-files/new"))).toBe(false);
  } finally { chmodSync(path, 0o700); }
});
