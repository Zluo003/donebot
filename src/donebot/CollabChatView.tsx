import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowUp,
  AtSign,
  Bot,
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
  ShieldAlert,
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
  type DoneBotCollabChatBot,
  type DoneBotCollabGroup,
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
import { CollabAvatar, CollabBotBadge, CollabTeamBadge } from "./CollabAvatar";
import {
  ARCHIVE_EXTS,
  AUDIO_EXTS,
  CODE_EXTS,
  detectMentionQuery,
  extOf,
  formatMessageStamp,
  IMAGE_EXTS,
  INLINE_IMAGE_MIMES,
  shouldShowTimestamp,
  triggerFileDownload,
  uploadChatFile,
  VIDEO_EXTS,
} from "./collab-chat-helpers";

const POLL_MS = 3_000;
const FAST_POLL_MS = 1_500;

function ChatFileIcon({ name }: { name: string }) {
  const ext = extOf(name);
  if (IMAGE_EXTS.has(ext)) return <FileImage size={18} className="shrink-0 text-[#F07EAE]" aria-hidden="true" />;
  if (VIDEO_EXTS.has(ext)) return <FileVideo size={18} className="shrink-0 text-[#B596EE]" aria-hidden="true" />;
  if (AUDIO_EXTS.has(ext)) return <FileAudio size={18} className="shrink-0 text-[#F2A65A]" aria-hidden="true" />;
  if (ARCHIVE_EXTS.has(ext)) return <FileArchive size={18} className="shrink-0 text-[#D8A729]" aria-hidden="true" />;
  if (CODE_EXTS.has(ext)) return <FileCode2 size={18} className="shrink-0 text-[#5FA0FF]" aria-hidden="true" />;
  return <FileText size={18} className="shrink-0 text-ink-secondary" aria-hidden="true" />;
}

