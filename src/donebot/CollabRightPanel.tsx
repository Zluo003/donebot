import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  AlertCircle,
  Camera,
  Check,
  Loader2,
  LogOut,
  Mail,
  Pencil,
  RefreshCw,
  Tag,
  UserMinus,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { api } from "@/state/api";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { Card, ItemRow, NavRow, PageHeader, panelActionCls, roundButtonCls } from "@/components/bot-panel/rows";
import { imeComposing } from "@/lib/send-key";
import { cn } from "@/lib/cn";
import type {
  DoneBotCollabChatBot,
  DoneBotCollabGroup,
  DoneBotFriend,
  DoneBotSharedFolder,
} from "../../shared/donebot-collab";
import type { DoneBotTeamCommand, DoneBotTeamIdentity } from "../../shared/donebot-teams";
import {
  openCollabDialog,
  refreshCollabOverview,
  setCollabRightPanelOpen,
  setCollabSelection,
  useCollabStore,
} from "./collab-store";
import {
  cleanError,
  COLLAB_BUTTON,
  displayPersonName,
  personSecondaryLabel,
  TEAM_ROLE_PILL,
  TEAM_ROLES,
  type CollabOverview,
} from "./collab-types";
import { CollabAvatar, CollabTeamBadge, compressAvatarFile } from "./CollabAvatar";
import { CollabChatBotsPanel } from "./CollabChatBotsPanel";
import { CollabFolderBrowser } from "./CollabFolderBrowser";
import { CollabRightBotsTab, CollabRightFilesTab, CollabRightFoldersTab } from "./CollabRightResources";
import "./collab.css";

type RightTabId = "info" | "folders" | "bots" | "files";

