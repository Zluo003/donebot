import { useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  AlertCircle,
  Bot,
  Check,
  Download,
  Eye,
  FolderOpen,
  Loader2,
  LogOut,
  Pencil,
  Trash2,
  UserMinus,
  Users,
  X,
} from "lucide-react";
import { api } from "@/state/api";
import { CommandLine, SETTINGS_INPUT, SettingsGroup, SIMPLE_CARD } from "@/components/SettingsPrimitives";
import { cn } from "@/lib/cn";
import type { DoneBotFriend, DoneBotSharedBot, DoneBotSharedFolder } from "../../shared/donebot-collab";
import type { DoneBotTeamCommand, DoneBotTeamIdentity, DoneBotTeamInvitation } from "../../shared/donebot-teams";
import type { CollabSelection } from "./collab-store";
import {
  accessLabel,
  cleanError,
  COLLAB_BUTTON,
  initialGlyph,
  sourceText,
  TEAM_ROLE_PILL,
  TEAM_ROLES,
  type CollabOverview,
} from "./collab-types";
import { CollabFolderBrowser } from "./CollabFolderBrowser";

function SharedFolderCards({
  folders,
  emptyText,
}: {
  folders: readonly DoneBotSharedFolder[];
  emptyText: string;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (folders.length === 0) {
    return <p className="px-4 py-4 text-[12px] text-ink-secondary">{emptyText}</p>;
  }
  return (
    <ul className="divide-y divide-hairline/40">
      {folders.map(folder => {
        const isOpen = openId === folder.id;
        return (
          <li key={folder.id} className="flex flex-col gap-3 px-4 py-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-start gap-2.5">
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-ink/[0.06] text-ink-secondary">
                  <FolderOpen size={15} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-ink">{folder.name}</span>
                    <span className={cn(
                      "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset",
                      folder.online
                        ? "bg-success/12 text-success ring-success/25"
                        : "bg-ink/[0.05] text-ink-tertiary ring-ink/10",
                    )}>
                      <span className={cn("size-1.5 rounded-full", folder.online ? "bg-success" : "bg-ink-tertiary")} aria-hidden="true" />
                      {folder.online ? "在线" : "对方离线"}
                    </span>
                    <span className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset",
                      folder.access === "write"
                        ? "bg-accent/14 text-accent-text ring-accent/25"
                        : "bg-ink/[0.05] text-ink-secondary ring-ink/10",
                    )}>
                      {accessLabel(folder.access)}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-ink-secondary">
                    来自 {folder.owner_email} · {folder.device_name} · {sourceText(folder.sources)}
                  </div>
                </div>
              </div>
              <button
                type="button"
                disabled={!folder.online}
                onClick={() => setOpenId(isOpen ? null : folder.id)}
                className={`${COLLAB_BUTTON} text-[12px]`}
              >
                <Eye size={13} aria-hidden="true" />
                {isOpen ? "收起浏览" : "浏览文件"}
              </button>
            </div>
            {isOpen && <CollabFolderBrowser folder={folder} />}
          </li>
        );
      })}
    </ul>
  );
}

