import { useEffect, useState } from "react";
import {
  AlertCircle,
  Bot,
  Check,
  ChevronRight,
  Download,
  FileText,
  FolderOpen,
  FolderPlus,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { api } from "@/state/api";
import { Card, ItemRow, NoteRow, panelActionCls, RowText, Segmented } from "@/components/bot-panel/rows";
import { cn } from "@/lib/cn";
import type {
  CollabAccess,
  CollabChatScopeType,
  CollabSubjectType,
  DoneBotChatMessage,
  DoneBotOwnedFolder,
  DoneBotOwnedSharedBot,
  DoneBotSharedBot,
  DoneBotSharedFolder,
} from "../../shared/donebot-collab";
import {
  accessLabel,
  cleanError,
  COLLAB_BUTTON,
  COLLAB_INPUT,
  displayPersonName,
  formatChatTime,
  formatFileSize,
  type CollabOverview,
  type LocalCollabFolder,
} from "./collab-types";

export function CollabRightFoldersTab({
  subjectType,
  subjectId,
  subjectLabel,
  incomingFolders,
  outgoingFolders,
  overview,
  onReload,
  onOpenFolder,
}: {
  subjectType: CollabSubjectType;
  subjectId: string;
  subjectLabel: string;
  incomingFolders: DoneBotSharedFolder[];
  outgoingFolders: DoneBotOwnedFolder[];
  overview: CollabOverview;
  onReload: () => Promise<void>;
  onOpenFolder: (folder: DoneBotSharedFolder) => void;
}) {
  const bridge = window.ogb?.collab;
  const [localFolders, setLocalFolders] = useState<LocalCollabFolder[]>([]);
  const [draft, setDraft] = useState<{ id: string; path: string; name: string; access: CollabAccess } | null>(null);
  const [showExisting, setShowExisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!bridge) return;
    void bridge.listFolders().then(list => setLocalFolders(Array.isArray(list) ? list : [])).catch(() => {});
  }, [bridge, overview.folders.owned.length]);

  const ungrantedOwned = overview.folders.owned.filter(f =>
    !f.grants.some(g => g.subject_type === subjectType && g.subject_id === subjectId),
  );

  const pickNewFolder = async () => {
    if (!bridge) {
      setError("仅桌面客户端支持选择本机文件夹共享。");
      return;
    }
    setError(""); setNotice("");
    try {
      const picked = await bridge.chooseFolder();
      if (!picked) return;
      setDraft({ id: picked.id, path: picked.path, name: picked.name, access: "read" });
      setShowExisting(false);
    } catch (cause) {
      setError(cleanError(cause, "选择本机文件夹失败。"));
    }
  };

  const saveNewFolder = async () => {
    if (!bridge || !draft || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const cleanName = draft.name.trim() || "共享文件夹";
      await bridge.saveFolder({
        id: draft.id,
        path: draft.path,
        name: cleanName,
        enabled: true,
        allowWrite: draft.access === "write",
      });
      await api("/api/donebot/collab/folders", {
        method: "POST",
        body: JSON.stringify({
          id: draft.id,
          name: cleanName,
          enabled: true,
          grants: [{ subject_type: subjectType, subject_id: subjectId, access: draft.access }],
        }),
      });
      setDraft(null);
      setNotice(`已共享「${cleanName}」给 ${subjectLabel}。`);
      await onReload();
    } catch (cause) {
      setError(cleanError(cause, "保存共享文件夹失败。"));
    } finally {
      setBusy(false);
    }
  };

  const updateOwnedFolderGrant = async (folder: DoneBotOwnedFolder, nextAccess: CollabAccess | null) => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const filtered = folder.grants
        .filter(g => !(g.subject_type === subjectType && g.subject_id === subjectId))
        .map(g => ({ subject_type: g.subject_type, subject_id: g.subject_id, access: g.access }));
      const nextGrants = nextAccess
        ? [...filtered, { subject_type: subjectType, subject_id: subjectId, access: nextAccess }]
        : filtered;
      const local = localFolders.find(item => item.id === folder.id);
      if (bridge && local) {
        const allowWrite = nextGrants.some(g => g.access === "write");
        await bridge.saveFolder({
          id: local.id,
          path: local.path,
          name: folder.name,
          enabled: folder.enabled,
          allowWrite,
        });
      }
      await api(`/api/donebot/collab/folders/${folder.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: folder.name,
          enabled: folder.enabled,
          grants: nextGrants,
        }),
      });
      setNotice(nextAccess ? `已更新「${folder.name}」的共享权限。` : `已停止向 ${subjectLabel} 共享「${folder.name}」。`);
      await onReload();
    } catch (cause) {
      setError(cleanError(cause, "更新共享文件夹权限失败。"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col">
      {error && (
        <div role="alert" className="mt-3 flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger/20">
          <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div role="status" className="mt-3 flex items-start gap-2 rounded-xl bg-success/12 px-3 py-2 text-[12px] text-success ring-1 ring-inset ring-success/25">
          <Check size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{notice}</span>
        </div>
      )}

      {/* Flat panel actions matching native BotPanel */}
      <div className="mt-3 flex flex-col gap-0.5">
        <button
          type="button"
          data-collab-right-add-folder=""
          disabled={busy}
          onClick={() => void pickNewFolder()}
          className={panelActionCls}
        >
          <FolderPlus size={16} aria-hidden="true" />
          <span>添加本机共享文件夹</span>
        </button>
        {ungrantedOwned.length > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => { setShowExisting(v => !v); setDraft(null); }}
            className={panelActionCls}
          >
            <Plus size={16} aria-hidden="true" />
            <span>从已有共享文件夹授权（{ungrantedOwned.length}）</span>
          </button>
        )}
      </div>

      {/* Inline new folder form */}
      {draft && (
        <Card label="新建共享文件夹">
          <div className="flex flex-col gap-3 px-3.5 py-3">
            <div className="truncate font-mono text-[12px] text-ink-tertiary" title={draft.path}>
              {draft.path}
            </div>
            <input
              aria-label="共享文件夹名称"
              value={draft.name}
              onChange={e => setDraft({ ...draft, name: e.target.value })}
              maxLength={120}
              placeholder="文件夹显示名称"
              className={COLLAB_INPUT}
            />
            <Segmented
              label="访问权限"
              attr="data-collab-folder-access"
              value={draft.access}
              onChange={access => setDraft({ ...draft, access })}
              options={[
                { value: "read", label: "只读浏览" },
                { value: "write", label: "可编辑 / 上传" },
              ]}
            />
            <div className="flex justify-end gap-2">
              <button type="button" disabled={busy} onClick={() => setDraft(null)} className={`${COLLAB_BUTTON} h-7 px-3 text-[12px]`}>取消</button>
              <button type="button" disabled={busy} onClick={() => void saveNewFolder()} className={`${COLLAB_BUTTON} ui-button-primary h-7 px-3 text-[12px]`}>
                {busy ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}
                确认共享
              </button>
            </div>
          </div>
        </Card>
      )}

      {/* Existing owned folders quick-grant picker */}
      {showExisting && ungrantedOwned.length > 0 && (
        <Card label="选择已有文件夹授权">
          {ungrantedOwned.map(folder => (
            <ItemRow key={folder.id} icon={FolderOpen} title={folder.name} hint={folder.device_name}>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void updateOwnedFolderGrant(folder, "read")}
                  className={`${COLLAB_BUTTON} h-7 px-2 text-[12px]`}
                >
                  只读
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void updateOwnedFolderGrant(folder, "write")}
                  className={`${COLLAB_BUTTON} ui-button-primary h-7 px-2 text-[12px]`}
                >
                  可编辑
                </button>
              </div>
            </ItemRow>
          ))}
        </Card>
      )}

      {/* Incoming shared folders — clickable to drill into file browser right inside the panel! */}
      <Card label={subjectType === "team" ? `团队共享的文件夹（${incomingFolders.length}）` : `对方共享的文件夹（${incomingFolders.length}）`}>
        {incomingFolders.length === 0 ? (
          <NoteRow>对方暂未共享本机文件夹。共享后可直接在这里浏览、预览与传输最大 100 MB 文件。</NoteRow>
        ) : (
          incomingFolders.map(folder => {
            const owner = displayPersonName({
              remark: folder.owner_remark,
              nickname: folder.owner_nickname,
              email: folder.owner_email,
            });
            return (
              <button
                key={folder.id}
                type="button"
                data-collab-right-browse-folder={folder.id}
                disabled={!folder.online}
                onClick={() => onOpenFolder(folder)}
                className="flex min-h-[52px] w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors enabled:hover:bg-ink/[0.03] disabled:cursor-default disabled:opacity-55"
              >
                <span className="relative flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#009957]/14 text-[#4CC98C]">
                  <FolderOpen size={15} aria-hidden="true" />
                  <span
                    aria-hidden="true"
                    className={cn(
                      "absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-composer",
                      folder.online ? "bg-success" : "bg-ink-tertiary/45",
                    )}
                  />
                </span>
                <RowText
                  title={<span className="block truncate">{folder.name}</span>}
                  hint={
                    <span className="block truncate text-[12px]">
                      {owner} · {folder.device_name} · {accessLabel(folder.access)}
                    </span>
                  }
                />
                <span className="shrink-0 text-[12px] text-ink-secondary">
                  {folder.online ? "浏览" : "离线"}
                </span>
                {folder.online && <ChevronRight size={15} className="shrink-0 text-ink-tertiary" aria-hidden="true" />}
              </button>
            );
          })
        )}
      </Card>

      {/* Outgoing shared folders */}
      <Card label={`我共享的文件夹（${outgoingFolders.length}）`}>
        {outgoingFolders.length === 0 ? (
          <NoteRow>还没有向 {subjectLabel} 共享你的本机文件夹。</NoteRow>
        ) : (
          outgoingFolders.map(folder => {
            const direct = folder.grants.find(g => g.subject_type === subjectType && g.subject_id === subjectId);
            const access = direct?.access ?? "read";
            return (
              <ItemRow
                key={folder.id}
                icon={FolderOpen}
                title={<span className="block truncate">{folder.name}</span>}
                hint={direct ? `${accessLabel(access)} · ${folder.device_name}` : `通过共同团队共享 · ${folder.device_name}`}
              >
                {direct && (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      disabled={busy}
                      title="切换只读 / 可编辑权限"
                      onClick={() => void updateOwnedFolderGrant(folder, access === "write" ? "read" : "write")}
                      className={`${COLLAB_BUTTON} h-7 px-2 text-[12px]`}
                    >
                      {access === "write" ? "可编辑" : "只读"}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`取消共享 ${folder.name}`}
                      title="取消对此共享"
                      onClick={() => void updateOwnedFolderGrant(folder, null)}
                      className="flex size-7 items-center justify-center rounded-lg text-ink-tertiary hover:bg-danger/10 hover:text-danger"
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </div>
                )}
              </ItemRow>
            );
          })
        )}
      </Card>
    </div>
  );
}

export function CollabRightBotsTab({
  subjectType,
  subjectId,
  subjectLabel,
  incomingBots,
  outgoingBots,
  overview,
  onReload,
}: {
  subjectType: CollabSubjectType;
  subjectId: string;
  subjectLabel: string;
  incomingBots: DoneBotSharedBot[];
  outgoingBots: DoneBotOwnedSharedBot[];
  overview: CollabOverview;
  onReload: () => Promise<void>;
}) {
  const [picking, setPicking] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const shareLocalBot = async (botId: string, botName: string) => {
    if (busyId) return;
    setBusyId(`share:${botId}`); setError(""); setNotice("");
    try {
      const existing = overview.bots.owned.find(b => b.source_bot_id === botId);
      if (existing) {
        const grants = existing.grants.some(g => g.subject_type === subjectType && g.subject_id === subjectId)
          ? existing.grants.map(g => ({ subject_type: g.subject_type, subject_id: g.subject_id }))
          : [...existing.grants.map(g => ({ subject_type: g.subject_type, subject_id: g.subject_id })), { subject_type: subjectType, subject_id: subjectId }];
        await api(`/api/donebot/collab/bots/${existing.id}`, {
          method: "PUT",
          body: JSON.stringify({ bot_id: botId, grants }),
        });
      } else {
        await api("/api/donebot/collab/bots/share", {
          method: "POST",
          body: JSON.stringify({
            bot_id: botId,
            grants: [{ subject_type: subjectType, subject_id: subjectId }],
          }),
        });
      }
      setPicking(false);
      setNotice(`已共享 Bot「${botName}」给 ${subjectLabel}（已自动剥离记忆与密钥）。`);
      await onReload();
    } catch (cause) {
      setError(cleanError(cause, "共享 Bot 失败。"));
    } finally {
      setBusyId(null);
    }
  };

  const syncOrRevokeOwnedBot = async (item: DoneBotOwnedSharedBot, revoke: boolean) => {
    if (busyId) return;
    setBusyId(item.id); setError(""); setNotice("");
    try {
      const nextGrants = revoke
        ? item.grants.filter(g => !(g.subject_type === subjectType && g.subject_id === subjectId)).map(g => ({ subject_type: g.subject_type, subject_id: g.subject_id }))
        : item.grants.map(g => ({ subject_type: g.subject_type, subject_id: g.subject_id }));
      if (revoke && nextGrants.length === 0) {
        await api(`/api/donebot/collab/bots/${item.id}`, { method: "DELETE" });
      } else {
        await api(`/api/donebot/collab/bots/${item.id}`, {
          method: "PUT",
          body: JSON.stringify({
            ...(revoke ? {} : { bot_id: item.source_bot_id }),
            grants: nextGrants,
          }),
        });
      }
      setNotice(revoke ? `已取消共享「${item.name}」。` : `已将「${item.name}」最新人设与技能同步。`);
      await onReload();
    } catch (cause) {
      setError(cleanError(cause));
    } finally {
      setBusyId(null);
    }
  };

  const installBot = async (item: DoneBotSharedBot) => {
    if (busyId) return;
    setBusyId(`install:${item.id}`); setError(""); setNotice("");
    try {
      const res = await api<{ bots?: Array<{ name: string }> }>(`/api/donebot/collab/bots/${item.id}/install`, {
        method: "POST",
        body: "{}",
      });
      const created = res?.bots?.[0]?.name || item.name;
      setNotice(`已添加到本机机器人列表：「${created}」。`);
    } catch (cause) {
      setError(cleanError(cause, "添加共享 Bot 失败。"));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex flex-col">
      {error && (
        <div role="alert" className="mt-3 flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger/20">
          <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div role="status" className="mt-3 flex items-start gap-2 rounded-xl bg-success/12 px-3 py-2 text-[12px] text-success ring-1 ring-inset ring-success/25">
          <Check size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{notice}</span>
        </div>
      )}

      <div className="mt-3 flex flex-col gap-0.5">
        <button
          type="button"
          data-collab-right-share-bot=""
          onClick={() => setPicking(v => !v)}
          className={panelActionCls}
        >
          <Plus size={16} aria-hidden="true" />
          <span>共享我的 Bot</span>
        </button>
      </div>

      {picking && (
        <Card label="选择要共享的本机 Bot">
          {overview.local_bots.length === 0 ? (
            <NoteRow>本机还没有可共享的 Bot。</NoteRow>
          ) : (
            overview.local_bots.map(bot => {
              const loading = busyId === `share:${bot.id}`;
              return (
                <ItemRow
                  key={bot.id}
                  icon={Bot}
                  title={<span className="block truncate">{bot.name}</span>}
                  hint={`${bot.has_soul ? "SOUL.md · " : ""}${bot.skill_count} 个技能`}
                >
                  <button
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => void shareLocalBot(bot.id, bot.name)}
                    className={`${COLLAB_BUTTON} ui-button-primary h-7 px-2.5 text-[12px]`}
                  >
                    {loading ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : "共享"}
                  </button>
                </ItemRow>
              );
            })
          )}
        </Card>
      )}

      <Card label={subjectType === "team" ? `团队共享的 Bot（${incomingBots.length}）` : `对方共享的 Bot（${incomingBots.length}）`}>
        {incomingBots.length === 0 ? (
          <NoteRow>对方暂未共享 Bot 模板。接收后可一键添加到本机独立运行。</NoteRow>
        ) : (
          incomingBots.map(item => {
            const loading = busyId === `install:${item.id}`;
            const owner = displayPersonName({
              remark: item.owner_remark,
              nickname: item.owner_nickname,
              email: item.owner_email,
            });
            return (
              <ItemRow
                key={item.id}
                icon={Bot}
                title={<span className="block truncate">{item.name}</span>}
                hint={`${owner} · ${item.has_soul ? "SOUL.md · " : ""}${item.skill_count} 技能`}
              >
                <button
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => void installBot(item)}
                  className={`${COLLAB_BUTTON} ui-button-primary h-7 shrink-0 px-2.5 text-[12px]`}
                >
                  {loading ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Download size={12} aria-hidden="true" />}
                  添加
                </button>
              </ItemRow>
            );
          })
        )}
      </Card>

      <Card label={`我共享的 Bot（${outgoingBots.length}）`}>
        {outgoingBots.length === 0 ? (
          <NoteRow>还没有向 {subjectLabel} 共享你的 Bot。</NoteRow>
        ) : (
          outgoingBots.map(item => {
            const direct = item.grants.some(g => g.subject_type === subjectType && g.subject_id === subjectId);
            const loading = busyId === item.id;
            return (
              <ItemRow
                key={item.id}
                icon={Bot}
                title={<span className="block truncate">{item.name}</span>}
                hint={`${item.has_soul ? "SOUL.md · " : ""}${item.skill_count} 技能`}
              >
                {direct && (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      disabled={busyId !== null}
                      title="同步本机最新人设与技能"
                      aria-label={`同步 ${item.name}`}
                      onClick={() => void syncOrRevokeOwnedBot(item, false)}
                      className="flex size-7 items-center justify-center rounded-lg text-ink-secondary hover:bg-ink/[0.06] hover:text-ink"
                    >
                      <RefreshCw size={13} className={loading ? "animate-spin" : ""} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      disabled={busyId !== null}
                      title="取消对此共享"
                      aria-label={`取消共享 ${item.name}`}
                      onClick={() => void syncOrRevokeOwnedBot(item, true)}
                      className="flex size-7 items-center justify-center rounded-lg text-ink-tertiary hover:bg-danger/10 hover:text-danger"
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </div>
                )}
              </ItemRow>
            );
          })
        )}
      </Card>
    </div>
  );
}

export function CollabRightFilesTab({
  scopeType,
  targetId,
  refreshKey,
}: {
  scopeType: CollabChatScopeType;
  targetId: string;
  refreshKey: number;
}) {
  const [files, setFiles] = useState<DoneBotChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void api<DoneBotChatMessage[]>(`/api/donebot/collab/chats/${scopeType}/${encodeURIComponent(targetId)}/files`)
      .then(list => {
        if (!alive) return;
        setFiles(Array.isArray(list) ? list : []);
        setLoading(false);
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [scopeType, targetId, refreshKey]);

  const download = async (fileId: string, fileName: string) => {
    if (downloadingId) return;
    setDownloadingId(fileId);
    setError("");
    try {
      const res = await fetch(`/api/donebot/collab/chats/files/${encodeURIComponent(fileId)}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）。`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName || "file";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) {
      setError(cleanError(cause, "下载聊天文件失败。"));
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <div className="flex flex-col">
      {error && (
        <div role="alert" className="mt-3 flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger/20">
          <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
      <Card label={`聊天文件（${files.length}）`}>
        {loading ? (
          <div className="flex items-center gap-2 px-3.5 py-4 text-[13px] text-ink-secondary">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />正在加载文件记录…
          </div>
        ) : files.length === 0 ? (
          <NoteRow>聊天中还没有互发过文件。在左下角点击 + 或直接拖拽文件到聊天框即可发送（最大 100 MB）。</NoteRow>
        ) : (
          files.map(item => {
            const sender = displayPersonName({
              remark: item.sender_remark,
              nickname: item.sender_nickname,
              email: item.sender_email,
            });
            return (
              <ItemRow
                key={item.id}
                icon={FileText}
                title={<span className="block truncate">{item.file_name || "未命名文件"}</span>}
                hint={`${formatFileSize(item.file_size)} · ${sender} · ${formatChatTime(item.created_at)}`}
              >
                {item.file_id && (
                  <button
                    type="button"
                    disabled={downloadingId !== null}
                    aria-label={`下载 ${item.file_name || "文件"}`}
                    onClick={() => void download(item.file_id!, item.file_name || "file")}
                    className="flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-ink/[0.06] hover:text-ink"
                  >
                    {downloadingId === item.file_id
                      ? <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                      : <Download size={13} aria-hidden="true" />}
                  </button>
                )}
              </ItemRow>
            );
          })
        )}
      </Card>
    </div>
  );
}