export function CollabRightPanel({
  friend,
  team,
  group,
  chatBots = [],
  overview,
  filesRefreshKey,
  onReload,
}: {
  friend?: DoneBotFriend | null;
  team?: DoneBotTeamIdentity | null;
  group?: DoneBotCollabGroup | null;
  chatBots?: DoneBotCollabChatBot[];
  overview: CollabOverview;
  filesRefreshKey: number;
  onReload: () => Promise<void>;
}) {
  const { dragProps } = useCaptionChrome();
  const { refreshing } = useCollabStore();
  const [tab, setTab] = useState<RightTabId>("info");
  const [browsingFolderId, setBrowsingFolderId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const tabIdPrefix = useId();
  const entityKey = friend ? `friend:${friend.user_id}` : team ? `team:${team.id}` : group ? `group:${group.id}` : "";

  const isGroup = Boolean(group);

  useEffect(() => {
    setBrowsingFolderId(null);
    setEditingTitle(null);
    setError("");
    setNotice("");
    bodyRef.current?.scrollTo({ top: 0 });
  }, [entityKey]);

  useEffect(() => {
    if (isGroup) setTab(prev => (prev === "folders" ? "info" : prev));
  }, [isGroup]);

  const sharedTeamIds = useMemo(() => {
    const ids = new Set<string>();
    if (!friend) return ids;
    for (const item of overview.teams) {
      if ((overview.team_members[item.id] ?? []).some(m => m.user_id === friend.user_id)) ids.add(item.id);
    }
    return ids;
  }, [overview, friend]);

  const incomingFolders = useMemo(() => {
    if (friend) return overview.folders.shared_with_me.filter(f => f.owner_user_id === friend.user_id);
    if (team) return overview.folders.shared_with_me.filter(f => f.sources.some(s => s.kind === "team" && s.team_id === team.id));
    return [];
  }, [overview.folders.shared_with_me, friend, team]);

  const outgoingFolders = useMemo(() => {
    if (friend) {
      return overview.folders.owned.filter(f =>
        f.grants.some(g =>
          (g.subject_type === "user" && g.subject_id === String(friend.user_id))
          || (g.subject_type === "team" && sharedTeamIds.has(g.subject_id)),
        ),
      );
    }
    if (team) {
      return overview.folders.owned.filter(f =>
        f.grants.some(g => g.subject_type === "team" && g.subject_id === team.id),
      );
    }
    return [];
  }, [overview.folders.owned, friend, team, sharedTeamIds]);

  const incomingBots = useMemo(() => {
    if (friend) return overview.bots.shared_with_me.filter(b => b.owner_user_id === friend.user_id);
    if (team) return overview.bots.shared_with_me.filter(b => b.sources.some(s => s.kind === "team" && s.team_id === team.id));
    return [];
  }, [overview.bots.shared_with_me, friend, team]);

  const outgoingBots = useMemo(() => {
    if (friend) {
      return overview.bots.owned.filter(b =>
        b.grants.some(g =>
          (g.subject_type === "user" && g.subject_id === String(friend.user_id))
          || (g.subject_type === "team" && sharedTeamIds.has(g.subject_id)),
        ),
      );
    }
    if (team) {
      return overview.bots.owned.filter(b =>
        b.grants.some(g => g.subject_type === "team" && g.subject_id === team.id),
      );
    }
    return [];
  }, [overview.bots.owned, friend, team, sharedTeamIds]);

  const browsingFolder: DoneBotSharedFolder | null = useMemo(
    () => (browsingFolderId ? incomingFolders.find(f => f.id === browsingFolderId) ?? null : null),
    [browsingFolderId, incomingFolders],
  );

  const primaryTitle = friend ? displayPersonName(friend) : team ? team.name : (group?.name ?? "");
  const subtitle = friend
    ? personSecondaryLabel(friend) || friend.email
    : team
      ? `${overview.team_members[team.id]?.length ?? 0} 位成员 · ${TEAM_ROLES[team.role]}`
      : group
        ? `${group.members.length} 位好友成员`
        : "";
  const canEditTitle = Boolean(friend || (team && team.role !== "member") || group);
  const canEditAvatar = Boolean((team && team.role !== "member") || group);
  const currentBadgeAvatar = team?.avatar_url ?? group?.avatar_url ?? "";

  const tabs: ReadonlyArray<{ id: RightTabId; label: string }> = group
    ? [
      { id: "info", label: "成员" },
      { id: "bots", label: "Bot" },
      { id: "files", label: "文件" },
    ]
    : [
      { id: "info", label: team ? "成员" : "详情" },
      { id: "folders", label: "文件夹" },
      { id: "bots", label: "Bot" },
      { id: "files", label: "文件" },
    ];

  const updateGroupOrTeamAvatar = async (nextAvatarUrl: string) => {
    if (avatarBusy || !canEditAvatar) return;
    setAvatarBusy(true); setError(""); setNotice("");
    try {
      if (team) {
        await api(`/api/donebot/collab/teams/${team.id}/avatar`, {
          method: "PUT",
          body: JSON.stringify({ avatar_url: nextAvatarUrl }),
        });
        setNotice(nextAvatarUrl ? "团队头像已更新" : "已恢复团队默认图标");
      } else if (group) {
        await api(`/api/donebot/collab/groups/${group.id}/avatar`, {
          method: "PUT",
          body: JSON.stringify({ avatar_url: nextAvatarUrl }),
        });
        setNotice(nextAvatarUrl ? "群聊头像已更新" : "已恢复群聊默认图标");
      }
      await onReload();
    } catch (cause) {
      setError(cleanError(cause, "更新头像失败，请确认网关已升级至最新版本。"));
    } finally {
      setAvatarBusy(false);
    }
  };

  const handleAvatarFilePicked = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(""); setNotice("");
    try {
      const compressed = await compressAvatarFile(file);
      await updateGroupOrTeamAvatar(compressed);
    } catch (cause) {
      setError(cleanError(cause, "处理头像图片失败，请换一张图片重试。"));
    }
  };

  const commitTitle = async (raw: string) => {
    setEditingTitle(null);
    const clean = raw.trim();
    if (friend) {
      if (clean === (friend.remark ?? "").trim()) return;
      setBusy(true); setError(""); setNotice("");
      try {
        await api(`/api/donebot/collab/friends/${friend.user_id}/remark`, {
          method: "PUT",
          body: JSON.stringify({ remark: clean }),
        });
        setNotice(clean ? `备注已修改为「${clean}」` : "已恢复显示对方昵称或邮箱");
        await onReload();
      } catch (cause) {
        setError(cleanError(cause, "修改好友备注失败。"));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (team && clean && clean !== team.name) {
      setBusy(true); setError(""); setNotice("");
      try {
        await api("/api/donebot/teams", {
          method: "POST",
          body: JSON.stringify({
            action: "rename",
            account_id: overview.identity.account_id,
            team_id: team.id,
            name: clean,
          } satisfies DoneBotTeamCommand),
        });
        await onReload();
      } catch (cause) {
        setError(cleanError(cause, "修改团队名称失败。"));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (group && clean && clean !== group.name) {
      setBusy(true); setError(""); setNotice("");
      try {
        await api(`/api/donebot/collab/groups/${group.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name: clean }),
        });
        setNotice(`群名称已修改为「${clean}」`);
        await onReload();
      } catch (cause) {
        setError(cleanError(cause, "修改群聊名称失败。"));
      } finally {
        setBusy(false);
      }
    }
  };

  const onTitleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (imeComposing(e.nativeEvent)) { e.stopPropagation(); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (editingTitle !== null) void commitTitle(editingTitle);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setEditingTitle(null);
    }
  };

  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
    let nextIdx = -1;
    if (e.key === "ArrowRight") nextIdx = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = tabs.length - 1;
    if (nextIdx < 0) return;
    e.preventDefault();
    const target = tabs[nextIdx];
    if (target) {
      setTab(target.id);
      tabRefs.current[nextIdx]?.focus();
    }
  };

  const removeFriend = async () => {
    if (!friend || busy) return;
    if (!window.confirm(`删除好友 ${primaryTitle}？基于好友关系的共享文件夹和共享 Bot 权限将立即收回。`)) return;
    setBusy(true); setError("");
    try {
      await api(`/api/donebot/collab/friends/${friend.user_id}`, { method: "DELETE" });
      await onReload();
      setCollabSelection(null);
    } catch (cause) {
      setError(cleanError(cause));
    } finally {
      setBusy(false);
    }
  };

  const mutateTeamMember = async (command: DoneBotTeamCommand) => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await api("/api/donebot/teams", { method: "POST", body: JSON.stringify(command) });
      await onReload();
    } catch (cause) {
      setError(cleanError(cause));
    } finally {
      setBusy(false);
    }
  };

  const leaveTeam = async () => {
    if (!team || busy) return;
    if (!window.confirm(`确定退出团队「${team.name}」？退出后将失去该团队的共享文件夹和共享 Bot 权限。`)) return;
    setBusy(true); setError("");
    try {
      await api(`/api/donebot/collab/teams/${team.id}/leave`, { method: "POST", body: "{}" });
      await onReload();
      setCollabSelection(null);
    } catch (cause) {
      setError(cleanError(cause));
    } finally {
      setBusy(false);
    }
  };

  const leaveGroup = async () => {
    if (!group || busy) return;
    if (!window.confirm(`确定退出群聊「${group.name}」？你在本群添加的机器人也将自动移出。`)) return;
    setBusy(true); setError("");
    try {
      await api(`/api/donebot/collab/groups/${group.id}/leave`, { method: "POST", body: "{}" });
      await onReload();
      setCollabSelection(null);
    } catch (cause) {
      setError(cleanError(cause, "退出群聊失败。"));
    } finally {
      setBusy(false);
    }
  };

  const members = team ? (overview.team_members[team.id] ?? []) : [];
  const groupMembers = group?.members ?? [];
  const myUserId = Number(overview.identity.account_id);

  return (
    <aside
      data-collab-right-panel=""
      aria-label="协作详情侧栏"
      className="animate-sheet-in md:animate-panel-in absolute inset-0 z-40 flex h-full min-w-0 flex-col border-l-[0.5px] border-ink/[0.06] bg-app outline-none md:static md:z-auto md:w-[340px] md:shrink-0 lg:w-[360px]"
    >
      {/* Top action bar matching native BotPanel */}
      <div {...dragProps} className="flex h-[50px] shrink-0 items-start justify-end gap-2.5 px-[13px] pt-[13px]">
        {team && team.role !== "member" && (
          <button
            type="button"
            aria-label="邀请成员"
            title="邀请成员"
            onClick={() => openCollabDialog({ kind: "invite-team", teamId: team.id })}
            className={roundButtonCls}
          >
            <UserPlus size={15} className="pointer-events-none" aria-hidden="true" />
          </button>
        )}
        {group && (
          <button
            type="button"
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
          aria-label="刷新"
          title="刷新协作状态"
          disabled={refreshing}
          onClick={() => void refreshCollabOverview()}
          className={roundButtonCls}
        >
          <RefreshCw size={15} className={cn("pointer-events-none", refreshing && "animate-spin")} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="关闭右侧栏"
          title="关闭右侧栏"
          onClick={() => setCollabRightPanelOpen(false)}
          className={roundButtonCls}
        >
          <X size={16} className="pointer-events-none" aria-hidden="true" />
        </button>
      </div>

      {/* Scrollable body */}
      <div ref={bodyRef} className="@container relative min-h-0 flex-1 overflow-y-auto px-4 pb-7">
        {browsingFolder ? (
          <div data-collab-right-folder-browser={browsingFolder.id}>
            <PageHeader
              back="文件夹"
              title={browsingFolder.name}
              intro={`${displayPersonName({
                remark: browsingFolder.owner_remark,
                nickname: browsingFolder.owner_nickname,
                email: browsingFolder.owner_email,
              })} · ${browsingFolder.device_name}`}
              onBack={() => {
                setBrowsingFolderId(null);
                bodyRef.current?.scrollTo({ top: 0 });
              }}
            />
            <div className="mt-4">
              <CollabFolderBrowser folder={browsingFolder} compact />
            </div>
          </div>
        ) : (
          <>
            {/* Centered Hero matching native PanelHero */}
            <div className="mt-2 flex flex-col items-center text-center">
              {friend ? (
                <CollabAvatar
                  avatarUrl={friend.avatar_url}
                  remark={friend.remark}
                  nickname={friend.nickname}
                  email={friend.email}
                  size={64}
                  online={incomingFolders.some(f => f.online) ? true : undefined}
                />
              ) : (team || group) ? (
                <div className="relative flex flex-col items-center">
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    aria-label={team ? "上传团队头像" : "上传群聊头像"}
                    onChange={e => void handleAvatarFilePicked(e)}
                    className="sr-only"
                  />
                  {canEditAvatar ? (
                    <button
                      type="button"
                      data-collab-avatar-edit=""
                      disabled={avatarBusy}
                      aria-label={team ? "点击更换团队头像" : "点击更换群聊头像"}
                      title={team ? "点击更换团队头像" : "点击更换群聊头像"}
                      onClick={() => avatarInputRef.current?.click()}
                      className="group relative rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border"
                    >
                      <CollabTeamBadge name={primaryTitle} avatarUrl={currentBadgeAvatar} size={64} />
                      <span
                        aria-hidden="true"
                        className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/0 text-white opacity-0 transition-[opacity,background-color] group-hover:bg-black/45 group-hover:opacity-100 group-focus-visible:bg-black/45 group-focus-visible:opacity-100"
                      >
                        {avatarBusy ? <Loader2 size={20} className="animate-spin" /> : <Camera size={20} />}
                      </span>
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute left-1/2 top-[calc(100%+4px)] z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-hairline bg-menu px-[7px] py-0.5 text-[11.5px] text-ink opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        更换头像
                      </span>
                    </button>
                  ) : (
                    <CollabTeamBadge name={primaryTitle} avatarUrl={currentBadgeAvatar} size={64} />
                  )}
                </div>
              ) : null}

              <div className="mt-2.5 flex max-w-full items-center justify-center">
                {editingTitle !== null ? (
                  <input
                    autoFocus
                    data-collab-inline-title-input=""
                    aria-label={friend ? "修改好友备注" : team ? "修改团队名称" : "修改群聊名称"}
                    placeholder={friend ? "输入备注名（留空恢复昵称）" : team ? "输入团队名称" : "输入群聊名称"}
                    maxLength={friend ? 64 : 100}
                    value={editingTitle}
                    onChange={e => setEditingTitle(e.target.value)}
                    onKeyDown={onTitleKeyDown}
                    onBlur={() => void commitTitle(editingTitle)}
                    className="w-[220px] max-w-full rounded-lg border border-accent-border bg-inset px-2 py-[3px] text-center text-[17px] font-medium leading-6 text-ink outline-none placeholder:text-ink-tertiary"
                  />
                ) : canEditTitle ? (
                  <button
                    type="button"
                    data-collab-inline-title=""
                    title={friend ? "点击修改好友备注" : team ? "点击修改团队名称" : "点击修改群聊名称"}
                    onClick={() => setEditingTitle(friend ? (friend.remark ?? "") : (team?.name ?? group?.name ?? ""))}
                    className="group/name relative inline-flex max-w-full items-center rounded-[8px] px-1.5 text-[17px] font-medium leading-6 text-ink hover:bg-ink/[0.04]"
                  >
                    <span className="min-w-0 truncate">{primaryTitle}</span>
                    <Pencil
                      size={13}
                      aria-hidden="true"
                      className="absolute -right-4 shrink-0 text-ink-tertiary opacity-0 transition-opacity group-hover/name:opacity-100 group-focus-visible/name:opacity-100"
                    />
                  </button>
                ) : (
                  <h2 className="max-w-full truncate text-[17px] font-medium leading-6 text-ink">{primaryTitle}</h2>
                )}
              </div>

              {subtitle && subtitle !== primaryTitle && (
                <p className="mt-0.5 max-w-full truncate text-[13px] text-ink-secondary">{subtitle}</p>
              )}
              {canEditAvatar && currentBadgeAvatar && (
                <button
                  type="button"
                  disabled={avatarBusy}
                  onClick={() => void updateGroupOrTeamAvatar("")}
                  className="mt-1 text-[11px] text-ink-tertiary hover:text-danger"
                >
                  移除头像
                </button>
              )}
            </div>

            {/* Sticky rounded pill tab bar matching native PanelShell */}
            <div
              role="tablist"
              aria-label="协作详情分区"
              className="sticky top-0 z-[1] -mx-4 mt-[15px] flex justify-center bg-app px-4 pb-2.5 pt-1 after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-3 after:bg-linear-to-b after:from-app after:to-transparent"
            >
              <div className="flex min-w-0 gap-0.5 rounded-full bg-ink/[0.05] p-[3px]">
                {tabs.map((item, idx) => {
                  const selected = tab === item.id;
                  return (
                    <button
                      key={item.id}
                      ref={el => { tabRefs.current[idx] = el; }}
                      id={`${tabIdPrefix}-tab-${item.id}`}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      tabIndex={selected ? 0 : -1}
                      data-collab-right-tab={item.id}
                      onClick={() => setTab(item.id)}
                      onKeyDown={e => onTabKeyDown(e, idx)}
                      className={cn(
                        "donebot-collab-tab h-[26px] min-w-0 shrink truncate rounded-full px-3 text-[13px] leading-[18px] transition-colors",
                        selected ? "bg-ink/[0.1] font-medium text-ink" : "text-ink-secondary hover:text-ink",
                      )}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {error && (
              <div role="alert" className="mt-2 flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger/20">
                <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}
            {notice && (
              <div role="status" className="mt-2 flex items-start gap-2 rounded-xl bg-success/12 px-3 py-2 text-[12px] text-success ring-1 ring-inset ring-success/25">
                <Check size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>{notice}</span>
              </div>
            )}

            {/* Tab panels */}
            <div role="tabpanel" aria-labelledby={`${tabIdPrefix}-tab-info`} hidden={tab !== "info"}>
              {friend && (
                <div className="flex flex-col">
                  <Card label="好友资料">
                    <NavRow
                      icon={Tag}
                      title="备注名称"
                      value={friend.remark || "未设置"}
                      onClick={() => setEditingTitle(friend.remark ?? "")}
                    />
                    {friend.nickname && (
                      <ItemRow icon={Users} title="对方昵称" hint={friend.nickname} />
                    )}
                    <ItemRow icon={Mail} title="DoneBot 账号" hint={friend.email} />
                  </Card>

                  <Card label="共享概览">
                    <NavRow
                      title="共享文件夹"
                      value={`${incomingFolders.length + outgoingFolders.length} 个`}
                      onClick={() => setTab("folders")}
                    />
                    <NavRow
                      title="共享 Bot"
                      value={`${incomingBots.length + outgoingBots.length} 个`}
                      onClick={() => setTab("bots")}
                    />
                    <NavRow
                      title="聊天文件"
                      value="查看"
                      onClick={() => setTab("files")}
                    />
                  </Card>

                  <Card>
                    <NavRow
                      icon={UserMinus}
                      title="删除好友"
                      danger
                      drill={false}
                      disabled={busy}
                      onClick={() => void removeFriend()}
                    />
                  </Card>
                </div>
              )}

              {team && (
                <div className="flex flex-col">
                  {team.role !== "member" && (
                    <div className="mt-3 flex flex-col gap-0.5">
                      <button
                        type="button"
                        data-collab-right-invite-member=""
                        onClick={() => openCollabDialog({ kind: "invite-team", teamId: team.id })}
                        className={panelActionCls}
                      >
                        <UserPlus size={16} aria-hidden="true" />
                        <span>邀请团队成员</span>
                      </button>
                    </div>
                  )}

                  <Card label={`团队成员（${members.length}）`}>
                    {members.map(member => {
                      const name = displayPersonName(member);
                      const sub = personSecondaryLabel(member);
                      const manageable = member.role !== "owner"
                        && (team.role === "owner" || (team.role === "admin" && member.role === "member"));
                      return (
                        <div key={member.user_id} className="flex items-center gap-2.5 px-3.5 py-2.5">
                          <CollabAvatar
                            avatarUrl={member.avatar_url}
                            remark={member.remark}
                            nickname={member.nickname}
                            email={member.email}
                            size={32}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-[13.5px] font-medium text-ink">{name}</span>
                              <span className={cn("inline-flex shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset", TEAM_ROLE_PILL[member.role])}>
                                {TEAM_ROLES[member.role]}
                              </span>
                            </div>
                            {sub && <div className="truncate text-[11.5px] text-ink-tertiary">{sub}</div>}
                          </div>
                          {manageable && (
                            <div className="flex shrink-0 items-center gap-1">
                              {team.role === "owner" && (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void mutateTeamMember({
                                    action: "member-role",
                                    account_id: overview.identity.account_id,
                                    team_id: team.id,
                                    user_id: member.user_id,
                                    role: member.role === "admin" ? "member" : "admin",
                                  })}
                                  className={`${COLLAB_BUTTON} h-6 px-2 text-[11px]`}
                                >
                                  {member.role === "admin" ? "降为成员" : "设管理员"}
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                  if (!window.confirm(`将 ${name} 移出团队「${team.name}」？`)) return;
                                  void mutateTeamMember({
                                    action: "remove-member",
                                    account_id: overview.identity.account_id,
                                    team_id: team.id,
                                    user_id: member.user_id,
                                  });
                                }}
                                className="rounded-md px-1.5 py-1 text-[11px] text-ink-tertiary hover:bg-danger/10 hover:text-danger"
                              >
                                移除
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </Card>

                  {team.role !== "owner" && (
                    <Card>
                      <NavRow
                        icon={LogOut}
                        title="退出团队"
                        danger
                        drill={false}
                        disabled={busy}
                        onClick={() => void leaveTeam()}
                      />
                    </Card>
                  )}
                </div>
              )}

              {group && (
                <div className="flex flex-col">
                  <div className="mt-3 flex flex-col gap-0.5">
                    <button
                      type="button"
                      data-collab-right-add-group-member=""
                      onClick={() => openCollabDialog({ kind: "add-group-members", groupId: group.id })}
                      className={panelActionCls}
                    >
                      <UserPlus size={16} aria-hidden="true" />
                      <span>添加好友进群</span>
                    </button>
                  </div>

                  <Card label={`群聊成员（${groupMembers.length}）`}>
                    {groupMembers.map(member => {
                      const name = displayPersonName(member);
                      const sub = personSecondaryLabel(member);
                      const isCreator = member.user_id === group.creator_id;
                      return (
                        <div key={member.user_id} className="flex items-center gap-2.5 px-3.5 py-2.5">
                          <CollabAvatar
                            avatarUrl={member.avatar_url}
                            remark={member.remark}
                            nickname={member.nickname}
                            email={member.email}
                            size={32}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-[13.5px] font-medium text-ink">{name}</span>
                              {isCreator && (
                                <span className={cn("inline-flex shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset", TEAM_ROLE_PILL.owner)}>
                                  群主
                                </span>
                              )}
                            </div>
                            {sub && <div className="truncate text-[11.5px] text-ink-tertiary">{sub}</div>}
                          </div>
                        </div>
                      );
                    })}
                  </Card>

                  <Card>
                    <NavRow
                      icon={LogOut}
                      title="退出群聊"
                      danger
                      drill={false}
                      disabled={busy}
                      onClick={() => void leaveGroup()}
                    />
                  </Card>
                </div>
              )}
            </div>

            {!group && (
              <div role="tabpanel" aria-labelledby={`${tabIdPrefix}-tab-folders`} hidden={tab !== "folders"}>
                {(friend || team) && (
                  <CollabRightFoldersTab
                    subjectType={friend ? "user" : "team"}
                    subjectId={friend ? String(friend.user_id) : team!.id}
                    subjectLabel={primaryTitle}
                    incomingFolders={incomingFolders}
                    outgoingFolders={outgoingFolders}
                    overview={overview}
                    onReload={onReload}
                    onOpenFolder={folder => {
                      setBrowsingFolderId(folder.id);
                      bodyRef.current?.scrollTo({ top: 0 });
                    }}
                  />
                )}
              </div>
            )}

            <div role="tabpanel" aria-labelledby={`${tabIdPrefix}-tab-bots`} hidden={tab !== "bots"}>
              {team && (
                <CollabChatBotsPanel
                  scopeType="team"
                  targetId={team.id}
                  members={members}
                  chatBots={chatBots}
                  overview={overview}
                  canModerate={team.role !== "member"}
                  onReload={onReload}
                />
              )}
              {group && (
                <CollabChatBotsPanel
                  scopeType="group"
                  targetId={group.id}
                  members={groupMembers}
                  chatBots={chatBots}
                  overview={overview}
                  canModerate={group.creator_id === myUserId}
                  onReload={onReload}
                />
              )}
              {(friend || team) && (
                <CollabRightBotsTab
                  subjectType={friend ? "user" : "team"}
                  subjectId={friend ? String(friend.user_id) : team!.id}
                  subjectLabel={primaryTitle}
                  incomingBots={incomingBots}
                  outgoingBots={outgoingBots}
                  overview={overview}
                  onReload={onReload}
                />
              )}
            </div>

            <div role="tabpanel" aria-labelledby={`${tabIdPrefix}-tab-files`} hidden={tab !== "files"}>
              {(friend || team || group) && (
                <CollabRightFilesTab
                  scopeType={friend ? "friend" : team ? "team" : "group"}
                  targetId={friend ? String(friend.user_id) : team ? team.id : group!.id}
                  refreshKey={filesRefreshKey}
                />
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
