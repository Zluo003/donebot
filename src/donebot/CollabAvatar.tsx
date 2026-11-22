import { useEffect, useId, useRef, useState } from "react";
import { AlertCircle, Camera, Check, Loader2, Trash2, X } from "lucide-react";
import { api } from "@/state/api";
import { useStore } from "@/state/store";
import { MausAvatar } from "@/components/Avatar";
import { MAUS_COLORS, normalizeState, type MausColor } from "@/lib/mascot";
import { cn } from "@/lib/cn";
import { botBodySchema, type BotBodyId } from "../../shared/bot-body";
import {
  avatarCropRadius,
  botAvatarCropSchema,
  clampAvatarFocus,
  clampAvatarZoom,
  type BotAvatarCrop,
  type MascotFaceColor,
} from "../../shared/bot-avatar";
import type { DoneBotChatMessage, DoneBotCollabChatBot } from "../../shared/donebot-collab";
import { newBotBody } from "./avatars";
import {
  cleanError,
  COLLAB_BUTTON,
  COLLAB_INPUT,
  displayPersonName,
  initialGlyph,
  type LocalBotSummary,
} from "./collab-types";
import "./collab.css";

const AVATAR_TONES = [
  "bg-[#377FE6]/18 text-[#5FA0FF] ring-[#377FE6]/28",
  "bg-[#009957]/18 text-[#4CC98C] ring-[#009957]/28",
  "bg-[#8D68CE]/18 text-[#B596EE] ring-[#8D68CE]/28",
  "bg-[#E78531]/18 text-[#F2A65A] ring-[#E78531]/28",
  "bg-[#D84F8B]/18 text-[#F07EAE] ring-[#D84F8B]/28",
  "bg-[#0EA5C6]/18 text-[#4ACAE5] ring-[#0EA5C6]/28",
  "bg-[#01A492]/18 text-[#46CFC0] ring-[#01A492]/28",
  "bg-[#E5634E]/18 text-[#F58C7B] ring-[#E5634E]/28",
] as const;

function hashToneIndex(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % AVATAR_TONES.length;
}

export function CollabAvatar({
  avatarUrl,
  remark,
  nickname,
  email,
  size = 36,
  online,
  shape = "circle",
  className,
}: {
  avatarUrl?: string | null;
  remark?: string | null;
  nickname?: string | null;
  email?: string | null;
  size?: number;
  online?: boolean;
  shape?: "circle" | "rounded";
  className?: string;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const src = avatarUrl?.trim() || "";
  useEffect(() => { setImgFailed(false); }, [src]);

  const label = displayPersonName({ remark, nickname, email });
  const seed = (email || nickname || remark || "donebot").trim().toLowerCase();
  const tone = AVATAR_TONES[hashToneIndex(seed)]!;
  const radiusClass = shape === "circle" ? "rounded-full" : "rounded-xl";
  const fontSize = Math.max(11, Math.round(size * 0.39));

  return (
    <span
      className={cn("relative inline-flex shrink-0 select-none", className)}
      style={{ width: size, height: size }}
    >
      <span
        className={cn(
          "flex size-full items-center justify-center overflow-hidden font-semibold ring-1 ring-inset",
          radiusClass,
          src && !imgFailed ? "bg-raised ring-ink/12" : tone,
        )}
        style={{ fontSize }}
      >
        {src && !imgFailed ? (
          <img
            src={src}
            alt={label}
            className="size-full object-cover"
            loading="lazy"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <span aria-hidden="true">{initialGlyph(label)}</span>
        )}
      </span>
      {online !== undefined && (
        <span
          aria-hidden="true"
          className={cn(
            "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-app",
            online ? "bg-success" : "bg-ink-tertiary/45",
          )}
        />
      )}
    </span>
  );
}

export function CollabTeamBadge({
  name,
  avatarUrl,
  size = 36,
  className,
}: {
  name: string;
  avatarUrl?: string | null;
  size?: number;
  className?: string;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const src = avatarUrl?.trim() || "";
  useEffect(() => { setImgFailed(false); }, [src]);

  const tone = AVATAR_TONES[hashToneIndex(`team:${name.trim().toLowerCase()}`)]!;
  const fontSize = Math.max(12, Math.round(size * 0.4));
  return (
    <span
      aria-hidden={!(src && !imgFailed) ? "true" : undefined}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-xl font-semibold ring-1 ring-inset",
        src && !imgFailed ? "bg-raised ring-ink/12" : tone,
        className,
      )}
      style={{ width: size, height: size, fontSize }}
    >
      {src && !imgFailed ? (
        <img
          src={src}
          alt={name}
          className="size-full object-cover"
          loading="lazy"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <span aria-hidden="true">{initialGlyph(name)}</span>
      )}
    </span>
  );
}

