import { splitTranscriptCitations, type CitationAttachment } from "@/lib/citations";
import { splitTranscriptAttachments } from "@/lib/composer-attachments";
import { peerLine } from "@/lib/peer-message";
import type { Message } from "@/state/store";

export function unreadContextMessage(messages: readonly Message[], unreadMessageId?: string | null): Message | null {
  if (!unreadMessageId) return null;
  const at = messages.findIndex((message) => message.id === unreadMessageId);
  if (at < 0) return null;
  for (let i = at - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "user" && message.kind === "text" && !peerLine(message)) return message;
  }
  return null;
}

export type UnreadContextAttachment = "images" | "files" | "both";

export type UnreadContextContent = {
  text: string;
  citations: CitationAttachment[];
  imageCount: number;
  fileCount: number;
  attachment: UnreadContextAttachment | null;
};

export function unreadContextContent(message: Pick<Message, "text">): UnreadContextContent {
  const cited = splitTranscriptCitations(message.text ?? "");
  const attached = splitTranscriptAttachments(cited.display);
  const text = attached.display.trim();
  const empty = !text && cited.citations.length === 0;
  const attachment: UnreadContextAttachment | null = !empty
    ? null
    : attached.images.length > 0 && attached.files.length > 0
      ? "both"
      : attached.images.length > 0
        ? "images"
        : attached.files.length > 0 ? "files" : null;
  return { text, citations: cited.citations, imageCount: attached.images.length, fileCount: attached.files.length, attachment };
}

export function hasUnreadContextContent(content: UnreadContextContent): boolean {
  return Boolean(content.text || content.citations.length > 0 || content.attachment);
}

export const UNREAD_CONTEXT_CITATION_LIMIT = 3;

export function unreadContextCitations(
  citations: readonly CitationAttachment[],
  limit = UNREAD_CONTEXT_CITATION_LIMIT,
): { shown: CitationAttachment[]; hidden: number } {
  const keep = Math.max(0, limit);
  return { shown: citations.slice(0, keep), hidden: Math.max(0, citations.length - keep) };
}

export type RowRect = { top: number; bottom: number; height: number };

export function isRowOffscreen(row: RowRect | null, viewport: RowRect | null): boolean {
  if (!row || !viewport || row.height <= 0 || viewport.height <= 0) return false;
  return row.bottom <= viewport.top || row.top >= viewport.bottom;
}
