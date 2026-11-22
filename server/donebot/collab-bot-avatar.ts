import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import {
  botAvatarProfile,
  clampAvatarFocus,
  clampAvatarZoom,
  type BotAvatarCrop,
} from "../../shared/bot-avatar.ts";
import { botBodySchema } from "../../shared/bot-body.ts";
import type { DoneBotCollabChatBot } from "../../shared/donebot-collab.ts";
import { readAttachment } from "../attachments.ts";
import type { BotRecord } from "../store.ts";

export const INLINE_BOT_AVATAR_DATA_URL = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=]+)$/;

const ALLOWED_INLINE_AVATAR_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_INLINE_RAW_BYTES = 480_000;
const MAX_INLINE_DATA_URL_CHARS = 720_000;
const MAX_DECODE_PIXELS = 32 * 1024 * 1024;
const AVATAR_RESIZE_SIDES = [256, 192, 128] as const;
const AVATAR_JPEG_QUALITIES = [86, 74, 62] as const;
const EXPRESSION_RE = /^[a-z0-9_-]{1,32}$/;

const compressedCache = new Map<string, string>();
const MAX_CACHE_ENTRIES = 64;

export interface CollabChatBotAppearance {
  local_bot_id: string;
  bot_name: string;
  bot_title: string;
  bot_color: string;
  bot_avatar_url: string;
  bot_mascot_body: string;
  bot_mascot_face_color: string;
  bot_mascot_expression: string;
  bot_avatar_crop: BotAvatarCrop;
  bot_avatar_zoom: number;
  bot_avatar_focus_x: number;
  bot_avatar_focus_y: number;
}

function resizeRgba(data: Uint8Array, width: number, height: number, maxSide: number): { data: Buffer; width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  if (w === width && h === height) return { data: Buffer.from(data), width, height };
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const sy = ((y + 0.5) * height) / h - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(height - 1, y0 + 1);
    const dy = Math.max(0, sy - y0);
    for (let x = 0; x < w; x += 1) {
      const sx = ((x + 0.5) * width) / w - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(width - 1, x0 + 1);
      const dx = Math.max(0, sx - x0);
      for (let c = 0; c < 4; c += 1) {
        const a = data[(y0 * width + x0) * 4 + c]! * (1 - dx) + data[(y0 * width + x1) * 4 + c]! * dx;
        const b = data[(y1 * width + x0) * 4 + c]! * (1 - dx) + data[(y1 * width + x1) * 4 + c]! * dx;
        out[(y * w + x) * 4 + c] = Math.round(a * (1 - dy) + b * dy);
      }
    }
  }
  return { data: out, width: w, height: h };
}

function hasTransparency(data: Uint8Array): boolean {
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) return true;
  }
  return false;
}

export function compressAvatarBytesToDataUrl(bytes: Buffer, rawMime: string): string {
  const mime = rawMime === "image/jpg" ? "image/jpeg" : rawMime;
  if (!ALLOWED_INLINE_AVATAR_MIMES.has(mime) || bytes.length === 0) return "";
  if (bytes.length <= MAX_INLINE_RAW_BYTES) {
    const direct = `data:${mime};base64,${bytes.toString("base64")}`;
    if (direct.length <= MAX_INLINE_DATA_URL_CHARS) return direct;
  }
  if (mime !== "image/png" && mime !== "image/jpeg") return "";

  try {
    if (mime === "image/png" && (bytes.length < 33 || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > MAX_DECODE_PIXELS)) {
      return "";
    }
    const decoded = mime === "image/png"
      ? PNG.sync.read(bytes)
      : jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: 32, maxMemoryUsageInMB: 256 });
    if (decoded.width <= 0 || decoded.height <= 0 || decoded.width * decoded.height > MAX_DECODE_PIXELS) {
      return "";
    }
    const transparent = mime === "image/png" && hasTransparency(decoded.data);
    for (const side of AVATAR_RESIZE_SIDES) {
      const scaled = resizeRgba(decoded.data, decoded.width, decoded.height, side);
      if (transparent) {
        const png = new PNG({ width: scaled.width, height: scaled.height });
        png.data = scaled.data;
        const out = PNG.sync.write(png);
        const dataUrl = `data:image/png;base64,${out.toString("base64")}`;
        if (dataUrl.length <= MAX_INLINE_DATA_URL_CHARS) return dataUrl;
      } else {
        for (const quality of AVATAR_JPEG_QUALITIES) {
          const out = jpeg.encode({ width: scaled.width, height: scaled.height, data: scaled.data }, quality).data;
          const dataUrl = `data:image/jpeg;base64,${out.toString("base64")}`;
          if (dataUrl.length <= MAX_INLINE_DATA_URL_CHARS) return dataUrl;
        }
      }
    }
  } catch {
    return "";
  }
  return "";
}

