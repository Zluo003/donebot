import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertCircle, Check, KeyRound, Loader2, Plus, RefreshCw, UserPlus, Users } from "lucide-react";
import { CommandLine, SETTINGS_INPUT, SettingsGroup, SIMPLE_CARD } from "@/components/SettingsPrimitives";
import { api } from "@/state/api";
import { cn } from "@/lib/cn";
import { DONEBOT_TEAMS_PROTOCOL, type DoneBotTeamCommand, type DoneBotTeamIdentity, type DoneBotTeamInvitation, type DoneBotTeamMember, type DoneBotTeamRole, type DoneBotWorkspaceSnapshot } from "../../shared/donebot-teams";
import { TeamCloudCard } from "./TeamCloudCard";
import { TeamDevicesCard } from "./TeamDevicesCard";

const button = "ui-button inline-flex items-center justify-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50";
const problem = (error: unknown) => error instanceof Error ? error.message : "团队请求未完成，请重试。";
const roles: Record<DoneBotTeamRole, string> = { owner: "所有者", admin: "管理员", member: "成员" };
const rolePill: Record<DoneBotTeamRole, string> = {
  owner: "bg-accent/14 text-accent-text ring-accent/25",
  admin: "bg-ink/[0.08] text-ink ring-ink/15",
  member: "bg-ink/[0.05] text-ink-secondary ring-ink/10",
};

function initialGlyph(label: string): string {
  const clean = label.trim();
  return clean ? Array.from(clean)[0]!.toUpperCase() : "T";
}

