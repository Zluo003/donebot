import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Eye,
  Folder,
  FolderOpen,
  FolderPlus,
  Loader2,
  Pencil,
  Shield,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { api } from "@/state/api";
import { SETTINGS_INPUT, SettingsGroup, SIMPLE_CARD, Switch } from "@/components/SettingsPrimitives";
import { cn } from "@/lib/cn";
import type { CollabAccess, DoneBotFolderGrantInput, DoneBotOwnedFolder, DoneBotSharedFolder } from "../../shared/donebot-collab";
import { CollabFolderBrowser } from "./CollabFolderBrowser";
import {
  accessLabel,
  buildGrantCandidates,
  cleanError,
  COLLAB_BUTTON,
  sourceText,
  type CollabOverview,
  type LocalCollabActivity,
  type LocalCollabFolder,
} from "./collab-types";

type DraftFolder = {
  id: string;
  path: string;
  name: string;
  enabled: boolean;
  grants: Map<string, DoneBotFolderGrantInput>;
  isNew: boolean;
};

const grantKey = (type: "user" | "team", id: string) => `${type}:${id}`;

export function CollabFoldersTab({
  overview,
  onReload,
}: {
  overview: CollabOverview;
  onReload: () => Promise<void>;
}) {
  const bridge = window.ogb?.collab;
  const [localFolders, setLocalFolders] = useState<LocalCollabFolder[]>([]);
  const [relayStatus, setRelayStatus] = useState<{ connected: boolean; activeCount: number; error?: string } | null>(null);
  const [activity, setActivity] = useState<LocalCollabActivity[]>([]);
  const [showActivity, setShowActivity] = useState(false);
  const [draft, setDraft] = useState<DraftFolder | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [browsing, setBrowsing] = useState<DoneBotSharedFolder | null>(null);

  const candidates = useMemo(() => buildGrantCandidates(overview), [overview]);

  const refreshLocal = useCallback(async () => {
    if (!bridge) return;
    try {
      const [list, st, log] = await Promise.all([
        bridge.listFolders(),
        bridge.status(),
        bridge.activity().catch(() => []),
      ]);
      setLocalFolders(list);
      setRelayStatus(st);
      setActivity(log);
    } catch (cause) {
      setError(cleanError(cause));
    }
  }, [bridge]);

  useEffect(() => {
    void refreshLocal();
    if (!bridge) return;
    const timer = window.setInterval(() => { if (!document.hidden) void refreshLocal(); }, 5000);
    return () => window.clearInterval(timer);
  }, [bridge, refreshLocal]);

  const localById = useMemo(() => new Map(localFolders.map(item => [item.id, item])), [localFolders]);

  const startPickFolder = async () => {
    if (!bridge || busy) return;
    setError("");
    try {
      const picked = await bridge.chooseFolder();
      if (!picked) return;
      const grants = new Map<string, DoneBotFolderGrantInput>();
      setDraft({
        id: picked.id,
        path: picked.path,
        name: picked.name,
        enabled: true,
        grants,
        isNew: true,
      });
    } catch (cause) {
      setError(cleanError(cause, "选择文件夹失败，请选择安全的项目目录。"));
    }
  };

  const openEditor = (folder: DoneBotOwnedFolder) => {
    const local = localById.get(folder.id);
    const grants = new Map<string, DoneBotFolderGrantInput>();
    for (const g of folder.grants) {
      grants.set(grantKey(g.subject_type, g.subject_id), {
        subject_type: g.subject_type,
        subject_id: g.subject_id,
        access: g.access,
      });
    }
    setDraft({
      id: folder.id,
      path: local?.path ?? "",
      name: folder.name,
      enabled: folder.enabled,
      grants,
      isNew: false,
    });
    setError("");
  };

  const toggleGrant = (subjectType: "user" | "team", subjectId: string) => {
    if (!draft) return;
    const key = grantKey(subjectType, subjectId);
    const next = new Map(draft.grants);
    if (next.has(key)) next.delete(key);
    else next.set(key, { subject_type: subjectType, subject_id: subjectId, access: "read" });
    setDraft({ ...draft, grants: next });
  };

  const setGrantAccess = (subjectType: "user" | "team", subjectId: string, access: CollabAccess) => {
    if (!draft) return;
    const key = grantKey(subjectType, subjectId);
    const next = new Map(draft.grants);
    next.set(key, { subject_type: subjectType, subject_id: subjectId, access });
    setDraft({ ...draft, grants: next });
  };

  const saveDraft = async () => {
    if (!draft || busy) return;
    const cleanName = draft.name.trim();
    if (!cleanName) { setError("请输入共享文件夹名称。"); return; }
    setBusy(true); setError("");
    try {
      const grantList = [...draft.grants.values()];
      const allowWrite = grantList.some(g => g.access === "write");
      if (bridge && draft.path) {
        await bridge.saveFolder({
          id: draft.id,
          path: draft.path,
          name: cleanName,
          enabled: draft.enabled,
          allowWrite,
        });
      }
      const route = draft.isNew ? "/api/donebot/collab/folders" : `/api/donebot/collab/folders/${draft.id}`;
      await api(route, {
        method: draft.isNew ? "POST" : "PUT",
        body: JSON.stringify({
          ...(draft.isNew ? { id: draft.id } : {}),
          device_name: overview.identity.device_name,
          name: cleanName,
          enabled: draft.enabled,
          grants: grantList,
        }),
      });
      setDraft(null);
      await Promise.all([onReload(), refreshLocal()]);
    } catch (cause) {
      setError(cleanError(cause, "保存共享文件夹失败，请重试。"));
    } finally {
      setBusy(false);
    }
  };

  const toggleFolderEnabled = async (folder: DoneBotOwnedFolder, enabled: boolean) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const local = localById.get(folder.id);
      const grants = folder.grants.map(({ subject_type, subject_id, access }) => ({ subject_type, subject_id, access }));
      const allowWrite = grants.some(g => g.access === "write");
      if (bridge && local?.path) {
        await bridge.saveFolder({ id: folder.id, path: local.path, name: folder.name, enabled, allowWrite });
      }
      await api(`/api/donebot/collab/folders/${folder.id}`, {
        method: "PUT",
        body: JSON.stringify({
          device_name: folder.device_name || overview.identity.device_name,
          name: folder.name,
          enabled,
          grants,
        }),
      });
      await Promise.all([onReload(), refreshLocal()]);
    } catch (cause) {
      setError(cleanError(cause));
    } finally {
      setBusy(false);
    }
  };

  const removeFolder = async (folder: DoneBotOwnedFolder) => {
    if (busy) return;
    if (!window.confirm(`停止共享「${folder.name}」？已授权的好友和团队成员将立刻无法继续访问。`)) return;
    setBusy(true); setError("");
    try {
      await api(`/api/donebot/collab/folders/${folder.id}`, { method: "DELETE" });
      if (bridge) await bridge.removeFolder(folder.id).catch(() => {});
      if (draft?.id === folder.id) setDraft(null);
      await Promise.all([onReload(), refreshLocal()]);
    } catch (cause) {
      setError(cleanError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3.5 py-2.5 text-[13px] text-danger ring-1 ring-inset ring-danger/20">
          <AlertCircle size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* 1. Owned local folders */}
      <SettingsGroup
        label={`我共享的本机文件夹（${overview.folders.owned.length}）`}
        actions={
          <div className="flex items-center gap-2">
            {relayStatus && relayStatus.activeCount > 0 && (
              <span className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ring-1 ring-inset",
                relayStatus.connected
                  ? "bg-success/12 text-success ring-success/25"
                  : "bg-accent/12 text-accent-text ring-accent/25",
              )}>
                <span className={cn("size-1.5 rounded-full", relayStatus.connected ? "bg-success" : "bg-accent")} aria-hidden="true" />
                {relayStatus.connected ? "中继在线" : "正在连接"}
              </span>
            )}
            {bridge && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void startPickFolder()}
                className={`${COLLAB_BUTTON} ui-button-primary text-[12px]`}
              >
                <FolderPlus size={13} aria-hidden="true" />共享本机文件夹
              </button>
            )}
          </div>
        }
        footnote="文件始终保存在你的电脑硬盘里，绝不上传云端；授权的好友或团队成员仅可在你设定的只读/可编辑范围内远程访问，随时可一键收回。"
      >
        <div className={cn(SIMPLE_CARD, "flex flex-col divide-y divide-hairline/40 p-0")}>
          {!bridge && (
            <div className="px-4 py-3 text-[12px] text-ink-secondary">
              请在桌面端本机窗口中添加或管理本机共享文件夹。
            </div>
          )}

          {relayStatus?.error && (
            <div role="alert" className="flex items-start gap-2 bg-danger/8 px-4 py-2.5 text-[12px] text-danger">
              <AlertCircle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
              <span>{relayStatus.error}</span>
            </div>
          )}

          {/* Inline editor for creating or updating folder ACL */}
          {draft && (
            <div className="flex flex-col gap-3.5 bg-inset/70 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-ink">
                    {draft.isNew ? "配置新共享文件夹权限" : `编辑「${draft.name}」的访问权限`}
                  </div>
                  {draft.path && (
                    <div className="mt-0.5 truncate font-mono text-[11px] text-ink-tertiary" title={draft.path}>
                      本机路径（仅本地可见）：{draft.path}
                    </div>
                  )}
                </div>
                <button type="button" onClick={() => setDraft(null)} className="rounded-lg p-1 text-ink-tertiary hover:bg-ink/[0.06] hover:text-ink" aria-label="取消">
                  <X size={15} aria-hidden="true" />
                </button>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[12px] font-medium text-ink-secondary">共享显示名称</label>
                <input
                  value={draft.name}
                  onChange={e => setDraft({ ...draft, name: e.target.value })}
                  maxLength={120}
                  placeholder="例如：产品方案文档"
                  className={SETTINGS_INPUT}
                  disabled={busy}
                />
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-medium text-ink-secondary">选择可访问的团队或好友（精确配置只读 / 可编辑）</span>
                  <span className="text-[11px] text-ink-tertiary">已选 {draft.grants.size} 项</span>
                </div>
                {candidates.length > 0 ? (
                  <div className="max-h-56 divide-y divide-hairline/40 overflow-y-auto rounded-xl bg-app/70 ring-1 ring-inset ring-hairline/60">
                    {candidates.map(item => {
                      const key = grantKey(item.subject_type, item.subject_id);
                      const granted = draft.grants.get(key);
                      return (
                        <div key={key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                            <input
                              type="checkbox"
                              checked={Boolean(granted)}
                              onChange={() => toggleGrant(item.subject_type, item.subject_id)}
                              className="size-4 rounded accent-accent"
                            />
                            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-ink/[0.06] text-ink-secondary">
                              {item.subject_type === "team" ? <Users size={13} aria-hidden="true" /> : <Shield size={13} aria-hidden="true" />}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] font-medium text-ink">{item.label}</span>
                              <span className="block truncate text-[11px] text-ink-tertiary">{item.hint}</span>
                            </span>
                          </label>
                          {granted && (
                            <div role="group" aria-label={`${item.label} 权限`} className="inline-flex rounded-lg bg-ink/[0.06] p-0.5 ring-1 ring-inset ring-ink/[0.08]">
                              {(["read", "write"] as const).map(level => (
                                <button
                                  key={level}
                                  type="button"
                                  onClick={() => setGrantAccess(item.subject_type, item.subject_id, level)}
                                  className={cn(
                                    "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                                    granted.access === level
                                      ? "bg-surface text-ink shadow-xs ring-1 ring-ink/10"
                                      : "text-ink-secondary hover:text-ink",
                                  )}
                                >
                                  {level === "read" ? "只读" : "可编辑"}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="rounded-xl bg-app/50 px-3.5 py-3 text-[12px] text-ink-secondary ring-1 ring-inset ring-hairline/50">
                    还没有可授权的好友或团队。你可以先保存文件夹，之后到「好友与团队」页添加好友或创建团队后再配置权限。
                  </p>
                )}
              </div>

              <div className="flex justify-end gap-2">
                <button type="button" className={COLLAB_BUTTON} disabled={busy} onClick={() => setDraft(null)}>取消</button>
                <button type="button" className={`${COLLAB_BUTTON} ui-button-primary`} disabled={busy || !draft.name.trim()} onClick={() => void saveDraft()}>
                  {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
                  保存共享配置
                </button>
              </div>
            </div>
          )}

          {overview.folders.owned.length > 0 ? (
            <ul className="divide-y divide-hairline/40">
              {overview.folders.owned.map(folder => {
                const local = localById.get(folder.id);
                const isThisDevice = folder.installation_id === overview.identity.installation_id;
                return (
                  <li key={folder.id} className="flex flex-col gap-2.5 px-4 py-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex min-w-0 flex-1 items-start gap-2.5">
                        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-ink/[0.06] text-ink-secondary ring-1 ring-inset ring-ink/[0.08]">
                          <FolderOpen size={15} aria-hidden="true" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-[14px] font-medium text-ink">{folder.name}</span>
                            <span className={cn(
                              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
                              folder.online
                                ? "bg-success/12 text-success ring-success/25"
                                : "bg-ink/[0.05] text-ink-tertiary ring-ink/10",
                            )}>
                              <span className={cn("size-1.5 rounded-full", folder.online ? "bg-success" : "bg-ink-tertiary/50")} aria-hidden="true" />
                              {folder.online ? "在线" : folder.enabled ? "离线" : "已暂停"}
                            </span>
                            <span className="text-[11px] text-ink-tertiary">
                              {folder.device_name}{isThisDevice ? "（本机）" : ""}
                            </span>
                          </div>
                          {local?.path && (
                            <div className="mt-0.5 truncate font-mono text-[11px] text-ink-tertiary" title={local.path}>{local.path}</div>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Switch
                          checked={folder.enabled}
                          disabled={busy}
                          aria-label={`启用共享文件夹 ${folder.name}`}
                          onClick={() => void toggleFolderEnabled(folder, !folder.enabled)}
                        />
                        <button type="button" disabled={busy} onClick={() => openEditor(folder)} className={`${COLLAB_BUTTON} text-[12px]`}>
                          <Pencil size={12} aria-hidden="true" />配置权限
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void removeFolder(folder)}
                          className="inline-flex size-8 items-center justify-center rounded-lg text-ink-tertiary transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50"
                          aria-label={`停止共享 ${folder.name}`}
                          title="停止共享"
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 pl-10">
                      {folder.grants.length > 0 ? folder.grants.map(g => (
                        <button
                          key={grantKey(g.subject_type, g.subject_id)}
                          type="button"
                          onClick={() => openEditor(folder)}
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium ring-1 ring-inset transition-colors hover:brightness-110",
                            g.access === "write"
                              ? "bg-accent/14 text-accent-text ring-accent/25"
                              : "bg-ink/[0.05] text-ink-secondary ring-ink/10",
                          )}
                        >
                          <span>{g.label || g.subject_id}</span>
                          <span className="opacity-70">· {accessLabel(g.access)}</span>
                        </button>
                      )) : (
                        <span className="text-[11px] text-ink-tertiary">尚未授权任何好友或团队，点击「配置权限」添加。</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : !draft && (
            <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
              <div className="flex size-10 items-center justify-center rounded-xl bg-ink/[0.06] text-ink-secondary ring-1 ring-inset ring-ink/[0.08]">
                <FolderOpen size={18} aria-hidden="true" />
              </div>
              <p className="text-[13px] font-medium text-ink">还没有共享本机文件夹</p>
              <p className="max-w-md text-[12px] leading-relaxed text-ink-secondary">
                选择一个本机目录并指定哪些好友或团队只读/可编辑。对方和对方的本机 Bot 即可通过网关实时协作，无需云服务器。
              </p>
            </div>
          )}

          {activity.length > 0 && (
            <div className="px-4 py-2.5">
              <button
                type="button"
                onClick={() => setShowActivity(v => !v)}
                className="flex w-full items-center justify-between text-[12px] font-medium text-ink-secondary hover:text-ink"
              >
                <span>最近远程访问记录（{activity.length}）</span>
                <ChevronDown size={14} aria-hidden="true" className={cn("transition-transform", showActivity && "rotate-180")} />
              </button>
              {showActivity && (
                <ul className="mt-2 max-h-44 divide-y divide-hairline/30 overflow-y-auto rounded-lg bg-inset/70 ring-1 ring-inset ring-hairline/40">
                  {activity.slice(0, 30).map((entry, idx) => (
                    <li key={`${entry.at}-${idx}`} className="flex items-center justify-between gap-3 px-3 py-1.5 text-[11px]">
                      <div className="min-w-0 flex-1 truncate text-ink-secondary">
                        <span className="font-medium text-ink">{entry.callerEmail}</span>
                        {" · "}
                        <span>{entry.action}</span>
                        {" · "}
                        <span className="font-mono">{entry.folderName}/{entry.detail}</span>
                        {!entry.ok && entry.error ? <span className="text-danger">（{entry.error}）</span> : null}
                      </div>
                      <span className="shrink-0 tabular-nums text-ink-tertiary">{new Date(entry.at).toLocaleTimeString()}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </SettingsGroup>

      {/* 2. Folders shared with me */}
      <SettingsGroup
        label={`共享给我的文件夹（${overview.folders.shared_with_me.length}）`}
        footnote="你本机的任意 Bot 都可以直接发现并读写（按授权权限）下面在线的文件夹，在聊天里直接说出文件夹名即可调用。"
      >
        <div className={cn(SIMPLE_CARD, "flex flex-col divide-y divide-hairline/40 p-0")}>
          {overview.folders.shared_with_me.length > 0 ? (
            <ul className="divide-y divide-hairline/40">
              {overview.folders.shared_with_me.map(folder => {
                const isOpen = browsing?.id === folder.id;
                return (
                  <li key={folder.id} className="flex flex-col gap-3 px-4 py-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex min-w-0 flex-1 items-start gap-2.5">
                        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-ink/[0.06] text-ink-secondary ring-1 ring-inset ring-ink/[0.08]">
                          <Folder size={15} aria-hidden="true" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-[14px] font-medium text-ink">{folder.name}</span>
                            <span className={cn(
                              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
                              folder.online
                                ? "bg-success/12 text-success ring-success/25"
                                : "bg-ink/[0.05] text-ink-tertiary ring-ink/10",
                            )}>
                              <span className={cn("size-1.5 rounded-full", folder.online ? "bg-success" : "bg-ink-tertiary/50")} aria-hidden="true" />
                              {folder.online ? "在线" : "对方离线"}
                            </span>
                            <span className={cn(
                              "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
                              folder.access === "write"
                                ? "bg-accent/14 text-accent-text ring-accent/25"
                                : "bg-ink/[0.05] text-ink-secondary ring-ink/10",
                            )}>
                              {accessLabel(folder.access)}
                            </span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-secondary">
                            <span>来自 {folder.owner_email}</span>
                            <span className="text-ink-tertiary">· {folder.device_name}</span>
                            <span className="text-ink-tertiary">· {sourceText(folder.sources)}</span>
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={!folder.online}
                        onClick={() => setBrowsing(isOpen ? null : folder)}
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
          ) : (
            <div className="px-4 py-6 text-center text-[12px] text-ink-secondary">
              还没有好友或队友向你共享文件夹。等对方在「远程协作 → 共享文件夹」里勾选你或你的团队后，这里会立刻显示。
            </div>
          )}
        </div>
      </SettingsGroup>
    </div>
  );
}