export interface CollabBotBadgeAppearance {
  name: string;
  color?: string | null;
  avatarUrl?: string | null;
  avatarCrop?: string | null;
  avatarZoom?: number | null;
  avatarFocusX?: number | null;
  avatarFocusY?: number | null;
  bodyId?: string | null;
  faceColor?: string | null;
  expression?: string | null;
}

export function resolveCollabBotBadgeFromChatBot(
  bot: DoneBotCollabChatBot,
  localMatch?: LocalBotSummary,
): CollabBotBadgeAppearance {
  if (localMatch) {
    return {
      name: localMatch.name || bot.bot_name,
      color: localMatch.color || bot.bot_color,
      avatarUrl: localMatch.avatar_crop === "mascot" ? "" : (localMatch.avatar_url || ""),
      avatarCrop: localMatch.avatar_crop,
      avatarZoom: localMatch.avatar_zoom,
      avatarFocusX: localMatch.avatar_focus_x,
      avatarFocusY: localMatch.avatar_focus_y,
      bodyId: localMatch.mascot_body,
      faceColor: localMatch.mascot_face_color,
      expression: localMatch.mascot_expression,
    };
  }
  return {
    name: bot.bot_name,
    color: bot.bot_color,
    avatarUrl: bot.bot_avatar_crop === "mascot" ? "" : bot.bot_avatar_url,
    avatarCrop: bot.bot_avatar_crop,
    avatarZoom: bot.bot_avatar_zoom,
    avatarFocusX: bot.bot_avatar_focus_x,
    avatarFocusY: bot.bot_avatar_focus_y,
    bodyId: bot.bot_mascot_body,
    faceColor: bot.bot_mascot_face_color,
    expression: bot.bot_mascot_expression,
  };
}

export function resolveCollabBotBadgeFromMessage(
  msg: DoneBotChatMessage,
  chatBot?: DoneBotCollabChatBot,
  localMatch?: LocalBotSummary,
): CollabBotBadgeAppearance {
  if (localMatch) {
    return {
      name: localMatch.name || msg.sender_bot_name || "机器人",
      color: localMatch.color || msg.sender_bot_color || chatBot?.bot_color,
      avatarUrl: localMatch.avatar_crop === "mascot" ? "" : (localMatch.avatar_url || ""),
      avatarCrop: localMatch.avatar_crop,
      avatarZoom: localMatch.avatar_zoom,
      avatarFocusX: localMatch.avatar_focus_x,
      avatarFocusY: localMatch.avatar_focus_y,
      bodyId: localMatch.mascot_body,
      faceColor: localMatch.mascot_face_color,
      expression: localMatch.mascot_expression,
    };
  }
  const crop = chatBot?.bot_avatar_crop || msg.sender_bot_avatar_crop;
  const rawAvatarUrl = chatBot ? (chatBot.bot_avatar_crop === "mascot" ? "" : (chatBot.bot_avatar_url || "")) : (msg.sender_bot_avatar_crop === "mascot" ? "" : (msg.sender_bot_avatar_url || ""));
  return {
    name: chatBot?.bot_name || msg.sender_bot_name || "机器人",
    color: chatBot?.bot_color || msg.sender_bot_color,
    avatarUrl: rawAvatarUrl,
    avatarCrop: crop,
    avatarZoom: chatBot?.bot_avatar_zoom ?? msg.sender_bot_avatar_zoom,
    avatarFocusX: chatBot?.bot_avatar_focus_x ?? msg.sender_bot_avatar_focus_x,
    avatarFocusY: chatBot?.bot_avatar_focus_y ?? msg.sender_bot_avatar_focus_y,
    bodyId: chatBot?.bot_mascot_body || msg.sender_bot_mascot_body,
    faceColor: chatBot?.bot_mascot_face_color || msg.sender_bot_mascot_face_color,
    expression: chatBot?.bot_mascot_expression || msg.sender_bot_mascot_expression,
  };
}

