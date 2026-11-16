/** Server-recorded file messages a reply reports, in the same conversation. Discovery only, never a file access grant. */
export interface ArtifactReportField {
  reportedAttachmentMessageIds?: string[];
}

/** One file reported by a bot. File access is always checked against messageId in threadId; reportMessageId is navigation only. */
export interface BotArtifact {
  id: string;
  title: string;
  name: string;
  path: string;
  mime?: string;
  kind: "image" | "video" | "audio" | "document";
  at: number;
  threadId: string;
  threadTitle: string;
  messageId: string;
  reportMessageId: string;
  previewUrl: string;
}

/** GET /api/bots/:id/artifacts. The opaque cursor continues strictly after the last file in descending report order. */
export interface BotArtifactPage {
  items: BotArtifact[];
  nextCursor: string | null;
}
