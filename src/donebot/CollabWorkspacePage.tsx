import { useCallback, useEffect, useId, useRef, useState } from "react";
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
  Send,
  Sparkles,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { api } from "@/state/api";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { cn } from "@/lib/cn";
import type { DoneBotTeamCommand } from "../../shared/donebot-teams";
import {
  collabPendingCount,
  refreshCollabOverview,
  setCollabSelection,
  useCollabStore,
} from "./collab-store";
import {
  cleanError,
  COLLAB_BUTTON,
  COLLAB_CARD,
  COLLAB_HERO,
  COLLAB_INPUT,
  displayPersonName,
  TEAM_ROLE_PILL,
  TEAM_ROLES,
  type CollabOverview,
} from "./collab-types";
import { CollabAvatar, CollabTeamBadge } from "./CollabAvatar";
import { CollabFoldersTab } from "./CollabFoldersTab";
import { CollabBotsTab } from "./CollabBotsTab";
import { CollabContactsTab } from "./CollabContactsTab";
import { CollabFriendDetail, CollabTeamDetail } from "./CollabEntityDetail";

function CollabInboxSection({
  overview,
  onReload,
}: {
  overview: CollabOverview;
  onReload: () => Promise<void>;
}) {
  const [friendEmail, setFriendEmail] = useState("");
  const [friendNote, setFriendNote] = useState("");
  const [quickPanel, setQuickPanel] = useState<"create-team" | "join-team" | null>(null);
  const [teamName, setTeamName] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const createKey = useRef<{ name: string; key: string } | null>(null);
  const emailId = useId();
  const noteId = useId();
  const teamNameId = useId();
  const tokenId = useId();

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

  const submitTeamCommand = (command: DoneBotTeamCommand, successMsg: string) => {
    void runAction(async () => {
      await api("/api/donebot/teams", { method: "POST", body: JSON.stringify(command) });
      createKey.current = null;
      setTeamName("");
      setInviteToken("");
      setQuickPanel(null);
      setNotice(successMsg);
      await onReload();
    });
  };

  const pending = collabPendingCount(overview);

  return (
    <div className="flex flex-col gap-6">
      {/* Hero overview strip */}
      <section className={cn(COLLAB_HERO, "flex flex-wrap items-center justify-between gap-4 p-5")}>
        <div className="flex min-w-0 items-center gap-3.5">
          <span className={cn(
            "flex size-12 shrink-0 items-center justify-center rounded-2xl ring-1 ring-inset",
            pending > 0
              ? "bg-danger/15 text-danger ring-danger/25"
              : "bg-accent/14 text-accent-text ring-accent/25",
          )}>
            <Bell size={20} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold text-ink">
              {pending > 0 ? `你有 ${pending} 条待处理的协作提醒` : "所有好友申请与团队邀请均已处理"}
            </h2>
            <p className="mt-0.5 text-[12.5px] text-ink-secondary">
              {overview.friends.friends.length} 位好友 · {overview.teams.length} 个团队 · 无需云服务器，成员各自使用自己的算力
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setQuickPanel(curr => (curr === "create-team" ? null : "create-team"))}
            className={`${COLLAB_BUTTON} text-[12.5px]`}
          >
            <Plus size={14} aria-hidden="true" />新建团队
          </button>
          <button
            type="button"
            onClick={() => setQuickPanel(curr => (curr === "join-team" ? null : "join-team"))}
            className={`${COLLAB_BUTTON} text-[12.5px]`}
          >
            <KeyRound size={13} aria-hidden="true" />邀请码加入
          </button>
        </div>
      </section>

      {error && (
        <div role="alert" className="flex items-start gap-2.5 rounded-2xl bg-danger/10 px-4 py-3 text-[13px] text-danger ring-1 ring-inset ring-danger/20">
          <AlertCircle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span className="flex-1">{error}</span>
          <button type="button" aria-label="关闭错误" onClick={() => setError("")} className="text-danger/70 hover:text-danger">
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      {notice && (
        <div role="status" className="flex items-start gap-2.5 rounded-2xl bg-success/12 px-4 py-3 text-[13px] text-success ring-1 ring-inset ring-success/25">
          <Check size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span className="flex-1">{notice}</span>
          <button type="button" aria-label="关闭通知" onClick={() => setNotice("")} className="text-success/70 hover:text-success">
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Expandable quick team creation / invite code join */}
      {quickPanel === "create-team" && (
        <form
          onSubmit={e => {
            e.preventDefault();
            const clean = teamName.trim();
            if (!createKey.current || createKey.current.name !== clean) {
              createKey.current = { name: clean, key: crypto.randomUUID() };
            }
            submitTeamCommand(
              { action: "create", account_id: overview.identity.account_id, name: clean, key: createKey.current.key },
              `已创建团队「${clean}」，现在可以在左侧团队列表中邀请成员。`,
            );
          }}
          className={cn(COLLAB_CARD, "flex flex-col gap-3.5 p-5")}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-[14px] font-semibold text-ink">
              <Users size={16} className="text-accent-text" aria-hidden="true" />新建协作团队
            </div>
            <button type="button" aria-label="收起" onClick={() => setQuickPanel(null)} className="rounded-lg p-1 text-ink-tertiary hover:bg-ink/[0.06] hover:text-ink">
              <X size={15} aria-hidden="true" />
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={teamNameId} className="text-[12px] font-medium text-ink-secondary">团队名称</label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id={teamNameId}
                name="team_name"
                type="text"
                autoFocus
                required
                maxLength={100}
                placeholder="例如：产品研发组、内容设计团队"
                value={teamName}
                onChange={e => setTeamName(e.target.value)}
                disabled={busy}
                className={cn(COLLAB_INPUT, "flex-1")}
              />
              <button type="submit" disabled={busy || !teamName.trim()} className={`${COLLAB_BUTTON} ui-button-primary shrink-0 px-4`}>
                {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
                创建团队
              </button>
            </div>
          </div>
        </form>
      )}

      {quickPanel === "join-team" && (
        <form
          onSubmit={e => {
            e.preventDefault();
            submitTeamCommand(
              { action: "accept", account_id: overview.identity.account_id, token: inviteToken.trim() },
              "已成功加入团队！",
            );
          }}
          className={cn(COLLAB_CARD, "flex flex-col gap-3.5 p-5")}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-[14px] font-semibold text-ink">
              <KeyRound size={16} className="text-accent-text" aria-hidden="true" />通过邀请码加入团队
            </div>
            <button type="button" aria-label="收起" onClick={() => setQuickPanel(null)} className="rounded-lg p-1 text-ink-tertiary hover:bg-ink/[0.06] hover:text-ink">
              <X size={15} aria-hidden="true" />
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={tokenId} className="text-[12px] font-medium text-ink-secondary">43 位团队邀请码</label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id={tokenId}
                name="invite_token"
                type="text"
                autoFocus
                required
                maxLength={43}
                pattern="[A-Za-z0-9_-]{43}"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="粘贴团队管理员发给你的邀请码"
                value={inviteToken}
                onChange={e => setInviteToken(e.target.value)}
                disabled={busy}
                className={cn(COLLAB_INPUT, "flex-1 font-mono")}
              />
              <button
                type="submit"
                disabled={busy || !/^[A-Za-z0-9_-]{43}$/.test(inviteToken.trim())}
                className={`${COLLAB_BUTTON} ui-button-primary shrink-0 px-4`}
              >
                加入团队
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Pending incoming requests & invitations */}
      <section className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between px-1">
          <h3 className="text-[13px] font-semibold text-ink">待处理的申请与邀请（{pending}）</h3>
        </div>
        <div className={cn(COLLAB_CARD, "overflow-hidden divide-y divide-ink/[0.06]")}>
          {pending === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <span className="flex size-11 items-center justify-center rounded-2xl bg-ink/[0.05] text-ink-tertiary">
                <Sparkles size={18} aria-hidden="true" />
              </span>
              <div className="text-[13.5px] font-medium text-ink">暂时没有待处理提醒</div>
              <p className="max-w-sm text-[12px] text-ink-tertiary">
                有新好友申请或团队邀请时，这里和系统通知栏都会立即提醒你。
              </p>
            </div>
          ) : (
            <>
              {overview.friends.incoming_requests.map(req => {
                const senderName = displayPersonName({ nickname: req.requester_nickname, email: req.requester_email });
                return (
                  <div key={req.id} className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <CollabAvatar
                        avatarUrl={req.requester_avatar_url}
                        nickname={req.requester_nickname}
                        email={req.requester_email}
                        size={40}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5 text-[13.5px]">
                          <span className="font-semibold text-ink">{senderName}</span>
                          <span className="text-ink-secondary">请求添加你为好友</span>
                        </div>
                        {senderName !== req.requester_email && (
                          <div className="text-[11.5px] text-ink-tertiary">{req.requester_email}</div>
                        )}
                        {req.note && (
                          <p className="mt-1.5 inline-block rounded-lg bg-inset/80 px-2.5 py-1 text-[12px] text-ink-secondary ring-1 ring-inset ring-ink/[0.06]">
                            「{req.note}」
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        className={`${COLLAB_BUTTON} text-[12.5px]`}
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
                        className={`${COLLAB_BUTTON} ui-button-primary text-[12.5px]`}
                        onClick={() => void runAction(async () => {
                          await api(`/api/donebot/collab/friends/requests/${req.id}/accept`, { method: "POST", body: "{}" });
                          setNotice(`已添加 ${senderName} 为好友。`);
                          await onReload();
                        })}
                      >
                        <Check size={13} aria-hidden="true" />同意
                      </button>
                    </div>
                  </div>
                );
              })}

              {overview.incoming_team_invitations.map(inv => {
                const inviterName = displayPersonName({ nickname: inv.invited_by_nickname, email: inv.invited_by_email });
                return (
                  <div key={inv.id} className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <CollabTeamBadge name={inv.team_name} size={40} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-[13.5px]">
                          <span className="font-semibold text-ink">受邀加入「{inv.team_name}」</span>
                          <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium ring-1 ring-inset", TEAM_ROLE_PILL[inv.role])}>
                            {TEAM_ROLES[inv.role]}
                          </span>
                        </div>
                        <p className="mt-1 text-[12px] text-ink-secondary">
                          邀请人：{inviterName} · 有效期至 {new Date(inv.expires_at).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        className={`${COLLAB_BUTTON} text-[12.5px]`}
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
                        className={`${COLLAB_BUTTON} ui-button-primary text-[12.5px]`}
                        onClick={() => void runAction(async () => {
                          await api(`/api/donebot/collab/teams/invitations/${inv.id}/accept`, { method: "POST", body: "{}" });
                          setNotice(`已加入团队「${inv.team_name}」。`);
                          await onReload();
                        })}
                      >
                        <Check size={13} aria-hidden="true" />加入团队
                      </button>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </section>

      {/* Add friend card */}
      <section className="flex flex-col gap-2.5">
        <div className="px-1">
          <h3 className="text-[13px] font-semibold text-ink">添加新好友</h3>
        </div>
        <div className={cn(COLLAB_CARD, "overflow-hidden divide-y divide-ink/[0.06]")}>
          <form onSubmit={sendFriend} className="flex flex-col gap-3.5 p-5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1.3fr_1fr_auto] sm:items-end">
              <div className="flex flex-col gap-1.5">
                <label htmlFor={emailId} className="flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary">
                  <UserPlus size={13} aria-hidden="true" />对方 DoneBot 账号邮箱
                </label>
                <input
                  id={emailId}
                  name="friend_email"
                  type="email"
                  autoComplete="email"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  maxLength={254}
                  placeholder="name@example.com"
                  value={friendEmail}
                  onChange={e => setFriendEmail(e.target.value)}
                  className={COLLAB_INPUT}
                  disabled={busy}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={noteId} className="text-[12px] font-medium text-ink-secondary">
                  附言（选填）
                </label>
                <input
                  id={noteId}
                  name="friend_note"
                  type="text"
                  maxLength={200}
                  placeholder="打个招呼，说明来意"
                  value={friendNote}
                  onChange={e => setFriendNote(e.target.value)}
                  className={COLLAB_INPUT}
                  disabled={busy}
                />
              </div>
              <button
                type="submit"
                disabled={busy || !friendEmail.trim()}
                className={`${COLLAB_BUTTON} ui-button-primary h-[38px] shrink-0 px-4 text-[13px]`}
              >
                {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Send size={13} aria-hidden="true" />}
                发送申请
              </button>
            </div>
          </form>

          {overview.friends.outgoing_requests.length > 0 && (
            <div className="flex flex-col gap-2.5 bg-inset/45 px-5 py-3.5">
              <div className="text-[11.5px] font-medium text-ink-tertiary">
                已发送，等待对方确认（{overview.friends.outgoing_requests.length}）
              </div>
              <ul className="flex flex-col gap-2">
                {overview.friends.outgoing_requests.map(req => {
                  const target = displayPersonName({ nickname: req.recipient_nickname, email: req.recipient_email });
                  return (
                    <li key={req.id} className="flex items-center justify-between gap-3 text-[12.5px]">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <CollabAvatar
                          avatarUrl={req.recipient_avatar_url}
                          nickname={req.recipient_nickname}
                          email={req.recipient_email}
                          size={26}
                        />
                        <span className="truncate font-medium text-ink">{target}</span>
                        {target !== req.recipient_email && (
                          <span className="truncate text-[11.5px] text-ink-tertiary">{req.recipient_email}</span>
                        )}
                      </div>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void runAction(async () => {
                          await api(`/api/donebot/collab/friends/requests/${req.id}/reject`, { method: "POST", body: "{}" });
                          await onReload();
                        })}
                        className="shrink-0 rounded-lg px-2 py-1 text-[11.5px] text-ink-tertiary transition-colors hover:bg-danger/10 hover:text-danger"
                      >
                        撤回申请
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </section>
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
  let subtitle = "";
  let HeaderVisual: React.ReactNode = <Users size={18} className="shrink-0 text-accent-text" aria-hidden="true" />;
  if (selection.kind === "inbox") {
    heading = "消息与申请";
    subtitle = "好友申请与团队邀请实时同步";
    HeaderVisual = <Bell size={18} className="shrink-0 text-accent-text" aria-hidden="true" />;
  } else if (selection.kind === "folders") {
    heading = "共享文件夹";
    subtitle = "本机硬盘直连协作 · 支持最大 100 MB 文件实时读写";
    HeaderVisual = <FolderOpen size={18} className="shrink-0 text-[#4CC98C]" aria-hidden="true" />;
  } else if (selection.kind === "bots") {
    heading = "共享 Bot";
    subtitle = "共享人设与技能模板 · 自动剥离记忆与密钥";
    HeaderVisual = <Bot size={18} className="shrink-0 text-accent-text" aria-hidden="true" />;
  } else if (selection.kind === "friend" && activeFriend) {
    heading = displayPersonName(activeFriend);
    subtitle = activeFriend.email;
    HeaderVisual = (
      <CollabAvatar
        avatarUrl={activeFriend.avatar_url}
        remark={activeFriend.remark}
        nickname={activeFriend.nickname}
        email={activeFriend.email}
        size={28}
      />
    );
  } else if (selection.kind === "team" && activeTeam) {
    heading = activeTeam.name;
    subtitle = `${overview?.team_members[activeTeam.id]?.length ?? 0} 位成员`;
    HeaderVisual = <CollabTeamBadge name={activeTeam.name} size={28} />;
  }

  return (
    <main data-collab-workspace="" className="flex min-w-0 flex-1 flex-col overflow-hidden bg-app text-ink">
      <header {...dragProps} className="flex shrink-0 items-center justify-between gap-3 border-b border-ink/[0.06] bg-app/80 px-6 py-3.5 backdrop-blur-sm max-md:pl-12">
        <div className="flex min-w-0 items-center gap-3">
          {HeaderVisual}
          <div className="min-w-0">
            <h1 className="truncate text-[16px] font-semibold leading-tight">{heading}</h1>
            {subtitle && heading !== subtitle && (
              <p className="truncate text-[11.5px] text-ink-tertiary">{subtitle}</p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={refreshing}
          aria-label="刷新协作数据"
          className={`${COLLAB_BUTTON} h-8 px-3 text-[12px]`}
        >
          <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} aria-hidden="true" />
          刷新
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-6 text-[13px]">
          {!loaded ? (
            <div className={cn(COLLAB_CARD, "flex items-center gap-2.5 p-5 text-ink-secondary")}>
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              <span role="status">正在加载好友与团队…</span>
            </div>
          ) : !overview ? (
            <div className={cn(COLLAB_CARD, "flex flex-col gap-3 p-6")}>
              <div className="text-[15px] font-semibold text-ink">协作服务暂未就绪</div>
              <p className="text-ink-secondary">
                通过网关与好友、团队成员共享本机文件夹（最大 100 MB）和 Bot（无需云服务器）。请确认已登录 DoneBot 账号，且网关已升级至最新版本。
              </p>
              {error && (
                <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3.5 py-2.5 text-[12px] text-danger">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span>{error}</span>
                </div>
              )}
              <div>
                <button type="button" onClick={() => void reload()} disabled={refreshing} className={`${COLLAB_BUTTON} text-[12px]`}>
                  <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} aria-hidden="true" />重新连接
                </button>
              </div>
            </div>
          ) : selection.kind === "inbox" ? (
            <CollabInboxSection overview={overview} onReload={reload} />
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
