import { basename } from "node:path";
import { ATTACHMENTS_DIR, FILE_MAX_BYTES } from "./attachments.ts";
import { openMessageFile, type OpenedMessageFile } from "./message-file.ts";
import type { Message } from "./store.ts";

export async function existingAttachmentReceipt(
  requestedPath: string,
  messages: () => readonly Message[],
  stillLive: () => boolean,
  openGenerated: (messageId: string, path: string) => Promise<OpenedMessageFile | null>,
) {
  const path = requestedPath.trim();
  // Only an exact attachment on the active conversation grants reuse, never its source or a sibling store file.
  const find = () => messages().flatMap(message => (message.attachments ?? []).map(attachment => ({ message, attachment })))
    .find(({ attachment }) => attachment.path === path && !(attachment.kind === "image" && attachment.fromTool));
  const found = find();
  if (!found) return null;
  const { attachment } = found;
  const file = await openGenerated(found.message.id, path) ?? await openMessageFile(path, [ATTACHMENTS_DIR], FILE_MAX_BYTES);
  try {
    if (!stillLive() || !find()) {
      throw Object.assign(new Error("This turn or its attachment is no longer available, so nothing was posted."), { status: 409 });
    }
    const name = "name" in attachment && attachment.name ? attachment.name : basename(path);
    return { ok: true, alreadyAttached: true, name, path: attachment.path, bytes: file.bytes };
  } finally {
    await file.handle.close();
  }
}
