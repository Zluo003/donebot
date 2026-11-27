import { useEffect, useId, useMemo, useState } from "react";
import { AlertCircle, Check, Loader2, MessageSquarePlus, UserPlus } from "lucide-react";
import { api } from "@/state/api";
import { cn } from "@/lib/cn";
import type { DoneBotCollabGroup } from "../../shared/donebot-collab";
import { refreshCollabOverview, setCollabSelection } from "./collab-store";
import {
  cleanError,
  COLLAB_BUTTON,
  COLLAB_INPUT,
  displayPersonName,
  personSecondaryLabel,
  type CollabOverview,
} from "./collab-types";
import { CollabAvatar } from "./CollabAvatar";
import { CollabModalDialog } from "./CollabDialogs";

export function CreateGroupDialog({
  open,
  overview,
  onClose,
}: {
  open: boolean;
  overview: CollabOverview | null;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nameId = useId();

  useEffect(() => {
    if (open) {
      setName("");
      setSelectedIds([]);
      setError("");
    }
  }, [open]);

  const friends = overview?.friends.friends ?? [];

  const toggle = (userId: number) => {
    setSelectedIds(prev => (prev.includes(userId) ? prev.filter(id => id !== userId) : [...prev, userId]));
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || selectedIds.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const created = await api<DoneBotCollabGroup>("/api/donebot/collab/groups", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), member_ids: selectedIds }),
      });
      await refreshCollabOverview({ silent: true });
      if (created?.id) setCollabSelection({ kind: "group", groupId: created.id });
      onClose();
    } catch (cause) {
      setError(cleanError(cause, "创建群聊失败，请确认网关已升级至最新版本。"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <CollabModalDialog
      open={open}
      onClose={onClose}
      title="发起好友群聊"
      subtitle="选择好友创建群聊，群内可互发消息、大文件，并添加本机 Bot @ 调用"
      icon={<MessageSquarePlus size={16} aria-hidden="true" />}
    >
      <form onSubmit={e => void create(e)} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={nameId} className="text-[12px] font-medium text-ink-secondary">
            群聊名称（选填）
          </label>
          <input
            id={nameId}
            name="group_name"
            type="text"
            autoFocus
            maxLength={100}
            placeholder="留空将自动按成员昵称命名"
            value={name}
            onChange={e => setName(e.target.value)}
            disabled={busy}
            className={COLLAB_INPUT}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[12px]">
            <span className="font-medium text-ink-secondary">选择好友</span>
            <span className="tabular-nums text-ink-tertiary">已选 {selectedIds.length} 人</span>
          </div>
          {friends.length === 0 ? (
            <p className="rounded-xl bg-inset/60 px-3.5 py-4 text-center text-[13px] text-ink-tertiary">
              还没有好友，请先添加好友后再发起群聊。
            </p>
          ) : (
            <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto rounded-xl bg-inset/45 p-1.5 ring-1 ring-inset ring-ink/[0.06]">
              {friends.map(friend => {
                const checked = selectedIds.includes(friend.user_id);
                const label = displayPersonName(friend);
                const sub = personSecondaryLabel(friend);
                return (
                  <li key={friend.user_id}>
                    <label
                      className={cn(
                        "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors",
                        checked ? "bg-accent/12" : "hover:bg-ink/[0.04]",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={busy}
                        onChange={() => toggle(friend.user_id)}
                        className="size-4 rounded accent-accent"
                      />
                      <CollabAvatar
                        avatarUrl={friend.avatar_url}
                        remark={friend.remark}
                        nickname={friend.nickname}
                        email={friend.email}
                        size={30}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-ink">{label}</div>
                        {sub && <div className="truncate text-[11px] text-ink-tertiary">{sub}</div>}
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger/20">
            <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={`${COLLAB_BUTTON} text-[13px]`}>取消</button>
          <button
            type="submit"
            disabled={busy || selectedIds.length === 0}
            className={`${COLLAB_BUTTON} ui-button-primary text-[13px]`}
          >
            {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
            创建群聊
          </button>
        </div>
      </form>
    </CollabModalDialog>
  );
}

export function AddGroupMembersDialog({
  open,
  group,
  overview,
  onClose,
}: {
  open: boolean;
  group: DoneBotCollabGroup | null;
  overview: CollabOverview | null;
  onClose: () => void;
}) {
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setSelectedIds([]);
      setError("");
    }
  }, [open, group?.id]);

  const candidates = useMemo(() => {
    if (!group || !overview) return [];
    const existing = new Set(group.members.map(m => m.user_id));
    return overview.friends.friends.filter(f => !existing.has(f.user_id));
  }, [group, overview]);

  if (!group || !overview) return null;

  const toggle = (userId: number) => {
    setSelectedIds(prev => (prev.includes(userId) ? prev.filter(id => id !== userId) : [...prev, userId]));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || selectedIds.length === 0) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/donebot/collab/groups/${group.id}/members`, {
        method: "POST",
        body: JSON.stringify({ member_ids: selectedIds }),
      });
      await refreshCollabOverview({ silent: true });
      onClose();
    } catch (cause) {
      setError(cleanError(cause, "添加群成员失败。"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <CollabModalDialog
      open={open}
      onClose={onClose}
      title={`邀请好友加入「${group.name}」`}
      subtitle="从你的好友列表中选择要拉入群聊的成员"
      icon={<UserPlus size={16} aria-hidden="true" />}
    >
      <form onSubmit={e => void submit(e)} className="flex flex-col gap-4">
        {candidates.length === 0 ? (
          <p className="rounded-xl bg-inset/60 px-3.5 py-5 text-center text-[13px] text-ink-tertiary">
            你的所有好友都已在当前群聊中。
          </p>
        ) : (
          <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-xl bg-inset/45 p-1.5 ring-1 ring-inset ring-ink/[0.06]">
            {candidates.map(friend => {
              const checked = selectedIds.includes(friend.user_id);
              const label = displayPersonName(friend);
              const sub = personSecondaryLabel(friend);
              return (
                <li key={friend.user_id}>
                  <label
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors",
                      checked ? "bg-accent/12" : "hover:bg-ink/[0.04]",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={busy}
                      onChange={() => toggle(friend.user_id)}
                      className="size-4 rounded accent-accent"
                    />
                    <CollabAvatar
                      avatarUrl={friend.avatar_url}
                      remark={friend.remark}
                      nickname={friend.nickname}
                      email={friend.email}
                      size={30}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-ink">{label}</div>
                      {sub && <div className="truncate text-[11px] text-ink-tertiary">{sub}</div>}
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger/20">
            <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={`${COLLAB_BUTTON} text-[13px]`}>取消</button>
          <button
            type="submit"
            disabled={busy || selectedIds.length === 0}
            className={`${COLLAB_BUTTON} ui-button-primary text-[13px]`}
          >
            {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
            添加到群聊
          </button>
        </div>
      </form>
    </CollabModalDialog>
  );
}
