import type { CollabChatScopeType, DoneBotChatMessage } from "../../shared/donebot-collab";

const MENTION_PATTERN = /(?:^|[\s([{"'，。！？、])@([^\s@]{0,40})$/;

export const INLINE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
export const VIDEO_EXTS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi"]);
export const AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".flac", ".ogg"]);
export const ARCHIVE_EXTS = new Set([".zip", ".tar", ".gz", ".7z", ".rar", ".dmg"]);
export const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".json", ".py", ".go", ".rs",
  ".java", ".css", ".html", ".sh", ".sql", ".yml", ".yaml",
]);

export function detectMentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = before.match(MENTION_PATTERN);
  if (!match) return null;
  const query = match[1] ?? "";
  const start = caret - query.length - 1;
  return start >= 0 ? { start, query } : null;
}

export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

export function formatMessageStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (sameDay) return `今天 ${hhmm}`;
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${hhmm}`;
}

export function shouldShowTimestamp(prev: DoneBotChatMessage | undefined, curr: DoneBotChatMessage): boolean {
  if (!prev) return true;
  const a = Date.parse(prev.created_at);
  const b = Date.parse(curr.created_at);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return b - a >= 5 * 60_000;
}

export function uploadChatFile(
  scopeType: CollabChatScopeType,
  targetId: string,
  file: File,
  caption: string,
  onProgress: (pct: number) => void,
): Promise<DoneBotChatMessage> {
  const params = new URLSearchParams({ name: file.name });
  if (caption.trim()) params.set("body", caption.trim());
  const url = `/api/donebot/collab/chats/${scopeType}/${encodeURIComponent(targetId)}/files?${params.toString()}`;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = evt => {
      if (evt.lengthComputable && evt.total > 0) {
        onProgress(Math.min(100, Math.round((evt.loaded / evt.total) * 100)));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        try {
          resolve(JSON.parse(xhr.responseText) as DoneBotChatMessage);
        } catch {
          reject(new Error("服务器返回了无效的文件消息。"));
        }
        return;
      }
      let message = `发送文件失败（HTTP ${xhr.status}）。`;
      try {
        const parsed = JSON.parse(xhr.responseText) as { error?: string; message?: string };
        if (parsed?.error) message = parsed.error;
        else if (parsed?.message) message = parsed.message;
      } catch { /* fallback */ }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("网络中断，发送文件失败。"));
    xhr.ontimeout = () => reject(new Error("发送文件超时，请稍后重试。"));
    xhr.send(file);
  });
}

export async function triggerFileDownload(fileId: string, fileName: string) {
  const res = await fetch(`/api/donebot/collab/chats/files/${encodeURIComponent(fileId)}`, { credentials: "same-origin" });
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
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = fileName || "file";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
}
