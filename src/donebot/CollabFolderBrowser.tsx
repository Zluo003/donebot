import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronRight,
  Download,
  Eye,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  Loader2,
  RefreshCw,
  Upload,
  X,
} from "lucide-react";
import { api } from "@/state/api";
import { cn } from "@/lib/cn";
import { DONEBOT_COLLAB_MAX_FILE_BYTES, type DoneBotSharedFolder } from "../../shared/donebot-collab";
import { cleanError, COLLAB_BUTTON, formatFileSize } from "./collab-types";

type RemoteDirEntry = { name: string; kind: "file" | "dir"; size?: number };

type PreviewState =
  | { kind: "text"; path: string; text: string; size?: number }
  | { kind: "image"; path: string; objectUrl: string; size?: number };

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".flac", ".ogg"]);
const ARCHIVE_EXTS = new Set([".zip", ".tar", ".gz", ".7z", ".rar", ".dmg"]);
const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".css", ".html", ".sh", ".sql", ".yml", ".yaml", ".toml"]);
const TEXT_PREVIEW_EXTS = new Set([".txt", ".md", ".csv", ".log", ".env", ".xml", ...CODE_EXTS]);

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function FileTypeIcon({ name, kind }: { name: string; kind: "file" | "dir" }) {
  if (kind === "dir") return <Folder size={15} className="shrink-0 text-[#4ACAE5]" aria-hidden="true" />;
  const ext = extOf(name);
  if (IMAGE_EXTS.has(ext)) return <FileImage size={15} className="shrink-0 text-[#F07EAE]" aria-hidden="true" />;
  if (VIDEO_EXTS.has(ext)) return <FileVideo size={15} className="shrink-0 text-[#B596EE]" aria-hidden="true" />;
  if (AUDIO_EXTS.has(ext)) return <FileAudio size={15} className="shrink-0 text-[#F2A65A]" aria-hidden="true" />;
  if (ARCHIVE_EXTS.has(ext)) return <FileArchive size={15} className="shrink-0 text-[#D8A729]" aria-hidden="true" />;
  if (CODE_EXTS.has(ext)) return <FileCode2 size={15} className="shrink-0 text-[#5FA0FF]" aria-hidden="true" />;
  return <FileText size={15} className="shrink-0 text-ink-secondary" aria-hidden="true" />;
}

