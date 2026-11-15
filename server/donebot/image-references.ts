import type { SendTurnInput, TurnImageInput } from "../contracts.ts";
import { extractTurnImages } from "../turn-images.ts";

export function doneBotImageReferences(
  messages: readonly { id: string; role: string; text?: string }[],
  current: readonly TurnImageInput[],
  attachmentsDir?: string,
): NonNullable<SendTurnInput["imageReferences"]> {
  const currentPaths = new Set(current.map(image => image.path));
  const references: NonNullable<SendTurnInput["imageReferences"]> = [];
  for (const message of messages) {
    if (message.role !== "user" || !message.text) continue;
    const resolved = extractTurnImages(message.text, { attachmentsDir, maxCount: Infinity, maxBytes: Infinity });
    for (const [index, image] of resolved.images.entries()) references.push({ image, messageId: message.id, position: index + 1, text: resolved.text, current: currentPaths.has(image.path) });
  }
  for (const image of current) if (!references.some(reference => reference.image.path === image.path)) {
    references.push({ image, messageId: "current", position: current.indexOf(image) + 1, text: image.source === "video-frame" ? "Frame sampled from the current attached video" : "Current attachment", current: true });
  }
  return references;
}
