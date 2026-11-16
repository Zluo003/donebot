import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import type { Message } from "./store.ts";

const root = mkdtempSync(join(tmpdir(), "donebot-reuse-attachment-"));
process.env.DONEBOT_DATA_DIR = join(root, "data");
const { ATTACHMENTS_DIR } = await import("./attachments.ts");
const { openMessageFile } = await import("./message-file.ts");
const { existingAttachmentReceipt } = await import("./reused-attachment.ts");
mkdirSync(ATTACHMENTS_DIR, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const line = (path: string, name = "delivered.pdf", mime = "application/pdf"): Message => ({
  id: "delivered", at: 1, role: "bot", kind: "text", attachments: [{ kind: "file", path, name, mime }],
});
const noGenerated = async () => null;

it.each(["png", "mp4", "mp3", "pdf"])("reuses a delivered %s without copying, publishing or changing its name", async ext => {
  const path = join(ATTACHMENTS_DIR, `delivered.${ext}`);
  writeFileSync(path, "delivered bytes");
  const messages = [line(path, `original.${ext}`)];
  const receipt = await existingAttachmentReceipt(` ${path} `, () => messages, () => true, noGenerated);
  expect(receipt).toEqual({ ok: true, alreadyAttached: true, name: `original.${ext}`, path, bytes: 15 });
  expect(messages).toHaveLength(1);
});

it("does not grant sibling files, source paths, other conversations or preview-only images", async () => {
  const path = join(ATTACHMENTS_DIR, "private.pdf");
  writeFileSync(path, "private");
  const original = line(path);
  const preview: Message = { ...original, attachments: [{ kind: "image", path, mime: "image/png", fromTool: true }] };
  const open = vi.fn(noGenerated);
  for (const messages of [[], [line(join(ATTACHMENTS_DIR, "other.pdf"))], [preview], [
    { ...original, attachments: [{ kind: "file" as const, path: join(ATTACHMENTS_DIR, "copy.pdf"), source: path, mime: "application/pdf", name: "copy.pdf" }] },
  ]]) expect(await existingAttachmentReceipt(path, () => messages, () => true, open)).toBeNull();
  expect(open).not.toHaveBeenCalled();
});

it("reuses generated artifacts through their existing message-scoped opener", async () => {
  const path = join(root, "generated.png");
  writeFileSync(path, "generated");
  const open = vi.fn(async () => openMessageFile(path, [root]));
  expect(await existingAttachmentReceipt(path, () => [line(path)], () => true, open)).toMatchObject({ alreadyAttached: true, bytes: 9 });
  expect(open).toHaveBeenCalledWith("delivered", path);
});

it("preserves failures for missing files and symlink escapes", async () => {
  const missing = join(ATTACHMENTS_DIR, "missing.pdf");
  await expect(existingAttachmentReceipt(missing, () => [line(missing)], () => true, noGenerated)).rejects.toMatchObject({ status: 404 });
  const outside = join(root, "outside.pdf");
  writeFileSync(outside, "private");
  const escape = join(ATTACHMENTS_DIR, "escape.pdf");
  symlinkSync(outside, escape);
  await expect(existingAttachmentReceipt(escape, () => [line(escape)], () => true, noGenerated)).rejects.toMatchObject({ status: 403 });
});

it.each(["stopped", "removed"])("refuses reuse if the turn or attachment becomes %s while opening", async state => {
  const path = join(ATTACHMENTS_DIR, `${state}.pdf`);
  writeFileSync(path, "bytes");
  let messages = [line(path)], live = true;
  const open = async () => {
    if (state === "stopped") live = false;
    else messages = [];
    return null;
  };
  await expect(existingAttachmentReceipt(path, () => messages, () => live, open)).rejects.toMatchObject({ status: 409 });
});
