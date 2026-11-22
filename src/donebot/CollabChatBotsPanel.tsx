import { useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  Loader2,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { api } from "@/state/api";
import { Card, NoteRow, panelActionCls } from "@/components/bot-panel/rows";
import { cn } from "@/lib/cn";
import type { DoneBotCollabChatBot } from "../../shared/donebot-collab";
import {
  cleanError,
  COLLAB_BUTTON,
  displayPersonName,
  type CollabOverview,
} from "./collab-types";
import { CollabAvatar, CollabBotBadge } from "./CollabAvatar";

export interface ChatBotMemberCandidate {
  user_id: number;
  email: string;
  nickname?: string;
  remark?: string;
  avatar_url?: string;
}

type GrantMode = "owner_only" | "selected" | "all";

function grantModeOf(bot: DoneBotCollabChatBot): GrantMode {
  if (bot.allow_all_members) return "all";
  if ((bot.allowed_user_ids ?? []).length > 0) return "selected";
  return "owner_only";
}

function grantSummaryLabel(bot: DoneBotCollabChatBot): string {
  if (bot.allow_all_members) return "全员可 @调用";
  const count = bot.allowed_user_ids?.length ?? 0;
  if (count > 0) return `已授权 ${count} 位成员`;
  return "仅所有者可用";
}

function GrantModePicker({
  mode,
  onModeChange,
  selectedUserIds,
  onToggleUser,
  otherMembers,
  disabled,
}: {
  mode: GrantMode;
  onModeChange: (next: GrantMode) => void;
  selectedUserIds: number[];
  onToggleUser: (userId: number) => void;
  otherMembers: ChatBotMemberCandidate[];
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11.5px] font-medium text-ink-secondary">允许谁在群里 @ 调用此 Bot</div>
      <div className="grid grid-cols-3 gap-1 rounded-xl bg-inset/70 p-1 ring-1 ring-inset ring-ink/[0.06]">
        {(
          [
            { id: "owner_only", label: "仅自己" },
            { id: "selected", label: "指定成员" },
            { id: "all", label: "群内全员" },
          ] as const
        ).map(opt => (
          <button
            key={opt.id}
            type="button"
            disabled={disabled}
            onClick={() => onModeChange(opt.id)}
            className={cn(
              "h-7 rounded-lg text-[11.5px] font-medium transition-colors",
              mode === opt.id ? "bg-composer text-ink shadow-xs ring-1 ring-ink/10" : "text-ink-secondary hover:text-ink",
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {mode === "selected" && (
        otherMembers.length === 0 ? (
          <p className="rounded-lg bg-inset/50 px-2.5 py-2 text-[11.5px] text-ink-tertiary">
            群里暂时没有其他成员，等成员加入后可随时回来授权。
          </p>
        ) : (
          <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-xl bg-inset/50 p-1 ring-1 ring-inset ring-ink/[0.06]">
            {otherMembers.map(member => {
              const checked = selectedUserIds.includes(member.user_id);
              const label = displayPersonName(member);
              return (
                <li key={member.user_id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-ink/[0.04]">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => onToggleUser(member.user_id)}
                      className="size-3.5 rounded accent-accent"
                    />
                    <CollabAvatar
                      avatarUrl={member.avatar_url}
                      remark={member.remark}
                      nickname={member.nickname}
                      email={member.email}
                      size={22}
                    />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{label}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )
      )}
    </div>
  );
}

export function CollabChatBotsPanel({
  scopeType,
  targetId,
  members,
  chatBots,
  overview,
  canModerate,
  onReload,
}: {
  scopeType: "team" | "group";
  targetId: string;
  members: ChatBotMemberCandidate[];
  chatBots: DoneBotCollabChatBot[];
  overview: CollabOverview;
  canModerate: boolean;
  onReload: () => Promise<void>;
}) {
  const myUserId = Number(overview.identity.account_id);
  const myInstallId = overview.identity.installation_id;
  const otherMembers = useMemo(
    () => members.filter(m => m.user_id !== myUserId),
    [members, myUserId],
  );

  const [adding, setAdding] = useState(false);
  const [selectedBotId, setSelectedBotId] = useState<string>("");
  const [addMode, setAddMode] = useState<GrantMode>("owner_only");
  const [addAllowedIds, setAddAllowedIds] = useState<number[]>([]);

  const [editingBotId, setEditingBotId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<GrantMode>("owner_only");
  const [editAllowedIds, setEditAllowedIds] = useState<number[]>([]);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const localBotById = useMemo(
    () => new Map(overview.local_bots.map(b => [b.id, b])),
    [overview.local_bots],
  );

  const availableLocalBots = useMemo(() => {
    const existingLocalIds = new Set(
      chatBots
        .filter(b => b.owner_user_id === myUserId && b.installation_id === myInstallId)
        .map(b => b.local_bot_id),
    );
    return overview.local_bots.filter(bot => !existingLocalIds.has(bot.id));
  }, [overview.local_bots, chatBots, myUserId, myInstallId]);

  const openAddForm = () => {
    setError("");
    setNotice("");
    setEditingBotId(null);
    setAdding(prev => {
      const next = !prev;
      if (next) {
        setSelectedBotId(availableLocalBots[0]?.id ?? "");
        setAddMode("owner_only");
        setAddAllowedIds([]);
      }
      return next;
    });
  };

  const submitAdd = async () => {
    if (!selectedBotId || busyId) return;
    setBusyId("add");
    setError("");
    setNotice("");
    try {
      await api(`/api/donebot/collab/chats/${scopeType}/${encodeURIComponent(targetId)}/bots`, {
        method: "POST",
        body: JSON.stringify({
          bot_id: selectedBotId,
          allow_all_members: addMode === "all",
          allowed_user_ids: addMode === "selected" ? addAllowedIds : [],
        }),
      });
      setAdding(false);
      setNotice("已将你的本机 Bot 添加到群聊。被授权的成员现在可以 @ 调用它。");
      await onReload();
    } catch (cause) {
      setError(cleanError(cause, "添加群聊 Bot 失败。"));
    } finally {
      setBusyId(null);
    }
  };

  const startEditGrants = (bot: DoneBotCollabChatBot) => {
    setError("");
    setNotice("");
    setAdding(false);
    if (editingBotId === bot.id) {
      setEditingBotId(null);
      return;
    }
    setEditingBotId(bot.id);
    setEditMode(grantModeOf(bot));
    setEditAllowedIds([...(bot.allowed_user_ids ?? [])]);
  };

  const saveGrants = async (bot: DoneBotCollabChatBot) => {
    if (busyId) return;
    setBusyId(`grant:${bot.id}`);
    setError("");
    setNotice("");
    try {
      await api(`/api/donebot/collab/chats/${scopeType}/${encodeURIComponent(targetId)}/bots/${bot.id}/grants`, {
        method: "PUT",
        body: JSON.stringify({
          allow_all_members: editMode === "all",
          allowed_user_ids: editMode === "selected" ? editAllowedIds : [],
        }),
      });
      setEditingBotId(null);
      setNotice(`已更新「${bot.bot_name}」的调用授权。`);
      await onReload();
    } catch (cause) {
      setError(cleanError(cause, "更新机器人授权失败。"));
    } finally {
      setBusyId(null);
    }
  };

  const removeBot = async (bot: DoneBotCollabChatBot) => {
    if (busyId) return;
    if (!window.confirm(`将机器人「${bot.bot_name}」移出本群？移出后群内将无法继续 @ 调用它。`)) return;
    setBusyId(`remove:${bot.id}`);
    setError("");
    setNotice("");
    try {
      await api(`/api/donebot/collab/chats/${scopeType}/${encodeURIComponent(targetId)}/bots/${bot.id}`, {
        method: "DELETE",
      });
      if (editingBotId === bot.id) setEditingBotId(null);
      setNotice(`已将「${bot.bot_name}」移出本群。`);
      await onReload();
    } catch (cause) {
      setError(cleanError(cause, "移除群聊 Bot 失败。"));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex flex-col" data-collab-chat-bots-panel="">
      {error && (
        <div role="alert" className="mt-3 flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger/20">
          <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div role="status" className="mt-3 flex items-start gap-2 rounded-xl bg-success/12 px-3 py-2 text-[12px] text-success ring-1 ring-inset ring-success/25">
          <Check size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{notice}</span>
        </div>
      )}

      <div className="mt-3 flex flex-col gap-0.5">
        <button
          type="button"
          data-collab-add-chat-bot=""
          onClick={openAddForm}
          className={panelActionCls}
        >
          <Plus size={16} aria-hidden="true" />
          <span>添加我的 Bot 到本群</span>
        </button>
      </div>

      {adding && (
        <Card label="添加本机 Bot 到群聊">
          <div className="flex flex-col gap-3 px-3.5 py-3">
            {availableLocalBots.length === 0 ? (
              <p className="text-[12px] text-ink-tertiary">
                本机所有可用 Bot 都已加入本群，或本机尚未创建 Bot。
              </p>
            ) : (
              <>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11.5px] font-medium text-ink-secondary">选择要加入本群的 Bot</span>
                  <div className="flex flex-col gap-1">
                    {availableLocalBots.map(bot => {
                      const picked = selectedBotId === bot.id;
                      return (
                        <button
                          key={bot.id}
                          type="button"
                          onClick={() => setSelectedBotId(bot.id)}
                          className={cn(
                            "flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left ring-1 ring-inset transition-colors",
                            picked
                              ? "bg-accent/12 ring-accent/40"
                              : "bg-inset/50 ring-ink/[0.06] hover:bg-ink/[0.04]",
                          )}
                        >
                          <CollabBotBadge
                            name={bot.name}
                            color={bot.color}
                            avatarUrl={bot.avatar_url}
                            bodyId={bot.mascot_body}
                            faceColor={bot.mascot_face_color}
                            size={26}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[12.5px] font-medium text-ink">{bot.name}</div>
                            <div className="truncate text-[11px] text-ink-tertiary">
                              {bot.title || `${bot.skill_count} 个技能`}
                            </div>
                          </div>
                          {picked && <Check size={14} className="shrink-0 text-accent-text" aria-hidden="true" />}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <GrantModePicker
                  mode={addMode}
                  onModeChange={setAddMode}
                  selectedUserIds={addAllowedIds}
                  onToggleUser={uid => setAddAllowedIds(prev => (prev.includes(uid) ? prev.filter(id => id !== uid) : [...prev, uid]))}
                  otherMembers={otherMembers}
                  disabled={busyId !== null}
                />

                <p className="text-[11px] leading-relaxed text-ink-tertiary">
                  所有工作仍在你的本机 DoneBot 本地处理，仅被你授权的成员可通过 @ 调用。
                </p>

                <div className="flex justify-end gap-2">
                  <button type="button" disabled={busyId !== null} onClick={() => setAdding(false)} className={`${COLLAB_BUTTON} h-7 px-3 text-[12px]`}>
                    取消
                  </button>
                  <button
                    type="button"
                    data-collab-confirm-add-bot=""
                    disabled={busyId !== null || !selectedBotId}
                    onClick={() => void submitAdd()}
                    className={`${COLLAB_BUTTON} ui-button-primary h-7 px-3 text-[12px]`}
                  >
                    {busyId === "add" ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}
                    加入本群
                  </button>
                </div>
              </>
            )}
          </div>
        </Card>
      )}

      <Card label={`群内机器人（${chatBots.length}）`}>
        {chatBots.length === 0 ? (
          <NoteRow>还没有群内机器人。添加自己的本机 Bot 并授权成员后，可在聊天中输入 @ 调用，所有任务在 Bot 所在本机处理。</NoteRow>
        ) : (
          chatBots.map(bot => {
            const isOwner = bot.owner_user_id === myUserId;
            const canRemove = isOwner || canModerate;
            const ownerName = isOwner
              ? "我"
              : displayPersonName({ remark: bot.owner_remark, nickname: bot.owner_nickname, email: bot.owner_email });
            const editing = editingBotId === bot.id;
            const localMatch = isOwner ? localBotById.get(bot.local_bot_id) : undefined;

            return (
              <div key={bot.id} data-collab-chat-bot-row={bot.id} className="flex flex-col gap-2 px-3.5 py-2.5">
                <div className="flex items-center gap-2.5">
                  <CollabBotBadge
                    name={bot.bot_name}
                    color={bot.bot_color || localMatch?.color}
                    avatarUrl={bot.bot_avatar_url || localMatch?.avatar_url}
                    bodyId={localMatch?.mascot_body}
                    faceColor={localMatch?.mascot_face_color}
                    size={32}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13.5px] font-medium text-ink">{bot.bot_name}</span>
                      <span
                        className={cn(
                          "inline-flex shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset",
                          bot.can_invoke
                            ? "bg-success/12 text-success ring-success/25"
                            : "bg-ink/[0.05] text-ink-tertiary ring-ink/10",
                        )}
                      >
                        {bot.can_invoke ? "可 @调用" : "未授权"}
                      </span>
                    </div>
                    <div className="truncate text-[11.5px] text-ink-tertiary">
                      {ownerName} 的本机 Bot · {grantSummaryLabel(bot)}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {isOwner && (
                      <button
                        type="button"
                        data-collab-bot-grants={bot.id}
                        disabled={busyId !== null}
                        onClick={() => startEditGrants(bot)}
                        className={cn(
                          `${COLLAB_BUTTON} h-7 px-2 text-[11.5px]`,
                          editing && "bg-accent/14 text-accent-text",
                        )}
                      >
                        <ShieldCheck size={12} aria-hidden="true" />授权
                      </button>
                    )}
                    {canRemove && (
                      <button
                        type="button"
                        disabled={busyId !== null}
                        aria-label={`移除机器人 ${bot.bot_name}`}
                        title="移出本群"
                        onClick={() => void removeBot(bot)}
                        className="flex size-7 items-center justify-center rounded-lg text-ink-tertiary hover:bg-danger/10 hover:text-danger"
                      >
                        <Trash2 size={13} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>

                {isOwner && editing && (
                  <div className="flex flex-col gap-2.5 rounded-xl bg-app/75 p-2.5 ring-1 ring-inset ring-ink/[0.07]">
                    <GrantModePicker
                      mode={editMode}
                      onModeChange={setEditMode}
                      selectedUserIds={editAllowedIds}
                      onToggleUser={uid => setEditAllowedIds(prev => (prev.includes(uid) ? prev.filter(id => id !== uid) : [...prev, uid]))}
                      otherMembers={otherMembers}
                      disabled={busyId !== null}
                    />
                    <div className="flex justify-end gap-1.5">
                      <button type="button" disabled={busyId !== null} onClick={() => setEditingBotId(null)} className={`${COLLAB_BUTTON} h-6 px-2.5 text-[11.5px]`}>
                        取消
                      </button>
                      <button
                        type="button"
                        data-collab-save-bot-grants={bot.id}
                        disabled={busyId !== null}
                        onClick={() => void saveGrants(bot)}
                        className={`${COLLAB_BUTTON} ui-button-primary h-6 px-2.5 text-[11.5px]`}
                      >
                        {busyId === `grant:${bot.id}` ? <Loader2 size={11} className="animate-spin" aria-hidden="true" /> : <Check size={11} aria-hidden="true" />}
                        保存授权
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </Card>
    </div>
  );
}
