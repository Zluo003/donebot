import { useMemo, useState } from "react";
import {
  AlertCircle,
  Bot,
  Check,
  Download,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Shield,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { api } from "@/state/api";
import { SettingsGroup, SIMPLE_CARD } from "@/components/SettingsPrimitives";
import { cn } from "@/lib/cn";
import type { DoneBotBotGrantInput, DoneBotOwnedSharedBot, DoneBotSharedBot } from "../../shared/donebot-collab";
import {
  buildGrantCandidates,
  cleanError,
  COLLAB_BUTTON,
  initialGlyph,
  sourceText,
  type CollabOverview,
} from "./collab-types";

type BotShareDraft = {
  id?: string;
  botId: string;
  grants: Map<string, DoneBotBotGrantInput>;
};

const grantKey = (type: "user" | "team", id: string) => `${type}:${id}`;

export function CollabBotsTab({
  overview,
  onReload,
}: {
  overview: CollabOverview;
  onReload: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<BotShareDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installedNotice, setInstalledNotice] = useState("");
  const [error, setError] = useState("");

  const candidates = useMemo(() => buildGrantCandidates(overview), [overview]);

  const openNewShare = () => {
    const first = overview.local_bots[0];
    setDraft({ botId: first?.id ?? "", grants: new Map() });
    setError("");
    setInstalledNotice("");
  };

  const openEditShare = (item: DoneBotOwnedSharedBot) => {
    const grants = new Map<string, DoneBotBotGrantInput>();
    for (const g of item.grants) {
      grants.set(grantKey(g.subject_type, g.subject_id), { subject_type: g.subject_type, subject_id: g.subject_id });
    }
    setDraft({ id: item.id, botId: item.source_bot_id, grants });
    setError("");
  };

  const toggleGrant = (subjectType: "user" | "team", subjectId: string) => {
    if (!draft) return;
    const key = grantKey(subjectType, subjectId);
    const next = new Map(draft.grants);
    if (next.has(key)) next.delete(key);
    else next.set(key, { subject_type: subjectType, subject_id: subjectId });
    setDraft({ ...draft, grants: next });
  };

  const saveDraft = async () => {
    if (!draft || busy) return;
    if (!draft.id && !draft.botId) {
      setError("请先选择一个本机 Bot。");
      return;
    }
    setBusy(true); setError("");
    try {
      const grantList = [...draft.grants.values()];
      if (draft.id) {
        const current = overview.bots.owned.find(b => b.id === draft.id);
        await api(`/api/donebot/collab/bots/${draft.id}`, {
          method: "PUT",
          body: JSON.stringify({
            ...(draft.botId && overview.local_bots.some(b => b.id === draft.botId) ? { bot_id: draft.botId } : {}),
            ...(current ? { name: current.name, title: current.title, description: current.description } : {}),
            grants: grantList,
          }),
        });
      } else {
        await api("/api/donebot/collab/bots/share", {
          method: "POST",
          body: JSON.stringify({ bot_id: draft.botId, grants: grantList }),
        });
      }
      setDraft(null);
      await onReload();
    } catch (cause) {
      setError(cleanError(cause, "保存共享 Bot 失败，请重试。"));
    } finally {
      setBusy(false);
    }
  };

  const syncLatestBot = async (item: DoneBotOwnedSharedBot) => {
    if (busy || !item.source_bot_id) return;
    setBusy(true); setError("");
    try {
      await api("/api/donebot/collab/bots/share", {
        method: "POST",
        body: JSON.stringify({
          id: item.id,
          bot_id: item.source_bot_id,
          grants: item.grants.map(({ subject_type, subject_id }) => ({ subject_type, subject_id })),
        }),
      });
      setInstalledNotice(`已同步「${item.name}」的最新人设和技能。`);
      await onReload();
    } catch (cause) {
      setError(cleanError(cause, "同步 Bot 最新能力失败。"));
    } finally {
      setBusy(false);
    }
  };

  const removeSharedBot = async (item: DoneBotOwnedSharedBot) => {
    if (busy) return;
    if (!window.confirm(`停止共享「${item.name}」？对方已添加到自己电脑的副本不受影响，但无法再获取新副本。`)) return;
    setBusy(true); setError("");
    try {
      await api(`/api/donebot/collab/bots/${item.id}`, { method: "DELETE" });
      if (draft?.id === item.id) setDraft(null);
      await onReload();
    } catch (cause) {
      setError(cleanError(cause));
    } finally {
      setBusy(false);
    }
  };

  const installSharedBot = async (item: DoneBotSharedBot) => {
    if (installingId) return;
    setInstallingId(item.id); setError(""); setInstalledNotice("");
    try {
      const res = await api<{ bots?: Array<{ name: string }>; skills?: number }>(`/api/donebot/collab/bots/${item.id}/install`, {
        method: "POST",
        body: "{}",
      });
      const createdName = res?.bots?.[0]?.name || item.name;
      setInstalledNotice(`已在本机创建同能力 Bot「${createdName}」（已包含人设与技能，不含原主人记忆），可在左侧机器人列表中直接使用。`);
    } catch (cause) {
      setError(cleanError(cause, "添加共享 Bot 失败，请重试。"));
    } finally {
      setInstallingId(null);
    }
  };

  const selectedLocalBot = draft?.botId ? overview.local_bots.find(b => b.id === draft.botId) : null;

  return (
    <div className="flex flex-col gap-5">
      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3.5 py-2.5 text-[13px] text-danger ring-1 ring-inset ring-danger/20">
          <AlertCircle size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {installedNotice && (
        <div role="status" className="flex items-start gap-2 rounded-xl bg-success/12 px-3.5 py-2.5 text-[13px] text-success ring-1 ring-inset ring-success/25">
          <Check size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{installedNotice}</span>
        </div>
      )}

      {/* 1. Owned shared bots */}
      <SettingsGroup
        label={`我共享的 Bot（${overview.bots.owned.length}）`}
        actions={
          <button
            type="button"
            disabled={busy || overview.local_bots.length === 0}
            onClick={openNewShare}
            className={`${COLLAB_BUTTON} ui-button-primary text-[12px]`}
          >
            <Plus size={13} aria-hidden="true" />共享我的 Bot
          </button>
        }
        footnote="共享会自动打包该 Bot 的 SOUL.md 人设、Skills 技能与基础设定，强制剥离个人记忆、对话历史与密钥。"
      >
        <div className={cn(SIMPLE_CARD, "flex flex-col divide-y divide-hairline/40 p-0")}>
          {draft && (
            <div className="flex flex-col gap-3.5 bg-inset/70 p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-[13px] font-medium text-ink">
                    {draft.id ? "编辑共享 Bot 授权" : "选择要共享的本机 Bot"}
                  </div>
                  <p className="mt-0.5 text-[11px] text-ink-secondary">
                    将完整带上 SOUL.md 人设和已安装的 Skills，不会包含任何聊天记录、个人记忆或 API 密钥。
                  </p>
                </div>
                <button type="button" onClick={() => setDraft(null)} className="rounded-lg p-1 text-ink-tertiary hover:bg-ink/[0.06] hover:text-ink" aria-label="取消">
                  <X size={15} aria-hidden="true" />
                </button>
              </div>

              {!draft.id && (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {overview.local_bots.map(bot => {
                    const active = draft.botId === bot.id;
                    return (
                      <button
                        key={bot.id}
                        type="button"
                        onClick={() => setDraft({ ...draft, botId: bot.id })}
                        className={cn(
                          "flex items-start gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors",
                          active
                            ? "bg-ink/[0.08] ring-1 ring-inset ring-ink/30"
                            : "bg-app/70 ring-1 ring-inset ring-hairline/60 hover:bg-ink/[0.04]",
                        )}
                      >
                        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-ink/[0.07] text-[12px] font-semibold text-ink">
                          {initialGlyph(bot.name)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-ink">{bot.name}</span>
                          {bot.title && <span className="block truncate text-[11px] text-ink-secondary">{bot.title}</span>}
                          <span className="mt-1 flex flex-wrap gap-1.5 text-[10px] text-ink-tertiary">
                            <span>{bot.has_soul ? "含 SOUL.md" : "无人设文件"}</span>
                            <span>· {bot.skill_count} 个技能</span>
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {selectedLocalBot && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg bg-app/60 px-3 py-2 text-[11px] text-ink-secondary ring-1 ring-inset ring-hairline/50">
                  <Sparkles size={13} className="shrink-0 text-accent-text" aria-hidden="true" />
                  <span>
                    已选中 <strong className="text-ink">{selectedLocalBot.name}</strong>：
                    {selectedLocalBot.has_soul ? "包含 SOUL.md、" : ""}{selectedLocalBot.skill_count} 个技能（不含记忆）。
                  </span>
                </div>
              )}

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-medium text-ink-secondary">共享给哪些团队或好友</span>
                  <span className="text-[11px] text-ink-tertiary">已选 {draft.grants.size} 项</span>
                </div>
                {candidates.length > 0 ? (
                  <div className="max-h-48 divide-y divide-hairline/40 overflow-y-auto rounded-xl bg-app/70 ring-1 ring-inset ring-hairline/60">
                    {candidates.map(item => {
                      const key = grantKey(item.subject_type, item.subject_id);
                      const checked = draft.grants.has(key);
                      return (
                        <label key={key} className="flex cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-ink/[0.03]">
                          <input
                            type="checkbox"
                            checked={checked}
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
                      );
                    })}
                  </div>
                ) : (
                  <p className="rounded-xl bg-app/50 px-3.5 py-3 text-[12px] text-ink-secondary ring-1 ring-inset ring-hairline/50">
                    请先到「好友与团队」添加好友或加入团队，再选择共享对象。
                  </p>
                )}
              </div>

              <div className="flex justify-end gap-2">
                <button type="button" className={COLLAB_BUTTON} disabled={busy} onClick={() => setDraft(null)}>取消</button>
                <button type="button" className={`${COLLAB_BUTTON} ui-button-primary`} disabled={busy || (!draft.id && !draft.botId)} onClick={() => void saveDraft()}>
                  {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
                  {draft.id ? "保存授权" : "发布共享"}
                </button>
              </div>
            </div>
          )}

          {overview.bots.owned.length > 0 ? (
            <ul className="divide-y divide-hairline/40">
              {overview.bots.owned.map(item => {
                const canSync = Boolean(item.source_bot_id && overview.local_bots.some(b => b.id === item.source_bot_id));
                return (
                  <li key={item.id} className="flex flex-col gap-2.5 px-4 py-3.5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex min-w-0 flex-1 items-start gap-2.5">
                        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-ink/[0.06] text-ink-secondary ring-1 ring-inset ring-ink/[0.08]">
                          <Bot size={15} aria-hidden="true" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-[14px] font-medium text-ink">{item.name}</span>
                            {item.has_soul && (
                              <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-[10px] font-medium text-ink-secondary ring-1 ring-inset ring-ink/10">SOUL.md</span>
                            )}
                            <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-[10px] font-medium text-ink-secondary ring-1 ring-inset ring-ink/10">
                              {item.skill_count} 个技能
                            </span>
                            <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success ring-1 ring-inset ring-success/20">
                              不含记忆
                            </span>
                          </div>
                          {(item.title || item.description) && (
                            <p className="mt-0.5 line-clamp-2 text-[12px] text-ink-secondary">{item.title || item.description}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {canSync && (
                          <button type="button" disabled={busy} onClick={() => void syncLatestBot(item)} className={`${COLLAB_BUTTON} text-[12px]`} title="将本机最新的人设和技能同步给已授权成员">
                            <RefreshCw size={12} aria-hidden="true" />同步更新
                          </button>
                        )}
                        <button type="button" disabled={busy} onClick={() => openEditShare(item)} className={`${COLLAB_BUTTON} text-[12px]`}>
                          <Pencil size={12} aria-hidden="true" />授权
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void removeSharedBot(item)}
                          className="inline-flex size-8 items-center justify-center rounded-lg text-ink-tertiary hover:bg-danger/10 hover:text-danger disabled:opacity-50"
                          aria-label={`停止共享 ${item.name}`}
                          title="停止共享"
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 pl-10">
                      {item.grants.length > 0 ? item.grants.map(g => (
                        <span key={grantKey(g.subject_type, g.subject_id)} className="inline-flex items-center rounded-full bg-ink/[0.05] px-2.5 py-0.5 text-[11px] font-medium text-ink-secondary ring-1 ring-inset ring-ink/10">
                          {g.label || g.subject_id}
                        </span>
                      )) : (
                        <span className="text-[11px] text-ink-tertiary">尚未指定共享对象，点击「授权」添加好友或团队。</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : !draft && (
            <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
              <div className="flex size-10 items-center justify-center rounded-xl bg-ink/[0.06] text-ink-secondary ring-1 ring-inset ring-ink/[0.08]">
                <Bot size={18} aria-hidden="true" />
              </div>
              <p className="text-[13px] font-medium text-ink">还没有共享任何 Bot</p>
              <p className="max-w-md text-[12px] leading-relaxed text-ink-secondary">
                把你调教好的得力 Bot（连同 SOUL.md 人设和 Skills 技能）共享给团队或好友，对方一键就能建出同样能力的全新 Bot。
              </p>
            </div>
          )}
        </div>
      </SettingsGroup>

      {/* 2. Bots shared with me */}
      <SettingsGroup
        label={`共享给我的 Bot（${overview.bots.shared_with_me.length}）`}
        footnote="点击「添加到我的电脑」会在本机新建一个完全独立、相同能力、不含对方记忆的 Bot。"
      >
        <div className={cn(SIMPLE_CARD, "flex flex-col divide-y divide-hairline/40 p-0")}>
          {overview.bots.shared_with_me.length > 0 ? (
            <ul className="divide-y divide-hairline/40">
              {overview.bots.shared_with_me.map(item => (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
                  <div className="flex min-w-0 flex-1 items-start gap-2.5">
                    <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent/14 text-[13px] font-semibold text-accent-text ring-1 ring-inset ring-accent/25">
                      {initialGlyph(item.name)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[14px] font-medium text-ink">{item.name}</span>
                        {item.has_soul && (
                          <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-[10px] font-medium text-ink-secondary ring-1 ring-inset ring-ink/10">SOUL.md</span>
                        )}
                        <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-[10px] font-medium text-ink-secondary ring-1 ring-inset ring-ink/10">
                          {item.skill_count} 个技能
                        </span>
                      </div>
                      {(item.title || item.description) && (
                        <p className="mt-0.5 line-clamp-2 text-[12px] text-ink-secondary">{item.title || item.description}</p>
                      )}
                      <div className="mt-1 text-[11px] text-ink-tertiary">
                        来自 {item.owner_email} · {sourceText(item.sources)}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={installingId !== null}
                    onClick={() => void installSharedBot(item)}
                    className={`${COLLAB_BUTTON} ui-button-primary shrink-0 text-[12px]`}
                  >
                    {installingId === item.id ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Download size={13} aria-hidden="true" />}
                    添加到我的电脑
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-4 py-6 text-center text-[12px] text-ink-secondary">
              还没有好友或队友向你共享 Bot。
            </div>
          )}
        </div>
      </SettingsGroup>
    </div>
  );
}
