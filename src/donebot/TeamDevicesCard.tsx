import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertCircle, ChevronDown, FolderOpen, FolderPlus, Laptop, Terminal, X } from "lucide-react";
import { api } from "@/state/api";
import { SettingsGroup, SIMPLE_CARD, Switch } from "@/components/SettingsPrimitives";
import { cn } from "@/lib/cn";
import type { DoneBotTeamDevice, DoneBotTeamDevicesSnapshot, DoneBotTeamIdentity, DoneBotTeamMember } from "../../shared/donebot-teams";

const button = "ui-button inline-flex items-center justify-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50";
const problem = (cause: unknown) => cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, "") : "团队设备操作未完成，请重试。";

type TeamSharingState = {
  enabled: boolean;
  connected: boolean;
  folders: DesktopSharedFolder[];
  terminal: boolean;
  error?: string;
};

export function TeamDevicesCard({
  accountId,
  team,
  members = [],
  teamCloud = null,
}: {
  accountId: string;
  team: DoneBotTeamIdentity;
  members?: DoneBotTeamMember[];
  teamCloud?: { instanceId: string; ready: boolean } | null;
}) {
  const sharingBridge = window.ogb?.teamSharing;
  const [snapshot, setSnapshot] = useState<DoneBotTeamDevicesSnapshot | null>(null);
  const [sharing, setSharing] = useState<TeamSharingState | null>(null);
  const [activity, setActivity] = useState<DesktopLendingActivity[]>([]);
  const [showActivity, setShowActivity] = useState(false);
  const [busy, setBusy] = useState(false), [sharingBusy, setSharingBusy] = useState(false);
  const [error, setError] = useState(""), [sharingError, setSharingError] = useState("");
  const titleId = useId(), descId = useId(), terminalTitleId = useId(), terminalDescId = useId();
  const generation = useRef(0), sharingGeneration = useRef(0), alive = useRef(true);

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = await api<DoneBotTeamDevicesSnapshot>(`/api/donebot/teams/${team.id}/devices`);
      if (generation.current === mine) { setSnapshot(next); setError(""); }
    } catch (cause) {
      if (generation.current === mine) setError(problem(cause));
    }
  }, [team.id]);

  const refreshSharing = useCallback(async () => {
    if (!sharingBridge) return;
    const mine = ++sharingGeneration.current;
    try {
      const [nextState, nextActivity] = await Promise.all([
        sharingBridge.state(team.id),
        sharingBridge.activity(team.id).catch(() => []),
      ]);
      if (sharingGeneration.current === mine) {
        setSharing(nextState);
        setActivity(nextActivity);
      }
    } catch (cause) {
      if (sharingGeneration.current === mine) setSharingError(problem(cause));
    }
  }, [sharingBridge, team.id]);

  useEffect(() => {
    alive.current = true; setSnapshot(null); setError(""); setSharing(null); setActivity([]); setSharingError(""); setShowActivity(false);
    void refresh();
    void refreshSharing();
    return () => { alive.current = false; generation.current++; sharingGeneration.current++; };
  }, [refresh, refreshSharing]);

  const localDevice = snapshot?.devices.find(device =>
    String(device.user_id) === accountId &&
    (snapshot.local_device_id ? device.id === snapshot.local_device_id : device.installation_id === snapshot.installation_id),
  ) ?? null;
  const localEnabled = localDevice?.enabled === true;

  useEffect(() => {
    if (!sharingBridge || !localEnabled) return;
    const timer = window.setInterval(() => { if (!document.hidden) void refreshSharing(); }, 4000);
    return () => window.clearInterval(timer);
  }, [localEnabled, refreshSharing, sharingBridge]);

  const toggleLocal = async (enabled: boolean) => {
    if (busy) return;
    const mine = generation.current;
    setBusy(true); setError("");
    try {
      await api(`/api/donebot/teams/${team.id}/devices`, { method: "POST", body: JSON.stringify({ action: "set", account_id: accountId, enabled }) });
      if (!enabled && sharingBridge) {
        try {
          const next = await sharingBridge.revoke(team.id);
          if (alive.current) setSharing(next);
        } catch { /* Device revocation already succeeded; keep going. */ }
      }
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
      if (device.id === localDevice?.id && sharingBridge) {
        try {
          const next = await sharingBridge.revoke(team.id);
          if (alive.current) setSharing(next);
        } catch { /* Best-effort stop for local folder channel. */ }
      }
      if (mine === generation.current) await refresh();
    } catch (cause) { if (mine === generation.current) setError(problem(cause)); }
    finally { if (alive.current) setBusy(false); }
  };

  const saveSharing = async (nextFolders: DesktopSharedFolder[], nextTerminal: boolean) => {
    if (!sharingBridge || sharingBusy) return;
    if (nextFolders.length === 0 && !nextTerminal) {
      setSharingBusy(true); setSharingError("");
      try {
        const next = await sharingBridge.revoke(team.id);
        if (alive.current) setSharing(next);
      } catch (cause) { if (alive.current) setSharingError(problem(cause)); }
      finally { if (alive.current) setSharingBusy(false); }
      return;
    }
    if (!teamCloud?.instanceId || !teamCloud.ready) {
      setSharingError("请先启动团队 Cloud 后再共享本机文件夹。");
      return;
    }
    setSharingBusy(true); setSharingError("");
    try {
      const next = await sharingBridge.save({
        teamId: team.id,
        instanceId: teamCloud.instanceId,
        accountId,
        teamName: team.name,
        role: team.role,
        folders: nextFolders,
        terminal: nextTerminal,
      });
      if (alive.current) setSharing(next);
    } catch (cause) { if (alive.current) setSharingError(problem(cause)); }
    finally { if (alive.current) setSharingBusy(false); }
  };

  const addFolder = async () => {
    if (!sharingBridge || sharingBusy) return;
    setSharingBusy(true); setSharingError("");
    try {
      const picked = await sharingBridge.chooseFolder();
      if (!picked || !alive.current) return;
      const currentFolders = sharing?.folders ?? [];
      if (currentFolders.some(entry => entry.path === picked.path)) return;
      const merged = [...currentFolders, picked];
      if (!teamCloud?.instanceId || !teamCloud.ready) {
        setSharingError("请先启动团队 Cloud 后再共享本机文件夹。");
        return;
      }
      const next = await sharingBridge.save({
        teamId: team.id,
        instanceId: teamCloud.instanceId,
        accountId,
        teamName: team.name,
        role: team.role,
        folders: merged,
        terminal: sharing?.terminal === true,
      });
      if (alive.current) setSharing(next);
    } catch (cause) { if (alive.current) setSharingError(problem(cause)); }
    finally { if (alive.current) setSharingBusy(false); }
  };

  const toggleTerminal = async () => {
    if (!sharingBridge || sharingBusy) return;
    const nextTerminal = !(sharing?.terminal === true);
    if (nextTerminal && !window.confirm("开启后，你在此团队发起的 Bot 对话可以在这台电脑上以你的身份运行终端命令（不仅限于共享文件夹）。确认开启？")) return;
    await saveSharing(sharing?.folders ?? [], nextTerminal);
  };

  const deviceRole = (device: DoneBotTeamDevice) =>
    device.role ?? members.find(member => member.user_id === device.user_id)?.role;
  const canRevoke = (device: DoneBotTeamDevice) =>
    String(device.user_id) === accountId || team.role === "owner" || (team.role === "admin" && deviceRole(device) === "member");

  const sharedFolders = sharing?.folders ?? [];
  const sharingConnected = sharing?.enabled === true && sharing.connected === true;
  const sharingConnecting = sharing?.enabled === true && !sharing.connected;
  const sharingPill = sharingConnected
    ? { label: "已连接", pill: "bg-success/12 text-success ring-success/25", dot: "bg-success" }
    : sharingConnecting
      ? { label: "正在连接", pill: "bg-accent/12 text-accent-text ring-accent/25", dot: "bg-accent animate-pulse" }
      : { label: "未共享", pill: "bg-ink/[0.06] text-ink-secondary ring-ink/10", dot: "bg-ink-tertiary" };
  const folderAlert = sharingError || sharing?.error || "";

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

      {localEnabled && sharingBridge && (
        <div data-team-folder-sharing className="flex flex-col gap-3.5 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-ink/[0.06] text-ink ring-1 ring-inset ring-ink/[0.08]">
                <FolderOpen size={17} aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[14px] font-medium leading-5 text-ink">共享给此团队的本机文件夹</span>
                  <span role="status" className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", sharingPill.pill)}>
                    <span aria-hidden="true" className={cn("size-1.5 rounded-full", sharingPill.dot)} />
                    {sharingPill.label}
                  </span>
                </div>
                <p className="text-[12px] leading-relaxed text-ink-secondary">
                  新添加的文件夹默认为只读，仅你本人在此团队发起的对话可访问；管理员和其他成员无法查看或远程修改权限。
                </p>
              </div>
            </div>
            <button
              type="button"
              className={`${button} text-[12px]`}
              disabled={sharingBusy || !teamCloud?.ready || sharedFolders.length >= 20}
              onClick={() => void addFolder()}
            >
              <FolderPlus size={14} aria-hidden="true" />
              添加文件夹
            </button>
          </div>

          {!teamCloud?.ready && (
            <p className="rounded-xl bg-inset/70 px-3 py-2 text-[12px] text-ink-secondary">
              请先启动团队 Cloud 后再添加共享文件夹。
            </p>
          )}

          {sharedFolders.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {sharedFolders.map(folder => {
                const editLabelId = `team-folder-edit-${folder.id}`;
                return (
                  <li key={folder.id} data-team-shared-folder={folder.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-inset/80 px-3.5 py-2.5 ring-1 ring-inset ring-ink/[0.06]">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium text-ink">{folder.name}</p>
                      <p className="truncate font-mono text-[11px] text-ink-secondary" title={folder.path}>{folder.path}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <div className="flex items-center gap-2">
                        <span id={editLabelId} className="text-[12px] text-ink-secondary">允许编辑</span>
                        <Switch
                          data-team-folder-write={folder.id}
                          checked={folder.write}
                          aria-labelledby={editLabelId}
                          disabled={sharingBusy || !teamCloud?.ready}
                          onClick={() => void saveSharing(
                            sharedFolders.map(item => item.id === folder.id ? { ...item, write: !item.write } : item),
                            sharing?.terminal === true,
                          )}
                        />
                      </div>
                      <button
                        type="button"
                        aria-label={`移除文件夹 ${folder.name}`}
                        title={`移除文件夹 ${folder.name}`}
                        disabled={sharingBusy}
                        onClick={() => void saveSharing(
                          sharedFolders.filter(item => item.id !== folder.id),
                          sharing?.terminal === true,
                        )}
                        className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-ink-secondary transition-colors hover:bg-ink/[0.08] hover:text-ink disabled:opacity-40"
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="rounded-xl bg-inset/60 px-3.5 py-2.5 text-[12px] text-ink-secondary">
              尚未添加任何本机文件夹。点击右上角「添加文件夹」选择目录，单个目录限制在 256 KB 以内的文本与小文件编辑，禁止共享系统根目录或整个主目录。
            </p>
          )}

          <div className="flex items-start justify-between gap-4 rounded-xl bg-inset/60 px-3.5 py-3 ring-1 ring-inset ring-ink/[0.06]">
            <div className="flex min-w-0 flex-1 items-start gap-2.5">
              <Terminal size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-ink-secondary" />
              <div className="min-w-0 space-y-0.5">
                <div id={terminalTitleId} className="text-[13px] font-medium text-ink">允许团队 Bot 在本机运行终端命令</div>
                <p id={terminalDescId} className="text-[11px] leading-relaxed text-ink-secondary">
                  高权限选项（默认关闭）：仅对你本人发起的对话生效，将以你的系统用户身份执行命令，不受上方文件夹范围限制。
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center pt-0.5">
              <Switch
                data-team-terminal-switch=""
                checked={sharing?.terminal === true}
                aria-labelledby={terminalTitleId}
                aria-describedby={terminalDescId}
                disabled={sharingBusy || !teamCloud?.ready}
                onClick={() => void toggleTerminal()}
              />
            </div>
          </div>

          {folderAlert && (
            <p role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger/20">
              <AlertCircle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
              <span>{folderAlert}</span>
            </p>
          )}

          {activity.length > 0 && (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                aria-expanded={showActivity}
                onClick={() => setShowActivity(open => !open)}
                className="flex w-fit cursor-pointer items-center gap-1.5 text-[12px] text-ink-secondary hover:text-ink"
              >
                <ChevronDown size={13} aria-hidden="true" className={cn("transition-transform", showActivity && "rotate-180")} />
                最近本机访问记录（{activity.length}）
              </button>
              {showActivity && (
                <ul className="divide-y divide-hairline/40 rounded-xl bg-inset/70 px-3 py-1 text-[11px] ring-1 ring-inset ring-ink/[0.06]">
                  {activity.slice(0, 10).map((entry, idx) => (
                    <li key={`${entry.at}-${idx}`} className="flex items-center justify-between gap-2 py-2">
                      <span className="min-w-0 truncate text-ink">{entry.detail || entry.action}</span>
                      <span className={cn("shrink-0 tabular-nums", entry.ok ? "text-ink-tertiary" : "text-danger")}>
                        {entry.ok ? new Date(entry.at).toLocaleTimeString() : (entry.error || "失败")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

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
