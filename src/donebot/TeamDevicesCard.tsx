import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertCircle, Laptop } from "lucide-react";
import { api } from "@/state/api";
import { SettingsGroup, SIMPLE_CARD, Switch } from "@/components/SettingsPrimitives";
import { cn } from "@/lib/cn";
import type { DoneBotTeamDevice, DoneBotTeamDevicesSnapshot, DoneBotTeamIdentity, DoneBotTeamMember } from "../../shared/donebot-teams";

const button = "ui-button inline-flex items-center justify-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50";
const problem = (cause: unknown) => cause instanceof Error ? cause.message : "团队设备操作未完成，请重试。";

export function TeamDevicesCard({ accountId, team, members = [] }: { accountId: string; team: DoneBotTeamIdentity; members?: DoneBotTeamMember[] }) {
  const [snapshot, setSnapshot] = useState<DoneBotTeamDevicesSnapshot | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const titleId = useId(), descId = useId();
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

  return <SettingsGroup label="团队本机执行设备">
    <div data-team-devices-card className={cn(SIMPLE_CARD, "divide-y divide-hairline/40 py-0")}>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-ink/[0.06] text-ink ring-1 ring-inset ring-ink/[0.08]">
              <Laptop size={17} aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1 space-y-0.5">
              <div id={titleId} className="text-[14px] font-medium leading-5 text-ink">允许本机参与团队执行</div>
              <p id={descId} className="text-[12px] leading-relaxed text-ink-secondary">
                本机执行默认关闭，仅由你本人显式授权。本机工具权限仍由你授予，管理员无法远程提升。
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center pt-1">
            <Switch
              data-team-local-device-switch=""
              checked={localEnabled}
              aria-labelledby={titleId}
              aria-describedby={descId}
              disabled={busy || !snapshot}
              onClick={() => void toggleLocal(!localEnabled)}
            />
          </div>
        </div>
        {error && (
          <p role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger/20">
            <AlertCircle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}
      </div>

      {snapshot && snapshot.devices.length > 0 && (
        <ul className="divide-y divide-hairline/40">
          {snapshot.devices.map(device => {
            const isLocal = device.id === localDevice?.id;
            const online = device.enabled && device.online;
            const statusPill = online
              ? { label: "在线", pill: "bg-success/12 text-success ring-success/25", dot: "bg-success" }
              : device.enabled
                ? { label: "已授权（离线）", pill: "bg-warning/12 text-warning ring-warning/25", dot: "bg-warning" }
                : { label: "已停用", pill: "bg-ink/[0.06] text-ink-secondary ring-ink/10", dot: "bg-ink-tertiary" };
            return (
              <li key={device.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-[13px]">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">
                      {device.name}{isLocal ? "（本机）" : ""}
                    </span>
                    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", statusPill.pill)}>
                      <span aria-hidden="true" className={cn("size-1.5 rounded-full", statusPill.dot)} />
                      {statusPill.label}
                    </span>
                  </div>
                  <p className="truncate text-[12px] text-ink-secondary">{device.email}</p>
                </div>
                {device.enabled && canRevoke(device) && (
                  <button type="button" className={`${button} text-[12px]`} disabled={busy} onClick={() => void revoke(device)}>
                    撤销设备
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  </SettingsGroup>;
}