function parseDirectoryEntries(rawText: string): RemoteDirEntry[] {
  try {
    const parsed = JSON.parse(rawText) as { entries?: Array<{ name?: string; type?: string; size?: number }> };
    if (Array.isArray(parsed?.entries)) {
      return parsed.entries
        .filter(item =>
          typeof item?.name === "string"
          && item.name.length > 0
          && !item.name.startsWith(".")
          && item.type !== "blocked-link"
          && item.type !== "protected",
        )
        .map(item => ({
          name: item.name!,
          kind: (item.type === "directory" ? "dir" : "file") as "dir" | "file",
          ...(typeof item.size === "number" ? { size: item.size } : {}),
        }))
        .sort((a, b) => (a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
    }
  } catch { /* Fall back to plain-text line format */ }
  const entries: RemoteDirEntry[] = [];
  for (const line of rawText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.endsWith("/")) {
      const name = trimmed.slice(0, -1);
      if (name && !name.startsWith(".")) entries.push({ name, kind: "dir" });
    } else {
      const match = /^(.+?)\s+\((\d+)\s*B\)$/.exec(trimmed);
      const name = match ? match[1]! : trimmed;
      if (name && !name.startsWith(".")) {
        entries.push(match ? { name, kind: "file", size: Number(match[2]) } : { name, kind: "file" });
      }
    }
  }
  return entries.sort((a, b) => (a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
}

function formatReadFilePreview(rawText: string): string {
  try {
    const parsed = JSON.parse(rawText) as { content?: unknown; encoding?: string };
    if (typeof parsed?.content === "string") {
      return parsed.encoding === "base64" ? `[二进制文件，共 ${Math.floor(parsed.content.length * 0.75)} 字节，请点击下载查看]` : parsed.content;
    }
  } catch { /* Plain text fallback */ }
  return rawText;
}

function extractResultText(payload: unknown): { text: string; isError: boolean } {
  const res = (payload as { result?: { isError?: boolean; content?: Array<{ text?: string }> } })?.result;
  const text = Array.isArray(res?.content) ? res.content.map(part => part?.text ?? "").join("\n") : "";
  return { text, isError: res?.isError === true };
}

function fileEndpoint(folderId: string, relPath: string): string {
  return `/api/donebot/collab/folders/${folderId}/file?path=${encodeURIComponent(relPath)}`;
}

async function uploadWithProgress(url: string, file: File, onProgress: (pct: number) => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = evt => {
      if (evt.lengthComputable && evt.total > 0) {
        onProgress(Math.min(100, Math.round((evt.loaded / evt.total) * 100)));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
        return;
      }
      let message = `上传失败（HTTP ${xhr.status}）。`;
      try {
        const parsed = JSON.parse(xhr.responseText) as { error?: string; message?: string };
        if (parsed?.error) message = parsed.error;
        else if (parsed?.message) message = parsed.message;
      } catch { /* fallback */ }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("网络中断，文件上传失败。"));
    xhr.ontimeout = () => reject(new Error("文件上传超时，请检查对方电脑是否在线。"));
    xhr.send(file);
  });
}

export function CollabFolderBrowser({ folder, compact = false }: { folder: DoneBotSharedFolder; compact?: boolean }) {
  const [browsePath, setBrowsePath] = useState("");
  const [entries, setEntries] = useState<RemoteDirEntry[]>([]);
  const [rawText, setRawText] = useState("");
  const [loading, setLoading] = useState(false);
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);
  const [uploading, setUploading] = useState<{ name: string; percent: number } | null>(null);
  const [draggingOver, setDraggingOver] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadInputId = useId();

  useEffect(() => {
    return () => {
      if (preview?.kind === "image") URL.revokeObjectURL(preview.objectUrl);
    };
  }, [preview]);

  const closePreview = () => {
    setPreview(prev => {
      if (prev?.kind === "image") URL.revokeObjectURL(prev.objectUrl);
      return null;
    });
  };

  const loadDir = useCallback(async (relPath: string) => {
    setBrowsePath(relPath);
    setPreview(prev => {
      if (prev?.kind === "image") URL.revokeObjectURL(prev.objectUrl);
      return null;
    });
    setLoading(true);
    setError("");
    try {
      const res = await api(`/api/donebot/collab/folders/${folder.id}/invoke`, {
        method: "POST",
        body: JSON.stringify({ action: "list_files", path: relPath }),
      });
      const parsed = extractResultText(res);
      if (parsed.isError) {
        setError(parsed.text || "无法列出远程目录。");
        setEntries([]);
        setRawText("");
      } else {
        setRawText(parsed.text);
        setEntries(parseDirectoryEntries(parsed.text));
      }
    } catch (cause) {
      setError(cleanError(cause, "读取远程目录失败。"));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [folder.id]);

  useEffect(() => {
    void loadDir("");
  }, [loadDir]);

  const downloadFile = async (filePath: string, fileName: string) => {
    if (downloadingPath) return;
    setDownloadingPath(filePath);
    setError("");
    setNotice("");
    try {
      const res = await fetch(fileEndpoint(folder.id, filePath), { credentials: "same-origin" });
      if (!res.ok) {
        let msg = `下载失败（HTTP ${res.status}）。`;
        try {
          const payload = await res.json() as { error?: string };
          if (payload?.error) msg = payload.error;
        } catch { /* ignore */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
      setNotice(`已开始下载「${fileName}」（${formatFileSize(blob.size)}）。`);
    } catch (cause) {
      setError(cleanError(cause, "下载远程文件失败。"));
    } finally {
      setDownloadingPath(null);
    }
  };

  const openFilePreview = async (entry: RemoteDirEntry, filePath: string) => {
    const ext = extOf(entry.name);
    if (IMAGE_EXTS.has(ext) && (entry.size === undefined || entry.size <= 15 * 1024 * 1024)) {
      setLoading(true);
      setError("");
      try {
        const res = await fetch(fileEndpoint(folder.id, filePath), { credentials: "same-origin" });
        if (!res.ok) {
          let msg = "无法预览该图片。";
          try {
            const payload = await res.json() as { error?: string };
            if (payload?.error) msg = payload.error;
          } catch { /* ignore */ }
          throw new Error(msg);
        }
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        setPreview({ kind: "image", path: filePath, objectUrl, size: blob.size });
      } catch (cause) {
        setError(cleanError(cause, "预览图片失败。"));
      } finally {
        setLoading(false);
      }
      return;
    }

    if (entry.size !== undefined && entry.size > 2 * 1024 * 1024) {
      void downloadFile(filePath, entry.name);
      return;
    }

    if (!TEXT_PREVIEW_EXTS.has(ext) && entry.size !== undefined && entry.size > 512 * 1024) {
      void downloadFile(filePath, entry.name);
      return;
    }

    setLoading(true);
    setError("");
    try {
      const res = await api(`/api/donebot/collab/folders/${folder.id}/invoke`, {
        method: "POST",
        body: JSON.stringify({ action: "read_file", path: filePath }),
      });
      const parsed = extractResultText(res);
      if (parsed.isError) {
        setError(parsed.text || "无法读取该文件。");
      } else {
        setPreview({ kind: "text", path: filePath, text: formatReadFilePreview(parsed.text), size: entry.size });
      }
    } catch (cause) {
      setError(cleanError(cause, "读取远程文件失败。"));
    } finally {
      setLoading(false);
    }
  };

  const uploadLocalFile = async (file: File) => {
    if (folder.access !== "write" || uploading) return;
    setError("");
    setNotice("");
    if (file.size > DONEBOT_COLLAB_MAX_FILE_BYTES) {
      setError(`「${file.name}」大小为 ${formatFileSize(file.size)}，超过了单个文件 100 MB 的上限。`);
      return;
    }
    const targetRelPath = browsePath ? `${browsePath}/${file.name}` : file.name;
    setUploading({ name: file.name, percent: 0 });
    try {
      await uploadWithProgress(fileEndpoint(folder.id, targetRelPath), file, percent => {
        setUploading(curr => (curr ? { ...curr, percent } : null));
      });
      setNotice(`已上传「${file.name}」（${formatFileSize(file.size)}）到对方文件夹。`);
      await loadDir(browsePath);
    } catch (cause) {
      setError(cleanError(cause, "上传文件失败。"));
    } finally {
      setUploading(null);
    }
  };

  const segments = browsePath ? browsePath.split("/").filter(Boolean) : [];
  const canWrite = folder.access === "write";

  return (
    <div
      onDragOver={e => {
        if (!canWrite) return;
        e.preventDefault();
        setDraggingOver(true);
      }}
      onDragLeave={() => setDraggingOver(false)}
      onDrop={e => {
        if (!canWrite) return;
        e.preventDefault();
        setDraggingOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file) void uploadLocalFile(file);
      }}
      className={cn(
        "flex flex-col gap-3 rounded-xl bg-inset/85 p-3.5 ring-1 ring-inset transition-colors",
        draggingOver ? "ring-2 ring-accent bg-accent/[0.06]" : "ring-ink/[0.08]",
      )}
    >
      {/* Breadcrumb & actions toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
        <nav aria-label="文件夹路径" className="flex min-w-0 flex-wrap items-center gap-1 font-mono text-ink-secondary">
          <button
            type="button"
            onClick={() => void loadDir("")}
            className="rounded-md px-1.5 py-0.5 transition-colors hover:bg-ink/[0.06] hover:text-ink"
          >
            {folder.name}
          </button>
          {segments.map((seg, idx) => {
            const target = segments.slice(0, idx + 1).join("/");
            const isLast = idx === segments.length - 1;
            return (
              <span key={target} className="inline-flex min-w-0 items-center gap-1">
                <ChevronRight size={12} className="shrink-0 opacity-60" aria-hidden="true" />
                <button
                  type="button"
                  onClick={() => void loadDir(target)}
                  className={cn(
                    "max-w-[160px] truncate rounded-md px-1.5 py-0.5 transition-colors hover:bg-ink/[0.06]",
                    isLast ? "font-medium text-ink" : "hover:text-ink",
                  )}
                >
                  {seg}
                </button>
              </span>
            );
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-1.5">
          {canWrite && (
            <>
              <input
                ref={uploadInputRef}
                id={uploadInputId}
                type="file"
                className="sr-only"
                onChange={e => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void uploadLocalFile(file);
                }}
              />
              <label
                htmlFor={uploadInputId}
                className={cn(
                  `${COLLAB_BUTTON} ui-button-primary h-7 cursor-pointer px-2.5 text-[11.5px]`,
                  uploading && "pointer-events-none opacity-50",
                )}
              >
                <Upload size={12} aria-hidden="true" />
                上传文件
              </label>
            </>
          )}
          <button
            type="button"
            aria-label="刷新目录"
            title="刷新目录"
            disabled={loading}
            onClick={() => void loadDir(browsePath)}
            className={`${COLLAB_BUTTON} h-7 px-2 text-[11.5px]`}
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Upload progress bar */}
      {uploading && (
        <div role="status" className="flex flex-col gap-1.5 rounded-xl bg-app/80 px-3 py-2.5 ring-1 ring-inset ring-ink/[0.07]">
          <div className="flex items-center justify-between text-[12px]">
            <span className="truncate font-medium text-ink">正在上传「{uploading.name}」…</span>
            <span className="shrink-0 tabular-nums text-ink-secondary">{uploading.percent}%</span>
          </div>
          <progress
            aria-label={`上传进度 ${uploading.name}`}
            className="donebot-upload-progress"
            max={100}
            value={uploading.percent}
          />
        </div>
      )}

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger/20">
          <AlertCircle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span className="flex-1">{error}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setError("")} className="text-danger/70 hover:text-danger">
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      )}

      {notice && (
        <div role="status" className="flex items-center justify-between gap-2 rounded-xl bg-success/12 px-3 py-2 text-[12px] text-success ring-1 ring-inset ring-success/25">
          <span className="flex items-center gap-1.5"><Check size={13} aria-hidden="true" />{notice}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setNotice("")} className="text-success/70 hover:text-success">
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Body */}
      {loading ? (
        <div className="flex items-center gap-2 py-5 text-[12px] text-ink-secondary">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          <span>正在经网关读取对方电脑文件夹…</span>
        </div>
      ) : preview ? (
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-mono font-medium text-ink">{preview.path}</span>
              {preview.size !== undefined && (
                <span className="shrink-0 text-[11px] text-ink-tertiary">{formatFileSize(preview.size)}</span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                disabled={downloadingPath === preview.path}
                onClick={() => void downloadFile(preview.path, preview.path.split("/").pop() || "download")}
                className={`${COLLAB_BUTTON} h-7 px-2.5 text-[11.5px]`}
              >
                {downloadingPath === preview.path ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Download size={12} aria-hidden="true" />}
                下载原文件
              </button>
              <button type="button" onClick={closePreview} className={`${COLLAB_BUTTON} h-7 px-2.5 text-[11.5px]`}>
                返回列表
              </button>
            </div>
          </div>
          {preview.kind === "image" ? (
            <div className="flex max-h-80 items-center justify-center overflow-auto rounded-xl bg-app/90 p-3 ring-1 ring-inset ring-ink/[0.07]">
              <img src={preview.objectUrl} alt={preview.path} className="max-h-72 max-w-full rounded-lg object-contain" />
            </div>
          ) : (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-app/90 p-3.5 font-mono text-[11.5px] leading-relaxed text-ink ring-1 ring-inset ring-ink/[0.07]">
              {preview.text}
            </pre>
          )}
        </div>
      ) : entries.length > 0 ? (
        <ul className={cn("divide-y divide-ink/[0.05] overflow-y-auto rounded-xl bg-app/80 ring-1 ring-inset ring-ink/[0.07]", compact ? "max-h-[55vh]" : "max-h-72")}>
          {entries.map(entry => {
            const fullPath = browsePath ? `${browsePath}/${entry.name}` : entry.name;
            const ext = extOf(entry.name);
            const canPreview = entry.kind === "file"
              && ((IMAGE_EXTS.has(ext) && (entry.size === undefined || entry.size <= 15 * 1024 * 1024))
                || ((TEXT_PREVIEW_EXTS.has(ext) || entry.size === undefined) && (entry.size === undefined || entry.size <= 2 * 1024 * 1024)));
            const isDownloading = downloadingPath === fullPath;
            return (
              <li key={fullPath} className="group flex items-center gap-2 px-3 py-2 transition-colors hover:bg-ink/[0.035]">
                <button
                  type="button"
                  onClick={() => entry.kind === "dir" ? void loadDir(fullPath) : void openFilePreview(entry, fullPath)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left text-[12.5px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  <FileTypeIcon name={entry.name} kind={entry.kind} />
                  <span className="truncate font-medium text-ink">{entry.name}</span>
                </button>
                {entry.size !== undefined && (
                  <span className="shrink-0 tabular-nums text-[11px] text-ink-tertiary">
                    {formatFileSize(entry.size)}
                  </span>
                )}
                {entry.kind === "file" && (
                  <div className="flex shrink-0 items-center gap-1">
                    {canPreview && (
                      <button
                        type="button"
                        onClick={() => void openFilePreview(entry, fullPath)}
                        aria-label={`预览 ${entry.name}`}
                        title="在线预览"
                        className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-ink-secondary transition-colors hover:bg-ink/[0.07] hover:text-ink"
                      >
                        <Eye size={12} aria-hidden="true" />
                        <span className="hidden sm:inline">预览</span>
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={downloadingPath !== null}
                      onClick={() => void downloadFile(fullPath, entry.name)}
                      aria-label={`下载 ${entry.name}`}
                      title="流式下载（支持最大 100 MB）"
                      className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-ink-secondary transition-colors hover:bg-ink/[0.07] hover:text-ink disabled:opacity-50"
                    >
                      {isDownloading ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Download size={12} aria-hidden="true" />}
                      <span className="hidden sm:inline">{isDownloading ? "下载中" : "下载"}</span>
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="rounded-xl bg-app/50 px-4 py-6 text-center text-[12px] text-ink-tertiary">
          {rawText || (canWrite ? "此目录为空，点击右上角「上传文件」或直接拖拽文件到这里（最大 100 MB）。" : "此目录为空。")}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 text-[11px] text-ink-tertiary">
        <span>支持最大 100 MB 流式传输 · 不显示隐藏文件</span>
        {canWrite && <span className="shrink-0">支持拖拽</span>}
      </div>
    </div>
  );
}