export function CollabBotBadge({
  name,
  color,
  avatarUrl,
  avatarCrop,
  avatarZoom,
  avatarFocusX,
  avatarFocusY,
  bodyId,
  faceColor,
  expression,
  size = 30,
  className,
}: CollabBotBadgeAppearance & {
  size?: number;
  className?: string;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const src = avatarUrl?.trim() || "";
  useEffect(() => { setImgFailed(false); }, [src]);

  const parsedCrop = botAvatarCropSchema.safeParse(avatarCrop).data;
  const resolvedCrop: BotAvatarCrop = parsedCrop ?? (src ? "circle" : "mascot");
  const rawColor = (color ?? "").trim().toLowerCase();
  const resolvedColor: MausColor = rawColor && rawColor in MAUS_COLORS ? (rawColor as MausColor) : "blue";
  const resolvedFace: MascotFaceColor | null = faceColor === "white" || faceColor === "black" ? faceColor : null;
  const resolvedBody: BotBodyId = newBotBody(botBodySchema.safeParse(bodyId).data);
  const resolvedState = normalizeState(expression ?? undefined);

  if (resolvedCrop !== "mascot" && src && !imgFailed) {
    const radius = avatarCropRadius(resolvedCrop);
    const zoom = clampAvatarZoom(avatarZoom ?? 1);
    const focusX = clampAvatarFocus(avatarFocusX ?? 0.5);
    const focusY = clampAvatarFocus(avatarFocusY ?? 0.5);
    const origin = `${focusX * 100}% ${focusY * 100}%`;
    return (
      <span
        className={cn(
          "relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden bg-raised ring-1 ring-inset ring-ink/12",
          className,
        )}
        style={{ width: size, height: size, borderRadius: radius }}
        title={name}
      >
        <img
          src={src}
          alt={name}
          width={size}
          height={size}
          draggable={false}
          className="block size-full max-w-none object-cover"
          style={{
            width: size,
            height: size,
            objectPosition: origin,
            transform: zoom === 1 ? undefined : `scale(${zoom})`,
            transformOrigin: origin,
          }}
          loading="lazy"
          onError={() => setImgFailed(true)}
        />
      </span>
    );
  }

  return (
    <span
      className={cn("inline-flex shrink-0 select-none items-center justify-center", className)}
      style={{ width: size, height: size }}
      title={name}
    >
      <MausAvatar
        color={resolvedColor}
        bodyId={resolvedBody}
        faceColor={resolvedFace}
        state={resolvedState ?? "idle"}
        size={size}
        label={name}
        animated={false}
        trackPointer={false}
      />
    </span>
  );
}

/** Preserves the original aspect ratio so the bot's own crop/zoom/focus apply identically in group chats. */
export async function compressLocalBotAvatarUrl(url: string): Promise<string> {
  const src = url.trim();
  if (!src) return "";
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("image load failed"));
      el.src = src;
    });
    const natW = img.naturalWidth || img.width;
    const natH = img.naturalHeight || img.height;
    if (!natW || !natH) return "";
    const scale = Math.min(1, 256 / Math.max(natW, natH));
    const w = Math.max(1, Math.round(natW * scale));
    const h = Math.max(1, Math.round(natH * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, w, h);
    const pixels = ctx.getImageData(0, 0, w, h).data;
    let transparent = false;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] !== 255) {
        transparent = true;
        break;
      }
    }
    if (transparent) {
      const png = canvas.toDataURL("image/png");
      if (png.length <= 700_000) return png;
    }
    for (const quality of [0.88, 0.78, 0.66]) {
      const jpg = canvas.toDataURL("image/jpeg", quality);
      if (jpg.length <= 240_000) return jpg;
    }
    return canvas.toDataURL("image/jpeg", 0.54);
  } catch {
    return "";
  }
}

