import { createHash } from "node:crypto";
import type { BotArtifact, BotArtifactPage } from "../shared/artifacts.ts";
import type { HandoffView } from "./coordinator.ts";
import type { Message } from "./store.ts";
import { messageFileTargets, referencedFileName } from "./message-file.ts";

export interface ArtifactThread {
  threadId: string;
  title: string;
  ownerBotId?: string;
  internal?: boolean;
  messages: readonly Message[];
}

const FILE_EXTENSION = /\.[a-z\d]{1,12}$/i;
const UUID = /\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/gi;

export function artifactTitle(task: string, fallback: string): string {
  const clean = (text: string) => text
    .replace(/<(?:file|image|attachment)\b[^>]*>[\s\S]*?<\/(?:file|image|attachment)>/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(?:file:\/\/|https?:\/\/|\/(?:Users|home|tmp|var)\/)[^\s<>]+/g, " ")
    .replace(UUID, " ").replace(/<[^>]*>/g, " ")
    .replace(/[@＠][^\s,，:：]+\s*/g, " ")
    .replace(/\s+/g, " ").trim();
  let title = clean(task).split(/[。！？\n]/, 1)[0]!
    .replace(/^(?:请|麻烦|帮我|给我|为我|再|先|我想要|我需要|能否|可以|让[^，。]{1,12}?(?=设计|画|生成|制作|写|做))+/u, "")
    .replace(/^(?:设计|绘制|画|生成|制作|创建|撰写|写|做)(?:一下|出)?(?:一[个张份段首篇套])?/u, "")
    .replace(/^(?:(?:please|can you|could you)\s+)*(?:create|generate|draw|make|write|design)\s+(?:(?:me\s+)?(?:an?|the)\s+)?/i, "")
    .replace(/风格的/g, "").replace(/的形象(?:图)?$/u, "")
    .replace(/^[\s，,:：-]+|[\s，,。.!！?？]+$/g, "");
  if (!title) title = clean(fallback).replace(FILE_EXTENSION, "");
  return [...title].slice(0, 64).join("");
}

