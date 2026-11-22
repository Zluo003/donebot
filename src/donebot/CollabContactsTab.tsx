import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AlertCircle,
  Bell,
  Check,
  KeyRound,
  LogOut,
  Pencil,
  Plus,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { api } from "@/state/api";
import { CommandLine, SETTINGS_INPUT, SettingsGroup, SIMPLE_CARD } from "@/components/SettingsPrimitives";
import { cn } from "@/lib/cn";
import type { DoneBotTeamCommand, DoneBotTeamInvitation } from "../../shared/donebot-teams";
import {
  cleanError,
  COLLAB_BUTTON,
  initialGlyph,
  TEAM_ROLE_PILL,
  TEAM_ROLES,
  type CollabOverview,
} from "./collab-types";

export function CollabContactsTab({
  overview,
  onReload,
  initialFocus,
}: {
  overview: CollabOverview;
  onReload: () => Promise<void>;
  initialFocus?: "add-friend" | "create-team" | "accept-team";
}) {
  const [selectedTeamId, setSelectedTeamId] = useState(overview.teams[0]?.id ?? "");
  const [teamInvitations, setTeamInvitations] = useState<DoneBotTeamInvitation[]>([]);
  const [friendEmail, setFriendEmail] = useState("");
  const [friendNote, setFriendNote] = useState("");
  const [teamPanel, setTeamPanel] = useState<"create" | "accept" | "rename" | null>(
    initialFocus === "create-team" ? "create" : initialFocus === "accept-team" ? "accept" : null,
  );
  const [teamName, setTeamName] = useState("");
  const [acceptToken, setAcceptToken] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [latestInvite, setLatestInvite] = useState<DoneBotTeamInvitation | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const createKey = useRef<{ name: string; key: string } | null>(null);
  const friendInputRef = useRef<HTMLInputElement>(null);
  const friendInputId = useId(), teamCreateId = useId(), teamAcceptId = useId(), teamInviteId = useId();

  useEffect(() => {
    if (initialFocus === "create-team") setTeamPanel("create");
    else if (initialFocus === "accept-team") setTeamPanel("accept");
    else if (initialFocus === "add-friend") friendInputRef.current?.focus();
  }, [initialFocus]);

  useEffect(() => {
    setSelectedTeamId(current => {
      if (current && overview.teams.some(t => t.id === current)) return current;
      return overview.teams[0]?.id ?? "";
    });
  }, [overview.teams]);

  const team = overview.teams.find(t => t.id === selectedTeamId) ?? null;
  const members = team ? (overview.team_members[team.id] ?? []) : [];

  const loadTeamInvitations = useCallback(async (teamId: string, role: string) => {
    if (!teamId || role === "member") { setTeamInvitations([]); return; }
    try {
      const list = await api<DoneBotTeamInvitation[]>(`/api/donebot/collab/teams/${teamId}/invitations`);
      setTeamInvitations(Array.isArray(list) ? list : []);
    } catch {
      setTeamInvitations([]);
    }
  }, []);

  useEffect(() => {
    setLatestInvite(null);
    if (team) void loadTeamInvitations(team.id, team.role);
    else setTeamInvitations([]);
  }, [team, loadTeamInvitations]);

  const runAction = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await work();
    } catch (cause) {
      setError(cleanError(cause));
    } finally {
      setBusy(false);
    }
  };

  const sendFriend = (e: React.FormEvent) => {
    e.preventDefault();
    void runAction(async () => {
      const res = await api<{ status?: string }>("/api/donebot/collab/friends/request", {
        method: "POST",
        body: JSON.stringify({ email: friendEmail.trim(), note: friendNote.trim() }),
      });
      setFriendEmail(""); setFriendNote("");
      setNotice(res?.status === "accepted" ? "对方也向你发送了申请，你们已成为好友！" : "好友申请已发送，对方在「远程协作」中即可一键同意。");
      await onReload();
    });
  };

  const mutateTeam = async (command: DoneBotTeamCommand) => {
    await runAction(async () => {
      const result = await api<unknown>("/api/donebot/teams", { method: "POST", body: JSON.stringify(command) });
      if (command.action === "invite") {
        setLatestInvite(result as DoneBotTeamInvitation);
        setInviteEmail("");
        setNotice("团队邀请已发送，对方在「远程协作」中直接点同意即可加入，也可复制下方邀请码。");
        if (team) await loadTeamInvitations(team.id, team.role);
        return;
      }
      if (command.action === "create") { createKey.current = null; setTeamName(""); setTeamPanel(null); }
      if (command.action === "accept") { setAcceptToken(""); setTeamPanel(null); }
      if (command.action === "rename") { setTeamName(""); setTeamPanel(null); }
      if (command.action === "revoke-invitation") {
        setLatestInvite(null);
        if (team) await loadTeamInvitations(team.id, team.role);
        return;
      }
      await onReload();
    });
  };

  const pendingCount = overview.friends.incoming_requests.length + overview.incoming_team_invitations.length;

  return (
    <div className="flex flex-col gap-5">
      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3.5 py-2.5 text-[13px] text-danger ring-1 ring-inset ring-danger/20">
          <AlertCircle size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {notice && (
        <div role="status" className="flex items-start gap-2 rounded-xl bg-success/12 px-3.5 py-2.5 text-[13px] text-success ring-1 ring-inset ring-success/25">
          <Check size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {/* Pending requests & team invitations */}
      {pendingCount > 0 && (
        <SettingsGroup label={`待处理的申请与邀请（${pendingCount}）`}>
          <div className={cn(SIMPLE_CARD, "divide-y divide-hairline/40 p-0")}>
            {overview.friends.incoming_requests.map(req => (
              <div key={req.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="flex min-w-0 flex-1 items-start gap-2.5">
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-accent/14 text-accent-text ring-1 ring-inset ring-accent/25">
                    <Bell size={14} aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-ink">
                      {req.requester_email} <span className="font-normal text-ink-secondary">请求添加你为好友</span>
                    </div>
                    {req.note && <p className="mt-0.5 text-[12px] text-ink-secondary">附言：{req.note}</p>}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    className={`${COLLAB_BUTTON} text-[12px]`}
                    onClick={() => void runAction(async () => {
                      await api(`/api/donebot/collab/friends/requests/${req.id}/reject`, { method: "POST", body: "{}" });
                      await onReload();
                    })}
                  >
                    拒绝
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={`${COLLAB_BUTTON} ui-button-primary text-[12px]`}
                    onClick={() => void runAction(async () => {
                      await api(`/api/donebot/collab/friends/requests/${req.id}/accept`, { method: "POST", body: "{}" });
                      setNotice(`已添加 ${req.requester_email} 为好友。`);
                      await onReload();
                    })}
                  >
                    同意
                  </button>
                </div>
              </div>
            ))}

            {overview.incoming_team_invitations.map(inv => (
              <div key={inv.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="flex min-w-0 flex-1 items-start gap-2.5">
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-accent/14 text-accent-text ring-1 ring-inset ring-accent/25">
                    <Users size={14} aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-ink">
                      受邀加入团队「{inv.team_name}」
                      <span className={cn("ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset", TEAM_ROLE_PILL[inv.role])}>
                        {TEAM_ROLES[inv.role]}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[12px] text-ink-secondary">
                      邀请人：{inv.invited_by_email} · 有效期至 {new Date(inv.expires_at).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    className={`${COLLAB_BUTTON} text-[12px]`}
                    onClick={() => void runAction(async () => {
                      await api(`/api/donebot/collab/teams/invitations/${inv.id}/decline`, { method: "POST", body: "{}" });
                      await onReload();
                    })}
                  >
                    拒绝
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={`${COLLAB_BUTTON} ui-button-primary text-[12px]`}
                    onClick={() => void runAction(async () => {
                      await api(`/api/donebot/collab/teams/invitations/${inv.id}/accept`, { method: "POST", body: "{}" });
                      setNotice(`已加入团队「${inv.team_name}」。`);
                      await onReload();
                    })}
                  >
                    加入团队
                  </button>
                </div>
              </div>
            ))}
          </div>
        </SettingsGroup>
      )}

      {/* Friends */}
      <SettingsGroup
        label={`我的好友（${overview.friends.friends.length}）`}
        footnote="非团队成员也可以通过好友关系互相共享文件夹和 Bot；删除好友后，基于好友关系的直接共享权限会立即失效。"
      >
        <div className={cn(SIMPLE_CARD, "divide-y divide-hairline/40 p-0")}>
          <form onSubmit={sendFriend} className="flex flex-col gap-2.5 p-4">
            <label htmlFor={friendInputId} className="flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary">
              <UserPlus size={13} aria-hidden="true" />添加好友
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                ref={friendInputRef}
                id={friendInputId}
                type="email"
                autoComplete="email"
                required
                maxLength={254}
                placeholder="输入对方 DoneBot 账号邮箱"
                value={friendEmail}
                onChange={e => setFriendEmail(e.target.value)}
                className={cn(SETTINGS_INPUT, "flex-1")}
                disabled={busy}
              />
              <input
                type="text"
                maxLength={200}
                placeholder="附言（选填）"
                value={friendNote}
                onChange={e => setFriendNote(e.target.value)}
                className={cn(SETTINGS_INPUT, "sm:w-44")}
                disabled={busy}
              />
              <button type="submit" disabled={busy || !friendEmail.trim()} className={`${COLLAB_BUTTON} ui-button-primary shrink-0`}>
                发送申请
              </button>
            </div>
          </form>

          {overview.friends.friends.length > 0 ? (
            <ul className="divide-y divide-hairline/40">
              {overview.friends.friends.map(friend => (
                <li key={friend.user_id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink/[0.06] text-[12px] font-medium text-ink ring-1 ring-inset ring-ink/[0.08]">
                      {initialGlyph(friend.email)}
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-medium text-ink">{friend.email}</div>
                      <div className="text-[11px] text-ink-tertiary">好友</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(`删除好友 ${friend.email}？基于好友关系的共享文件夹和共享 Bot 权限将立即收回。`)) return;
                      void runAction(async () => {
                        await api(`/api/donebot/collab/friends/${friend.user_id}`, { method: "DELETE" });
                        await onReload();
                      });
                    }}
                    className={`${COLLAB_BUTTON} text-[12px]`}
                  >
                    删除好友
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-4 text-[12px] text-ink-secondary">
              还没有添加好友，输入对方 DoneBot 邮箱发送申请即可开始远程协作。
            </p>
          )}

          {overview.friends.outgoing_requests.length > 0 && (
            <div className="flex flex-col gap-2 bg-inset/50 px-4 py-3">
              <div className="text-[11px] font-medium text-ink-tertiary">等待对方确认的好友申请</div>
              <ul className="flex flex-col gap-1.5">
                {overview.friends.outgoing_requests.map(req => (
                  <li key={req.id} className="flex items-center justify-between gap-2 text-[12px]">
                    <span className="truncate text-ink-secondary">{req.recipient_email}</span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void runAction(async () => {
                        await api(`/api/donebot/collab/friends/requests/${req.id}/reject`, { method: "POST", body: "{}" });
                        await onReload();
                      })}
                      className="text-[11px] text-ink-tertiary hover:text-danger"
                    >
                      撤回
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </SettingsGroup>

      {/* Teams (lightweight, zero Team Cloud) */}
      <SettingsGroup
        label={`我的团队（${overview.teams.length}）`}
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => { setError(""); setTeamPanel(c => c === "create" ? null : "create"); }}
              className={`${COLLAB_BUTTON} text-[12px]`}
            >
              <Plus size={13} aria-hidden="true" />新建团队
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => { setError(""); setTeamPanel(c => c === "accept" ? null : "accept"); }}
              className={`${COLLAB_BUTTON} text-[12px]`}
            >
              <KeyRound size={13} aria-hidden="true" />邀请码加入
            </button>
          </div>
        }
        footnote="团队用于批量管理协作成员和文件夹/Bot 授权，无需开通任何团队云服务器。"
      >
        <div className={cn(SIMPLE_CARD, "flex flex-col gap-3 p-4")}>
          {overview.teams.length > 0 ? (
            <div role="group" aria-label="已加入的团队" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {overview.teams.map(item => {
                const active = item.id === selectedTeamId;
                const count = overview.team_members[item.id]?.length;
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-team-item={item.id}
                    aria-pressed={active}
                    onClick={() => { setSelectedTeamId(item.id); setTeamPanel(null); }}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-xl px-3.5 py-3 text-left transition-colors",
                      active
                        ? "bg-ink/[0.08] ring-1 ring-inset ring-ink/30"
                        : "bg-inset/70 ring-1 ring-inset ring-ink/[0.07] hover:bg-ink/[0.05]",
                    )}
                  >
                    <span aria-hidden="true" className={cn(
                      "flex size-9 shrink-0 items-center justify-center rounded-xl text-[14px] font-semibold ring-1 ring-inset",
                      active ? "bg-ink text-app ring-transparent" : "bg-ink/[0.06] text-ink ring-ink/[0.08]",
                    )}>
                      {initialGlyph(item.name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium text-ink">{item.name}</span>
                      <span className="mt-1 flex items-center gap-1.5">
                        <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset", TEAM_ROLE_PILL[item.role])}>
                          {TEAM_ROLES[item.role]}
                        </span>
                        {count ? <span className="text-[11px] text-ink-tertiary">{count} 人</span> : null}
                      </span>
                    </span>
                    {active && <Check size={15} aria-hidden="true" className="shrink-0 text-ink" />}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl bg-inset/60 px-4 py-5 text-center text-[12px] text-ink-secondary">
              还没有创建或加入团队。点击右上角「新建团队」，即可按团队批量授权共享文件夹和 Bot。
            </div>
          )}

          {teamPanel === "create" && (
            <form
              className="flex flex-col gap-3 rounded-xl bg-inset p-3.5 ring-1 ring-inset ring-hairline/70"
              onSubmit={e => {
                e.preventDefault();
                const clean = teamName.trim();
                if (!createKey.current || createKey.current.name !== clean) createKey.current = { name: clean, key: crypto.randomUUID() };
                void mutateTeam({ action: "create", account_id: overview.identity.account_id, name: clean, key: createKey.current.key });
              }}
            >
              <label htmlFor={teamCreateId} className="text-[13px] font-medium text-ink">新建团队</label>
              <input
                id={teamCreateId}
                placeholder="输入团队名称，例如：产品研发组"
                className={SETTINGS_INPUT}
                value={teamName}
                onChange={e => setTeamName(e.target.value)}
                maxLength={100}
                required
                disabled={busy}
              />
              <div className="flex justify-end gap-2">
                <button type="button" className={COLLAB_BUTTON} onClick={() => setTeamPanel(null)}>取消</button>
                <button type="submit" disabled={busy || !teamName.trim()} className={`${COLLAB_BUTTON} ui-button-primary`}>创建团队</button>
              </div>
            </form>
          )}

          {teamPanel === "accept" && (
            <form
              className="flex flex-col gap-3 rounded-xl bg-inset p-3.5 ring-1 ring-inset ring-hairline/70"
              onSubmit={e => {
                e.preventDefault();
                void mutateTeam({ action: "accept", account_id: overview.identity.account_id, token: acceptToken.trim() });
              }}
            >
              <label htmlFor={teamAcceptId} className="text-[13px] font-medium text-ink">通过邀请码加入团队</label>
              <input
                id={teamAcceptId}
                placeholder="粘贴 43 位团队邀请码"
                className={`${SETTINGS_INPUT} font-mono`}
                value={acceptToken}
                onChange={e => setAcceptToken(e.target.value)}
                maxLength={43}
                pattern="[A-Za-z0-9_-]{43}"
                required
                disabled={busy}
              />
              <div className="flex justify-end gap-2">
                <button type="button" className={COLLAB_BUTTON} onClick={() => setTeamPanel(null)}>取消</button>
                <button type="submit" disabled={busy || !/^[A-Za-z0-9_-]{43}$/.test(acceptToken.trim())} className={`${COLLAB_BUTTON} ui-button-primary`}>加入团队</button>
              </div>
            </form>
          )}

          {team && (
            <div className="flex flex-col divide-y divide-hairline/40 rounded-xl bg-inset/50 ring-1 ring-inset ring-hairline/60">
              <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-ink">{team.name}</span>
                  <span className="text-[11px] text-ink-tertiary">成员（{members.length}）</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {team.role !== "member" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => { setTeamName(team.name); setTeamPanel(c => c === "rename" ? null : "rename"); }}
                      className={`${COLLAB_BUTTON} h-7 px-2.5 text-[11px]`}
                    >
                      <Pencil size={11} aria-hidden="true" />改名
                    </button>
                  )}
                  {team.role !== "owner" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`确定退出团队「${team.name}」？退出后将失去该团队的共享文件夹和共享 Bot 访问权限。`)) return;
                        void runAction(async () => {
                          await api(`/api/donebot/collab/teams/${team.id}/leave`, { method: "POST", body: "{}" });
                          await onReload();
                        });
                      }}
                      className={`${COLLAB_BUTTON} h-7 px-2.5 text-[11px]`}
                    >
                      <LogOut size={11} aria-hidden="true" />退出团队
                    </button>
                  )}
                </div>
              </div>

              {teamPanel === "rename" && (
                <form
                  className="flex items-center gap-2 px-3.5 py-2.5"
                  onSubmit={e => {
                    e.preventDefault();
                    void mutateTeam({ action: "rename", account_id: overview.identity.account_id, team_id: team.id, name: teamName.trim() });
                  }}
                >
                  <input
                    value={teamName}
                    onChange={e => setTeamName(e.target.value)}
                    maxLength={100}
                    required
                    className={cn(SETTINGS_INPUT, "flex-1")}
                    disabled={busy}
                  />
                  <button type="submit" disabled={busy || !teamName.trim()} className={`${COLLAB_BUTTON} ui-button-primary text-[12px]`}>保存</button>
                  <button type="button" onClick={() => setTeamPanel(null)} className="p-1 text-ink-tertiary hover:text-ink" aria-label="取消"><X size={14} /></button>
                </form>
              )}

              <ul className="divide-y divide-hairline/40">
                {members.map(member => {
                  const manageable = member.role !== "owner" && (team.role === "owner" || (team.role === "admin" && member.role === "member"));
                  return (
                    <li key={member.user_id} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink/[0.06] text-[11px] font-medium text-ink">
                          {initialGlyph(member.email)}
                        </span>
                        <span className="truncate text-[13px] text-ink">{member.email}</span>
                        <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset", TEAM_ROLE_PILL[member.role])}>
                          {TEAM_ROLES[member.role]}
                        </span>
                      </div>
                      {manageable && (
                        <div className="flex shrink-0 gap-1.5">
                          {team.role === "owner" && (
                            <button
                              type="button"
                              disabled={busy}
                              className={`${COLLAB_BUTTON} h-7 px-2.5 text-[11px]`}
                              onClick={() => void mutateTeam({
                                action: "member-role",
                                account_id: overview.identity.account_id,
                                team_id: team.id,
                                user_id: member.user_id,
                                role: member.role === "admin" ? "member" : "admin",
                              })}
                            >
                              {member.role === "admin" ? "设为成员" : "设为管理员"}
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busy}
                            className={`${COLLAB_BUTTON} h-7 px-2.5 text-[11px]`}
                            onClick={() => {
                              if (!window.confirm(`移除 ${member.email}？对方将立即失去此团队所有共享文件夹访问权限。`)) return;
                              void mutateTeam({ action: "remove-member", account_id: overview.identity.account_id, team_id: team.id, user_id: member.user_id });
                            }}
                          >
                            移除
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>

              {team.role !== "member" && (
                <div className="flex flex-col gap-3 px-3.5 py-3">
                  <form
                    className="flex flex-col gap-2 sm:flex-row sm:items-end"
                    onSubmit={e => {
                      e.preventDefault();
                      void mutateTeam({
                        action: "invite",
                        account_id: overview.identity.account_id,
                        team_id: team.id,
                        email: inviteEmail.trim(),
                        role: team.role === "owner" ? inviteRole : "member",
                      });
                    }}
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <label htmlFor={teamInviteId} className="text-[11px] font-medium text-ink-secondary">邀请成员加入「{team.name}」</label>
                      <input
                        id={teamInviteId}
                        type="email"
                        autoComplete="email"
                        required
                        maxLength={254}
                        placeholder="输入对方 DoneBot 账号邮箱"
                        value={inviteEmail}
                        onChange={e => setInviteEmail(e.target.value)}
                        className={SETTINGS_INPUT}
                        disabled={busy}
                      />
                    </div>
                    {team.role === "owner" && (
                      <select
                        aria-label="邀请角色"
                        value={inviteRole}
                        onChange={e => setInviteRole(e.target.value === "admin" ? "admin" : "member")}
                        className={cn(SETTINGS_INPUT, "sm:w-28")}
                        disabled={busy}
                      >
                        <option value="member">成员</option>
                        <option value="admin">管理员</option>
                      </select>
                    )}
                    <button type="submit" disabled={busy || !inviteEmail.trim()} className={`${COLLAB_BUTTON} ui-button-primary shrink-0`}>
                      发送邀请
                    </button>
                  </form>

                  {latestInvite && (
                    <div className="flex flex-col gap-2 rounded-lg bg-app/70 p-3 ring-1 ring-inset ring-hairline/60">
                      <p className="text-[11px] text-ink-secondary">
                        对方登录 <strong className="text-ink">{latestInvite.email}</strong> 后可在「远程协作」直接点同意，或粘贴以下备用邀请码：
                      </p>
                      <CommandLine command={latestInvite.token} copyLabel="复制邀请码" />
                    </div>
                  )}

                  {teamInvitations.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                      <div className="text-[11px] font-medium text-ink-tertiary">待接受邀请（{teamInvitations.length}）</div>
                      <ul className="divide-y divide-hairline/30 rounded-lg bg-app/60 ring-1 ring-inset ring-hairline/50">
                        {teamInvitations.map(inv => (
                          <li key={inv.id} className="flex items-center justify-between gap-2 px-3 py-2 text-[12px]">
                            <span className="truncate text-ink-secondary">
                              <span className="text-ink">{inv.email}</span> · {TEAM_ROLES[inv.role]}
                            </span>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void mutateTeam({ action: "revoke-invitation", account_id: overview.identity.account_id, team_id: team.id, invitation_id: inv.id })}
                              className="inline-flex items-center gap-1 text-[11px] text-ink-tertiary hover:text-danger"
                            >
                              <Trash2 size={11} aria-hidden="true" />撤销
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </SettingsGroup>
    </div>
  );
}