export function inlineBotAvatarDataUrl(
  bot: Pick<BotRecord, "avatarUrl" | "avatarCrop">,
  fallbackDataUrl?: string,
  reader: (filename: string) => { bytes: Buffer; mime: string } | null = readAttachment,
): string {
  const profile = botAvatarProfile(bot);
  if (!profile.avatarUrl || profile.avatarCrop === "mascot") return "";
  const match = profile.avatarUrl.match(/^\/api\/attachments\/([A-Za-z0-9-]+\.(?:png|jpg|webp|gif))$/);
  if (match?.[1]) {
    try {
      const file = reader(match[1]);
      if (file && file.bytes.length > 0) {
        const digest = createHash("sha256").update(file.bytes).digest("hex").slice(0, 16);
        const cacheKey = `${match[1]}:${file.bytes.length}:${digest}`;
        const cached = compressedCache.get(cacheKey);
        if (cached !== undefined) return cached;
        const encoded = compressAvatarBytesToDataUrl(file.bytes, file.mime);
        if (encoded) {
          if (compressedCache.size >= MAX_CACHE_ENTRIES) {
            const oldest = compressedCache.keys().next().value;
            if (oldest) compressedCache.delete(oldest);
          }
          compressedCache.set(cacheKey, encoded);
          return encoded;
        }
      }
    } catch {
      // Fall through to optional client-provided compressed data URL.
    }
  }
  const fallback = fallbackDataUrl?.trim() ?? "";
  if (fallback && fallback.length <= MAX_INLINE_DATA_URL_CHARS && INLINE_BOT_AVATAR_DATA_URL.test(fallback)) {
    return fallback;
  }
  return "";
}

export function resolveSyncedMascotBody(value: unknown): string {
  const parsed = botBodySchema.safeParse(value).data;
  return !parsed || parsed === "cursor" ? "circle" : parsed;
}

export function buildCollabChatBotAppearance(
  bot: BotRecord,
  fallbackAvatarDataUrl?: string,
  reader?: (filename: string) => { bytes: Buffer; mime: string } | null,
): CollabChatBotAppearance {
  const profile = botAvatarProfile(bot);
  const face = bot.mascotFaceColor === "white" || bot.mascotFaceColor === "black" ? bot.mascotFaceColor : "";
  const exprRaw = typeof bot.mascotExpression === "string" ? bot.mascotExpression.trim().toLowerCase() : "";
  const expression = EXPRESSION_RE.test(exprRaw) ? exprRaw : "";
  return {
    local_bot_id: bot.id,
    bot_name: bot.name.slice(0, 120),
    bot_title: (bot.title ?? "").slice(0, 200),
    bot_color: bot.color || "blue",
    bot_avatar_url: inlineBotAvatarDataUrl(bot, fallbackAvatarDataUrl, reader),
    bot_mascot_body: resolveSyncedMascotBody(bot.mascotBody),
    bot_mascot_face_color: face,
    bot_mascot_expression: expression,
    bot_avatar_crop: profile.avatarCrop,
    bot_avatar_zoom: clampAvatarZoom(bot.avatarZoom ?? 1),
    bot_avatar_focus_x: clampAvatarFocus(bot.avatarFocusX ?? 0.5),
    bot_avatar_focus_y: clampAvatarFocus(bot.avatarFocusY ?? 0.5),
  };
}

export function chatBotNeedsSync(
  remote: Partial<DoneBotCollabChatBot>,
  local: CollabChatBotAppearance,
): boolean {
  const rZoom = typeof remote.bot_avatar_zoom === "number" && Number.isFinite(remote.bot_avatar_zoom) ? remote.bot_avatar_zoom : 1;
  const rFx = typeof remote.bot_avatar_focus_x === "number" && Number.isFinite(remote.bot_avatar_focus_x) ? remote.bot_avatar_focus_x : 0.5;
  const rFy = typeof remote.bot_avatar_focus_y === "number" && Number.isFinite(remote.bot_avatar_focus_y) ? remote.bot_avatar_focus_y : 0.5;
  return (
    (remote.bot_name ?? "") !== local.bot_name
    || (remote.bot_title ?? "") !== local.bot_title
    || (remote.bot_color ?? "") !== local.bot_color
    || (remote.bot_avatar_url ?? "") !== local.bot_avatar_url
    || (remote.bot_mascot_body ?? "") !== local.bot_mascot_body
    || (remote.bot_mascot_face_color ?? "") !== local.bot_mascot_face_color
    || (remote.bot_mascot_expression ?? "") !== local.bot_mascot_expression
    || (remote.bot_avatar_crop ?? "") !== local.bot_avatar_crop
    || Math.abs(rZoom - local.bot_avatar_zoom) > 0.001
    || Math.abs(rFx - local.bot_avatar_focus_x) > 0.0005
    || Math.abs(rFy - local.bot_avatar_focus_y) > 0.0005
  );
}

export function appearanceSignature(a: CollabChatBotAppearance): string {
  const avatarDigest = a.bot_avatar_url
    ? createHash("sha256").update(a.bot_avatar_url).digest("hex").slice(0, 16)
    : "";
  return [
    a.bot_name,
    a.bot_title,
    a.bot_color,
    a.bot_mascot_body,
    a.bot_mascot_face_color,
    a.bot_mascot_expression,
    a.bot_avatar_crop,
    a.bot_avatar_zoom,
    a.bot_avatar_focus_x,
    a.bot_avatar_focus_y,
    avatarDigest,
  ].join("|");
}
