import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Bot, FolderOpen, Loader2, RefreshCw, Users } from "lucide-react";
import { SIMPLE_CARD } from "@/components/SettingsPrimitives";
import { cn } from "@/lib/cn";
import { refreshCollabOverview, useCollabStore } from "./collab-store";
import { COLLAB_BUTTON } from "./collab-types";
import { CollabFoldersTab } from "./CollabFoldersTab";
import { CollabBotsTab } from "./CollabBotsTab";
import { CollabContactsTab } from "./CollabContactsTab";
import { ChiefAutoSubmitToggle } from "./CollabTeamTaskSections";

type CollabTab = "folders" | "bots" | "contacts";

export function RemoteCollab({ standalone = false }: { standalone?: boolean }) {
  const { overview, loaded, refreshing, error } = useCollabStore();
  const [tab, setTab] = useState<CollabTab>("folders");

  const load = useCallback(async () => {
    await refreshCollabOverview();
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!loaded) {
    if (!standalone) return null;
    return (
      <div data-donebot-collab className={cn(SIMPLE_CARD, "flex items-center gap-2 p-4 text-[13px] text-ink-secondary")}>
        <Loader2 size={15} aria-hidden="true" className="animate-spin" />
        <span role="status">正在加载远程协作…</span>
      </div>
    );
  }

  if (!overview) {
    if (!standalone) return null;
    return (
      <div data-donebot-collab className={cn(SIMPLE_CARD, "flex flex-col gap-3 p-5 text-[13px]")}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-medium text-ink">
            <Users size={16} aria-hidden="true" />远程协作暂未就绪
          </div>
          <button type="button" onClick={() => void load()} disabled={refreshing} className={`${COLLAB_BUTTON} text-[12px]`}>
            <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} aria-hidden="true" />重试
          </button>
        </div>
        <p className="text-ink-secondary">
          通过网关与好友、团队成员共享本机文件夹和 Bot（无需团队云服务器）。请确认已登录 DoneBot 账号，且网关已升级至最新版本。
        </p>
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">
            <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}
      </div>
    );
  }

  const pendingContacts = overview.friends.incoming_requests.length + overview.incoming_team_invitations.length;
  const folderCount = overview.folders.owned.length + overview.folders.shared_with_me.length;
  const botCount = overview.bots.owned.length + overview.bots.shared_with_me.length;

  const tabs: Array<{ id: CollabTab; label: string; icon: typeof FolderOpen; badge?: number; alert?: boolean }> = [
    { id: "folders", label: "共享文件夹", icon: FolderOpen, badge: folderCount || undefined },
    { id: "bots", label: "共享 Bot", icon: Bot, badge: botCount || undefined },
    { id: "contacts", label: "好友与团队", icon: Users, badge: pendingContacts || undefined, alert: pendingContacts > 0 },
  ];

  return (
    <div data-donebot-collab className="flex w-full flex-col gap-5 text-[13px] text-ink">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="远程协作板块" className="inline-flex rounded-xl bg-ink/[0.06] p-1 ring-1 ring-inset ring-ink/[0.08]">
          {tabs.map(item => {
            const active = tab === item.id;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                data-collab-tab={item.id}
                onClick={() => setTab(item.id)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                  active
                    ? "bg-surface text-ink shadow-xs ring-1 ring-ink/10"
                    : "text-ink-secondary hover:text-ink",
                )}
              >
                <Icon size={14} aria-hidden="true" />
                <span>{item.label}</span>
                {item.badge !== undefined && (
                  <span className={cn(
                    "inline-flex min-w-4 items-center justify-center rounded-full px-1.5 text-[10px] font-semibold tabular-nums",
                    item.alert
                      ? "bg-danger text-white"
                      : active ? "bg-ink/10 text-ink" : "bg-ink/[0.08] text-ink-secondary",
                  )}>
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => void load()}
          disabled={refreshing}
          aria-label="刷新远程协作"
          title="刷新远程协作"
          className={`${COLLAB_BUTTON} text-[12px]`}
        >
          <RefreshCw size={13} aria-hidden="true" className={refreshing ? "animate-spin" : ""} />
          刷新
        </button>
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3.5 py-2.5 text-[13px] text-danger ring-1 ring-inset ring-danger/20">
          <AlertCircle size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {tab === "folders" && <CollabFoldersTab overview={overview} onReload={load} />}
      {tab === "bots" && <CollabBotsTab overview={overview} onReload={load} />}
      {tab === "contacts" && <CollabContactsTab overview={overview} onReload={load} />}

      <ChiefAutoSubmitToggle variant="card" />
    </div>
  );
}
