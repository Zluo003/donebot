import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, extname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MediaContext } from "./media.ts";
import { mediaScopeKey, type MediaScope } from "./media-store.ts";

export interface MediaReferenceFile { bytes: Uint8Array; mime: string; name: string }
export interface MediaReferencePolicy {
  maxFiles: number;
  maxBytesPerFile?: number;
  validateFile?: (file: MediaReferenceFile) => void;
}
export const MAX_MEDIA_REFERENCE_FILES = 32;
export const MAX_MEDIA_REFERENCE_BYTES = 32 * 1024 * 1024;
export class MediaReferenceChanged extends Error {}

export function mediaReferenceMime(mime: string, name: string): string {
  if (mime !== "application/octet-stream") return mime;
  const images: Record<string, string> = { ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff", ".heic": "image/heic", ".heif": "image/heif" };
  return images[extname(name).toLowerCase()] ?? mime;
}

export interface MediaAssetDeps {
  dbPath: string;
  scope: () => MediaScope | null | Promise<MediaScope | null>;
  fetchGateway: (path: string, init: RequestInit, expectedScope: MediaScope) => Promise<Response>;
  resolveReference?: (context: MediaContext, path: string, maxBytes: number) => Promise<MediaReferenceFile>;
  maxReferenceBytes?: number;
}

const referenceFields = new Set(["references", "url", "image", "images", "image_url", "image_urls", "video_url", "video_urls", "audio_url", "audio_urls", "reference_image", "reference_images", "reference_video", "reference_audio", "input_reference", "mask"]);
const referenceMetadata = new Set(["type", "role", "detail", "mime_type"]);
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

async function assetResponse(response: Response): Promise<{ id: string; url: string }> {
  if (!response.ok) throw new Error(`Gateway reference asset request failed (HTTP ${response.status}).`);
  const data = record(await response.json());
  if (typeof data?.id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(data.id) || typeof data.url !== "string") throw new Error("Gateway returned invalid reference asset metadata.");
  const url = new URL(data.url);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Gateway returned an invalid reference asset URL.");
  return { id: data.id, url: url.toString() };
}

export class MediaAssetCache {
  private readonly deps: MediaAssetDeps;
  private readonly db: DatabaseSync;
  private readonly locks = new Map<string, Promise<{ id: string; url: string }>>();

  constructor(deps: MediaAssetDeps) {
    this.deps = deps;
    if (deps.dbPath !== ":memory:") mkdirSync(dirname(deps.dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(deps.dbPath);
    if (deps.dbPath !== ":memory:") chmodSync(deps.dbPath, 0o600);
    this.db.exec(`CREATE TABLE IF NOT EXISTS donebot_media_assets (
      scope TEXT NOT NULL, content_hash TEXT NOT NULL, mime TEXT NOT NULL, asset_id TEXT NOT NULL,
      PRIMARY KEY(scope, content_hash, mime)
    )`);
  }

  private async checkScope(scope: MediaScope): Promise<void> {
    const current = await this.deps.scope();
    if (!current || mediaScopeKey(current) !== mediaScopeKey(scope)) throw new Error("DoneBot account changed while preparing reference media.");
  }

  private async asset(scope: MediaScope, file: MediaReferenceFile, hash: string): Promise<{ id: string; url: string }> {
    const scopeKey = mediaScopeKey(scope);
    const cache = this.db.prepare("SELECT asset_id FROM donebot_media_assets WHERE scope = ? AND content_hash = ? AND mime = ?").get(scopeKey, hash, file.mime);
    if (cache) {
      await this.checkScope(scope);
      const response = await this.deps.fetchGateway(`/v1/assets/${encodeURIComponent(String(cache.asset_id))}`, { method: "GET", signal: AbortSignal.timeout(30_000) }, scope);
      if (response.ok) {
        const metadata = await assetResponse(response);
        await this.checkScope(scope);
        if (metadata.id !== cache.asset_id) throw new Error("Gateway reference asset identity changed.");
        return metadata;
      }
      await response.body?.cancel();
      if (response.status !== 404 && response.status !== 410) throw new Error(`Gateway reference asset lookup failed (HTTP ${response.status}).`);
      this.db.prepare("DELETE FROM donebot_media_assets WHERE scope = ? AND content_hash = ? AND mime = ?").run(scopeKey, hash, file.mime);
    }
    await this.checkScope(scope);
    const form = new FormData();
    form.append("file", new Blob([Uint8Array.from(file.bytes)], { type: file.mime }), file.name);
    const metadata = await assetResponse(await this.deps.fetchGateway("/v1/assets", { method: "POST", body: form, signal: AbortSignal.timeout(120_000) }, scope));
    await this.checkScope(scope);
    this.db.prepare("INSERT OR REPLACE INTO donebot_media_assets(scope, content_hash, mime, asset_id) VALUES(?, ?, ?, ?)").run(scopeKey, hash, file.mime, metadata.id);
    return metadata;
  }

  async prepare(context: MediaContext, scope: MediaScope, parameters: Record<string, unknown>, expected?: Record<string, unknown>, policy?: MediaReferencePolicy): Promise<{ parameters: Record<string, unknown>; fingerprint: Record<string, unknown> }> {
    let references = 0;
    const maxBytes = Math.min(this.deps.maxReferenceBytes ?? Infinity, policy?.maxBytesPerFile ?? MAX_MEDIA_REFERENCE_BYTES);
    const visit = async (value: unknown, field: string, isReference: boolean, depth: number, previous?: unknown, modality?: string): Promise<{ value: unknown; fingerprint: unknown }> => {
      if (depth > 24) throw new Error("Media reference parameters are too deeply nested.");
      const data = record(value);
      if (data && "local_path" in data) {
        if (!isReference) throw new Error("A local media reference must be in a native media reference field.");
        const intentReference = field === "references" && Object.keys(data).every(key => key === "local_path" || key === "type") &&
          typeof data.type === "string" && ["image", "video", "audio"].includes(data.type);
        if (!(Object.keys(data).length === 1 || intentReference) || typeof data.local_path !== "string" || !data.local_path.trim() || data.local_path.length > 8192) throw new Error("A media reference must be exactly {local_path: '/allowed/file'}.");
        if (!this.deps.resolveReference) throw new Error("Local reference media is unavailable in this context.");
        if (++references > (policy?.maxFiles ?? MAX_MEDIA_REFERENCE_FILES)) throw new Error("Too many reference media files.");
        if (!context.active()) throw new Error("This turn ended before uploading reference media.");
        const file = await this.deps.resolveReference(context, data.local_path, maxBytes);
        if (!context.active()) throw new Error("This turn ended before uploading reference media.");
        if (!file.bytes.byteLength || file.bytes.byteLength > maxBytes || !/^(image|video|audio)\/[a-zA-Z0-9.+-]+$/.test(file.mime)) throw new Error("Reference media has an unsupported type or size.");
        if (modality && !file.mime.startsWith(`${modality}/`)) throw new Error(`The reference file does not match its native ${modality} field.`);
        if (intentReference && !file.mime.startsWith(`${data.type}/`)) throw new Error(`The reference file does not match its declared ${data.type} type.`);
        policy?.validateFile?.(file);
        const hash = createHash("sha256").update(file.bytes).digest("hex");
        if (previous !== undefined && (record(previous)?.sha256 !== hash || record(previous)?.mime !== file.mime ||
            intentReference && record(previous)?.type !== data.type)) throw new MediaReferenceChanged("A queued reference changed after authorization; no generation was submitted.");
        const key = JSON.stringify([mediaScopeKey(scope), hash, file.mime]);
        let active = this.locks.get(key);
        if (!active) {
          active = this.asset(scope, file, hash);
          this.locks.set(key, active);
          void active.finally(() => { if (this.locks.get(key) === active) this.locks.delete(key); }).catch(() => {});
        }
        const metadata = await active;
        await this.checkScope(scope);
        return { value: intentReference ? { asset_id: metadata.id, type: data.type } : metadata.url,
          fingerprint: { sha256: hash, mime: file.mime, ...(intentReference ? { type: data.type } : {}) } };
      }
      if (Array.isArray(value)) {
        const entries = [];
        for (const [index, part] of value.entries()) entries.push(await visit(part, field, isReference, depth + 1, Array.isArray(previous) ? previous[index] : undefined, modality));
        return { value: entries.map(entry => entry.value), fingerprint: entries.map(entry => entry.fingerprint) };
      }
      if (data) {
        const valueEntries: [string, unknown][] = [];
        const fingerprintEntries: [string, unknown][] = [];
        for (const [key, part] of Object.entries(data)) {
          const nativeModality = /^(image|video|audio)(?:_urls?|s)?$/.exec(key)?.[1] ?? modality;
          const entry = await visit(part, key, isReference || referenceFields.has(key), depth + 1, record(previous)?.[key], nativeModality);
          valueEntries.push([key, entry.value]);
          fingerprintEntries.push([key, entry.fingerprint]);
        }
        return { value: Object.fromEntries(valueEntries), fingerprint: Object.fromEntries(fingerprintEntries) };
      }
      if (typeof value === "string" && ((isReference && !referenceMetadata.has(field)) || /^asset:\/\//i.test(value))) throw new Error(`Reference field ${field} must use {local_path: '/allowed/file'} so DoneBot can upload it through the gateway.`);
      return { value, fingerprint: value };
    };
    const prepared = await visit(parameters, "parameters", false, 0, expected);
    return { parameters: prepared.value as Record<string, unknown>, fingerprint: prepared.fingerprint as Record<string, unknown> };
  }

  close(): void { this.db.close(); }
}
