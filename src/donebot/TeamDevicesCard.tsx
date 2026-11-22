import { useCallback, useEffect, useRef, useState } from "react";
import { Laptop } from "lucide-react";
import { api } from "@/state/api";
import type { DoneBotTeamDevice, DoneBotTeamDevicesSnapshot, DoneBotTeamIdentity, DoneBotTeamMember } from "../../shared/donebot-teams";

const button = "ui-button inline-flex items-center gap-2 disabled:opacity-50";
const problem = (cause: unknown) => cause instanceof Error ? cause.message : "团队设备操作未完成，请重试。";

export function TeamDevicesCard({ accountId, team, members = [] }: { accountId: string; team: DoneBotTeamIdentity; members?: DoneBotTeamMember[] }) {
  const [snapshot, setSnapshot] = useState<DoneBotTeamDevicesSnapshot | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const generation = useRef(0), alive = useRef(true);

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = await api<DoneBotTeamDevicesSnapshot>(`/api/donebot/teams/${team.id}/devices`);
      if (generation.current === mine) { setSnapshot(next); setError(""); }
    } catch (cause) {
      if (generation.current === mine) setError(problem(cause));
    }
  }, [team.id]);

  useEffect(() => {
    alive.current = true; setSnapshot(null); setError("");
    void refresh();
    return () => { alive.current = false; generation.current++; };
  }, [refresh]);

  const localDevice = snapshot?.devices.find(device =>
    String(device.user_id) === accountId &&
    (snapshot.local_device_id ? device.id === snapshot.local_device_id : device.installation_id === snapshot.installation_id),
  ) ?? null;
  const localEnabled = localDevice?.enabled === true;

  const toggleLocal = async (enabled: boolean) => {
    if (busy) return;
    const mine = generation.current;
    setBusy(true); setError("");
    try {
      await api(`/api/donebot/teams/${team.id}/devices`, { method: "POST", body: JSON.stringify({ action: "set", account_id: accountId, enabled }) });
      if (mine === generation.current) await refresh();
    } catch (cause) { if (mine === generation.current) setError(problem(cause)); }
    finally { if (alive.current) setBusy(false); }
  };

  const revoke = async (device: DoneBotTeamDevice) => {
    if (busy) return;
    if (!window.confirm(`撤销设备「${device.name}」（${device.email}）的团队执行权限？`)) return;
    const mine = generation.current;
    setBusy(true); setError("");
    try {
      await api(`/api/donebot/teams/${team.id}/devices`, { method: "POST", body: JSON.stringify({ action: "revoke", account_id: accountId, device_id: device.id }) });
      if (mine === generation.current) await refresh();
    } catch (cause) { if (mine === generation.current) setError(problem(cause)); }
    finally { if (alive.current) setBusy(false); }
  };

  const deviceRole = (device: DoneBotTeamDevice) =>
    device.role ?? members.find(member => member.user_id === device.user_id)?.role;
  const canRevoke = (device: DoneBotTeamDevice) =>
    String(device.user_id) === accountId || team.role === "owner" || (team.role === "admin" && deviceRole(device) === "member");

  return <div data-team-devices-card className="flex flex-col gap-3 rounded-lg border border-line p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2 font-medium text-ink"><Laptop size={16} aria-hidden="true" />团队本机执行设备</div>
      <button type="button" className={button} disabled={busy || !snapshot} onClick={() => void toggleLocal(!localEnabled)}>
        {localEnabled ? "停用本机参与" : "在此团队启用本机"}
      </button>
    </div>
    <p className="text-xs text-ink-secondary">本机执行默认关闭，仅由你本人显式授权。本机工具权限仍由你授予，管理员无法远程提升。</p>
    {snapshot && snapshot.devices.length > 0 && <ul className="divide-y divide-line text-xs">
      {snapshot.devices.map(device => <li key={device.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
        <span>{device.name}{device.id === localDevice?.id ? "（本机）" : ""} · {device.email} · {device.enabled ? (device.online ? "在线" : "已授权（离线）") : "已停用"}</span>
        {device.enabled && canRevoke(device) && <button type="button" className={button} disabled={busy} onClick={() => void revoke(device)}>撤销设备</button>}
      </li>)}
    </ul>}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </div>;
}
