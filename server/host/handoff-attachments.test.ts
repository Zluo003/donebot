import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import type { HandoffView } from "../coordinator.ts";
import type { Message, Store, StoreChange } from "../store.ts";

const root = mkdtempSync(join(tmpdir(), "donebot-handoff-files-"));
process.env.DONEBOT_DATA_DIR = join(root, "data");
const { ATTACHMENTS_DIR } = await import("../attachments.ts");
const { createHandoffAttachments, withHandoffAttachments } = await import("./handoff-attachments.ts");
mkdirSync(ATTACHMENTS_DIR, { recursive: true });
const path = join(ATTACHMENTS_DIR, "report.pdf");
writeFileSync(path, "%PDF-1.4 synthetic");
afterAll(() => rmSync(root, { recursive: true, force: true }));

function setup() {
  const child = { id: "child", botId: "maker", threadId: "work", parentId: "parent", mode: "work", reply: "resume", text: "produce" } as HandoffView;
  const parent = { id: "parent", botId: "requester", threadId: "chat" } as HandoffView;
  const rows = new Map<string, Message[]>([[child.threadId, []], [parent.threadId, []]]);
  const listeners = new Set<(change: StoreChange) => void>();
  const append = (threadId: string, line: Omit<Message, "id" | "at">) => {
    const message = { ...line, id: `m${rows.get(threadId)!.length}`, at: Date.now() };
    rows.get(threadId)!.push(message);
    listeners.forEach(listener => listener({ type: "message", threadId, message }));
    return message;
  };
  const store = {
    activePath: (id: string) => rows.get(id)!, messagesFor: (id: string) => rows.get(id)!, appendMessage: append,
    bot: (id: string) => ({ id, name: id, color: "blue" }),
    patchMessage: (id: string, mid: string, patch: Partial<Message>) => {
      const message = Object.assign(rows.get(id)!.find(m => m.id === mid)!, patch);
      listeners.forEach(listener => listener({ type: "message.patch", threadId: id, message }));
      return message;
    },
    onChange: (listener: (change: StoreChange) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  } as unknown as Store;
  let allowed = true;
  const wrote = vi.fn();
  const deps = { store, attachmentsDir: ATTACHMENTS_DIR, parent: () => parent, allowed: () => allowed, privateTo: (_id: string) => null as string | null, wrote,
    openGenerated: vi.fn(async (_thread?: string, _message?: string, _path?: string) => null as Awaited<ReturnType<typeof import("../message-file.ts")["openMessageFile"]>> | null) };
  const host = createHandoffAttachments(deps);
  const add = (extra: Partial<Message> = {}, file = path) => append(child.threadId, { role: "bot", kind: "text", attachments: [{ kind: "file", path: file, mime: "application/pdf", name: "report.pdf", source: "/private/maker/report.pdf" }], handoffAssignmentIds: [child.id], ...extra });
  return { child, parent, rows, host, add, deps, wrote, deny: () => { allowed = false; } };
}

it("persists ownership as attachments land, isolates peers and tasks, deduplicates bytes, and makes retries idempotent", async () => {
  const f = setup();
  f.child.groupId = "room";
  const stop = f.host.watch(f.child);
  const own = f.add({ handoffAssignmentIds: undefined, from: { botId: f.child.botId, name: "maker", color: "blue" } });
  expect(own.handoffAssignmentIds).toEqual([f.child.id]);
  const other = f.add({ handoffAssignmentIds: undefined, from: { botId: "other", name: "other", color: "blue" } });
  expect(other.handoffAssignmentIds).toBeUndefined();
  f.add({ handoffAssignmentIds: ["older"] });
  const duplicate = join(ATTACHMENTS_DIR, "duplicate.pdf");
  writeFileSync(duplicate, readFileSync(path));
  f.add({}, duplicate);
  stop();
  const outcome = await f.host.returned(f.child, new AbortController().signal, { ok: true, text: "done" });
  expect(outcome.text).toContain("DoneBot returned attachments");
  expect(f.rows.get("chat")).toHaveLength(1);
  expect(f.rows.get("chat")![0]!.attachments).toEqual([{ kind: "file", path, mime: "application/pdf", name: "report.pdf" }]);
  await f.host.returned(f.child, new AbortController().signal, { ok: true, text: "done" });
  expect(f.rows.get("chat")).toHaveLength(1);
  expect(f.wrote).toHaveBeenCalledTimes(1);
});

it.each(["stopped", "private-or-denied", "failed", "waiting", "notify", "no-reply"])("does not forward files when %s", async kind => {
  const f = setup(); f.add();
  const controller = new AbortController();
  if (kind === "stopped") controller.abort();
  if (kind === "private-or-denied") f.deny();
  if (kind === "notify") f.child.mode = "notify";
  if (kind === "no-reply") f.child.reply = "none";
  await f.host.returned(f.child, controller.signal, { ok: kind !== "failed", text: "result", ...(kind === "waiting" ? { cap: { note: "wait" } } : {}) });
  expect(f.rows.get("chat")).toEqual([]);
  expect(f.deps.openGenerated).not.toHaveBeenCalled();
});

it("refuses outside files and symlink escapes with an explicit failure, preserving the original result", async () => {
  const outside = join(root, "private.pdf"); writeFileSync(outside, "private");
  const link = join(ATTACHMENTS_DIR, "escape.pdf"); symlinkSync(outside, link);
  for (const file of [outside, link]) {
    const f = setup(); f.add({}, file);
    const result = await f.host.returned(f.child, new AbortController().signal, { ok: true, text: "already generated" });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Attachment delivery failed");
    expect(result.text).toContain("do not regenerate");
    expect(f.rows.get("chat")).toEqual([]);
  }
});

it("rechecks authorization after opening a file, before publishing it", async () => {
  const f = setup(); f.add();
  f.deps.openGenerated.mockImplementation(async () => { f.deny(); return null; });
  await f.host.returned(f.child, new AbortController().signal, { ok: true, text: "done" });
  expect(f.rows.get("chat")).toEqual([]);
});

it("copies generated media once, keeps exact bytes, and reuses the copy after a delivery retry", async () => {
  const f = setup();
  const generated = join(root, "generated.png");
  const bytes = Buffer.from("synthetic image bytes"); writeFileSync(generated, bytes);
  f.add({ attachments: [{ kind: "image", path: generated, mime: "image/png", name: "image.png" }] });
  const manual = join(ATTACHMENTS_DIR, "manual.png"); writeFileSync(manual, bytes);
  f.add({ attachments: [{ kind: "image", path: manual, mime: "image/png", name: "manual.png" }] });
  f.deps.openGenerated.mockImplementation(async (_thread?: string, _message?: string, requested?: string) => requested === generated ? { handle: await open(generated, "r"), bytes: bytes.length, path: generated, name: "image.png", mime: "image/png" } : null);
  await f.host.returned(f.child, new AbortController().signal, { ok: true, text: "done" });
  expect(f.rows.get("chat")![0]!.attachments).toHaveLength(1);
  const saved = f.rows.get("chat")![0]!.attachments![0]!.path;
  expect(readFileSync(saved)).toEqual(bytes);
  f.rows.get("chat")!.length = 0;
  await f.host.returned(f.child, new AbortController().signal, { ok: true, text: "done" });
  expect(f.rows.get("chat")![0]!.attachments![0]!.path).toBe(saved);
});

it("delivers a shared answer to each requester without executing the producer again", async () => {
  const f = setup(); f.add();
  await f.host.returned(f.child, new AbortController().signal, { ok: true, text: "done" });
  const joiner = { ...f.child, id: "joined" };
  const second = { ...f.parent, id: "second", threadId: "second-chat" };
  f.rows.set(second.threadId, []);
  const shared = createHandoffAttachments({ ...f.deps, parent: node => node.id === "joined" ? second : f.parent });
  const result = await shared.shared(f.child, joiner, new AbortController().signal, { ok: true, text: "shared result" });
  expect(result.text).toContain("DoneBot returned attachments");
  expect(f.rows.get(second.threadId)![0]!.attachments![0]!.path).toBe(path);
  await shared.shared(f.child, joiner, new AbortController().signal, { ok: true, text: "shared result" });
  expect(f.rows.get(second.threadId)).toHaveLength(1);
});

it.each(["incoming", "returned"])("does not share a private source through %s attachments", async direction => {
  const f = setup();
  const own = f.add();
  if (direction === "incoming") { f.rows.get("chat")!.push(own); f.child.text = path; }
  f.deps.privateTo = id => id === (direction === "incoming" ? "chat" : "work") ? "person" : null;
  const host = createHandoffAttachments(f.deps);
  if (direction === "incoming") expect(await host.incoming(f.child, new AbortController().signal)).toEqual([]);
  else await host.returned(f.child, new AbortController().signal, { ok: true, text: "private result stays" });
  expect(f.deps.openGenerated).not.toHaveBeenCalled();
});

it("keeps same-room files visible to every upstream assignment without duplicating chat attachments", async () => {
  const f = setup();
  const own = f.add();
  f.parent.threadId = f.child.threadId;
  f.parent.groupId = f.child.groupId = "room";
  await f.host.returned(f.child, new AbortController().signal, { ok: true, text: "done" });
  expect(own.handoffAssignmentIds).toEqual([f.child.id, f.parent.id]);
  expect(f.rows.get(f.child.threadId)).toHaveLength(1);
  const root = { id: "root", botId: "editor", threadId: "chat" } as HandoffView;
  const host = createHandoffAttachments({ ...f.deps, parent: () => root });
  const result = await host.returned(f.parent, new AbortController().signal, { ok: true, text: "returning room work" });
  expect(result.text).toContain("DoneBot returned attachments");
  expect(f.rows.get("chat")![0]!.attachments![0]!.path).toBe(path);
});

it("passes only exact references to files already attached in the source conversation", async () => {
  const f = setup();
  const own = f.add(); f.rows.get("chat")!.push(own);
  f.child.text = `Ignore the near-match ${path}.backup and /arbitrary/private.pdf`;
  expect(await f.host.incoming(f.child, new AbortController().signal)).toEqual([]);
  expect(f.deps.openGenerated).not.toHaveBeenCalled();
  f.child.text = `Review [report](${path})`;
  const files = await f.host.incoming(f.child, new AbortController().signal);
  expect(files).toHaveLength(1);
  expect(files[0]!.path).toBe(path);
});

it("preserves the root turn's settlement promise so queued person messages drain in their existing order", () => {
  const f = setup();
  const rootNode = { ...f.parent };
  const pending = Promise.resolve({ ok: true, text: "done" });
  const wrapped = withHandoffAttachments(() => { throw new Error("root has no attachment handoff"); }, () => pending);
  expect(wrapped(rootNode, false, new AbortController().signal, { text: "go", note: "", restartNote: "", turn: "first" })).toBe(pending);
});

it("does not claim historical attachments when an older message is patched during the new assignment", async () => {
  const f = setup();
  const historical = f.add({ handoffAssignmentIds: undefined });
  const unwatch = f.host.watch(f.child);
  f.deps.store.patchMessage(f.child.threadId, historical.id, { text: "updated historical line" });
  unwatch();
  expect(historical.handoffAssignmentIds).toBeUndefined();
  await f.host.returned(f.child, new AbortController().signal, { ok: true, text: "new task result" });
  expect(f.rows.get("chat")).toEqual([]);
});