function identity(path: string, threadId: string): string {
  let decoded = path.split(/[?#]/, 1)[0]!;
  try { decoded = decodeURIComponent(decoded); } catch {}
  decoded = decoded.replace(/^file:\/\/(?:localhost)?/i, "");
  return /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(decoded) ? decoded : `${threadId}:${decoded.replace(/^\.\//, "")}`;
}

function kindOf(path: string, mime?: string): BotArtifact["kind"] {
  if (mime?.startsWith("image/") || /\.(?:png|jpe?g|gif|webp|avif|bmp)$/i.test(path)) return "image";
  if (mime?.startsWith("video/") || /\.(?:mp4|m4v|webm|mov)$/i.test(path)) return "video";
  if (mime?.startsWith("audio/") || /\.(?:mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i.test(path)) return "audio";
  return "document";
}

function ownReply(message: Message, botId: string, owner?: string): boolean {
  return message.role === "bot" && message.kind === "text" && !message.roomRequest && !message.peerAsk &&
    !message.sendId?.startsWith("handoff_inputs_") && (message.from?.botId ?? owner) === botId;
}

/** Security: references stay on their original visible message; assignment metadata never grants another thread's files. */
export function collectBotArtifacts(botId: string, threads: readonly ArtifactThread[], node: (id: string) => HandoffView | undefined = () => undefined): BotArtifact[] {
  const artifacts = new Map<string, BotArtifact>();
  for (const thread of threads) {
    const { messages, threadId } = thread;
    if (thread.internal && !messages.some(message => message.role === "user" && !message.peerAsk && !message.roomRequest)) continue;
    const byId = new Map(messages.map(message => [message.id, message]));
    const aliases = new Map<string, string>();
    const legacy = new Map<string, Message[]>();
    for (const message of messages) for (const file of message.attachments ?? []) {
      if ("source" in file && file.source) aliases.set(identity(file.source, threadId), identity(file.path, threadId));
    }
    // Security: legacy reports need an exact persisted assignment result, never a guessed neighbouring reply.
    for (const source of messages) {
      if (!source.attachments?.length || source.sendId?.startsWith("handoff_inputs_")) continue;
      for (const id of source.handoffAssignmentIds ?? []) {
        const assignment = node(id);
        if (assignment?.botId !== botId || assignment.threadId !== threadId || assignment.status !== "completed" || !assignment.result.trim()) continue;
        const key = assignment.result.trim();
        legacy.set(key, [...legacy.get(key) ?? [], source]);
      }
    }
    let request: Message | undefined;
    for (const report of messages) {
      if (report.role === "user" && !report.peerAsk && !report.roomRequest) request = report;
      if (!ownReply(report, botId, thread.ownerBotId)) continue;
      const sources = new Map<string, Message>([[report.id, report]]);
      for (const id of report.reportedAttachmentMessageIds ?? []) {
        const source = byId.get(id);
        if (source?.role === "bot" && source.kind === "text" && source.at <= report.at) sources.set(id, source);
      }
      for (const source of legacy.get(report.text?.trim() ?? "") ?? []) if (source.at <= report.at) sources.set(source.id, source);
      const prompt = (report.requestMessageId ? byId.get(report.requestMessageId) : undefined)?.text ?? request?.text ?? thread.title;
      for (const source of sources.values()) {
        const files: Array<{ path: string; name: string; mime?: string }> = (source.attachments ?? [])
          .filter(file => !(file.kind === "image" && file.fromTool))
          .map(file => ({ path: file.path, name: "name" in file && file.name || referencedFileName(file.path) || "", mime: file.mime }));
        for (const path of messageFileTargets(source.text ?? "", true)) {
          const name = referencedFileName(path);
          if (name && FILE_EXTENSION.test(name)) files.push({ path, name });
        }
        for (const file of files) {
          const key = aliases.get(identity(file.path, threadId)) ?? identity(file.path, threadId);
          const id = createHash("sha256").update(key).digest("hex");
          const existing = artifacts.get(id);
          if (existing && existing.at > report.at) continue;
          if (existing?.at === report.at && key !== identity(file.path, threadId)) continue;
          const kind = kindOf(file.name, file.mime);
          artifacts.set(id, { id, title: artifactTitle(prompt, file.name), ...file, kind, at: report.at,
            threadId, threadTitle: thread.title, messageId: source.id, reportMessageId: report.id,
            previewUrl: `/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(source.id)}/file?preview=1&path=${encodeURIComponent(file.path)}` });
        }
      }
    }
  }
  const items = [...artifacts.values()].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  const names = new Map<string, BotArtifact[]>();
  for (const item of items) {
    const key = `${item.title}:${item.kind}`;
    const group = names.get(key) ?? [];
    group.push(item); names.set(key, group);
  }
  for (const group of names.values()) if (group.length > 1) group.forEach((item, index) => { item.title += ` · ${group.length - index}`; });
  return items;
}

export function artifactPage(items: readonly BotArtifact[], limit: number, before?: string | null): BotArtifactPage {
  let remaining = items;
  if (before) {
    const cursor = JSON.parse(Buffer.from(before, "base64url").toString()) as { at: number; id: string };
    if (!Number.isSafeInteger(cursor.at) || typeof cursor.id !== "string" || !/^[a-f\d]{64}$/.test(cursor.id)) throw new Error("invalid artifact cursor");
    remaining = items.filter(item => item.at < cursor.at || item.at === cursor.at && item.id.localeCompare(cursor.id) > 0);
  }
  const page = remaining.slice(0, limit);
  const last = page.at(-1);
  return { items: page, nextCursor: remaining.length > limit && last ? Buffer.from(JSON.stringify({ at: last.at, id: last.id })).toString("base64url") : null };
}
