import { useEffect, useId, useRef, type ReactNode } from "react";
import { Download, Loader2, Music, Play, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { DoneBotChatMessage } from "../../shared/donebot-collab";
import { formatFileSize } from "./collab-types";
import type { ChatMediaKind } from "./collab-chat-helpers";
import "./collab.css";

export interface CollabMediaPreviewTarget {
  kind: Exclude<ChatMediaKind, "file">;
  fileId: string;
  src: string;
  name: string;
  size?: number;
}

export function CollabMediaBubble({
  msg,
  mediaKind,
  fileSrc,
  mine,
  bodyNode,
  onPreview,
}: {
  msg: DoneBotChatMessage;
  mediaKind: Exclude<ChatMediaKind, "file">;
  fileSrc: string;
  mine: boolean;
  bodyNode?: ReactNode;
  onPreview: (target: CollabMediaPreviewTarget) => void;
}) {
  const fileName = msg.file_name || (mediaKind === "image" ? "图片" : mediaKind === "video" ? "视频" : "音频");
  const openPreview = () => {
    if (!msg.file_id) return;
    onPreview({
      kind: mediaKind,
      fileId: msg.file_id,
      src: fileSrc,
      name: fileName,
      size: msg.file_size,
    });
  };

  return (
    <div className={cn("flex flex-col gap-1.5", mine ? "items-end" : "items-start")}>
      {mediaKind === "image" && (
        <button
          type="button"
          data-collab-media-bubble="image"
          aria-label={`预览图片 ${fileName}`}
          title="点击预览大图"
          onClick={openPreview}
          className="group relative block cursor-zoom-in overflow-hidden rounded-2xl ring-1 ring-ink/10 transition-opacity hover:opacity-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <img
            src={fileSrc}
            alt={fileName}
            loading="lazy"
            className="block max-h-72 max-w-[min(300px,68vw)] object-cover transition-transform duration-150 group-hover:scale-[1.015]"
          />
        </button>
      )}

      {mediaKind === "video" && (
        <button
          type="button"
          data-collab-media-bubble="video"
          aria-label={`预览视频 ${fileName}`}
          title="点击播放预览视频"
          onClick={openPreview}
          className="group relative block overflow-hidden rounded-2xl bg-black/90 ring-1 ring-ink/12 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <video
            src={fileSrc}
            preload="metadata"
            muted
            playsInline
            className="block max-h-64 min-h-[120px] min-w-[200px] max-w-[min(300px,68vw)] object-cover opacity-90 transition-opacity group-hover:opacity-100"
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/20 transition-colors group-hover:bg-black/30"
          >
            <span className="flex size-12 items-center justify-center rounded-full bg-black/55 text-white shadow-lg ring-1 ring-white/25 backdrop-blur-xs transition-transform group-hover:scale-105">
              <Play size={20} className="ml-0.5 fill-current" />
            </span>
          </span>
          {msg.file_size !== undefined && (
            <span className="pointer-events-none absolute bottom-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-medium tabular-nums text-white/90 backdrop-blur-xs">
              {formatFileSize(msg.file_size)}
            </span>
          )}
        </button>
      )}

      {mediaKind === "audio" && (
        <button
          type="button"
          data-collab-media-bubble="audio"
          aria-label={`播放预览音乐 ${fileName}`}
          title="点击试听音乐"
          onClick={openPreview}
          className={cn(
            "group flex w-[min(280px,68vw)] items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
            mine
              ? "bg-bubble-user text-bubble-user-ink hover:brightness-105"
              : "bg-card text-ink ring-1 ring-inset ring-ink/[0.08] hover:bg-raised/80",
          )}
        >
          <span
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-full transition-transform group-hover:scale-105",
              mine
                ? "bg-white/18 text-white"
                : "bg-accent/15 text-accent-text ring-1 ring-inset ring-accent/25",
            )}
          >
            <Play size={16} className="ml-0.5 fill-current" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-medium leading-5">{fileName}</span>
            <span className={cn("mt-0.5 flex items-center gap-1.5 text-[11px]", mine ? "opacity-75" : "text-ink-tertiary")}>
              <Music size={11} aria-hidden="true" />
              <span className="tabular-nums">{formatFileSize(msg.file_size) || "点击试听"}</span>
            </span>
          </span>
        </button>
      )}

      {msg.body && (
        <div
          className={cn(
            "whitespace-pre-wrap break-words rounded-[18px] px-3.5 py-2 text-[14px] leading-relaxed",
            mine
              ? "rounded-br-[6px] bg-bubble-user text-bubble-user-ink"
              : "rounded-bl-[6px] bg-card text-ink ring-1 ring-inset ring-ink/[0.07]",
          )}
        >
          {bodyNode ?? msg.body}
        </div>
      )}
    </div>
  );
}

