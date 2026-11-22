import { useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  AlertCircle,
  Bot,
  Check,
  FolderOpen,
  Loader2,
  LogOut,
  Pencil,
  Tag,
  Trash2,
  UserMinus,
  Users,
  X,
} from "lucide-react";
import { api } from "@/state/api";
import { CommandLine } from "@/components/SettingsPrimitives";
import { cn } from "@/lib/cn";
import type { DoneBotFriend, DoneBotSharedBot } from "../../shared/donebot-collab";
import type { DoneBotTeamCommand, DoneBotTeamIdentity, DoneBotTeamInvitation } from "../../shared/donebot-teams";
import type { CollabSelection } from "./collab-store";
import {
  accessLabel,
  cleanError,
  COLLAB_BUTTON,
  COLLAB_CARD,
  COLLAB_HERO,
  COLLAB_INPUT,
  displayPersonName,
  personSecondaryLabel,
  TEAM_ROLE_PILL,
  TEAM_ROLES,
  type CollabOverview,
} from "./collab-types";
import { CollabAvatar, CollabTeamBadge } from "./CollabAvatar";
import { SectionTabBar, SharedBotCards, SharedFolderCards } from "./CollabSharedCards";

export function CollabFriendDetail({
  friend,
  overview,
  onReload,
  onSelect,
}: {
  friend: DoneBotFriend;
  overview: CollabOverview;
  onReload: () => Promise<void>;
  onSelect: (target: CollabSelection) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [editingRemark, setEditingRemark] = useState(false);
  const [remarkDraft, setRemarkDraft] = useState(friend.remark ?? "");
  const [activeTab, setActiveTab] = useState<"incoming" | "outgoing">("incoming");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const tabIdPrefix = useId();
  const remarkInputId = useId();

  useEffect(() => {
    setEditingRemark(false);
    setRemarkDraft(friend.remark ?? "");
    setError("");
    setNotice("");
  }, [friend.user_id, friend.remark]);

  const sharedTeamIds = useMemo(() => {
    const ids = new Set<string>();
    for (const team of overview.teams) {
      if ((overview.team_members[team.id] ?? []).some(m => m.user_id === friend.user_id)) {
        ids.add(team.id);
      }
    }
    return ids;
  }, [overview, friend.user_id]);

  const incomingFolders = useMemo(
    () => overview.folders.shared_with_me.filter(f => f.owner_user_id === friend.user_id),
    [overview.folders.shared_with_me, friend.user_id],
  );
  const outgoingFolders = useMemo(
    () => overview.folders.owned.filter(f =>
      f.grants.some(g =>
        (g.subject_type === "user" && g.subject_id === String(friend.user_id))
        || (g.subject_type === "team" && sharedTeamIds.has(g.subject_id)),
      ),
    ),
    [overview.folders.owned, friend.user_id, sharedTeamIds],
  );
  const incomingBots = useMemo(
    () => overview.bots.shared_with_me.filter(b => b.owner_user_id === friend.user_id),
    [overview.bots.shared_with_me, friend.user_id],
  );
  const outgoingBots = useMemo(
    () => overview.bots.owned.filter(b =>
      b.grants.some(g =>
        (g.subject_type === "user" && g.subject_id === String(friend.user_id))
        || (g.subject_type === "team" && sharedTeamIds.has(g.subject_id)),
      ),
    ),
    [overview.bots.owned, friend.user_id, sharedTeamIds],
  );

  const hasOnlineFolder = incomingFolders.some(f => f.online);
  const primaryName = displayPersonName(friend);
  const subLabel = personSecondaryLabel(friend);

  const saveRemark = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const cleaned = remarkDraft.trim();
      await api(`/api/donebot/collab/friends/${friend.user_id}/remark`, {
        method: "PUT",
        body: JSON.stringify({ remark: cleaned }),
      });
      setEditingRemark(false);
      setNotice(cleaned ? `已将好友备注修改为「${cleaned}」。` : "已清除好友备注，将显示对方昵称或邮箱。");
      await onReload();
    } catch (cause) {
      setError(cleanError(cause, "保存好友备注失败，请确认网关已升级至最新版本。"));
    } finally {
      setBusy(false);
    }
  };

  const installBot = async (item: DoneBotSharedBot) => {
    if (installingId) return;
    setInstallingId(item.id); setError(""); setNotice("");
    try {
      const res = await api<{ bots?: Array<{ name: string }> }>(`/api/donebot/collab/bots/${item.id}/install`, {
        method: "POST",
        body: "{}",
      });
      const created = res?.bots?.[0]?.name || item.name;
      setNotice(`已在本机创建同能力 Bot「${created}」（含人设与技能，不含原主人记忆），切回左侧「机器人」即可对话。`);
    } catch (cause) {
      setError(cleanError(cause, "添加共享 Bot 失败，请重试。"));
    } finally {
      setInstallingId(null);
    }
  };

  const removeFriend = async () => {
    if (busy) return;
    if (!window.confirm(`删除好友 ${primaryName}？基于好友关系的共享文件夹和共享 Bot 权限将立即收回。`)) return;
    setBusy(true); setError("");
    try {
      await api(`/api/donebot/collab/friends/${friend.user_id}`, { method: "DELETE" });
      await onReload();
      onSelect({ kind: "inbox" });
    } catch (cause) {
      setError(cleanError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Friend Hero Card */}
      <section className={cn(COLLAB_HERO, "flex flex-col gap-4 p-5")}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <CollabAvatar
              avatarUrl={friend.avatar_url}
              remark={friend.remark}
              nickname={friend.nickname}
              email={friend.email}
              size={56}
              online={hasOnlineFolder ? true : undefined}
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-[17px] font-semibold text-ink">{primaryName}</h2>
                {friend.remark && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-accent/14 px-2 py-0.5 text-[10.5px] font-medium text-accent-text ring-1 ring-inset ring-accent/25">
                    <Tag size={10} aria-hidden="true" />备注
                  </span>
                )}
              </div>
              {subLabel && (
                <p className="mt-0.5 truncate text-[12.5px] text-ink-secondary">{subLabel}</p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-tertiary">
                <span className="rounded-full bg-ink/[0.06] px-2.5 py-0.5">
                  {sharedTeamIds.size > 0 ? `共同加入 ${sharedTeamIds.size} 个团队` : "直接好友协作"}
                </span>
                <span className="rounded-full bg-ink/[0.06] px-2.5 py-0.5">
                  共享文件夹 {incomingFolders.length + outgoingFolders.length}
                </span>
                <span className="rounded-full bg-ink/[0.06] px-2.5 py-0.5">
                  共享 Bot {incomingBots.length + outgoingBots.length}
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-collab-edit-remark=""
              disabled={busy}
              onClick={() => { setRemarkDraft(friend.remark ?? ""); setEditingRemark(v => !v); }}
              className={`${COLLAB_BUTTON} text-[12px]`}
            >
              <Pencil size={12} aria-hidden="true" />
              {friend.remark ? "修改备注" : "设置备注"}
            </button>
            <button type="button" disabled={busy} onClick={() => void removeFriend()} className={`${COLLAB_BUTTON} text-[12px] hover:text-danger`}>
              <UserMinus size={13} aria-hidden="true" />删除好友
            </button>
          </div>
        </div>

        {editingRemark && (
          <form
            onSubmit={e => void saveRemark(e)}
            className="flex flex-col gap-2 rounded-xl bg-app/75 p-3.5 ring-1 ring-inset ring-ink/[0.08] sm:flex-row sm:items-end"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <label htmlFor={remarkInputId} className="text-[11.5px] font-medium text-ink-secondary">
                好友备注名称（仅自己可见，留空恢复默认昵称/邮箱）
              </label>
              <input
                id={remarkInputId}
                name="friend_remark"
                type="text"
                autoFocus
                maxLength={64}
                placeholder="输入便于识别的备注名"
                value={remarkDraft}
                onChange={e => setRemarkDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Escape") setEditingRemark(false);
                }}
                disabled={busy}
                className={COLLAB_INPUT}
              />
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button type="submit" disabled={busy} className={`${COLLAB_BUTTON} ui-button-primary h-[38px] px-3.5 text-[12.5px]`}>
                {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
                保存备注
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditingRemark(false)}
                aria-label="取消修改备注"
                className={`${COLLAB_BUTTON} h-[38px] px-2.5 text-[12.5px]`}
              >
                取消
              </button>
            </div>
          </form>
        )}
      </section>

      {error && (
        <div role="alert" className="flex items-start gap-2.5 rounded-2xl bg-danger/10 px-4 py-3 text-[13px] text-danger ring-1 ring-inset ring-danger/20">
          <AlertCircle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div role="status" className="flex items-start gap-2.5 rounded-2xl bg-success/12 px-4 py-3 text-[13px] text-success ring-1 ring-inset ring-success/25">
          <Check size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      <SectionTabBar
        label="好友共享视图"
        idPrefix={tabIdPrefix}
        active={activeTab}
        onChange={setActiveTab}
        tabs={[
          { id: "incoming", label: "TA 共享给我", count: incomingFolders.length + incomingBots.length },
          { id: "outgoing", label: "我共享给 TA", count: outgoingFolders.length + outgoingBots.length },
        ]}
      />

      <div
        role="tabpanel"
        aria-labelledby={`${tabIdPrefix}-tab-incoming`}
        hidden={activeTab !== "incoming"}
      >
        <div className="flex flex-col gap-5">
          <section className="flex flex-col gap-2">
            <h3 className="px-1 text-[13px] font-semibold text-ink">共享文件夹（{incomingFolders.length}）</h3>
            <div className={cn(COLLAB_CARD, "overflow-hidden")}>
              <SharedFolderCards folders={incomingFolders} emptyText="对方暂未向你共享本机文件夹。" />
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="px-1 text-[13px] font-semibold text-ink">共享 Bot（{incomingBots.length}）</h3>
            <div className={cn(COLLAB_CARD, "overflow-hidden")}>
              <SharedBotCards
                bots={incomingBots}
                emptyText="对方暂未向你共享 Bot 模板。"
                installingId={installingId}
                onInstall={item => void installBot(item)}
              />
            </div>
          </section>
        </div>
      </div>

      <div
        role="tabpanel"
        aria-labelledby={`${tabIdPrefix}-tab-outgoing`}
        hidden={activeTab !== "outgoing"}
      >
        <div className="flex flex-col gap-5">
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between px-1">
              <h3 className="text-[13px] font-semibold text-ink">我共享的文件夹（{outgoingFolders.length}）</h3>
              <button type="button" onClick={() => onSelect({ kind: "folders" })} className={`${COLLAB_BUTTON} h-7 px-2.5 text-[12px]`}>
                管理共享文件夹
              </button>
            </div>
            <div className={cn(COLLAB_CARD, "overflow-hidden")}>
              {outgoingFolders.length > 0 ? (
                <ul className="divide-y divide-ink/[0.06]">
                  {outgoingFolders.map(folder => {
                    const direct = folder.grants.find(g => g.subject_type === "user" && g.subject_id === String(friend.user_id));
                    const teamGrant = folder.grants.find(g => g.subject_type === "team" && sharedTeamIds.has(g.subject_id));
                    const access = direct?.access === "write" || teamGrant?.access === "write" ? "write" : "read";
                    return (
                      <li key={folder.id} className="flex items-center justify-between gap-2 px-5 py-3.5 text-[13px]">
                        <span className="flex min-w-0 items-center gap-2.5">
                          <FolderOpen size={15} className="shrink-0 text-[#4CC98C]" aria-hidden="true" />
                          <span className="truncate font-medium text-ink">{folder.name}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2 text-[11px]">
                          <span className="rounded-full bg-ink/[0.06] px-2.5 py-0.5 text-ink-secondary">{accessLabel(access)}</span>
                          {!folder.enabled && <span className="text-ink-tertiary">已暂停</span>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="px-5 py-6 text-center text-[12.5px] text-ink-tertiary">你还没有向 {primaryName} 共享本机文件夹。</p>
              )}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between px-1">
              <h3 className="text-[13px] font-semibold text-ink">我共享的 Bot（{outgoingBots.length}）</h3>
              <button type="button" onClick={() => onSelect({ kind: "bots" })} className={`${COLLAB_BUTTON} h-7 px-2.5 text-[12px]`}>
                管理共享 Bot
              </button>
            </div>
            <div className={cn(COLLAB_CARD, "overflow-hidden")}>
              {outgoingBots.length > 0 ? (
                <ul className="divide-y divide-ink/[0.06]">
                  {outgoingBots.map(item => (
                    <li key={item.id} className="flex items-center justify-between gap-2 px-5 py-3.5 text-[13px]">
                      <span className="flex min-w-0 items-center gap-2.5">
                        <Bot size={15} className="shrink-0 text-accent-text" aria-hidden="true" />
                        <span className="truncate font-medium text-ink">{item.name}</span>
                      </span>
                      <span className="shrink-0 text-[11.5px] text-ink-tertiary">
                        {item.has_soul ? "SOUL.md · " : ""}{item.skill_count} 技能
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-5 py-6 text-center text-[12.5px] text-ink-tertiary">你还没有向 {primaryName} 共享 Bot。</p>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export function CollabTeamDetail({
  team,
  overview,
  onReload,
  onSelect,
}: {
  team: DoneBotTeamIdentity;
  overview: CollabOverview;
  onReload: () => Promise<void>;
  onSelect: (target: CollabSelection) => void;
}) {
  const members = overview.team_members[team.id] ?? [];
  const [invitations, setInvitations] = useState<DoneBotTeamInvitation[]>([]);
  const [activeTab, setActiveTab] = useState<"resources" | "members">("resources");
  const [renaming, setRenaming] = useState(false);
  const [teamName, setTeamName] = useState(team.name);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [latestInvite, setLatestInvite] = useState<DoneBotTeamInvitation | null>(null);
  const [busy, setBusy] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const inviteInputId = useId();
  const tabIdPrefix = useId();

  const loadInvitations = useCallback(async () => {
    if (team.role === "member") { setInvitations([]); return; }
    try {
      const list = await api<DoneBotTeamInvitation[]>(`/api/donebot/collab/teams/${team.id}/invitations`);
      setInvitations(Array.isArray(list) ? list : []);
    } catch {
      setInvitations([]);
    }
  }, [team.id, team.role]);

  useEffect(() => {
    setLatestInvite(null);
    setRenaming(false);
    setTeamName(team.name);
    void loadInvitations();
  }, [team.id, team.name, loadInvitations]);

  const teamIncomingFolders = useMemo(
    () => overview.folders.shared_with_me.filter(f => f.sources.some(s => s.kind === "team" && s.team_id === team.id)),
    [overview.folders.shared_with_me, team.id],
  );
  const teamOwnedFolders = useMemo(
    () => overview.folders.owned.filter(f => f.grants.some(g => g.subject_type === "team" && g.subject_id === team.id)),
    [overview.folders.owned, team.id],
  );
  const teamIncomingBots = useMemo(
    () => overview.bots.shared_with_me.filter(b => b.sources.some(s => s.kind === "team" && s.team_id === team.id)),
    [overview.bots.shared_with_me, team.id],
  );
  const teamOwnedBots = useMemo(
    () => overview.bots.owned.filter(b => b.grants.some(g => g.subject_type === "team" && g.subject_id === team.id)),
    [overview.bots.owned, team.id],
  );

  const mutateTeam = async (command: DoneBotTeamCommand) => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api<unknown>("/api/donebot/teams", { method: "POST", body: JSON.stringify(command) });
      if (command.action === "invite") {
        setLatestInvite(result as DoneBotTeamInvitation);
        setInviteEmail("");
        setNotice("团队邀请已发送，对方客户端会收到实时提醒，也可复制下方备用邀请码。");
        await loadInvitations();
        return;
      }
      if (command.action === "rename") setRenaming(false);
      if (command.action === "revoke-invitation") {
        setLatestInvite(null);
        await loadInvitations();
        return;
      }
      await onReload();
    } catch (cause) {
      setError(cleanError(cause));
    } finally {
      setBusy(false);
    }
  };

  const leaveTeam = async () => {
    if (busy) return;
    if (!window.confirm(`确定退出团队「${team.name}」？退出后将失去该团队的共享文件夹和共享 Bot 访问权限。`)) return;
    setBusy(true); setError("");
    try {
      await api(`/api/donebot/collab/teams/${team.id}/leave`, { method: "POST", body: "{}" });
      await onReload();
      onSelect({ kind: "inbox" });
    } catch (cause) {
      setError(cleanError(cause));
    } finally {
      setBusy(false);
    }
  };

  const installBot = async (item: DoneBotSharedBot) => {
    if (installingId) return;
    setInstallingId(item.id); setError(""); setNotice("");
    try {
      const res = await api<{ bots?: Array<{ name: string }> }>(`/api/donebot/collab/bots/${item.id}/install`, {
        method: "POST",
        body: "{}",
      });
      const created = res?.bots?.[0]?.name || item.name;
      setNotice(`已在本机创建同能力 Bot「${created}」（含人设与技能，不含原主人记忆），切回左侧「机器人」即可对话。`);
    } catch (cause) {
      setError(cleanError(cause, "添加共享 Bot 失败，请重试。"));
    } finally {
      setInstallingId(null);
    }
  };

  const resourceCount = teamIncomingFolders.length + teamOwnedFolders.length + teamIncomingBots.length + teamOwnedBots.length;

  return (
    <div className="flex flex-col gap-5">
      {/* Team Hero Card */}
      <section className={cn(COLLAB_HERO, "flex flex-col gap-4 p-5")}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <CollabTeamBadge name={team.name} size={52} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-[17px] font-semibold text-ink">{team.name}</h2>
                <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-[10.5px] font-medium ring-1 ring-inset", TEAM_ROLE_PILL[team.role])}>
                  {TEAM_ROLES[team.role]}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-3">
                <div className="flex -space-x-2">
                  {members.slice(0, 6).map(m => (
                    <CollabAvatar
                      key={m.user_id}
                      avatarUrl={m.avatar_url}
                      remark={m.remark}
                      nickname={m.nickname}
                      email={m.email}
                      size={24}
                      className="ring-2 ring-app rounded-full"
                    />
                  ))}
                </div>
                <span className="text-[12px] text-ink-secondary">
                  {members.length} 位成员 · 按团队批量共享文件夹与 Bot
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {team.role !== "member" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => { setTeamName(team.name); setRenaming(v => !v); }}
                className={`${COLLAB_BUTTON} text-[12px]`}
              >
                <Pencil size={12} aria-hidden="true" />改名
              </button>
            )}
            {team.role !== "owner" && (
              <button type="button" disabled={busy} onClick={() => void leaveTeam()} className={`${COLLAB_BUTTON} text-[12px] hover:text-danger`}>
                <LogOut size={12} aria-hidden="true" />退出团队
              </button>
            )}
          </div>
        </div>

        {renaming && (
          <form
            className="flex items-center gap-2 rounded-xl bg-app/75 p-3 ring-1 ring-inset ring-ink/[0.08]"
            onSubmit={e => {
              e.preventDefault();
              void mutateTeam({ action: "rename", account_id: overview.identity.account_id, team_id: team.id, name: teamName.trim() });
            }}
          >
            <input
              aria-label="新团队名称"
              name="team_name"
              value={teamName}
              onChange={e => setTeamName(e.target.value)}
              maxLength={100}
              required
              disabled={busy}
              className={cn(COLLAB_INPUT, "flex-1")}
            />
            <button type="submit" disabled={busy || !teamName.trim()} className={`${COLLAB_BUTTON} ui-button-primary text-[12px]`}>保存</button>
            <button type="button" onClick={() => setRenaming(false)} aria-label="取消" className="rounded-lg p-1.5 text-ink-tertiary hover:bg-ink/[0.06] hover:text-ink">
              <X size={14} aria-hidden="true" />
            </button>
          </form>
        )}
      </section>

      {error && (
        <div role="alert" className="flex items-start gap-2.5 rounded-2xl bg-danger/10 px-4 py-3 text-[13px] text-danger ring-1 ring-inset ring-danger/20">
          <AlertCircle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div role="status" className="flex items-start gap-2.5 rounded-2xl bg-success/12 px-4 py-3 text-[13px] text-success ring-1 ring-inset ring-success/25">
          <Check size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      <SectionTabBar
        label="团队详情视图"
        idPrefix={tabIdPrefix}
        active={activeTab}
        onChange={setActiveTab}
        tabs={[
          { id: "resources", label: "共享资源", count: resourceCount },
          { id: "members", label: `团队成员与邀请（${members.length}）` },
        ]}
      />

      <div
        role="tabpanel"
        aria-labelledby={`${tabIdPrefix}-tab-resources`}
        hidden={activeTab !== "resources"}
      >
        <div className="flex flex-col gap-5">
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between px-1">
              <h3 className="text-[13px] font-semibold text-ink">团队共享文件夹（{teamIncomingFolders.length + teamOwnedFolders.length}）</h3>
              <button type="button" onClick={() => onSelect({ kind: "folders" })} className={`${COLLAB_BUTTON} h-7 px-2.5 text-[12px]`}>
                管理共享文件夹
              </button>
            </div>
            <div className={cn(COLLAB_CARD, "overflow-hidden divide-y divide-ink/[0.06]")}>
              {teamOwnedFolders.length > 0 && (
                <ul className="divide-y divide-ink/[0.06]">
                  {teamOwnedFolders.map(folder => {
                    const grant = folder.grants.find(g => g.subject_type === "team" && g.subject_id === team.id);
                    return (
                      <li key={folder.id} className="flex items-center justify-between gap-2 px-5 py-3.5 text-[13px]">
                        <span className="flex min-w-0 items-center gap-2.5">
                          <FolderOpen size={15} className="shrink-0 text-[#4CC98C]" aria-hidden="true" />
                          <span className="truncate font-medium text-ink">
                            {folder.name} <span className="text-[11px] font-normal text-ink-tertiary">（我共享的）</span>
                          </span>
                        </span>
                        <span className="shrink-0 rounded-full bg-ink/[0.06] px-2.5 py-0.5 text-[11px] text-ink-secondary">
                          {accessLabel(grant?.access ?? "read")}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <SharedFolderCards
                folders={teamIncomingFolders}
                emptyText={teamOwnedFolders.length > 0 ? "暂无其他成员共享给此团队的文件夹。" : "此团队暂未配置共享文件夹，点右上角「管理共享文件夹」添加。"}
              />
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between px-1">
              <h3 className="text-[13px] font-semibold text-ink">团队共享 Bot（{teamIncomingBots.length + teamOwnedBots.length}）</h3>
              <button type="button" onClick={() => onSelect({ kind: "bots" })} className={`${COLLAB_BUTTON} h-7 px-2.5 text-[12px]`}>
                管理共享 Bot
              </button>
            </div>
            <div className={cn(COLLAB_CARD, "overflow-hidden divide-y divide-ink/[0.06]")}>
              {teamOwnedBots.length > 0 && (
                <ul className="divide-y divide-ink/[0.06]">
                  {teamOwnedBots.map(item => (
                    <li key={item.id} className="flex items-center justify-between gap-2 px-5 py-3.5 text-[13px]">
                      <span className="flex min-w-0 items-center gap-2.5">
                        <Bot size={15} className="shrink-0 text-accent-text" aria-hidden="true" />
                        <span className="truncate font-medium text-ink">
                          {item.name} <span className="text-[11px] font-normal text-ink-tertiary">（我共享的）</span>
                        </span>
                      </span>
                      <span className="shrink-0 text-[11.5px] text-ink-tertiary">
                        {item.has_soul ? "SOUL.md · " : ""}{item.skill_count} 技能
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <SharedBotCards
                bots={teamIncomingBots}
                emptyText={teamOwnedBots.length > 0 ? "暂无其他成员共享给此团队的 Bot。" : "此团队暂未共享 Bot 模板。"}
                installingId={installingId}
                onInstall={item => void installBot(item)}
              />
            </div>
          </section>
        </div>
      </div>

      <div
        role="tabpanel"
        aria-labelledby={`${tabIdPrefix}-tab-members`}
        hidden={activeTab !== "members"}
      >
        <div className={cn(COLLAB_CARD, "overflow-hidden divide-y divide-ink/[0.06]")}>
          <ul className="divide-y divide-ink/[0.06]">
            {members.map(member => {
              const manageable = member.role !== "owner" && (team.role === "owner" || (team.role === "admin" && member.role === "member"));
              const name = displayPersonName(member);
              const sub = personSecondaryLabel(member);
              return (
                <li key={member.user_id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                  <div className="flex min-w-0 items-center gap-3">
                    <CollabAvatar
                      avatarUrl={member.avatar_url}
                      remark={member.remark}
                      nickname={member.nickname}
                      email={member.email}
                      size={36}
                    />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[13.5px] font-medium text-ink">{name}</span>
                        <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset", TEAM_ROLE_PILL[member.role])}>
                          {TEAM_ROLES[member.role]}
                        </span>
                      </div>
                      {sub && <div className="truncate text-[11.5px] text-ink-tertiary">{sub}</div>}
                    </div>
                  </div>
                  {manageable && (
                    <div className="flex shrink-0 gap-1.5">
                      {team.role === "owner" && (
                        <button
                          type="button"
                          disabled={busy}
                          className={`${COLLAB_BUTTON} h-7 px-2.5 text-[11.5px]`}
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
                        className={`${COLLAB_BUTTON} h-7 px-2.5 text-[11.5px] hover:text-danger`}
                        onClick={() => {
                          if (!window.confirm(`移除 ${name}？对方将立即失去此团队所有共享文件夹访问权限。`)) return;
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
            <div className="flex flex-col gap-3.5 bg-inset/40 p-5">
              <form
                className="flex flex-col gap-2.5 sm:flex-row sm:items-end"
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
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <label htmlFor={inviteInputId} className="flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary">
                    <Users size={13} aria-hidden="true" />邀请新成员加入「{team.name}」
                  </label>
                  <input
                    id={inviteInputId}
                    name="invite_email"
                    type="email"
                    autoComplete="email"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                    maxLength={254}
                    placeholder="输入对方 DoneBot 账号邮箱"
                    value={inviteEmail}
                    onChange={e => setInviteEmail(e.target.value)}
                    className={COLLAB_INPUT}
                    disabled={busy}
                  />
                </div>
                {team.role === "owner" && (
                  <select
                    aria-label="邀请角色"
                    name="invite_role"
                    value={inviteRole}
                    onChange={e => setInviteRole(e.target.value === "admin" ? "admin" : "member")}
                    className={cn(COLLAB_INPUT, "sm:w-28")}
                    disabled={busy}
                  >
                    <option value="member">成员</option>
                    <option value="admin">管理员</option>
                  </select>
                )}
                <button type="submit" disabled={busy || !inviteEmail.trim()} className={`${COLLAB_BUTTON} ui-button-primary h-[38px] shrink-0 px-4`}>
                  发送邀请
                </button>
              </form>

              {latestInvite && (
                <div className="flex flex-col gap-2 rounded-xl bg-app/80 p-3.5 ring-1 ring-inset ring-ink/[0.08]">
                  <p className="text-[12px] text-ink-secondary">
                    对方登录 <strong className="text-ink">{latestInvite.email}</strong> 后会立即收到通知，也可粘贴以下备用邀请码：
                  </p>
                  <CommandLine command={latestInvite.token} copyLabel="复制邀请码" />
                </div>
              )}

              {invitations.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <div className="text-[11.5px] font-medium text-ink-tertiary">待接受邀请（{invitations.length}）</div>
                  <ul className="divide-y divide-ink/[0.05] rounded-xl bg-app/70 ring-1 ring-inset ring-ink/[0.07]">
                    {invitations.map(inv => (
                      <li key={inv.id} className="flex items-center justify-between gap-2 px-3.5 py-2.5 text-[12px]">
                        <span className="truncate text-ink-secondary">
                          <span className="font-medium text-ink">{inv.email}</span> · {TEAM_ROLES[inv.role]}
                        </span>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void mutateTeam({ action: "revoke-invitation", account_id: overview.identity.account_id, team_id: team.id, invitation_id: inv.id })}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-ink-tertiary hover:bg-danger/10 hover:text-danger"
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
      </div>
    </div>
  );
}
