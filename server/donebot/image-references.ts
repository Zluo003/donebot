import { lstatSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { ATTACHMENTS_DIR } from "../attachments.ts";
import type { SendTurnInput, TurnImageInput } from "../contracts.ts";
import { extractTurnImages } from "../turn-images.ts";
import { describeMediaAsset } from "./thread-files.ts";

const SUPPORTED_IMAGE_MIMES: ReadonlySet<TurnImageInput["mime"]> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

type MessageAttachmentLike = {
  kind?: string;
  path?: string;
  mime?: string;
  name?: string;
};

type MessageLike = {
  id: string;
  role: string;
  text?: string;
  attachments?: readonly MessageAttachmentLike[];
};

function normalizeImageMime(mime?: string, filePath?: string): TurnImageInput["mime"] | null {
  const lower = (mime || "").toLowerCase().trim();
  if (lower === "image/jpg") return "image/jpeg";
  if (SUPPORTED_IMAGE_MIMES.has(lower as TurnImageInput["mime"])) return lower as TurnImageInput["mime"];
  const p = (filePath || "").toLowerCase();
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
  if (p.endsWith(".webp")) return "image/webp";
  if (p.endsWith(".gif")) return "image/gif";
  return null;
}

export function doneBotImageReferences(
  messages: readonly MessageLike[],
  current: readonly TurnImageInput[],
  attachmentsDir?: string,
): NonNullable<SendTurnInput["imageReferences"]> {
  const currentPaths = new Set(current.map(image => image.path));
  const references: NonNullable<SendTurnInput["imageReferences"]> = [];
  const rootAttachmentsDir = attachmentsDir ?? ATTACHMENTS_DIR;

  for (const message of messages) {
    const addedForMessage = new Set<string>();
    if (message.role === "user" && message.text) {
      const resolved = extractTurnImages(message.text, { attachmentsDir, maxCount: Infinity, maxBytes: Infinity });
      for (const [index, image] of resolved.images.entries()) {
        addedForMessage.add(image.path);
        references.push({ image, messageId: message.id, position: index + 1, text: resolved.text, current: currentPaths.has(image.path) });
      }
    }
    if (Array.isArray(message.attachments) && message.attachments.length > 0) {
      let pos = addedForMessage.size;
      for (const att of message.attachments) {
        const rawPath = att.path?.trim();
        if (!rawPath) continue;
        const mime = normalizeImageMime(att.mime, rawPath);
        if (!mime) continue;
        const resolvedPath = isAbsolute(rawPath) ? rawPath : join(rootAttachmentsDir, rawPath);
        if (addedForMessage.has(resolvedPath)) continue;
        let bytes = 0;
        try {
          const info = lstatSync(resolvedPath);
          if (info.isSymbolicLink() || !info.isFile() || info.size <= 0) continue;
          bytes = info.size;
        } catch {
          continue;
        }
        addedForMessage.add(resolvedPath);
        pos += 1;
        const fileName = att.name || basename(resolvedPath);
        const meta = describeMediaAsset(resolvedPath) ?? describeMediaAsset(fileName);
        const refNote = meta?.references?.length ? `（参考素材：${meta.references.join(", ")}）` : "";
        const contextText = meta
          ? `[Bot生成图片 · ${meta.model || "media"}] ${meta.prompt || fileName}${refNote}（文件名：${fileName}）`
          : message.role === "bot"
            ? `[Bot附加图片] ${message.text?.trim() || fileName}（文件名：${fileName}）`
            : `${message.text?.trim() || fileName}（文件名：${fileName}）`;
        references.push({
          image: { path: resolvedPath, mime, bytes },
          messageId: message.id,
          position: pos,
          text: contextText,
          current: currentPaths.has(resolvedPath),
        });
      }
    }
  }
  for (const image of current) if (!references.some(reference => reference.image.path === image.path)) {
    references.push({ image, messageId: "current", position: current.indexOf(image) + 1, text: image.source === "video-frame" ? "Frame sampled from the current attached video" : "Current attachment", current: true });
  }
  return references;
}
