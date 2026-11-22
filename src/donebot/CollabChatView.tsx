import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowUp,
  ChevronRight,
  Download,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileText,
  FileVideo,
  Loader2,
  PanelRight,
  Plus,
  UserPlus,
  X,
} from "lucide-react";
import { api } from "@/state/api";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { ELEVATED_FLOAT, ELEVATED_HOVER } from "@/components/elevated";
import { roundButtonCls } from "@/components/bot-panel/rows";
import { imeComposing } from "@/lib/send-key";
import { cn } from "@/lib/cn";
import {
  DONEBOT_COLLAB_MAX_FILE_BYTES,
  type CollabChatScopeType,
  type DoneBotChatMessage,
  type DoneBotFriend,
} from "../../shared/donebot-collab";
import type { DoneBotTeamIdentity } from "../../shared/donebot-teams";
import {
  clearChatSummaryUnread,
  openCollabDialog,
  toggleCollabRightPanel,
  upsertChatSummaryFromMessage,
  useCollabStore,
} from "./collab-store";
import {
  cleanError,
  displayPersonName,
  formatFileSize,
  type CollabOverview,
} from "./collab-types";
import { CollabAvatar, CollabTeamBadge } from "./CollabAvatar";

const POLL_MS = 3_000;
const INLINE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".flac", ".ogg"]);
const ARCHIVE_EXTS = new Set([".zip", ".tar", ".gz", ".7z", ".rar", ".dmg"]);
const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".py", ".go", ".rs", ".java", ".css", ".html", ".sh", ".sql", ".yml", ".yaml"]);

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function ChatFileIcon({ name }: { name: string }) {
  const ext = extOf(name);
  if (IMAGE_EXTS.has(ext)) return <FileImage size={18} className="shrink-0 text-[#F07EAE]" aria-hidden="true" />;
  if (VIDEO_EXTS.has(ext)) return <FileVideo size={18} className="shrink-0 text-[#B596EE]" aria-hidden="true" />;
  if (AUDIO_EXTS.has(ext)) return <FileAudio size={18} className="shrink-0 text-[#F2A65A]" aria-hidden="true" />;
  if (ARCHIVE_EXTS.has(ext)) return <FileArchive size={18} className="shrink-0 text-[#D8A729]" aria-hidden="true" />;
  if (CODE_EXTS.has(ext)) return <FileCode2 size={18} className="shrink-0 text-[#5FA0FF]" aria-hidden="true" />;
  return <FileText size={18} className="shrink-0 text-ink-secondary" aria-hidden="true" />;
}

