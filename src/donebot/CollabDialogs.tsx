import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle,
  Bell,
  Check,
  Loader2,
  Send,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { api } from "@/state/api";
import { cn } from "@/lib/cn";
import type { DoneBotTeamCommand, DoneBotTeamIdentity, DoneBotTeamInvitation } from "../../shared/donebot-teams";
import {
  collabPendingCount,
  openCollabDialog,
  refreshCollabOverview,
  setCollabSelection,
  useCollabStore,
} from "./collab-store";
import {
  cleanError,
  COLLAB_BUTTON,
  COLLAB_INPUT,
  displayPersonName,
  TEAM_ROLE_PILL,
  TEAM_ROLES,
  type CollabOverview,
} from "./collab-types";
import { CollabAvatar, CollabTeamBadge } from "./CollabAvatar";
import { CollabSelect } from "./CollabSelect";
import { AddGroupMembersDialog, CreateGroupDialog } from "./CollabGroupDialogs";
import "./collab.css";

export function CollabModalDialog({
  open,
  onClose,
  title,
  subtitle,
  icon,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

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

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={handleClose}
      {...({ closedby: "any" } as Record<string, unknown>)}
      className="donebot-collab-dialog"
    >
      {open && (
        <div className="w-[min(440px,calc(100vw-2rem))] overflow-hidden rounded-2xl bg-menu shadow-2xl ring-1 ring-ink/12">
          <div className="flex items-start justify-between gap-3 border-b border-hairline/40 px-5 py-4">
            <div className="flex min-w-0 items-center gap-2.5">
              {icon && (
                <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-accent/14 text-accent-text ring-1 ring-inset ring-accent/25">
                  {icon}
                </span>
              )}
              <div className="min-w-0">
                <h2 id={titleId} className="truncate text-[15px] font-semibold text-ink">{title}</h2>
                {subtitle && <p className="mt-0.5 truncate text-[12px] text-ink-secondary">{subtitle}</p>}
              </div>
            </div>
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              aria-label="关闭窗口"
              className="flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-tertiary transition-colors hover:bg-ink/[0.08] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
          <div className="max-h-[min(72vh,560px)] overflow-y-auto p-5">{children}</div>
        </div>
      )}
    </dialog>
  );
}

