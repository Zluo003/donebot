import { createHash } from "node:crypto";
import { botAvatarUrlFromStoredPath } from "../../shared/bot-avatar.ts";
import { saveImage } from "../attachments.ts";

export const INLINE_AVATAR_DATA_URL = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/;

export interface LocalProfileSnapshot {
  name?: string;
  avatarUrl?: string;
  email?: string;
}

export interface LocalProfileSyncDeps {
  syncLocalProfile?(patch: { name?: string; avatarUrl?: string; email?: string }): void;
  currentLocalProfile?(): LocalProfileSnapshot | undefined;
}

export function storeLocalAvatarFromDataUrl(dataUrl: string): string | undefined {
  if (dataUrl === "") return "";
  const match = INLINE_AVATAR_DATA_URL.exec(dataUrl.trim());
  if (!match) return undefined;
  try {
    const mime = match[1] === "image/jpg" ? "image/jpeg" : match[1]!;
    const bytes = Buffer.from(match[2]!, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > 512 * 1024) return undefined;
    const saved = saveImage(bytes, mime);
    return botAvatarUrlFromStoredPath(saved.path) ?? undefined;
  } catch {
    return undefined;
  }
}

function hashAvatarData(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function createAccountProfileSynchronizer(deps: LocalProfileSyncDeps) {
  const avatarCache = new Map<string, string>();

  const remember = (rawDataUrl: string, localUrl: string) => {
    const trimmed = rawDataUrl.trim();
    if (!trimmed || !localUrl) return;
    const key = hashAvatarData(trimmed);
    avatarCache.set(key, localUrl);
    if (avatarCache.size > 16) {
      const oldest = avatarCache.keys().next().value;
      if (oldest) avatarCache.delete(oldest);
    }
  };

  const syncFromRemote = (input: {
    email?: string;
    nickname?: string;
    avatarUrl?: string;
    profileLoaded: boolean;
  }): { localAvatarUrl?: string } => {
    const email = (input.email ?? "").trim();
    const nickname = (input.nickname ?? "").trim();
    const avatarUrl = (input.avatarUrl ?? "").trim();
    const local = deps.currentLocalProfile?.();
    const localEmail = local?.email?.trim() ?? "";
    const localName = local?.name?.trim() ?? "";
    const localAvatarNow = local?.avatarUrl?.trim() ?? "";
    const accountSwitched = Boolean(email && localEmail && localEmail.toLowerCase() !== email.toLowerCase());

    let resolvedAvatar: string | undefined;
    if (avatarUrl) {
      if (/^https?:\/\//i.test(avatarUrl)) {
        resolvedAvatar = avatarUrl;
      } else if (INLINE_AVATAR_DATA_URL.test(avatarUrl)) {
        const key = hashAvatarData(avatarUrl);
        const cached = avatarCache.get(key);
        if (cached) {
          resolvedAvatar = cached;
        } else {
          const stored = storeLocalAvatarFromDataUrl(avatarUrl);
          if (stored) {
            remember(avatarUrl, stored);
            resolvedAvatar = stored;
          }
        }
      }
    } else if (input.profileLoaded && accountSwitched && localAvatarNow) {
      resolvedAvatar = "";
    }

    if (deps.syncLocalProfile) {
      const needName = (Boolean(nickname) && localName !== nickname)
        || (input.profileLoaded && accountSwitched && !nickname && Boolean(localName));
      const needAvatar = resolvedAvatar !== undefined && localAvatarNow !== resolvedAvatar;
      const needEmail = Boolean(email) && localEmail.toLowerCase() !== email.toLowerCase();

      if (needName || needAvatar || needEmail) {
        try {
          deps.syncLocalProfile({
            ...(needName ? { name: nickname } : {}),
            ...(needAvatar ? { avatarUrl: resolvedAvatar } : {}),
            ...(needEmail ? { email } : {}),
          });
        } catch {
          // Best-effort local profile sync.
        }
      }
    }

    return { localAvatarUrl: resolvedAvatar };
  };

  return { remember, syncFromRemote };
}
