import { useCallback, useEffect, useId, useState } from "react";
import {
  AlertCircle,
  Bell,
  Bot,
  Check,
  FolderOpen,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  User,
  UserPlus,
  Users,
} from "lucide-react";
import { api } from "@/state/api";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { SETTINGS_INPUT, SettingsGroup, SIMPLE_CARD } from "@/components/SettingsPrimitives";
import { cn } from "@/lib/cn";
import {
  collabPendingCount,
  refreshCollabOverview,
  setCollabSelection,
  useCollabStore,
  type CollabSelection,
} from "./collab-store";
import { cleanError, COLLAB_BUTTON, TEAM_ROLE_PILL, TEAM_ROLES, type CollabOverview } from "./collab-types";
import { CollabFoldersTab } from "./CollabFoldersTab";
import { CollabBotsTab } from "./CollabBotsTab";
import { CollabContactsTab } from "./CollabContactsTab";
import { CollabFriendDetail, CollabTeamDetail } from "./CollabEntityDetail";

function CollabInboxSection({
  overview,
  onReload,
  onSelect,
}: {
  overview: CollabOverview;
  onReload: () => Promise<void>;
  onSelect: (target: CollabSelection) => void;
}) {
  const [friendEmail, setFriendEmail] = useState("");
  const [friendNote, setFriendNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const emailId = useId();

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
      setNotice(res?.status === "accepted" ? "对方也向你发送了申请，你们已成为好友！" : "好友申请已发送，对方客户端会收到实时提醒。");
      await onReload();
    });
  };

  const pending = collabPendingCount(overview);

  return (
    <div className="flex flex-col gap-6">
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

      <SettingsGroup label={`待处理的申请与邀请（${pending}）`}>
        <div className={cn(SIMPLE_CARD, "divide-y divide-hairline/40 p-0")}>
          {pending === 0 ? (
            <div className="px-4 py-6 text-center text-[13px] text-ink-secondary">
              暂时没有新的好友申请或团队邀请。
            </div>
          ) : (
            <>
              {overview.friends.incoming_requests.map(req => (
                <div key={req.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
                  <div className="flex min-w-0 flex-1 items-start gap-2.5">
                    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-danger/14 text-danger ring-1 ring-inset ring-danger/25">
                      <UserPlus size={14} aria-hidden="true" />
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
                <div key={inv.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
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
            </>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup
        label="添加好友或加入团队"
        actions={
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={() => onSelect({ kind: "contacts", focus: "create-team" })} className={`${COLLAB_BUTTON} text-[12px]`}>
              <Plus size={13} aria-hidden="true" />新建团队
            </button>
            <button type="button" onClick={() => onSelect({ kind: "contacts", focus: "accept-team" })} className={`${COLLAB_BUTTON} text-[12px]`}>
              <KeyRound size={13} aria-hidden="true" />邀请码加入
            </button>
          </div>
        }
      >
        <div className={cn(SIMPLE_CARD, "divide-y divide-hairline/40 p-0")}>
          <form onSubmit={sendFriend} className="flex flex-col gap-2.5 p-4">
            <label htmlFor={emailId} className="flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary">
              <UserPlus size={13} aria-hidden="true" />通过邮箱添加好友
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id={emailId}
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
                aria-label="好友申请附言"
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

          {overview.friends.outgoing_requests.length > 0 && (
            <div className="flex flex-col gap-2 bg-inset/50 px-4 py-3">
              <div className="text-[11px] font-medium text-ink-tertiary">
                已发送，等待对方确认（{overview.friends.outgoing_requests.length}）
              </div>
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
    </div>
  );
}

export function CollabWorkspacePage() {
  const { dragProps } = useCaptionChrome();
  const { overview, loaded, refreshing, error, selection } = useCollabStore();

  const reload = useCallback(async () => {
    await refreshCollabOverview();
  }, []);

  useEffect(() => {
    if (!loaded) void reload();
  }, [loaded, reload]);

  const activeFriend = selection.kind === "friend"
    ? overview?.friends.friends.find(f => f.user_id === selection.userId) ?? null
    : null;
  const activeTeam = selection.kind === "team"
    ? overview?.teams.find(t => t.id === selection.teamId) ?? null
    : null;

  let heading = "好友与团队";
  let Icon = Users;
  if (selection.kind === "inbox") { heading = "消息与申请"; Icon = Bell; }
  else if (selection.kind === "folders") { heading = "共享文件夹"; Icon = FolderOpen; }
  else if (selection.kind === "bots") { heading = "共享 Bot"; Icon = Bot; }
  else if (selection.kind === "friend" && activeFriend) { heading = activeFriend.email; Icon = User; }
  else if (selection.kind === "team" && activeTeam) { heading = activeTeam.name; Icon = Users; }

  return (
    <main data-collab-workspace="" className="flex min-w-0 flex-1 flex-col overflow-hidden bg-app text-ink">
      <header {...dragProps} className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline/40 px-6 py-4 max-md:pl-12">
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon size={18} className="shrink-0 text-ink-secondary" aria-hidden="true" />
          <h1 className="truncate text-[17px] font-semibold">{heading}</h1>
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={refreshing}
          aria-label="刷新协作数据"
          className={`${COLLAB_BUTTON} text-[12px]`}
        >
          <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} aria-hidden="true" />
          刷新
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-6 text-[13px]">
          {!loaded ? (
            <div className={cn(SIMPLE_CARD, "flex items-center gap-2 p-4 text-ink-secondary")}>
              <Loader2 size={15} className="animate-spin" aria-hidden="true" />
              <span role="status">正在加载好友与团队…</span>
            </div>
          ) : !overview ? (
            <div className={cn(SIMPLE_CARD, "flex flex-col gap-3 p-5")}>
              <div className="font-medium text-ink">远程协作暂未就绪</div>
              <p className="text-ink-secondary">
                通过网关与好友、团队成员共享本机文件夹和 Bot（无需团队云服务器）。请确认已登录 DoneBot 账号，且网关已升级至最新版本。
              </p>
              {error && (
                <div role="alert" className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span>{error}</span>
                </div>
              )}
              <div>
                <button type="button" onClick={() => void reload()} disabled={refreshing} className={`${COLLAB_BUTTON} text-[12px]`}>
                  <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} aria-hidden="true" />重试
                </button>
              </div>
            </div>
          ) : selection.kind === "inbox" ? (
            <CollabInboxSection overview={overview} onReload={reload} onSelect={setCollabSelection} />
          ) : selection.kind === "folders" ? (
            <CollabFoldersTab overview={overview} onReload={reload} />
          ) : selection.kind === "bots" ? (
            <CollabBotsTab overview={overview} onReload={reload} />
          ) : selection.kind === "friend" && activeFriend ? (
            <CollabFriendDetail friend={activeFriend} overview={overview} onReload={reload} onSelect={setCollabSelection} />
          ) : selection.kind === "team" && activeTeam ? (
            <CollabTeamDetail team={activeTeam} overview={overview} onReload={reload} onSelect={setCollabSelection} />
          ) : (
            <CollabContactsTab
              overview={overview}
              onReload={reload}
              initialFocus={selection.kind === "contacts" ? selection.focus : undefined}
            />
          )}
        </div>
      </div>
    </main>
  );
}