function AddFriendDialog({
  open,
  overview,
  onClose,
}: {
  open: boolean;
  overview: CollabOverview | null;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const emailId = useId();
  const noteId = useId();

  useEffect(() => {
    if (open) {
      setEmail("");
      setNote("");
      setNotice("");
      setError("");
    }
  }, [open]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !email.trim()) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const res = await api<{ status?: string; friend?: { user_id: number } }>("/api/donebot/collab/friends/request", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), note: note.trim() }),
      });
      setEmail("");
      setNote("");
      await refreshCollabOverview({ silent: true });
      if (res?.status === "accepted") {
        if (res.friend?.user_id) setCollabSelection({ kind: "friend", userId: res.friend.user_id });
        setNotice("对方也发来过申请，你们已成为好友！");
      } else {
        setNotice("好友申请已发送，对方将收到实时提醒。");
      }
    } catch (cause) {
      setError(cleanError(cause, "发送好友申请失败，请检查邮箱是否正确。"));
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (requestId: string) => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await api(`/api/donebot/collab/friends/requests/${requestId}/reject`, { method: "POST", body: "{}" });
      await refreshCollabOverview({ silent: true });
    } catch (cause) {
      setError(cleanError(cause));
    } finally {
      setBusy(false);
    }
  };

  const outgoing = overview?.friends.outgoing_requests ?? [];

  return (
    <CollabModalDialog
      open={open}
      onClose={onClose}
      title="添加好友"
      subtitle="输入对方的 DoneBot 账号邮箱发送好友申请"
      icon={<UserPlus size={16} aria-hidden="true" />}
    >
      <div className="flex flex-col gap-4">
        <form onSubmit={e => void send(e)} className="flex flex-col gap-3.5">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={emailId} className="text-[12px] font-medium text-ink-secondary">对方邮箱</label>
            <input
              id={emailId}
              name="friend_email"
              type="email"
              autoFocus
              autoComplete="email"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              required
              maxLength={254}
              placeholder="name@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              disabled={busy}
              className={COLLAB_INPUT}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={noteId} className="text-[12px] font-medium text-ink-secondary">附言（选填）</label>
            <input
              id={noteId}
              name="friend_note"
              type="text"
              maxLength={200}
              placeholder="例如：我是研发组的老罗"
              value={note}
              onChange={e => setNote(e.target.value)}
              disabled={busy}
              className={COLLAB_INPUT}
            />
          </div>

          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger/20">
              <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}
          {notice && (
            <div role="status" className="flex items-start gap-2 rounded-xl bg-success/12 px-3 py-2 text-[12px] text-success ring-1 ring-inset ring-success/25">
              <Check size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{notice}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className={`${COLLAB_BUTTON} text-[13px]`}>关闭</button>
            <button type="submit" disabled={busy || !email.trim()} className={`${COLLAB_BUTTON} ui-button-primary text-[13px]`}>
              {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Send size={13} aria-hidden="true" />}
              发送申请
            </button>
          </div>
        </form>

        {outgoing.length > 0 && (
          <div className="flex flex-col gap-2 border-t border-hairline/40 pt-3.5">
            <div className="text-[12px] font-medium text-ink-tertiary">等待对方确认（{outgoing.length}）</div>
            <ul className="flex flex-col gap-2">
              {outgoing.map(req => {
                const target = displayPersonName({ nickname: req.recipient_nickname, email: req.recipient_email });
                return (
                  <li key={req.id} className="flex items-center justify-between gap-2 rounded-xl bg-inset/60 px-3 py-2 text-[13px]">
                    <div className="flex min-w-0 items-center gap-2">
                      <CollabAvatar
                        avatarUrl={req.recipient_avatar_url}
                        nickname={req.recipient_nickname}
                        email={req.recipient_email}
                        size={26}
                      />
                      <div className="min-w-0">
                        <div className="truncate font-medium text-ink">{target}</div>
                        {target !== req.recipient_email && (
                          <div className="truncate text-[11px] text-ink-tertiary">{req.recipient_email}</div>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void withdraw(req.id)}
                      className="shrink-0 rounded-lg px-2 py-1 text-[12px] text-ink-tertiary hover:bg-danger/10 hover:text-danger"
                    >
                      撤回
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </CollabModalDialog>
  );
}

function AddTeamDialog({
  open,
  overview,
  onClose,
}: {
  open: boolean;
  overview: CollabOverview | null;
  onClose: () => void;
}) {
  const [teamName, setTeamName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const createKey = useRef<{ name: string; key: string } | null>(null);
  const nameId = useId();

  useEffect(() => {
    if (open) {
      setTeamName("");
      setError("");
      createKey.current = null;
    }
  }, [open]);

  const submitCommand = async (command: DoneBotTeamCommand) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const res = await api<{ id?: string; team_id?: string }>("/api/donebot/teams", {
        method: "POST",
        body: JSON.stringify(command),
      });
      await refreshCollabOverview({ silent: true });
      const createdId = res?.id || res?.team_id;
      if (createdId) setCollabSelection({ kind: "team", teamId: createdId });
      onClose();
    } catch (cause) {
      setError(cleanError(cause, "创建团队失败，请稍后重试。"));
    } finally {
      setBusy(false);
    }
  };

  const accountId = overview?.identity.account_id ?? "";

  return (
    <CollabModalDialog
      open={open}
      onClose={onClose}
      title="新建团队"
      subtitle="创建后可直接邀请好友或成员加入，对方同意即可进团队"
      icon={<Users size={16} aria-hidden="true" />}
    >
      <form
        onSubmit={e => {
          e.preventDefault();
          const clean = teamName.trim();
          if (!clean || !accountId) return;
          if (!createKey.current || createKey.current.name !== clean) {
            createKey.current = { name: clean, key: crypto.randomUUID() };
          }
          void submitCommand({ action: "create", account_id: accountId, name: clean, key: createKey.current.key });
        }}
        className="flex flex-col gap-3.5"
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor={nameId} className="text-[12px] font-medium text-ink-secondary">团队名称</label>
          <input
            id={nameId}
            name="team_name"
            type="text"
            autoFocus
            required
            maxLength={100}
            placeholder="例如：产品研发组、内容工作室"
            value={teamName}
            onChange={e => setTeamName(e.target.value)}
            disabled={busy}
            className={COLLAB_INPUT}
          />
        </div>
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger/20">
            <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={`${COLLAB_BUTTON} text-[13px]`}>取消</button>
          <button type="submit" disabled={busy || !teamName.trim() || !accountId} className={`${COLLAB_BUTTON} ui-button-primary text-[13px]`}>
            {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
            创建团队
          </button>
        </div>
      </form>
    </CollabModalDialog>
  );
}

function InviteTeamMemberDialog({
  open,
  team,
  overview,
  onClose,
}: {
  open: boolean;
  team: DoneBotTeamIdentity | null;
  overview: CollabOverview | null;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [invitations, setInvitations] = useState<DoneBotTeamInvitation[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const emailId = useId();

  const loadInvitations = useCallback(async () => {
    if (!team || team.role === "member") { setInvitations([]); return; }
    try {
      const list = await api<DoneBotTeamInvitation[]>(`/api/donebot/collab/teams/${team.id}/invitations`);
      setInvitations(Array.isArray(list) ? list : []);
    } catch {
      setInvitations([]);
    }
  }, [team]);

  useEffect(() => {
    if (open && team) {
      setEmail("");
      setRole("member");
      setNotice("");
      setError("");
      void loadInvitations();
    }
  }, [open, team, loadInvitations]);

  const invitableFriends = useMemo(() => {
    if (!team || !overview) return [];
    const memberIds = new Set((overview.team_members[team.id] ?? []).map(m => m.user_id));
    const pendingEmails = new Set(invitations.map(i => i.email.toLowerCase()));
    return overview.friends.friends.filter(
      f => !memberIds.has(f.user_id) && !pendingEmails.has(f.email.toLowerCase()),
    );
  }, [team, overview, invitations]);

  if (!team || !overview) return null;

  const sendInvite = async (targetEmail: string, targetLabel?: string) => {
    const clean = targetEmail.trim();
    if (busy || !clean) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await api<DoneBotTeamInvitation>("/api/donebot/teams", {
        method: "POST",
        body: JSON.stringify({
          action: "invite",
          account_id: overview.identity.account_id,
          team_id: team.id,
          email: clean,
          role: team.role === "owner" ? role : "member",
        } satisfies DoneBotTeamCommand),
      });
      setEmail("");
      setNotice(`已向 ${targetLabel || clean} 发送团队邀请，对方同意后将自动加入团队。`);
      await loadInvitations();
    } catch (cause) {
      setError(cleanError(cause, "发送团队邀请失败。"));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (invitationId: string) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await api("/api/donebot/teams", {
        method: "POST",
        body: JSON.stringify({
          action: "revoke-invitation",
          account_id: overview.identity.account_id,
          team_id: team.id,
          invitation_id: invitationId,
        } satisfies DoneBotTeamCommand),
      });
      await loadInvitations();
    } catch (cause) {
      setError(cleanError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <CollabModalDialog
      open={open}
      onClose={onClose}
      title={`邀请成员加入「${team.name}」`}
      subtitle="发出邀请后对方客户端将收到提醒，直接同意即可加入团队"
      icon={<UserPlus size={16} aria-hidden="true" />}
    >
      <div className="flex flex-col gap-4">
        {invitableFriends.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="text-[12px] font-medium text-ink-secondary">直接邀请好友</div>
            <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-xl bg-inset/45 p-1.5 ring-1 ring-inset ring-ink/[0.06]">
              {invitableFriends.map(friend => {
                const label = displayPersonName(friend);
                return (
                  <li key={friend.user_id} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-ink/[0.04]">
                    <div className="flex min-w-0 items-center gap-2">
                      <CollabAvatar
                        avatarUrl={friend.avatar_url}
                        remark={friend.remark}
                        nickname={friend.nickname}
                        email={friend.email}
                        size={26}
                      />
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium text-ink">{label}</div>
                        {label !== friend.email && (
                          <div className="truncate text-[11px] text-ink-tertiary">{friend.email}</div>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void sendInvite(friend.email, label)}
                      className={`${COLLAB_BUTTON} h-7 shrink-0 px-2.5 text-[12px]`}
                    >
                      邀请
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <form
          onSubmit={e => {
            e.preventDefault();
            void sendInvite(email);
          }}
          className="flex flex-col gap-3"
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor={emailId} className="text-[12px] font-medium text-ink-secondary">或通过 DoneBot 账号邮箱邀请</label>
            <div className="flex gap-2">
              <input
                id={emailId}
                name="invite_email"
                type="email"
                autoFocus={invitableFriends.length === 0}
                autoComplete="email"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                required
                maxLength={254}
                placeholder="name@example.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                disabled={busy}
                className={cn(COLLAB_INPUT, "flex-1")}
              />
              {team.role === "owner" && (
                <CollabSelect
                  ariaLabel="邀请角色"
                  value={role}
                  options={[
                    { value: "member", label: "成员" },
                    { value: "admin", label: "管理员" },
                  ]}
                  onChange={next => setRole(next === "admin" ? "admin" : "member")}
                  disabled={busy}
                  className="w-24 shrink-0"
                  menuMinWidth={112}
                />
              )}
            </div>
          </div>

          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger/20">
              <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}
          {notice && (
            <div role="status" className="flex items-start gap-2 rounded-xl bg-success/12 px-3 py-2 text-[12px] text-success ring-1 ring-inset ring-success/25">
              <Check size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{notice}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={onClose} className={`${COLLAB_BUTTON} text-[13px]`}>关闭</button>
            <button type="submit" disabled={busy || !email.trim()} className={`${COLLAB_BUTTON} ui-button-primary text-[13px]`}>
              {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Send size={13} aria-hidden="true" />}
              发送邀请
            </button>
          </div>
        </form>

        {invitations.length > 0 && (
          <div className="flex flex-col gap-2 border-t border-hairline/40 pt-3">
            <div className="text-[12px] font-medium text-ink-tertiary">待对方确认的邀请（{invitations.length}）</div>
            <ul className="flex flex-col gap-1.5">
              {invitations.map(inv => (
                <li key={inv.id} className="flex items-center justify-between gap-2 rounded-xl bg-inset/60 px-3 py-2 text-[12px]">
                  <span className="truncate text-ink">
                    {inv.email} · <span className="text-ink-secondary">{TEAM_ROLES[inv.role]}</span>
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void revoke(inv.id)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-0.5 text-[12px] text-ink-tertiary hover:bg-danger/10 hover:text-danger"
                  >
                    <Trash2 size={11} aria-hidden="true" />撤销
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </CollabModalDialog>
  );
}

function CollabRequestsDialog({
  open,
  overview,
  onClose,
}: {
  open: boolean;
  overview: CollabOverview | null;
  onClose: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const pending = collabPendingCount(overview);

  useEffect(() => {
    if (open) setError("");
  }, [open]);

  const handleAction = async (id: string, work: () => Promise<void>) => {
    if (busyId) return;
    setBusyId(id); setError("");
    try {
      await work();
      const refreshed = await refreshCollabOverview({ silent: true });
      if (collabPendingCount(refreshed) === 0) onClose();
    } catch (cause) {
      setError(cleanError(cause));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <CollabModalDialog
      open={open}
      onClose={onClose}
      title={`新的申请与邀请${pending > 0 ? `（${pending}）` : ""}`}
      subtitle="通过后即可在好友与团队列表中聊天与共享资源"
      icon={<Bell size={16} aria-hidden="true" />}
    >
      <div className="flex flex-col gap-3">
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger/20">
            <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        {pending === 0 ? (
          <p className="py-6 text-center text-[13px] text-ink-tertiary">所有好友申请与团队邀请均已处理。</p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {(overview?.friends.incoming_requests ?? []).map(req => {
              const sender = displayPersonName({ nickname: req.requester_nickname, email: req.requester_email });
              const busy = busyId === req.id;
              return (
                <li key={req.id} className="flex flex-col gap-2.5 rounded-xl bg-inset/70 p-3.5 ring-1 ring-inset ring-ink/[0.07]">
                  <div className="flex items-start gap-2.5">
                    <CollabAvatar
                      avatarUrl={req.requester_avatar_url}
                      nickname={req.requester_nickname}
                      email={req.requester_email}
                      size={36}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold text-ink">{sender}</div>
                      <div className="truncate text-[12px] text-ink-secondary">请求添加你为好友</div>
                      {req.note && (
                        <p className="mt-1 rounded-lg bg-app/70 px-2.5 py-1 text-[12px] text-ink-secondary">「{req.note}」</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      disabled={busyId !== null}
                      onClick={() => void handleAction(req.id, async () => {
                        await api(`/api/donebot/collab/friends/requests/${req.id}/reject`, { method: "POST", body: "{}" });
                      })}
                      className={`${COLLAB_BUTTON} h-7 px-3 text-[12px]`}
                    >
                      拒绝
                    </button>
                    <button
                      type="button"
                      disabled={busyId !== null}
                      onClick={() => void handleAction(req.id, async () => {
                        const res = await api<{ user_id?: number }>(`/api/donebot/collab/friends/requests/${req.id}/accept`, { method: "POST", body: "{}" });
                        if (res?.user_id) setCollabSelection({ kind: "friend", userId: res.user_id });
                      })}
                      className={`${COLLAB_BUTTON} ui-button-primary h-7 px-3 text-[12px]`}
                    >
                      {busy ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}
                      同意
                    </button>
                  </div>
                </li>
              );
            })}

            {(overview?.incoming_team_invitations ?? []).map(inv => {
              const inviter = displayPersonName({ nickname: inv.invited_by_nickname, email: inv.invited_by_email });
              const busy = busyId === inv.id;
              return (
                <li key={inv.id} className="flex flex-col gap-2.5 rounded-xl bg-inset/70 p-3.5 ring-1 ring-inset ring-ink/[0.07]">
                  <div className="flex items-start gap-2.5">
                    <CollabTeamBadge name={inv.team_name} size={36} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-[13px] font-semibold text-ink">{inv.team_name}</span>
                        <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset", TEAM_ROLE_PILL[inv.role])}>
                          {TEAM_ROLES[inv.role]}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[12px] text-ink-secondary">
                        {inviter} 邀请你加入团队
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      disabled={busyId !== null}
                      onClick={() => void handleAction(inv.id, async () => {
                        await api(`/api/donebot/collab/teams/invitations/${inv.id}/decline`, { method: "POST", body: "{}" });
                      })}
                      className={`${COLLAB_BUTTON} h-7 px-3 text-[12px]`}
                    >
                      拒绝
                    </button>
                    <button
                      type="button"
                      disabled={busyId !== null}
                      onClick={() => void handleAction(inv.id, async () => {
                        await api(`/api/donebot/collab/teams/invitations/${inv.id}/accept`, { method: "POST", body: "{}" });
                        setCollabSelection({ kind: "team", teamId: inv.team_id });
                      })}
                      className={`${COLLAB_BUTTON} ui-button-primary h-7 px-3 text-[12px]`}
                    >
                      {busy ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}
                      加入团队
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </CollabModalDialog>
  );
}

export function CollabDialogsHost() {
  const { activeDialog, overview } = useCollabStore();
  const close = () => openCollabDialog(null);
  const inviteTeam = activeDialog?.kind === "invite-team"
    ? overview?.teams.find(t => t.id === activeDialog.teamId) ?? null
    : null;
  const targetGroup = activeDialog?.kind === "add-group-members"
    ? (overview?.groups ?? []).find(g => g.id === activeDialog.groupId) ?? null
    : null;

  return (
    <>
      <AddFriendDialog open={activeDialog?.kind === "add-friend"} overview={overview} onClose={close} />
      <AddTeamDialog open={activeDialog?.kind === "add-team"} overview={overview} onClose={close} />
      <CreateGroupDialog open={activeDialog?.kind === "create-group"} overview={overview} onClose={close} />
      <AddGroupMembersDialog
        open={activeDialog?.kind === "add-group-members" && Boolean(targetGroup)}
        group={targetGroup}
        overview={overview}
        onClose={close}
      />
      <InviteTeamMemberDialog
        open={activeDialog?.kind === "invite-team" && Boolean(inviteTeam)}
        team={inviteTeam}
        overview={overview}
        onClose={close}
      />
      <CollabRequestsDialog open={activeDialog?.kind === "requests"} overview={overview} onClose={close} />
    </>
  );
}