export function DoneBotTeams({ standalone = false }: { standalone?: boolean }) {
  const [snapshot, setSnapshot] = useState<DoneBotWorkspaceSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState("");
  const [members, setMembers] = useState<DoneBotTeamMember[]>([]);
  const [panel, setPanel] = useState<"create" | "accept" | null>(null);
  const [name, setName] = useState(""), [token, setToken] = useState(""), [email, setEmail] = useState("");
  const [invite, setInvite] = useState<DoneBotTeamInvitation | null>(null);
  const [busy, setBusy] = useState(false), [refreshing, setRefreshing] = useState(false), [error, setError] = useState("");
  const createInputId = useId(), acceptInputId = useId(), inviteInputId = useId();
  const generation = useRef(0), memberGeneration = useRef(0), sending = useRef(false);
  const mounted = useRef(true);
  const createKey = useRef<{ name: string; key: string } | null>(null);

  const refresh = useCallback(async (preferTeamId?: string) => {
    const mine = ++generation.current;
    setRefreshing(true);
    try {
      const next = await api<DoneBotWorkspaceSnapshot>("/api/donebot/workspaces");
      if (generation.current !== mine) return;
      if (next?.protocol !== DONEBOT_TEAMS_PROTOCOL || typeof next.account_id !== "string" || !Array.isArray(next.capabilities) || !Array.isArray(next.workspaces)) {
        setSnapshot(null); setSelected(""); return;
      }
      setSnapshot(next);
      setSelected(current => {
        if (preferTeamId && next.workspaces.some(team => team.id === preferTeamId)) return preferTeamId;
        if (current && next.workspaces.some(team => team.id === current)) return current;
        return next.workspaces[0]?.id ?? "";
      });
    } finally {
      if (generation.current === mine) { setLoaded(true); setRefreshing(false); }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh().catch(cause => { if (mounted.current) setError(problem(cause)); });
    return () => { mounted.current = false; generation.current++; memberGeneration.current++; };
  }, [refresh]);

  useEffect(() => {
    const mine = ++memberGeneration.current; setMembers([]); setInvite(null);
    if (selected) void api<DoneBotTeamMember[]>(`/api/donebot/teams/${selected}/members`).then(next => {
      if (mine === memberGeneration.current) setMembers(next);
    }).catch(cause => { if (mine === memberGeneration.current) setError(problem(cause)); });
    return () => { memberGeneration.current++; };
  }, [selected, snapshot]);

  const mutate = async (command: DoneBotTeamCommand) => {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError("");
    const mine = generation.current, selection = memberGeneration.current;
    try {
      const result = await api<unknown>("/api/donebot/teams", { method: "POST", body: JSON.stringify(command) });
      if (generation.current !== mine) return;
      if (command.action === "invite" && memberGeneration.current === selection) { setInvite(result as DoneBotTeamInvitation); setEmail(""); }
      if (command.action === "accept") { setToken(""); setPanel(null); }
      if (command.action === "create") { createKey.current = null; setName(""); setPanel(null); }
      if (command.action !== "invite" && command.action !== "revoke-invitation") {
        const nextTeamId = (command.action === "create" || command.action === "accept") && result && typeof result === "object" && "id" in result
          ? String((result as DoneBotTeamIdentity).id) : undefined;
        await refresh(nextTeamId);
      }
      if (command.action === "revoke-invitation") setInvite(null);
    } catch (cause) { if (generation.current === mine) setError(problem(cause)); }
    finally { sending.current = false; if (mounted.current) setBusy(false); }
  };

  if (!snapshot?.capabilities.includes("identity")) {
    if (!standalone) return null;
    if (!loaded) {
      return <div data-donebot-teams className={cn(SIMPLE_CARD, "flex items-center gap-2 p-4 text-[13px] text-ink-secondary")}>
        <Loader2 size={15} aria-hidden="true" className="animate-spin" />
        <span role="status">正在加载团队信息…</span>
      </div>;
    }
    return <div data-donebot-teams className={cn(SIMPLE_CARD, "flex flex-col gap-2 p-5 text-[13px]")}>
      <div className="flex items-center gap-2 font-medium text-ink"><Users size={16} aria-hidden="true" />团队协作暂未开放</div>
      <p className="text-ink-secondary">当前网关未启用团队协作能力，个人工作空间和个人云服务器不受影响。</p>
      {error && <p role="alert" className="text-danger">{error}</p>}
    </div>;
  }

  const team = snapshot.workspaces.find(item => item.id === selected) ?? null;

  return <div data-donebot-teams className="flex w-full flex-col gap-5 text-[13px] text-ink">
    <SettingsGroup
      label={snapshot.workspaces.length > 0 ? `我的团队（${snapshot.workspaces.length}）` : "我的团队"}
      actions={
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className={`${button} text-[12px]`}
            aria-expanded={panel === "create"}
            disabled={busy}
            onClick={() => { setError(""); setPanel(current => current === "create" ? null : "create"); }}
          >
            <Plus size={13} aria-hidden="true" />新建团队
          </button>
          <button
            type="button"
            className={`${button} text-[12px]`}
            aria-expanded={panel === "accept"}
            disabled={busy}
            onClick={() => { setError(""); setPanel(current => current === "accept" ? null : "accept"); }}
          >
            <KeyRound size={13} aria-hidden="true" />接受邀请
          </button>
          <button
            type="button"
            className={`${button} text-[12px]`}
            disabled={busy || refreshing}
            aria-label="刷新团队"
            title="刷新团队"
            onClick={() => void refresh().catch(cause => { if (mounted.current) setError(problem(cause)); })}
          >
            <RefreshCw size={13} aria-hidden="true" className={refreshing ? "animate-spin" : ""} />
          </button>
        </div>
      }
      footnote="个人资料保持独立。团队使用独立工作空间，共享内容由团队 Cloud 保存。"
    >
      <div className={cn(SIMPLE_CARD, "flex flex-col gap-3 p-4")}>
        {snapshot.workspaces.length > 0 ? (
          <div role="group" aria-label="已创建的团队" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {snapshot.workspaces.map(item => {
              const active = item.id === selected;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-team-item={item.id}
                  aria-pressed={active}
                  disabled={busy}
                  onClick={() => { setSelected(item.id); setError(""); }}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-xl px-3.5 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50",
                    active
                      ? "bg-ink/[0.08] ring-1 ring-inset ring-ink/30"
                      : "bg-inset/70 ring-1 ring-inset ring-ink/[0.07] hover:bg-ink/[0.05]",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex size-9 shrink-0 items-center justify-center rounded-xl text-[14px] font-semibold ring-1 ring-inset",
                      active ? "bg-ink text-app ring-transparent" : "bg-ink/[0.06] text-ink ring-ink/[0.08]",
                    )}
                  >
                    {initialGlyph(item.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium leading-5 text-ink">{item.name}</span>
                    <span className="mt-1 inline-flex items-center gap-1.5">
                      <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", rolePill[item.role])}>
                        {roles[item.role]}
                      </span>
                    </span>
                  </span>
                  {active && <Check size={15} aria-hidden="true" className="shrink-0 text-ink" />}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 rounded-xl bg-inset/60 px-4 py-6 text-center">
            <div className="flex size-10 items-center justify-center rounded-xl bg-ink/[0.06] text-ink-secondary ring-1 ring-inset ring-ink/[0.08]">
              <Users size={18} aria-hidden="true" />
            </div>
            <p className="text-[14px] font-medium text-ink">还没有创建或加入团队</p>
            <p className="max-w-sm text-[12px] leading-relaxed text-ink-secondary">
              创建一个团队与成员共享团队 Cloud 和机器人，或者输入团队管理员发来的邀请码加入现有团队。
            </p>
          </div>
        )}

        {panel === "create" && (
          <form
            className="flex flex-col gap-3 rounded-xl bg-inset p-3.5 ring-1 ring-inset ring-hairline/70"
            onSubmit={event => {
              event.preventDefault();
              const clean = name.trim();
              if (!createKey.current || createKey.current.name !== clean) createKey.current = { name: clean, key: crypto.randomUUID() };
              void mutate({ action: "create", account_id: snapshot.account_id, name: clean, key: createKey.current.key });
            }}
          >
            <div className="flex flex-col gap-1.5">
              <label htmlFor={createInputId} className="text-[13px] font-medium text-ink">新建团队</label>
              <input
                id={createInputId}
                aria-label="团队名称"
                placeholder="输入团队名称，例如：产品研发组"
                className={SETTINGS_INPUT}
                value={name}
                onChange={event => setName(event.target.value)}
                maxLength={100}
                required
                disabled={busy}
              />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className={button} disabled={busy} onClick={() => setPanel(null)}>取消</button>
              <button type="submit" disabled={busy || !name.trim()} className={`${button} ui-button-primary`}>创建团队</button>
            </div>
          </form>
        )}

        {panel === "accept" && (
          <form
            className="flex flex-col gap-3 rounded-xl bg-inset p-3.5 ring-1 ring-inset ring-hairline/70"
            onSubmit={event => {
              event.preventDefault();
              void mutate({ action: "accept", account_id: snapshot.account_id, token: token.trim() });
            }}
          >
            <div className="flex flex-col gap-1.5">
              <label htmlFor={acceptInputId} className="text-[13px] font-medium text-ink">接受邀请</label>
              <input
                id={acceptInputId}
                aria-label="接受邀请码"
                placeholder="粘贴 43 位团队邀请码"
                className={`${SETTINGS_INPUT} font-mono`}
                autoComplete="off"
                value={token}
                onChange={event => setToken(event.target.value)}
                maxLength={43}
                pattern="[A-Za-z0-9_-]{43}"
                required
                disabled={busy}
              />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className={button} disabled={busy} onClick={() => setPanel(null)}>取消</button>
              <button type="submit" disabled={busy || !/^[A-Za-z0-9_-]{43}$/.test(token.trim())} className={`${button} ui-button-primary`}>加入团队</button>
            </div>
          </form>
        )}
      </div>
    </SettingsGroup>

    {error && (
      <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3.5 py-2.5 text-[13px] text-danger ring-1 ring-inset ring-danger/20">
        <AlertCircle size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span>{error}</span>
      </div>
    )}

    {team && (
      <div className="flex flex-col gap-5">
        {snapshot.capabilities.includes("cloud_access") ? (
          <TeamCloudCard key={`cloud-${team.id}`} accountId={snapshot.account_id} team={team} />
        ) : (
          <div className={cn(SIMPLE_CARD, "px-4 py-3.5 text-[13px] text-ink-secondary")}>
            协作运行服务尚未就绪，当前可管理团队和成员。
          </div>
        )}

        {snapshot.capabilities.includes("local_execution") && (
          <TeamDevicesCard key={`devices-${team.id}`} accountId={snapshot.account_id} team={team} members={members} />
        )}

        <SettingsGroup label={members.length > 0 ? `团队成员（${members.length}）` : "团队成员"}>
          <div className={cn(SIMPLE_CARD, "divide-y divide-hairline/40 py-0")}>
            {members.length > 0 ? (
              <ul className="divide-y divide-hairline/40">
                {members.map(member => {
                  const manageable = member.role !== "owner" && (team.role === "owner" || (team.role === "admin" && member.role === "member"));
                  return (
                    <li key={member.user_id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <span
                          aria-hidden="true"
                          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink/[0.06] text-[12px] font-medium text-ink ring-1 ring-inset ring-ink/[0.08]"
                        >
                          {initialGlyph(member.email)}
                        </span>
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="break-all text-[13px] font-medium text-ink">{member.email}</span>
                          <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", rolePill[member.role])}>
                            {roles[member.role]}
                          </span>
                        </div>
                      </div>
                      {manageable && (
                        <div className="flex shrink-0 flex-wrap gap-2">
                          {team.role === "owner" && (
                            <button
                              type="button"
                              disabled={busy}
                              className={`${button} text-[12px]`}
                              onClick={() => void mutate({ action: "member-role", account_id: snapshot.account_id, team_id: team.id, user_id: member.user_id, role: member.role === "admin" ? "member" : "admin" })}
                            >
                              {member.role === "admin" ? "设为成员" : "设为管理员"}
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busy}
                            className={`${button} text-[12px]`}
                            onClick={() => {
                              if (window.confirm(`移除 ${member.email}？后续团队访问将停止，共享成果保留，已下载的文件无法远程收回。`)) {
                                void mutate({ action: "remove-member", account_id: snapshot.account_id, team_id: team.id, user_id: member.user_id });
                              }
                            }}
                          >
                            移除成员
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-4 py-3.5 text-[12px] text-ink-secondary">正在加载成员列表…</p>
            )}

            {team.role !== "member" && (
              <div className="flex flex-col gap-3 p-4">
                <form
                  className="flex flex-col gap-2 sm:flex-row sm:items-end"
                  onSubmit={event => {
                    event.preventDefault();
                    void mutate({ action: "invite", account_id: snapshot.account_id, team_id: team.id, email, role: "member" });
                  }}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <label htmlFor={inviteInputId} className="flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary">
                      <UserPlus size={13} aria-hidden="true" />邀请成员加入「{team.name}」
                    </label>
                    <input
                      id={inviteInputId}
                      className={SETTINGS_INPUT}
                      aria-label="成员邮箱"
                      placeholder="输入对方 DoneBot 账号邮箱"
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={event => setEmail(event.target.value)}
                      required
                      maxLength={254}
                      disabled={busy}
                    />
                  </div>
                  <button type="submit" disabled={busy || !email.trim()} className={`${button} ui-button-primary shrink-0`}>
                    生成邀请
                  </button>
                </form>

                {invite && (
                  <div className="flex flex-col gap-2.5 rounded-xl bg-inset p-3.5 ring-1 ring-inset ring-hairline/70">
                    <p className="text-[12px] leading-relaxed text-ink-secondary">
                      将邀请码发给 <span className="font-medium text-ink">{invite.email}</span>，对方登录该邮箱的 DoneBot 账号后在「团队协作 → 接受邀请」中输入即可加入。有效期至 {new Date(invite.expires_at).toLocaleString()}。
                    </p>
                    <CommandLine command={invite.token} copyLabel="复制邀请码" />
                    <div className="flex justify-end">
                      <button
                        type="button"
                        className={`${button} text-[12px]`}
                        disabled={busy}
                        onClick={() => void mutate({ action: "revoke-invitation", account_id: snapshot.account_id, team_id: team.id, invitation_id: invite.id })}
                      >
                        撤销邀请
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </SettingsGroup>
      </div>
    )}
  </div>;
}