function SharedBotCards({
  bots,
  emptyText,
  installingId,
  onInstall,
}: {
  bots: readonly DoneBotSharedBot[];
  emptyText: string;
  installingId: string | null;
  onInstall: (bot: DoneBotSharedBot) => void;
}) {
  if (bots.length === 0) {
    return <p className="px-4 py-4 text-[12px] text-ink-secondary">{emptyText}</p>;
  }
  return (
    <ul className="divide-y divide-hairline/40">
      {bots.map(item => {
        const loading = installingId === item.id;
        return (
          <li key={item.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5">
            <div className="flex min-w-0 flex-1 items-start gap-2.5">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent-text">
                <Bot size={15} aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-ink">{item.name}</span>
                  {item.has_soul && (
                    <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-[10px] text-ink-secondary">SOUL.md</span>
                  )}
                  <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-[10px] text-ink-secondary">{item.skill_count} 技能</span>
                </div>
                {item.title && <div className="mt-0.5 text-[12px] text-ink-secondary">{item.title}</div>}
                {item.description && <p className="mt-1 text-[11px] text-ink-tertiary">{item.description}</p>}
              </div>
            </div>
            <button
              type="button"
              disabled={installingId !== null}
              onClick={() => onInstall(item)}
              className={`${COLLAB_BUTTON} ui-button-primary shrink-0 text-[12px]`}
            >
              {loading ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Download size={13} aria-hidden="true" />}
              {loading ? "正在添加…" : "添加到我的电脑"}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

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
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

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
    if (!window.confirm(`删除好友 ${friend.email}？基于好友关系的共享文件夹和共享 Bot 权限将立即收回。`)) return;
    setBusy(true); setError("");
    try {
      await api(`/api/donebot/collab/friends/${friend.user_id}`, { method: "DELETE" });
      await onReload();
      onSelect({ kind: "contacts" });
    } catch (cause) {
      setError(cleanError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className={cn(SIMPLE_CARD, "flex flex-wrap items-center justify-between gap-3 p-4")}>
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center rounded-full bg-ink/[0.08] text-[15px] font-semibold text-ink ring-1 ring-inset ring-ink/10">
            {initialGlyph(friend.email)}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold text-ink">{friend.email}</h2>
            <p className="mt-0.5 text-[12px] text-ink-secondary">
              好友 · {sharedTeamIds.size > 0 ? `共同加入 ${sharedTeamIds.size} 个团队` : "直接好友协作"}
            </p>
          </div>
        </div>
        <button type="button" disabled={busy} onClick={() => void removeFriend()} className={`${COLLAB_BUTTON} text-[12px]`}>
          <UserMinus size={13} aria-hidden="true" />删除好友
        </button>
      </div>

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

      <SettingsGroup label={`TA 共享给我的文件夹（${incomingFolders.length}）`}>
        <div className={cn(SIMPLE_CARD, "p-0")}>
          <SharedFolderCards folders={incomingFolders} emptyText="对方暂未向你共享本机文件夹。" />
        </div>
      </SettingsGroup>

      <SettingsGroup
        label={`我共享给 TA 的文件夹（${outgoingFolders.length}）`}
        actions={
          <button type="button" onClick={() => onSelect({ kind: "folders" })} className={`${COLLAB_BUTTON} text-[12px]`}>
            管理共享文件夹
          </button>
        }
      >
        <div className={cn(SIMPLE_CARD, "p-0")}>
          {outgoingFolders.length > 0 ? (
            <ul className="divide-y divide-hairline/40">
              {outgoingFolders.map(folder => {
                const direct = folder.grants.find(g => g.subject_type === "user" && g.subject_id === String(friend.user_id));
                const teamGrant = folder.grants.find(g => g.subject_type === "team" && sharedTeamIds.has(g.subject_id));
                const access = direct?.access === "write" || teamGrant?.access === "write" ? "write" : "read";
                return (
                  <li key={folder.id} className="flex items-center justify-between gap-2 px-4 py-3 text-[13px]">
                    <span className="truncate font-medium text-ink">{folder.name}</span>
                    <span className="flex shrink-0 items-center gap-2 text-[11px]">
                      <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-ink-secondary">{accessLabel(access)}</span>
                      {!folder.enabled && <span className="text-ink-tertiary">已暂停</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-4 py-4 text-[12px] text-ink-secondary">你还没有向 {friend.email} 共享本机文件夹。</p>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup label={`TA 共享给我的 Bot（${incomingBots.length}）`}>
        <div className={cn(SIMPLE_CARD, "p-0")}>
          <SharedBotCards
            bots={incomingBots}
            emptyText="对方暂未向你共享 Bot 模板。"
            installingId={installingId}
            onInstall={item => void installBot(item)}
          />
        </div>
      </SettingsGroup>

      <SettingsGroup
        label={`我共享给 TA 的 Bot（${outgoingBots.length}）`}
        actions={
          <button type="button" onClick={() => onSelect({ kind: "bots" })} className={`${COLLAB_BUTTON} text-[12px]`}>
            管理共享 Bot
          </button>
        }
      >
        <div className={cn(SIMPLE_CARD, "p-0")}>
          {outgoingBots.length > 0 ? (
            <ul className="divide-y divide-hairline/40">
              {outgoingBots.map(item => (
                <li key={item.id} className="flex items-center justify-between gap-2 px-4 py-3 text-[13px]">
                  <span className="truncate font-medium text-ink">{item.name}</span>
                  <span className="shrink-0 text-[11px] text-ink-tertiary">
                    {item.has_soul ? "SOUL.md · " : ""}{item.skill_count} 技能
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-4 text-[12px] text-ink-secondary">你还没有向 {friend.email} 共享 Bot。</p>
          )}
        </div>
      </SettingsGroup>
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
      onSelect({ kind: "contacts" });
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

  return (
    <div className="flex flex-col gap-5">
      <div className={cn(SIMPLE_CARD, "flex flex-col gap-3 p-4")}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent/14 text-[15px] font-semibold text-accent-text ring-1 ring-inset ring-accent/20">
              {initialGlyph(team.name)}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-[15px] font-semibold text-ink">{team.name}</h2>
                <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset", TEAM_ROLE_PILL[team.role])}>
                  {TEAM_ROLES[team.role]}
                </span>
              </div>
              <p className="mt-0.5 text-[12px] text-ink-secondary">{members.length} 位成员 · 按团队批量共享文件夹与 Bot</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
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
              <button type="button" disabled={busy} onClick={() => void leaveTeam()} className={`${COLLAB_BUTTON} text-[12px]`}>
                <LogOut size={12} aria-hidden="true" />退出团队
              </button>
            )}
          </div>
        </div>

        {renaming && (
          <form
            className="flex items-center gap-2 pt-1"
            onSubmit={e => {
              e.preventDefault();
              void mutateTeam({ action: "rename", account_id: overview.identity.account_id, team_id: team.id, name: teamName.trim() });
            }}
          >
            <input
              aria-label="新团队名称"
              value={teamName}
              onChange={e => setTeamName(e.target.value)}
              maxLength={100}
              required
              disabled={busy}
              className={cn(SETTINGS_INPUT, "flex-1")}
            />
            <button type="submit" disabled={busy || !teamName.trim()} className={`${COLLAB_BUTTON} ui-button-primary text-[12px]`}>保存</button>
            <button type="button" onClick={() => setRenaming(false)} aria-label="取消" className="p-1 text-ink-tertiary hover:text-ink">
              <X size={14} aria-hidden="true" />
            </button>
          </form>
        )}
      </div>

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

      <SettingsGroup
        label={`团队共享文件夹（${teamIncomingFolders.length + teamOwnedFolders.length}）`}
        actions={
          <button type="button" onClick={() => onSelect({ kind: "folders" })} className={`${COLLAB_BUTTON} text-[12px]`}>
            管理共享文件夹
          </button>
        }
      >
        <div className={cn(SIMPLE_CARD, "divide-y divide-hairline/40 p-0")}>
          {teamOwnedFolders.length > 0 && (
            <ul className="divide-y divide-hairline/40">
              {teamOwnedFolders.map(folder => {
                const grant = folder.grants.find(g => g.subject_type === "team" && g.subject_id === team.id);
                return (
                  <li key={folder.id} className="flex items-center justify-between gap-2 px-4 py-3 text-[13px]">
                    <span className="truncate font-medium text-ink">
                      {folder.name} <span className="text-[11px] font-normal text-ink-tertiary">（我共享的）</span>
                    </span>
                    <span className="shrink-0 rounded-full bg-ink/[0.06] px-2 py-0.5 text-[11px] text-ink-secondary">
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
      </SettingsGroup>

      <SettingsGroup
        label={`团队共享 Bot（${teamIncomingBots.length + teamOwnedBots.length}）`}
        actions={
          <button type="button" onClick={() => onSelect({ kind: "bots" })} className={`${COLLAB_BUTTON} text-[12px]`}>
            管理共享 Bot
          </button>
        }
      >
        <div className={cn(SIMPLE_CARD, "divide-y divide-hairline/40 p-0")}>
          {teamOwnedBots.length > 0 && (
            <ul className="divide-y divide-hairline/40">
              {teamOwnedBots.map(item => (
                <li key={item.id} className="flex items-center justify-between gap-2 px-4 py-3 text-[13px]">
                  <span className="truncate font-medium text-ink">
                    {item.name} <span className="text-[11px] font-normal text-ink-tertiary">（我共享的）</span>
                  </span>
                  <span className="shrink-0 text-[11px] text-ink-tertiary">
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
      </SettingsGroup>

      <SettingsGroup label={`团队成员与邀请（${members.length}）`}>
        <div className={cn(SIMPLE_CARD, "divide-y divide-hairline/40 p-0")}>
          <ul className="divide-y divide-hairline/40">
            {members.map(member => {
              const manageable = member.role !== "owner" && (team.role === "owner" || (team.role === "admin" && member.role === "member"));
              return (
                <li key={member.user_id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink/[0.06] text-[11px] font-medium text-ink">
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
            <div className="flex flex-col gap-3 p-4">
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
                  <label htmlFor={inviteInputId} className="flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary">
                    <Users size={13} aria-hidden="true" />邀请新成员加入「{team.name}」
                  </label>
                  <input
                    id={inviteInputId}
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
                    对方登录 <strong className="text-ink">{latestInvite.email}</strong> 后会立即收到通知，也可粘贴以下备用邀请码：
                  </p>
                  <CommandLine command={latestInvite.token} copyLabel="复制邀请码" />
                </div>
              )}

              {invitations.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <div className="text-[11px] font-medium text-ink-tertiary">待接受邀请（{invitations.length}）</div>
                  <ul className="divide-y divide-hairline/30 rounded-lg bg-app/60 ring-1 ring-inset ring-hairline/50">
                    {invitations.map(inv => (
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
      </SettingsGroup>
    </div>
  );
}