export function CollabChatView({
  scopeType,
  targetId,
  friend,
  team,
  group,
  chatBots = [],
  overview,
  onChatFileSent,
}: {
  scopeType: CollabChatScopeType;
  targetId: string;
  friend?: DoneBotFriend | null;
  team?: DoneBotTeamIdentity | null;
  group?: DoneBotCollabGroup | null;
  chatBots?: DoneBotCollabChatBot[];
  overview: CollabOverview;
  onChatFileSent?: () => void;
}) {
  const { dragProps } = useCaptionChrome();
  const { rightPanelOpen } = useCollabStore();
  const [messages, setMessages] = useState<DoneBotChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [caretPos, setCaretPos] = useState(0);
  const [mentionedBotIds, setMentionedBotIds] = useState<string[]>([]);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [sending, setSending] = useState(false);
  const [awaitingBotReply, setAwaitingBotReply] = useState(false);
  const [uploading, setUploading] = useState<{ name: string; percent: number } | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [draggingOver, setDraggingOver] = useState(false);
  const [warning, setWarning] = useState("");
  const [error, setError] = useState("");

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastIdRef = useRef(0);
  const pinnedBottomRef = useRef(true);
  const botWaitTimerRef = useRef<number | null>(null);
  const fileInputId = useId();

  const myUserId = Number(overview.identity.account_id);
  const localBotById = useMemo(
    () => new Map(overview.local_bots.map(b => [b.id, b])),
    [overview.local_bots],
  );
  const chatBotById = useMemo(
    () => new Map(chatBots.map(b => [b.id, b])),
    [chatBots],
  );
  const myDisplayName = displayPersonName({
    nickname: overview.identity.nickname,
    email: overview.identity.email,
  });
  const isGroupLike = scopeType === "team" || scopeType === "group";
  const title = friend ? displayPersonName(friend) : team ? team.name : (group?.name ?? "协作聊天");
  const headerAvatarUrl = team?.avatar_url ?? group?.avatar_url;
  const subtitle = friend
    ? (friend.remark && friend.nickname && friend.nickname !== friend.remark ? `${friend.nickname} · ${friend.email}` : friend.email)
    : team
      ? `${overview.team_members[team.id]?.length ?? 0} 位成员`
      : group
        ? `${group.members.length} 位成员`
        : "";

  const mentionMatch = useMemo(
    () => (isGroupLike && chatBots.length > 0 && !mentionDismissed ? detectMentionQuery(draft, caretPos) : null),
    [isGroupLike, chatBots.length, mentionDismissed, draft, caretPos],
  );

  const mentionCandidates = useMemo(() => {
    if (!mentionMatch) return [];
    const q = mentionMatch.query.trim().toLowerCase();
    return chatBots.filter(bot =>
      !q
      || bot.bot_name.toLowerCase().includes(q)
      || (bot.owner_nickname ?? "").toLowerCase().includes(q)
      || (bot.bot_title ?? "").toLowerCase().includes(q),
    );
  }, [mentionMatch, chatBots]);

  const invocableCandidates = useMemo(
    () => mentionCandidates.filter(bot => bot.can_invoke),
    [mentionCandidates],
  );

  useEffect(() => {
    setMentionIdx(0);
  }, [mentionMatch?.query, mentionCandidates.length]);

  const clearBotWait = useCallback(() => {
    setAwaitingBotReply(false);
    if (botWaitTimerRef.current !== null) {
      window.clearTimeout(botWaitTimerRef.current);
      botWaitTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    if (botWaitTimerRef.current !== null) window.clearTimeout(botWaitTimerRef.current);
  }, []);

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
    setWarning("");
    setMessages([]);
    setMentionedBotIds([]);
    clearBotWait();
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
  }, [scopeType, targetId, markRead, scrollToBottom, clearBotWait]);

  // Incremental poll while conversation is open & visible (faster when waiting for @bot reply).
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
        let gotBotReply = false;
        setMessages(prev => {
          const seen = new Set(prev.map(m => m.id));
          const fresh = incoming.filter(m => !seen.has(m.id));
          if (fresh.length === 0) return prev;
          newest = fresh[fresh.length - 1]!;
          if (fresh.some(m => m.sender_kind === "bot")) gotBotReply = true;
          lastIdRef.current = Math.max(lastIdRef.current, newest.id);
          return [...prev, ...fresh];
        });
        if (gotBotReply) clearBotWait();
        if (newest) {
          upsertChatSummaryFromMessage(newest, -1);
          void markRead((newest as DoneBotChatMessage).id);
          if ((newest as DoneBotChatMessage).kind === "file") onChatFileSent?.();
          if (pinnedBottomRef.current) queueMicrotask(() => scrollToBottom(true));
        }
      } catch { /* silent background poll */ }
    };
    const timer = window.setInterval(() => void poll(), awaitingBotReply ? FAST_POLL_MS : POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [scopeType, targetId, markRead, scrollToBottom, onChatFileSent, awaitingBotReply, clearBotWait]);

  const insertBotMention = (bot: DoneBotCollabChatBot) => {
    if (!bot.can_invoke) return;
    const ta = textareaRef.current;
    const start = mentionMatch ? mentionMatch.start : caretPos;
    const before = draft.slice(0, start);
    const after = draft.slice(caretPos);
    const token = `@${bot.bot_name} `;
    const nextDraft = `${before}${token}${after}`;
    const nextCaret = before.length + token.length;
    setDraft(nextDraft);
    setCaretPos(nextCaret);
    setMentionDismissed(false);
    setMentionedBotIds(prev => (prev.includes(bot.id) ? prev : [...prev, bot.id]));
    queueMicrotask(() => {
      if (ta) {
        ta.focus();
        ta.setSelectionRange(nextCaret, nextCaret);
        ta.style.height = "auto";
        ta.style.height = `${Math.min(160, ta.scrollHeight)}px`;
      }
    });
  };

  const triggerAtPicker = () => {
    const ta = textareaRef.current;
    const pos = ta?.selectionStart ?? draft.length;
    const needsSpace = pos > 0 && !/\s/.test(draft[pos - 1] ?? "");
    const inserted = needsSpace ? " @" : "@";
    const nextDraft = `${draft.slice(0, pos)}${inserted}${draft.slice(pos)}`;
    const nextCaret = pos + inserted.length;
    setDraft(nextDraft);
    setCaretPos(nextCaret);
    setMentionDismissed(false);
    queueMicrotask(() => {
      if (ta) {
        ta.focus();
        ta.setSelectionRange(nextCaret, nextCaret);
      }
    });
  };

  const sendText = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError("");
    setWarning("");
    try {
      const activeMentionIds = isGroupLike
        ? mentionedBotIds.filter(id => {
          const bot = chatBots.find(b => b.id === id);
          return bot ? text.toLowerCase().includes(`@${bot.bot_name.toLowerCase()}`) : false;
        })
        : [];
      const created = await api<DoneBotChatMessage>(`/api/donebot/collab/chats/${scopeType}/${encodeURIComponent(targetId)}/messages`, {
        method: "POST",
        body: JSON.stringify({
          body: text,
          ...(activeMentionIds.length > 0 ? { mention_bot_ids: activeMentionIds } : {}),
        }),
      });
      setDraft("");
      setCaretPos(0);
      setMentionedBotIds([]);
      setMentionDismissed(false);
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      setMessages(prev => (prev.some(m => m.id === created.id) ? prev : [...prev, created]));
      lastIdRef.current = Math.max(lastIdRef.current, created.id);
      upsertChatSummaryFromMessage(created, -1);
      if (created.denied_bot_names && created.denied_bot_names.length > 0) {
        setWarning(`「${created.denied_bot_names.join("、")}」尚未向你开放调用权限，请联系机器人所有者在右侧栏「Bot」中授权。`);
      }
      if (created.triggered_bot_ids && created.triggered_bot_ids.length > 0) {
        clearBotWait();
        setAwaitingBotReply(true);
        botWaitTimerRef.current = window.setTimeout(() => setAwaitingBotReply(false), 45_000);
      }
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

  const handleComposerChange = (value: string, selectionStart: number) => {
    setDraft(value);
    setCaretPos(selectionStart);
    setMentionDismissed(false);
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
            <CollabTeamBadge name={title} avatarUrl={headerAvatarUrl} size={26} />
          )}
          <span dir="auto" className="min-w-0 truncate text-[14px] font-medium leading-5">{title}</span>
          {(team || group) && (
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
          {group && (
            <button
              type="button"
              data-collab-group-add-member=""
              aria-label="添加好友进群"
              title="添加好友进群"
              onClick={() => openCollabDialog({ kind: "add-group-members", groupId: group.id })}
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
                <CollabTeamBadge name={title} avatarUrl={headerAvatarUrl} size={60} />
              )}
              <div>
                <h2 className="text-[16px] font-semibold text-ink">{title}</h2>
                {subtitle && subtitle !== title && (
                  <p className="mt-0.5 text-[12.5px] text-ink-secondary">{subtitle}</p>
                )}
              </div>
              <p className="max-w-xs text-[12.5px] leading-relaxed text-ink-tertiary">
                {isGroupLike
                  ? "在下方发送消息或文件（最大 100 MB）；可在右侧栏「Bot」中添加本机机器人并在群内 @ 调用。"
                  : "在下方直接发送消息或文件（最大 100 MB）；右侧栏可管理共享文件夹与共享 Bot。"}
              </p>
            </div>
          ) : (
            messages.map((msg, idx) => {
              const isBot = msg.sender_kind === "bot";
              const mine = !isBot && msg.sender_id === myUserId;
              const prev = messages[idx - 1];
              const showTime = shouldShowTimestamp(prev, msg);
              const senderLabel = mine
                ? myDisplayName
                : displayPersonName({
                  remark: msg.sender_remark,
                  nickname: msg.sender_nickname,
                  email: msg.sender_email,
                });
              const isInlineImage = msg.kind === "file"
                && Boolean(msg.file_id)
                && INLINE_IMAGE_MIMES.has((msg.file_mime ?? "").toLowerCase().split(";")[0] ?? "");
              const fileSrc = msg.file_id ? `/api/donebot/collab/chats/files/${encodeURIComponent(msg.file_id)}?inline=1` : "";

              const botMeta = isBot && msg.sender_bot_id ? chatBotById.get(msg.sender_bot_id) : undefined;
              const localBotMeta = botMeta && botMeta.owner_user_id === myUserId ? localBotById.get(botMeta.local_bot_id) : undefined;
              const avatarNode = isBot ? (
                <CollabBotBadge
                  name={msg.sender_bot_name || "机器人"}
                  color={msg.sender_bot_color || botMeta?.bot_color || localBotMeta?.color}
                  avatarUrl={msg.sender_bot_avatar_url || botMeta?.bot_avatar_url || localBotMeta?.avatar_url}
                  bodyId={localBotMeta?.mascot_body}
                  faceColor={localBotMeta?.mascot_face_color}
                  size={30}
                  className="mb-0.5"
                />
              ) : (
                <CollabAvatar
                  avatarUrl={mine ? (msg.sender_avatar_url || overview.identity.avatar_url) : msg.sender_avatar_url}
                  remark={mine ? undefined : msg.sender_remark}
                  nickname={mine ? (msg.sender_nickname || overview.identity.nickname) : msg.sender_nickname}
                  email={mine ? (msg.sender_email || overview.identity.email) : msg.sender_email}
                  size={30}
                  className="mb-0.5"
                />
              );

              return (
                <div key={msg.id} data-collab-msg={msg.id} data-collab-msg-kind={isBot ? "bot" : mine ? "self" : "peer"} className="flex flex-col gap-2">
                  {showTime && (
                    <div className="my-1 text-center text-[11.5px] text-ink-tertiary">
                      {formatMessageStamp(msg.created_at)}
                    </div>
                  )}
                  <div className={cn("flex items-end gap-2.5", mine ? "justify-end" : "justify-start")}>
                    {!mine && avatarNode}
                    <div className={cn("flex max-w-[min(78%,520px)] flex-col gap-1", mine ? "items-end" : "items-start")}>
                      {isBot ? (
                        <div className="flex items-center gap-1.5 px-1 text-[11.5px] text-ink-tertiary">
                          <span className="font-medium text-ink-secondary">{msg.sender_bot_name || "机器人"}</span>
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-accent/14 px-1.5 py-0 text-[10px] font-medium text-accent-text ring-1 ring-inset ring-accent/25">
                            <Bot size={10} aria-hidden="true" />机器人
                          </span>
                          <span>来自 {senderLabel}</span>
                        </div>
                      ) : isGroupLike ? (
                        <span data-collab-msg-sender="" className="px-1 text-[11.5px] text-ink-tertiary">{senderLabel}</span>
                      ) : null}

                      {msg.kind === "file" && msg.file_id ? (
                        <div
                          className={cn(
                            "flex w-full max-w-[360px] flex-col gap-2 overflow-hidden rounded-[18px] p-2.5",
                            mine
                              ? "rounded-br-[6px] bg-bubble-user text-bubble-user-ink"
                              : "rounded-bl-[6px] bg-card text-ink ring-1 ring-inset ring-ink/[0.07]",
                          )}
                        >
                          {isInlineImage && (
                            <button
                              type="button"
                              onClick={() => void handleDownload(msg.file_id!, msg.file_name || "image")}
                              className="group relative flex w-full justify-center overflow-hidden rounded-xl bg-inset/45"
                              title="点击下载原图"
                            >
                              <img
                                src={fileSrc}
                                alt={msg.file_name || "图片"}
                                loading="lazy"
                                className="max-h-72 w-full rounded-xl object-contain"
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
                              : isBot
                                ? "rounded-bl-[6px] bg-card text-ink ring-1 ring-inset ring-accent/28"
                                : "rounded-bl-[6px] bg-card text-ink ring-1 ring-inset ring-ink/[0.07]",
                          )}
                        >
                          {msg.body}
                        </div>
                      )}
                    </div>
                    {mine && avatarNode}
                  </div>
                </div>
              );
            })
          )}
          {awaitingBotReply && (
            <div role="status" className="flex items-center gap-2 px-1 py-1 text-[12px] text-ink-secondary">
              <Loader2 size={13} className="animate-spin text-accent-text" aria-hidden="true" />
              <span>正在由机器人所在本机处理并回复…</span>
            </div>
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="shrink-0 px-5 pb-4 pt-1">
        <div className="relative mx-auto flex w-full max-w-[740px] flex-col gap-2">
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger/20">
              <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span className="flex-1">{error}</span>
              <button type="button" aria-label="关闭提示" onClick={() => setError("")} className="text-danger/70 hover:text-danger">
                <X size={13} aria-hidden="true" />
              </button>
            </div>
          )}

          {warning && (
            <div role="status" className="flex items-start gap-2 rounded-xl bg-amber-500/12 px-3 py-2 text-[12px] text-amber-300 ring-1 ring-inset ring-amber-500/25">
              <ShieldAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span className="flex-1">{warning}</span>
              <button type="button" aria-label="关闭提示" onClick={() => setWarning("")} className="opacity-70 hover:opacity-100">
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

          {/* @Bot mention picker */}
          {mentionMatch && mentionCandidates.length > 0 && (
            <div
              data-collab-mention-menu=""
              role="listbox"
              aria-label="选择要 @ 调用的群内机器人"
              className="overflow-hidden rounded-2xl bg-menu p-1.5 shadow-xl ring-1 ring-ink/12"
            >
              <div className="px-2.5 py-1 text-[11px] font-medium text-ink-tertiary">
                选择要调用的群内机器人（在 Bot 所在本机处理）
              </div>
              <ul className="flex max-h-52 flex-col gap-0.5 overflow-y-auto">
                {mentionCandidates.map(bot => {
                  const invocableIndex = invocableCandidates.findIndex(item => item.id === bot.id);
                  const active = bot.can_invoke && invocableIndex === mentionIdx;
                  const ownerName = bot.owner_user_id === myUserId
                    ? "我"
                    : displayPersonName({ remark: bot.owner_remark, nickname: bot.owner_nickname, email: bot.owner_email });
                  return (
                    <li key={bot.id} role="option" aria-selected={active} aria-disabled={!bot.can_invoke}>
                      <button
                        type="button"
                        data-collab-mention-item={bot.id}
                        disabled={!bot.can_invoke}
                        onMouseDown={e => {
                          e.preventDefault();
                          insertBotMention(bot);
                        }}
                        className={cn(
                          "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors",
                          active ? "bg-raised text-ink" : "text-ink enabled:hover:bg-raised/60",
                          !bot.can_invoke && "cursor-not-allowed opacity-55",
                        )}
                      >
                        <CollabBotBadge
                          name={bot.bot_name}
                          color={bot.bot_color}
                          avatarUrl={bot.bot_avatar_url || (bot.owner_user_id === myUserId ? localBotById.get(bot.local_bot_id)?.avatar_url : undefined)}
                          bodyId={bot.owner_user_id === myUserId ? localBotById.get(bot.local_bot_id)?.mascot_body : undefined}
                          faceColor={bot.owner_user_id === myUserId ? localBotById.get(bot.local_bot_id)?.mascot_face_color : undefined}
                          size={28}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-medium text-ink">@{bot.bot_name}</div>
                          <div className="truncate text-[11px] text-ink-tertiary">
                            {ownerName} 的本机 Bot{bot.bot_title ? ` · ${bot.bot_title}` : ""}
                          </div>
                        </div>
                        <span
                          className={cn(
                            "shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium ring-1 ring-inset",
                            bot.can_invoke
                              ? "bg-success/12 text-success ring-success/25"
                              : "bg-ink/[0.05] text-ink-tertiary ring-ink/10",
                          )}
                        >
                          {bot.can_invoke ? "可调用" : "需所有者授权"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
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
              placeholder={isGroupLike && chatBots.length > 0 ? `给 ${title} 发消息，输入 @ 可调用机器人` : `给 ${title} 发消息`}
              value={draft}
              onChange={e => handleComposerChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
              onClick={e => setCaretPos(e.currentTarget.selectionStart ?? draft.length)}
              onKeyUp={e => setCaretPos(e.currentTarget.selectionStart ?? draft.length)}
              onKeyDown={e => {
                if (mentionMatch && mentionCandidates.length > 0 && !imeComposing(e.nativeEvent)) {
                  if (e.key === "ArrowDown" && invocableCandidates.length > 0) {
                    e.preventDefault();
                    setMentionIdx(prev => (prev + 1) % invocableCandidates.length);
                    return;
                  }
                  if (e.key === "ArrowUp" && invocableCandidates.length > 0) {
                    e.preventDefault();
                    setMentionIdx(prev => (prev - 1 + invocableCandidates.length) % invocableCandidates.length);
                    return;
                  }
                  if ((e.key === "Enter" || e.key === "Tab") && invocableCandidates[mentionIdx]) {
                    e.preventDefault();
                    insertBotMention(invocableCandidates[mentionIdx]!);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setMentionDismissed(true);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey && !imeComposing(e.nativeEvent)) {
                  e.preventDefault();
                  void sendText();
                }
              }}
              disabled={sending}
              className="max-h-40 min-h-[32px] flex-1 resize-none bg-transparent py-1.5 text-[14px] leading-5 text-ink outline-none placeholder:text-ink-tertiary"
            />

            {isGroupLike && chatBots.length > 0 && (
              <button
                type="button"
                data-collab-chat-at-btn=""
                aria-label="提及群内机器人"
                title="输入 @ 调用群内机器人"
                onClick={triggerAtPicker}
                className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-ink/[0.08] hover:text-ink"
              >
                <AtSign size={16} aria-hidden="true" />
              </button>
            )}

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
