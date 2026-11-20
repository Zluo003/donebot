import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/SettingsPrimitives";
import { api } from "@/state/api";
import type { DoneBotTeamCommand, DoneBotTeamInvitation, DoneBotTeamMember, DoneBotWorkspaceSnapshot } from "../../shared/donebot-teams";

const button = "ui-button disabled:opacity-50";
const field = "w-full rounded-lg border border-line bg-app px-3 py-2 text-sm text-ink";
const problem = (error: unknown) => error instanceof Error ? error.message : "团队请求未完成，请重试。";
const roles = { owner: "所有者", admin: "管理员", member: "成员" };

export function DoneBotTeams() {
  const [snapshot, setSnapshot] = useState<DoneBotWorkspaceSnapshot | null>(null);
  const [selected, setSelected] = useState("");
  const [members, setMembers] = useState<DoneBotTeamMember[]>([]);
  const [name, setName] = useState(""), [token, setToken] = useState(""), [email, setEmail] = useState("");
  const [invite, setInvite] = useState<DoneBotTeamInvitation | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const generation = useRef(0), memberGeneration = useRef(0), sending = useRef(false);
  const mounted = useRef(true);
  const createKey = useRef<{ name: string; key: string } | null>(null);
  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    const next = await api<DoneBotWorkspaceSnapshot>("/api/donebot/workspaces");
    if (generation.current === mine) {
      setSnapshot(next); setSelected(current => next.workspaces.some(team => team.id === current) ? current : "");
    }
  }, []);
  useEffect(() => { mounted.current = true; void refresh().catch(cause => { if (mounted.current) setError(problem(cause)); }); return () => { mounted.current = false; generation.current++; memberGeneration.current++; }; }, [refresh]);
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
      if (command.action === "invite" && memberGeneration.current === selection) setInvite(result as DoneBotTeamInvitation);
      if (command.action === "accept") setToken("");
      if (command.action === "create") { createKey.current = null; setName(""); }
      if (command.action !== "invite" && command.action !== "revoke-invitation") await refresh();
      if (command.action === "revoke-invitation") setInvite(null);
    } catch (cause) { if (generation.current === mine) setError(problem(cause)); }
    finally { sending.current = false; if (mounted.current) setBusy(false); }
  };
  const team = snapshot?.workspaces.find(item => item.id === selected);
  if (!snapshot?.capabilities.includes("identity")) return null;
  return <Card title="团队" subtitle="个人资料保持独立。团队使用独立工作空间，共享内容由团队 Cloud 保存。">
    <div className="flex flex-col gap-4 text-sm text-ink">
      <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy} onClick={() => void refresh().catch(cause => { if (mounted.current) setError(problem(cause)); })}>刷新团队</button></div>
      {snapshot.workspaces.length > 0 && <label className="flex flex-col gap-2">团队工作空间<select aria-label="团队工作空间" value={selected} disabled={busy} className={field} onChange={event => { setSelected(event.target.value); setError(""); }}><option value="">选择团队</option>{snapshot.workspaces.map(item => <option key={item.id} value={item.id}>{item.name} · {roles[item.role]}</option>)}</select></label>}
      {team && <div className="flex flex-col gap-3">
        <p className="text-ink-secondary">协作运行服务尚未就绪，当前可管理团队和成员。</p>
        <ul className="divide-y divide-line">{members.map(member => <li key={member.user_id} className="flex flex-wrap items-center justify-between gap-2 py-2"><span className="break-all">{member.email} · {roles[member.role]}</span>{member.role !== "owner" && (team.role === "owner" || team.role === "admin" && member.role === "member") && <div className="flex gap-2">
          {team.role === "owner" && <button type="button" disabled={busy} className={button} onClick={() => void mutate({ action: "member-role", account_id: snapshot.account_id, team_id: team.id, user_id: member.user_id, role: member.role === "admin" ? "member" : "admin" })}>{member.role === "admin" ? "设为成员" : "设为管理员"}</button>}
          <button type="button" disabled={busy} className={button} onClick={() => { if (window.confirm(`移除 ${member.email}？后续团队访问将停止，共享成果保留，已下载的文件无法远程收回。`)) void mutate({ action: "remove-member", account_id: snapshot.account_id, team_id: team.id, user_id: member.user_id }); }}>移除成员</button>
        </div>}</li>)}</ul>
        {team.role !== "member" && <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); void mutate({ action: "invite", account_id: snapshot.account_id, team_id: team.id, email, role: "member" }); }}><label>邀请成员<input className={field} aria-label="成员邮箱" type="email" value={email} onChange={event => setEmail(event.target.value)} required maxLength={254} disabled={busy} /></label><button type="submit" disabled={busy || !email.trim()} className={button}>生成邀请</button></form>}
        {invite && <div className="flex flex-col gap-2 rounded-lg border border-line p-3"><p>将邀请码发给 {invite.email}，对方登录该邮箱的 DoneBot 账号后接受邀请。有效期至 {new Date(invite.expires_at).toLocaleString()}。</p><input aria-label="邀请码" readOnly value={invite.token} className={field} onFocus={event => event.target.select()} /><button type="button" className={button} disabled={busy} onClick={() => void mutate({ action: "revoke-invitation", account_id: snapshot.account_id, team_id: team!.id, invitation_id: invite.id })}>撤销邀请</button></div>}
      </div>}
      <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); const clean = name.trim(); if (!createKey.current || createKey.current.name !== clean) createKey.current = { name: clean, key: crypto.randomUUID() }; void mutate({ action: "create", account_id: snapshot.account_id, name: clean, key: createKey.current.key }); }}><label>新建团队<input aria-label="团队名称" className={field} value={name} onChange={event => setName(event.target.value)} maxLength={100} required disabled={busy} /></label><button type="submit" disabled={busy || !name.trim()} className={button}>创建团队</button></form>
      <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); void mutate({ action: "accept", account_id: snapshot.account_id, token: token.trim() }); }}><label>接受邀请<input aria-label="接受邀请码" className={field} autoComplete="off" value={token} onChange={event => setToken(event.target.value)} maxLength={43} pattern="[A-Za-z0-9_-]{43}" required disabled={busy} /></label><button type="submit" disabled={busy || !/^[A-Za-z0-9_-]{43}$/.test(token.trim())} className={button}>加入团队</button></form>
      {error && <p role="alert" className="text-danger">{error}</p>}
    </div>
  </Card>;
}