export async function compressAvatarFile(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("请选择 PNG、JPEG 或 WebP 格式的图片文件。");
  }
  if (file.size > 10 * 1024 * 1024) {
    throw new Error("所选图片过大，请选择 10 MB 以内的图片。");
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("无法解码所选图片，请换一张尝试。"));
      el.src = objectUrl;
    });
    const side = 256;
    const canvas = document.createElement("canvas");
    canvas.width = side;
    canvas.height = side;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("当前环境不支持图片压缩。");
    const minDim = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height);
    const sx = Math.max(0, Math.floor(((img.naturalWidth || img.width) - minDim) / 2));
    const sy = Math.max(0, Math.floor(((img.naturalHeight || img.height) - minDim) / 2));
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, side, side);
    for (const quality of [0.88, 0.78, 0.68]) {
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      if (dataUrl.length <= 240_000) return dataUrl;
    }
    return canvas.toDataURL("image/jpeg", 0.56);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function CollabProfileDialog({
  open,
  onClose,
  email,
  initialNickname,
  initialAvatarUrl,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  email: string;
  initialNickname: string;
  initialAvatarUrl: string;
  onSaved?: (profile: { nickname: string; avatar_url: string }) => Promise<void> | void;
}) {
  const { state, dispatch } = useStore();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const nicknameId = useId();
  const fileInputId = useId();

  const [nickname, setNickname] = useState(initialNickname);
  const [avatarUrl, setAvatarUrl] = useState(initialAvatarUrl);
  const [avatarTouched, setAvatarTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setNickname(initialNickname);
      setAvatarUrl(initialAvatarUrl);
      setAvatarTouched(false);
      setError("");
    }
  }, [open, initialNickname, initialAvatarUrl]);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open) {
      if (!el.open && typeof el.showModal === "function") el.showModal();
    } else if (el.open) {
      el.close();
    }
  }, [open]);

  // Progressive fallback for browsers without <dialog closedby="any">
  useEffect(() => {
    const el = dialogRef.current;
    if (!el || !open || (typeof HTMLDialogElement !== "undefined" && "closedBy" in HTMLDialogElement.prototype)) return;
    let pressedOutside = false;
    const isOutside = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    const onDown = (e: PointerEvent) => { pressedOutside = isOutside(e); };
    const onUp = (e: PointerEvent) => { if (pressedOutside && isOutside(e)) el.close(); };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
    };
  }, [open]);

  const handleClose = () => {
    const el = dialogRef.current;
    if (el) el.returnValue = "";
    onClose();
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError("");
    try {
      const compressed = await compressAvatarFile(file);
      setAvatarUrl(compressed);
      setAvatarTouched(true);
    } catch (cause) {
      setError(cleanError(cause, "处理头像图片失败，请重试。"));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const payload: { nickname: string; avatar_url?: string } = { nickname: nickname.trim() };
      if (avatarTouched) payload.avatar_url = avatarUrl;
      const updated = await api<{ nickname?: string; avatar_url?: string; local_avatar_url?: string }>("/api/donebot/collab/profile", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      const nextNickname = updated?.nickname ?? nickname.trim();
      const nextAvatar = updated?.avatar_url ?? avatarUrl;
      const nextLocalAvatar = updated?.local_avatar_url !== undefined
        ? updated.local_avatar_url
        : avatarTouched
          ? nextAvatar
          : state.config?.profile?.avatarUrl;
      if (state.config) {
        dispatch({
          type: "configStatus",
          config: {
            ...state.config,
            profile: {
              ...state.config.profile,
              name: nextNickname,
              email: email || state.config.profile?.email || "",
              ...(nextLocalAvatar ? { avatarUrl: nextLocalAvatar } : { avatarUrl: undefined }),
            },
          },
        });
      }
      await onSaved?.({ nickname: nextNickname, avatar_url: nextAvatar });
      dialogRef.current?.close();
    } catch (cause) {
      setError(cleanError(cause, "保存个人资料失败，请确认网关已升级至最新版本。"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={handleClose}
      {...({ closedby: "any" } as Record<string, unknown>)}
      className="donebot-collab-dialog"
    >
      {open && (
        <div className="w-[min(420px,calc(100vw-2rem))] overflow-hidden rounded-2xl bg-menu shadow-2xl ring-1 ring-ink/12">
          <div className="flex items-center justify-between border-b border-hairline/40 px-5 py-4">
            <h2 id={titleId} className="text-[15px] font-semibold text-ink">编辑个人资料</h2>
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              aria-label="关闭窗口"
              className="flex size-7 items-center justify-center rounded-lg text-ink-tertiary transition-colors hover:bg-ink/[0.08] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>

          <form onSubmit={e => void handleSubmit(e)} className="flex flex-col gap-5 p-5">
            <div className="flex items-center gap-4">
              <div className="relative">
                <CollabAvatar
                  avatarUrl={avatarUrl}
                  nickname={nickname}
                  email={email}
                  size={72}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="选择新头像"
                  className="absolute -bottom-1 -right-1 flex size-7 items-center justify-center rounded-full bg-accent text-accent-ink shadow-md ring-2 ring-menu transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  <Camera size={13} aria-hidden="true" />
                </button>
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="text-[13px] font-medium text-ink">头像</div>
                <p className="text-[11.5px] leading-relaxed text-ink-secondary">
                  好友和团队成员都会看到你的头像与昵称。
                </p>
                <div className="mt-0.5 flex flex-wrap items-center gap-2">
                  <input
                    ref={fileInputRef}
                    id={fileInputId}
                    name="avatar"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={e => void handleFileChange(e)}
                    className="sr-only"
                  />
                  <label
                    htmlFor={fileInputId}
                    className={`${COLLAB_BUTTON} h-7 cursor-pointer px-2.5 text-[12px]`}
                  >
                    <Camera size={12} aria-hidden="true" />上传头像
                  </label>
                  {avatarUrl && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => { setAvatarUrl(""); setAvatarTouched(true); }}
                      className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[12px] text-ink-tertiary hover:bg-danger/10 hover:text-danger"
                    >
                      <Trash2 size={12} aria-hidden="true" />移除
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor={nicknameId} className="text-[12px] font-medium text-ink-secondary">
                昵称
              </label>
              <input
                id={nicknameId}
                name="nickname"
                type="text"
                autoFocus
                autoComplete="nickname"
                maxLength={64}
                placeholder="例如：阿泽、Product Lead"
                value={nickname}
                onChange={e => setNickname(e.target.value)}
                disabled={busy}
                className={COLLAB_INPUT}
              />
              <span className="text-[11px] text-ink-tertiary">
                账号邮箱：{email || "未登录"}（最多 64 个字符，留空则显示邮箱）
              </span>
            </div>

            {error && (
              <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger/20">
                <AlertCircle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 border-t border-hairline/40 pt-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => dialogRef.current?.close()}
                className={`${COLLAB_BUTTON} text-[12.5px]`}
              >
                取消
              </button>
              <button
                type="submit"
                disabled={busy}
                className={`${COLLAB_BUTTON} ui-button-primary text-[12.5px]`}
              >
                {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
                保存资料
              </button>
            </div>
          </form>
        </div>
      )}
    </dialog>
  );
}
