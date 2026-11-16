import { useEffect, useRef, useState } from "react";
import { LoaderCircle, RotateCcw } from "lucide-react";
import type { BotArtifact, BotArtifactPage } from "../../../shared/artifacts";
import { intlLocale, t } from "@/lib/i18n";
import { SIDEBAR_INLINE, useMediaQuery } from "@/lib/use-media-query";
import { api, ApiError, useStore, type Bot } from "@/state/store";
import { ArtifactRow } from "./ArtifactRow";

export function artifactDateGroups(items: readonly BotArtifact[], locale = intlLocale()): Array<{ date: string; label: string; items: BotArtifact[] }> {
  const groups = new Map<string, { date: string; label: string; items: BotArtifact[] }>();
  for (const item of items) {
    const day = new Date(item.at);
    const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    let group = groups.get(date);
    if (!group) { group = { date, label: new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric" }).format(day), items: [] }; groups.set(date, group); }
    group.items.push(item);
  }
  return [...groups.values()];
}

export function ArtifactsTab({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const phone = !useMediaQuery(SIDEBAR_INLINE, true);
  const [items, setItems] = useState<BotArtifact[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const botId = useRef(bot.id);
  const failedBefore = useRef<string | undefined>(undefined);
  const load = async (before?: string) => {
    controller.current?.abort();
    const own = new AbortController(); controller.current = own;
    const current = ++generation.current;
    setLoading(true); setError(false);
    failedBefore.current = before;
    try {
      const page = await api<BotArtifactPage>(`/api/bots/${encodeURIComponent(bot.id)}/artifacts${before ? `?before=${encodeURIComponent(before)}` : ""}`, { signal: own.signal });
      if (current !== generation.current || own.signal.aborted) return;
      setItems(existing => before ? [...existing ?? [], ...page.items].filter((item, index, all) => all.findIndex(other => other.id === item.id) === index) : page.items);
      setCursor(page.nextCursor);
    } catch (reason) {
      if (current === generation.current && !own.signal.aborted) {
        setError(true);
        if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) { setItems(null); setCursor(null); }
      }
    } finally { if (current === generation.current && !own.signal.aborted) setLoading(false); }
  };
  useEffect(() => {
    if (botId.current !== bot.id) { botId.current = bot.id; setItems(null); setCursor(null); }
    const timer = setTimeout(() => void load(), 350);
    return () => { clearTimeout(timer); controller.current?.abort(); generation.current += 1; };
  }, [bot.id, bot.messages, bot.tasks, state.groups, attempt]);
  const showMessage = (item: BotArtifact) => {
    dispatch({ type: "focusMessage", threadId: item.threadId, messageId: item.reportMessageId });
    if (phone) dispatch({ type: "toggleSettings", open: false });
  };
  return <div data-panel-tabpanel="artifacts" className="pt-2">
    <div className="mb-3 flex items-start gap-2 px-2">
      <p className="flex-1 text-[12px] leading-5 text-ink-tertiary">{t("artifacts.hint", { name: bot.name })}</p>
      <button type="button" disabled={loading} onClick={() => setAttempt(attempt + 1)} aria-label={t("artifacts.refresh")} className="rounded-lg p-1.5 text-ink-secondary hover:text-ink disabled:opacity-40"><RotateCcw size={14} /></button>
    </div>
    {artifactDateGroups(items ?? []).map(group => <section key={group.date} data-artifact-date={group.date} className="mb-5">
      <h3 className="mb-1 px-2 text-[11px] font-medium text-ink-tertiary"><time dateTime={group.date}>{group.label}</time></h3>
      <ul className="flex flex-col gap-0.5">{group.items.map(item => <ArtifactRow key={`${item.id}:${item.messageId}`} item={item} onShowMessage={() => showMessage(item)} />)}</ul>
    </section>)}
    {items?.length === 0 && !loading && !error && <p data-panel-empty="artifacts" className="px-3 py-8 text-center text-[13px] text-ink-secondary">{t("artifacts.empty")}</p>}
    {error && <div role="alert" className="px-3 py-4 text-center text-[13px] text-ink-secondary"><p>{t("artifacts.loadFailed")}</p><button type="button" onClick={() => void load(failedBefore.current)} className="mt-2 text-accent">{t("chat.retry")}</button></div>}
    {loading && <div role="status" className="flex items-center justify-center gap-2 p-4 text-[12px] text-ink-secondary"><LoaderCircle size={14} className="animate-spin" />{t("artifacts.loading")}</div>}
    {cursor && !loading && !error && <button type="button" onClick={() => void load(cursor)} className="w-full rounded-xl bg-ink/[0.05] px-3 py-2 text-[13px] text-ink-secondary hover:bg-ink/[0.08]">{t("artifacts.more")}</button>}
  </div>;
}