function formatMessageStamp(iso: string): string {
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

function shouldShowTimestamp(prev: DoneBotChatMessage | undefined, curr: DoneBotChatMessage): boolean {
  if (!prev) return true;
  const a = Date.parse(prev.created_at);
  const b = Date.parse(curr.created_at);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return b - a >= 5 * 60_000;
}

function uploadChatFile(
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

async function triggerFileDownload(fileId: string, fileName: string) {
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

export function CollabChatView({
  scopeType,
  targetId,
  friend,
  team,
  overview,
  onChatFileSent,
}: {
  scopeType: CollabChatScopeType;
  targetId: string;
  friend?: DoneBotFriend | null;
  team?: DoneBotTeamIdentity | null;
  overview: CollabOverview;
  onChatFileSent?: () => void;
}) {
  const { dragProps } = useCaptionChrome();
  const { rightPanelOpen } = useCollabStore();
  const [messages, setMessages] = useState<DoneBotChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState<{ name: string; percent: number } | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [draggingOver, setDraggingOver] = useState(false);
  const [error, setError] = useState("");

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastIdRef = useRef(0);
  const pinnedBottomRef = useRef(true);
  const fileInputId = useId();

  const myUserId = Number(overview.identity.account_id);
  const title = friend ? displayPersonName(friend) : (team?.name ?? "协作聊天");
  const subtitle = friend
    ? (friend.remark && friend.nickname && friend.nickname !== friend.remark ? `${friend.nickname} · ${friend.email}` : friend.email)
    : `${overview.team_members[team?.id ?? ""]?.length ?? 0} 位成员`;

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "instant" });
  }, []);

  const markRead = useCallback(async (lastReadId: number) => {
    clearChatSummaryUnread(scopeType, targetId);
    try {
      await api(`/api/donebot/collab/chats/${scopeType}/${encodeURIComponent(targetId)}/read`, {
        method: "POST",
        body: JSON.stringify(lastReadId > 0 ? { last_read_id: lastReadId } : {}),
      });
    } catch { /* best-effort read receipt */ }
  }, [scopeType, targetId]);

  // Initial load when conversation changes.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    setMessages([]);
    lastIdRef.current = 0;
    pinnedBottomRef.current = true;

    void api<DoneBotChatMessage[]>(`/api/donebot/collab/chats/${scopeType}/${encodeURIComponent(targetId)}/messages?limit=80`)
      .then(list => {
        if (!alive) return;
        const arr = Array.isArray(list) ? list : [];
        setMessages(arr);
        const latest = arr[arr.length - 1];
        if (latest) {
          lastIdRef.current = latest.id;
          void markRead(latest.id);
        } else {
          clearChatSummaryUnread(scopeType, targetId);
        }
        setLoading(false);
        queueMicrotask(() => scrollToBottom(false));
      })
      .catch(cause => {
        if (!alive) return;
        setError(cleanError(cause, "加载聊天记录失败，请确认网关已升级至最新版本。"));
        setLoading(false);
      });

    return () => { alive = false; };
  }, [scopeType, targetId, markRead, scrollToBottom]);

  // Incremental poll every 3s while conversation is open & visible.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (!alive) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        const query = lastIdRef.current > 0 ? `?after_id=${lastIdRef.current}&limit=100` : "?limit=80";
        const incoming = await api<DoneBotChatMessage[]>(`/api/donebot/collab/chats/${scopeType}/${encodeURIComponent(targetId)}/messages${query}`);
        if (!alive || !Array.isArray(incoming) || incoming.length === 0) return;
        let newest: DoneBotChatMessage | null = null;
        setMessages(prev => {
          const seen = new Set(prev.map(m => m.id));
          const fresh = incoming.filter(m => !seen.has(m.id));
          if (fresh.length === 0) return prev;
          newest = fresh[fresh.length - 1]!;
          lastIdRef.current = Math.max(lastIdRef.current, newest.id);
          return [...prev, ...fresh];
        });
        if (newest) {
          upsertChatSummaryFromMessage(newest, -1);
          void markRead((newest as DoneBotChatMessage).id);
          if ((newest as DoneBotChatMessage).kind === "file") onChatFileSent?.();
          if (pinnedBottomRef.current) queueMicrotask(() => scrollToBottom(true));
        }
      } catch { /* silent background poll */ }
    };
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [scopeType, targetId, markRead, scrollToBottom, onChatFileSent]);

  const sendText = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError("");
    try {
      const created = await api<DoneBotChatMessage>(`/api/donebot/collab/chats/${scopeType}/${encodeURIComponent(targetId)}/messages`, {
        method: "POST",
        body: JSON.stringify({ body: text }),
      });
      setDraft("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      setMessages(prev => (prev.some(m => m.id === created.id) ? prev : [...prev, created]));
      lastIdRef.current = Math.max(lastIdRef.current, created.id);
      upsertChatSummaryFromMessage(created, -1);
      pinnedBottomRef.current = true;
      queueMicrotask(() => scrollToBottom(true));
    } catch (cause) {
      setError(cleanError(cause, "发送消息失败，请稍后重试。"));
    } finally {
      setSending(false);
    }
  };

  const sendFile = async (file: File) => {
    if (uploading) return;
    setError("");
    if (file.size === 0) {
      setError("不能发送空文件。");
      return;
    }
    if (file.size > DONEBOT_COLLAB_MAX_FILE_BYTES) {
      setError(`「${file.name}」大小为 ${formatFileSize(file.size)}，超过了 100 MB 上限。`);
      return;
    }
    const caption = draft.trim();
    setUploading({ name: file.name, percent: 0 });
    try {
      const created = await uploadChatFile(scopeType, targetId, file, caption, percent => {
        setUploading(curr => (curr ? { ...curr, percent } : null));
      });
      if (caption) {
        setDraft("");
        if (textareaRef.current) textareaRef.current.style.height = "auto";
      }
      setMessages(prev => (prev.some(m => m.id === created.id) ? prev : [...prev, created]));
      lastIdRef.current = Math.max(lastIdRef.current, created.id);
      upsertChatSummaryFromMessage(created, -1);
      onChatFileSent?.();
      pinnedBottomRef.current = true;
      queueMicrotask(() => scrollToBottom(true));
    } catch (cause) {
      setError(cleanError(cause, "发送文件失败。"));
    } finally {
      setUploading(null);
    }
  };

  const handleDownload = async (fileId: string, fileName: string) => {
    if (downloadingId) return;
    setDownloadingId(fileId);
    setError("");
    try {
      await triggerFileDownload(fileId, fileName);
    } catch (cause) {
      setError(cleanError(cause, "下载文件失败。"));
    } finally {
      setDownloadingId(null);
    }
  };

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  };

  const handleComposerChange = (value: string) => {
    setDraft(value);
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(160, ta.scrollHeight)}px`;
    }
  };

  const canInviteTeam = Boolean(team && team.role !== "member");

  return (
    <section
      data-collab-chat={`${scopeType}:${targetId}`}
      onDragOver={e => {
        e.preventDefault();
        setDraggingOver(true);
      }}
      onDragLeave={e => {
        if (e.currentTarget === e.target) setDraggingOver(false);
      }}
      onDrop={e => {
        e.preventDefault();
        setDraggingOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file) void sendFile(file);
      }}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-app"
    >
      {/* Floating Chat Header matching native ChatHeadPill */}
      <header {...dragProps} className="flex h-[54px] shrink-0 items-center justify-between gap-3 px-4 max-md:pl-12">
        <button
          type="button"
          data-collab-chat-head-pill=""
          aria-expanded={rightPanelOpen}
          title={rightPanelOpen ? "收起右侧详情栏" : "展开右侧详情栏"}
          onClick={() => toggleCollabRightPanel()}
          className={cn(
            "group flex min-w-0 max-w-[min(70%,420px)] items-center gap-2 rounded-full py-[6px] pl-[7px] pr-[13px] text-ink",
            ELEVATED_FLOAT,
            ELEVATED_HOVER,
          )}
        >
          {friend ? (
            <CollabAvatar
              avatarUrl={friend.avatar_url}
              remark={friend.remark}
              nickname={friend.nickname}
              email={friend.email}
              size={26}
            />
          ) : (
            <CollabTeamBadge name={title} size={26} />
          )}
          <span dir="auto" className="min-w-0 truncate text-[14px] font-medium leading-5">{title}</span>
          {team && (
            <span className="shrink-0 text-[12px] text-ink-tertiary">{subtitle}</span>
          )}
          {!rightPanelOpen && (
            <ChevronRight size={13} aria-hidden="true" className="shrink-0 text-ink-tertiary transition-transform group-hover:translate-x-0.5" />
          )}
        </button>

        <div className="flex shrink-0 items-center gap-2">
          {canInviteTeam && team && (
            <button
              type="button"
              data-collab-chat-invite=""
              aria-label="邀请团队成员"
              title="邀请团队成员"
              onClick={() => openCollabDialog({ kind: "invite-team", teamId: team.id })}
              className={roundButtonCls}
            >
              <UserPlus size={15} className="pointer-events-none" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            data-collab-toggle-panel=""
            aria-label={rightPanelOpen ? "收起右侧栏" : "展开右侧栏"}
            title={rightPanelOpen ? "收起右侧栏" : "展开右侧栏"}
            aria-pressed={rightPanelOpen}
            onClick={() => toggleCollabRightPanel()}
            className={cn(roundButtonCls, rightPanelOpen && "bg-ink/[0.12]")}
          >
            <PanelRight size={15} className="pointer-events-none" aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* Drop overlay */}
      {draggingOver && (
        <div className="pointer-events-none absolute inset-4 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-app/85 backdrop-blur-xs">
          <div className="rounded-xl bg-menu px-5 py-3 text-[13.5px] font-medium text-ink shadow-lg ring-1 ring-ink/10">
            松开鼠标即可发送文件给「{title}」（最大 100 MB）
          </div>
        </div>
      )}

      {/* Message list */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
      >
        <div className="mx-auto flex w-full max-w-[740px] flex-col gap-3">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-ink-secondary">
              <Loader2 size={15} className="animate-spin" aria-hidden="true" />
              <span>正在加载消息…</span>
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-20 text-center">
              {friend ? (
                <CollabAvatar
                  avatarUrl={friend.avatar_url}
                  remark={friend.remark}
                  nickname={friend.nickname}
                  email={friend.email}
                  size={60}
                />
              ) : (
                <CollabTeamBadge name={title} size={60} />
              )}
              <div>
                <h2 className="text-[16px] font-semibold text-ink">{title}</h2>
                {subtitle && subtitle !== title && (
                  <p className="mt-0.5 text-[12.5px] text-ink-secondary">{subtitle}</p>
                )}
              </div>
              <p className="max-w-xs text-[12.5px] leading-relaxed text-ink-tertiary">
                在下方直接发送消息或文件（最大 100 MB）；右侧栏可管理共享文件夹与共享 Bot。
              </p>
            </div>
          ) : (
            messages.map((msg, idx) => {
              const mine = msg.sender_id === myUserId;
              const prev = messages[idx - 1];
              const showTime = shouldShowTimestamp(prev, msg);
              const senderLabel = displayPersonName({
                remark: msg.sender_remark,
                nickname: msg.sender_nickname,
                email: msg.sender_email,
              });
              const isInlineImage = msg.kind === "file"
                && Boolean(msg.file_id)
                && INLINE_IMAGE_MIMES.has((msg.file_mime ?? "").toLowerCase().split(";")[0] ?? "");
              const fileSrc = msg.file_id ? `/api/donebot/collab/chats/files/${encodeURIComponent(msg.file_id)}?inline=1` : "";

              return (
                <div key={msg.id} data-collab-msg={msg.id} className="flex flex-col gap-2">
                  {showTime && (
                    <div className="my-1 text-center text-[11.5px] text-ink-tertiary">
                      {formatMessageStamp(msg.created_at)}
                    </div>
                  )}
                  <div className={cn("flex items-end gap-2.5", mine ? "justify-end" : "justify-start")}>
                    {!mine && (
                      <CollabAvatar
                        avatarUrl={msg.sender_avatar_url}
                        remark={msg.sender_remark}
                        nickname={msg.sender_nickname}
                        email={msg.sender_email}
                        size={30}
                        className="mb-0.5"
                      />
                    )}
                    <div className={cn("flex max-w-[min(78%,520px)] flex-col gap-1", mine ? "items-end" : "items-start")}>
                      {!mine && scopeType === "team" && (
                        <span className="px-1 text-[11.5px] text-ink-tertiary">{senderLabel}</span>
                      )}

                      {msg.kind === "file" && msg.file_id ? (
                        <div
                          className={cn(
                            "flex flex-col gap-2 overflow-hidden rounded-[18px] p-2.5",
                            mine
                              ? "rounded-br-[6px] bg-bubble-user text-bubble-user-ink"
                              : "rounded-bl-[6px] bg-card text-ink ring-1 ring-inset ring-ink/[0.07]",
                          )}
                        >
                          {isInlineImage && (
                            <button
                              type="button"
                              onClick={() => void handleDownload(msg.file_id!, msg.file_name || "image")}
                              className="group relative overflow-hidden rounded-xl bg-inset/60 text-left"
                              title="点击下载原图"
                            >
                              <img
                                src={fileSrc}
                                alt={msg.file_name || "图片"}
                                loading="lazy"
                                className="max-h-72 max-w-[320px] rounded-xl object-contain"
                              />
                            </button>
                          )}
                          <div className="flex items-center gap-2.5 px-1 py-0.5">
                            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-ink/[0.08]">
                              <ChatFileIcon name={msg.file_name || ""} />
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[13px] font-medium">{msg.file_name || "未命名文件"}</div>
                              <div className={cn("text-[11px] tabular-nums", mine ? "opacity-75" : "text-ink-tertiary")}>
                                {formatFileSize(msg.file_size)}
                              </div>
                            </div>
                            <button
                              type="button"
                              disabled={downloadingId !== null}
                              aria-label={`下载 ${msg.file_name || "文件"}`}
                              onClick={() => void handleDownload(msg.file_id!, msg.file_name || "file")}
                              className={cn(
                                "flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
                                mine ? "bg-white/15 hover:bg-white/25" : "bg-ink/[0.06] text-ink hover:bg-ink/[0.12]",
                              )}
                            >
                              {downloadingId === msg.file_id
                                ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                                : <Download size={14} aria-hidden="true" />}
                            </button>
                          </div>
                          {msg.body && (
                            <p className="whitespace-pre-wrap break-words px-1 text-[13.5px] leading-relaxed">{msg.body}</p>
                          )}
                        </div>
                      ) : (
                        <div
                          className={cn(
                            "whitespace-pre-wrap break-words rounded-[18px] px-3.5 py-2 text-[14px] leading-relaxed",
                            mine
                              ? "rounded-br-[6px] bg-bubble-user text-bubble-user-ink"
                              : "rounded-bl-[6px] bg-card text-ink ring-1 ring-inset ring-ink/[0.07]",
                          )}
                        >
                          {msg.body}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="shrink-0 px-5 pb-4 pt-1">
        <div className="mx-auto flex w-full max-w-[740px] flex-col gap-2">
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger/20">
              <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span className="flex-1">{error}</span>
              <button type="button" aria-label="关闭提示" onClick={() => setError("")} className="text-danger/70 hover:text-danger">
                <X size={13} aria-hidden="true" />
              </button>
            </div>
          )}

          {uploading && (
            <div role="status" className="flex flex-col gap-1.5 rounded-xl bg-composer px-3.5 py-2.5 ring-1 ring-inset ring-ink/[0.08]">
              <div className="flex items-center justify-between text-[12px]">
                <span className="truncate font-medium text-ink">正在发送「{uploading.name}」…</span>
                <span className="shrink-0 tabular-nums text-ink-secondary">{uploading.percent}%</span>
              </div>
              <progress
                aria-label={`发送文件进度 ${uploading.name}`}
                className="donebot-upload-progress"
                max={100}
                value={uploading.percent}
              />
            </div>
          )}

          <div className="flex items-end gap-2 rounded-[24px] bg-composer px-2.5 py-2 shadow-[0_1px_4px_rgb(0_0_0/0.12)] ring-1 ring-inset ring-ink/[0.08] focus-within:ring-ink/[0.18]">
            <input
              ref={fileInputRef}
              id={fileInputId}
              type="file"
              className="sr-only"
              onChange={e => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void sendFile(file);
              }}
            />
            <button
              type="button"
              data-collab-chat-attach=""
              disabled={Boolean(uploading)}
              aria-label="发送文件（最大 100 MB）"
              title="发送文件（最大 100 MB）"
              onClick={() => fileInputRef.current?.click()}
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-ink/[0.08] hover:text-ink disabled:opacity-45"
            >
              <Plus size={18} aria-hidden="true" />
            </button>

            <textarea
              ref={textareaRef}
              rows={1}
              data-collab-chat-input=""
              aria-label={`给 ${title} 发消息`}
              placeholder={`给 ${title} 发消息`}
              value={draft}
              onChange={e => handleComposerChange(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey && !imeComposing(e.nativeEvent)) {
                  e.preventDefault();
                  void sendText();
                }
              }}
              disabled={sending}
              className="max-h-40 min-h-[32px] flex-1 resize-none bg-transparent py-1.5 text-[14px] leading-5 text-ink outline-none placeholder:text-ink-tertiary"
            />

            <button
              type="button"
              data-collab-chat-send=""
              disabled={sending || !draft.trim()}
              aria-label="发送消息"
              onClick={() => void sendText()}
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
                draft.trim() && !sending
                  ? "bg-accent text-accent-ink hover:opacity-90"
                  : "bg-ink/[0.08] text-ink-tertiary",
              )}
            >
              {sending ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <ArrowUp size={16} aria-hidden="true" />}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
