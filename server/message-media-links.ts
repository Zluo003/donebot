// A <video> element cannot send the JSON body the message-file route reads, so the route hands out an opaque id
// for the exact request it just authorized. The id is not a bearer secret: each use still needs the same signed-in
// viewer, and the route re-runs every message, folder and MIME check against what the id stands for.
import { randomBytes } from "node:crypto";

import type { AudioRange } from "./attachments.ts";
import type { RequestAuth } from "./request-auth.ts";

export const MESSAGE_MEDIA_IDLE_MS = 15 * 60_000;
export const MESSAGE_MEDIA_MAX_AGE_MS = 4 * 60 * 60_000;
const MAX_LINKS = 512;
export const MESSAGE_MEDIA_RANGE_MAX_BYTES = 8 * 1024 * 1024;
export const STREAMABLE_MEDIA_MIMES: ReadonlySet<string> = new Set([
  "video/mp4", "video/webm", "video/quicktime", "video/x-m4v",
  "audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/wav", "audio/x-wav", "audio/wave", "audio/ogg", "audio/opus", "audio/flac", "audio/x-flac",
]);

export function cappedMediaRange(range: AudioRange): AudioRange {
  return range.kind === "range" ? { ...range, end: Math.min(range.end, range.start + MESSAGE_MEDIA_RANGE_MAX_BYTES - 1) } : range;
}

export interface MessageMediaGrant {
  threadId: string;
  messageId: string;
  path: string;
  entry?: string;
}

interface StoredGrant extends MessageMediaGrant {
  viewer: string;
  idleUntil: number;
  expiresAt: number;
}

export function mediaViewerKey(auth: RequestAuth): string {
  if (auth.kind === "session") return `session:${auth.session.id}`;
  return auth.companionDevice ? `companion:${auth.companionDevice}` : "loopback";
}

export class MessageMediaLinks {
  private readonly grants = new Map<string, StoredGrant>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  issue(grant: MessageMediaGrant, auth: RequestAuth): string {
    const now = this.now();
    for (const [id, stored] of this.grants) {
      if (!this.live(stored, now)) this.grants.delete(id);
    }
    while (this.grants.size >= MAX_LINKS) this.grants.delete(this.grants.keys().next().value!);
    const id = randomBytes(32).toString("base64url");
    this.grants.set(id, {
      ...grant,
      viewer: mediaViewerKey(auth),
      idleUntil: now + MESSAGE_MEDIA_IDLE_MS,
      expiresAt: now + MESSAGE_MEDIA_MAX_AGE_MS,
    });
    return id;
  }

  use(id: string, threadId: string, messageId: string, auth: RequestAuth): MessageMediaGrant | null {
    const stored = this.grants.get(id);
    if (!stored) return null;
    const now = this.now();
    if (!this.live(stored, now)) {
      this.grants.delete(id);
      return null;
    }
    if (stored.threadId !== threadId || stored.messageId !== messageId || stored.viewer !== mediaViewerKey(auth)) return null;
    stored.idleUntil = now + MESSAGE_MEDIA_IDLE_MS;
    return { threadId: stored.threadId, messageId: stored.messageId, path: stored.path, ...(stored.entry !== undefined ? { entry: stored.entry } : {}) };
  }

  private live(stored: StoredGrant, now: number): boolean {
    return now < stored.idleUntil && now < stored.expiresAt;
  }
}