export function CollabMediaPreviewDialog({
  preview,
  downloading,
  onClose,
  onDownload,
}: {
  preview: CollabMediaPreviewTarget | null;
  downloading: boolean;
  onClose: () => void;
  onDownload: (fileId: string, fileName: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const open = Boolean(preview);

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
    const onClick = (e: MouseEvent) => {
      if (e.target === el) el.close();
    };
    el.addEventListener("click", onClick);
    return () => { el.removeEventListener("click", onClick); };
  }, [open]);

  const closeDialog = () => {
    const el = dialogRef.current;
    if (el?.open) el.close();
    onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={onClose}
      {...({ closedby: "any" } as Record<string, unknown>)}
      className="donebot-collab-dialog max-h-none max-w-none bg-transparent p-0"
    >
      {preview && (
        <div
          data-collab-media-preview={preview.kind}
          onClick={e => {
            if (e.target === e.currentTarget) closeDialog();
          }}
          className="fixed inset-0 flex flex-col items-center justify-center bg-black/82 p-5 backdrop-blur-sm"
        >
          <div className="pointer-events-auto absolute inset-x-0 top-0 flex items-center justify-between gap-3 bg-gradient-to-b from-black/70 to-transparent px-5 py-4">
            <div className="min-w-0">
              <div id={titleId} className="truncate text-[14px] font-medium text-white">{preview.name}</div>
              {preview.size !== undefined && (
                <div className="text-[12px] tabular-nums text-white/65">{formatFileSize(preview.size)}</div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                disabled={downloading}
                onClick={() => onDownload(preview.fileId, preview.name)}
                aria-label="保存到本地"
                title="保存到本地"
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-white/14 px-3 text-[12px] font-medium text-white transition-colors hover:bg-white/24 disabled:opacity-50"
              >
                {downloading ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Download size={13} aria-hidden="true" />}
                保存
              </button>
              <button
                type="button"
                aria-label="关闭预览"
                title="关闭预览"
                onClick={closeDialog}
                className="flex size-8 items-center justify-center rounded-full bg-white/14 text-white transition-colors hover:bg-white/24"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          </div>

          {preview.kind === "image" && (
            <img
              src={preview.src}
              alt={preview.name}
              className="max-h-[82vh] max-w-[90vw] rounded-2xl object-contain shadow-2xl"
            />
          )}

          {preview.kind === "video" && (
            <video
              src={preview.src}
              controls
              autoPlay
              playsInline
              className="max-h-[82vh] max-w-[90vw] rounded-2xl bg-black shadow-2xl"
            />
          )}

          {preview.kind === "audio" && (
            <div className="flex w-[min(420px,calc(100vw-2.5rem))] flex-col items-center gap-4 rounded-3xl bg-menu/95 p-6 text-center shadow-2xl ring-1 ring-white/14">
              <span className="flex size-16 items-center justify-center rounded-2xl bg-accent/18 text-accent-text ring-1 ring-inset ring-accent/30">
                <Music size={28} aria-hidden="true" />
              </span>
              <div className="w-full min-w-0">
                <div className="truncate text-[15px] font-semibold text-ink">{preview.name}</div>
                {preview.size !== undefined && (
                  <div className="mt-0.5 text-[12px] tabular-nums text-ink-tertiary">{formatFileSize(preview.size)}</div>
                )}
              </div>
              <audio src={preview.src} controls autoPlay className="w-full" />
            </div>
          )}
        </div>
      )}
    </dialog>
  );
}
