import path from "node:path";

export type ThreadFileKind = "image" | "video" | "music" | "audio" | "document" | "file";

export interface MediaAssetMeta {
  jobId: string;
  kind?: "image" | "video" | "music";
  model?: string;
  prompt?: string;
  references?: string[];
  createdAt?: number;
}

export interface ThreadFileEntry {
  path: string;
  name: string;
  mime?: string;
  kind?: ThreadFileKind;
  bytes?: number;
  at?: number;
  role?: "user" | "bot";
  messageId?: string;
  messageText?: string;
  jobId?: string;
  model?: string;
  prompt?: string;
  references?: string[];
  source?: "bot-generated" | "bot-attached" | "user-uploaded";
}

type MediaSourceHooks = {
  describeMedia: (filePathOrName: string) => MediaAssetMeta | undefined;
  listThreadMedia: (botId: string, threadId: string) => ThreadFileEntry[];
};

type StoreAttachmentReader = (threadId: string) => ThreadFileEntry[];

let mediaHooks: MediaSourceHooks | undefined;
let storeAttachmentReader: StoreAttachmentReader | undefined;

export function registerMediaThreadSource(hooks: MediaSourceHooks | undefined): void {
  mediaHooks = hooks;
}

export function registerStoreThreadAttachments(reader: StoreAttachmentReader | undefined): void {
  storeAttachmentReader = reader;
}

export function describeMediaAsset(filePathOrName: string): MediaAssetMeta | undefined {
  return mediaHooks?.describeMedia(filePathOrName);
}

export function inferThreadFileKind(mime?: string, filePath?: string, mediaKind?: string): ThreadFileKind {
  if (mediaKind === "image" || mediaKind === "video" || mediaKind === "music") return mediaKind;
  const m = (mime || "").toLowerCase();
  const ext = path.extname(filePath || "").toLowerCase();
  if (m.startsWith("image/") || [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"].includes(ext)) return "image";
  if (m.startsWith("video/") || [".mp4", ".mov", ".webm", ".mkv", ".avi"].includes(ext)) return "video";
  if (m.startsWith("audio/") || [".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac"].includes(ext)) return "audio";
  if (
    m.startsWith("text/")
    || m === "application/pdf"
    || m === "application/json"
    || m.includes("wordprocessingml")
    || m.includes("spreadsheetml")
    || m.includes("presentationml")
    || [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".md", ".txt", ".csv", ".json", ".yaml", ".yml", ".xml", ".html", ".srt", ".ts", ".js", ".py", ".sql"].includes(ext)
  ) {
    return "document";
  }
  return "file";
}

export function listUnifiedThreadFiles(
  botId: string | undefined,
  threadId: string | undefined,
  extraEntries: readonly ThreadFileEntry[] = [],
): ThreadFileEntry[] {
  const fromStore = threadId ? (storeAttachmentReader?.(threadId) ?? []) : [];
  const fromMedia = botId && threadId ? (mediaHooks?.listThreadMedia(botId, threadId) ?? []) : [];
  const all = [...fromStore, ...fromMedia, ...extraEntries];
  const byPath = new Map<string, ThreadFileEntry>();

  for (const raw of all) {
    const p = raw.path?.trim();
    if (!p) continue;
    const key = process.platform === "win32" ? p.toLowerCase() : p;
    const prev = byPath.get(key);
    const meta = mediaHooks?.describeMedia(p) ?? (raw.name ? mediaHooks?.describeMedia(raw.name) : undefined);
    const name = raw.name || prev?.name || path.basename(p);
    const mime = raw.mime || prev?.mime;
    const kind = inferThreadFileKind(mime, p, raw.kind || meta?.kind || prev?.kind);
    const merged: ThreadFileEntry = {
      path: p,
      name,
      ...(mime ? { mime } : {}),
      kind,
      ...(raw.bytes ?? prev?.bytes ? { bytes: raw.bytes ?? prev?.bytes } : {}),
      ...(raw.at ?? meta?.createdAt ?? prev?.at ? { at: raw.at ?? meta?.createdAt ?? prev?.at } : {}),
      ...(raw.role ?? prev?.role ? { role: raw.role ?? prev?.role } : {}),
      ...(raw.messageId ?? prev?.messageId ? { messageId: raw.messageId ?? prev?.messageId } : {}),
      ...(raw.messageText ?? prev?.messageText ? { messageText: raw.messageText ?? prev?.messageText } : {}),
      ...(raw.jobId ?? meta?.jobId ?? prev?.jobId ? { jobId: raw.jobId ?? meta?.jobId ?? prev?.jobId } : {}),
      ...(raw.model ?? meta?.model ?? prev?.model ? { model: raw.model ?? meta?.model ?? prev?.model } : {}),
      ...(raw.prompt ?? meta?.prompt ?? prev?.prompt ? { prompt: raw.prompt ?? meta?.prompt ?? prev?.prompt } : {}),
      ...(raw.references?.length ? { references: raw.references } : meta?.references?.length ? { references: meta.references } : prev?.references?.length ? { references: prev.references } : {}),
      source: raw.source
        ?? (meta?.jobId || raw.jobId ? "bot-generated" : raw.role === "user" ? "user-uploaded" : raw.role === "bot" ? "bot-attached" : prev?.source),
    };
    byPath.set(key, merged);
  }

  return [...byPath.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}
