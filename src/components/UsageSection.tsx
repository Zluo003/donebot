import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Download, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { activeLocale, documentLanguage, t } from "@/lib/i18n";
import { listenLiveFrames } from "@/lib/live-events";
import { formatTokens, hasFiniteCost, headlineTokens } from "@/lib/usage";
import { fetchTraces, formatCost, formatDuration, USAGE_PERIODS, usageExportHref, usagePeriodRange, type UsagePeriod } from "@/lib/usage-trace";
import { formatCny } from "@/donebot/market-api";
import { opcApi } from "@/donebot/opc-api";
import { api, useStore } from "@/state/store";
import type { LocaleKey } from "@/locales";
import type { OpcSpendResponse } from "../../shared/donebot-opc";
import type { TraceList, TraceRootSummary } from "../../shared/usage-trace";
import { BotAvatar } from "./Avatar";
import { Select } from "./Select";
import { UsageBudgetCards, type BudgetState } from "./UsageBudget";
import { TraceView } from "./usage/TraceView";
import { LiveBadge, modelName, StatStrip, totalsStats } from "./usage/TraceWaterfall";

export type UsageGroupBy = "bot" | "model" | "user" | "day" | "engine" | "routine" | "department";
const ALL_OTHER_GROUPINGS: readonly UsageGroupBy[] = ["model", "department", "day", "routine", "user", "engine"];
const DONEBOT_OTHER_GROUPINGS: readonly UsageGroupBy[] = ["model", "department", "day", "routine", "user"];

const PERIOD_SPEND_DAYS: Record<UsagePeriod, number> = {
  today: 1,
  week: 7,
  month: 30,
  lastMonth: 30,
  days30: 30,
};

const PERIOD_SPEND_LABELS: Record<UsagePeriod, string> = {
  today: "今日",
  week: "近 7 天",
  month: "近 30 天",
  lastMonth: "近 30 天",
  days30: "近 30 天",
};

export interface UsageGroup {
  key: string;
  label: string;
  turns: number;
  input: number;
  output: number;
  cachedInput: number;
  costUsd: number | null;
}

interface UsageSummary {
  groupBy: UsageGroupBy;
  groups: UsageGroup[];
  budget?: BudgetState | null;
}

const GROUP_LABEL_KEYS: Record<UsageGroupBy, LocaleKey> = {
  bot: "usage.history.byBot",
  model: "usage.history.byModel",
  user: "usage.history.byUser",
  day: "usage.history.byDay",
  engine: "usage.history.byEngine",
  routine: "usage.history.byRoutine",
  department: "usage.history.byDepartment",
};

const PERIOD_LABEL_KEYS: Record<UsagePeriod, LocaleKey> = {
  today: "usage.page.today",
  week: "usage.page.week",
  month: "usage.history.thisMonth",
  lastMonth: "usage.history.lastMonth",
  days30: "usage.history.last30Days",
};

const LIVE_REFRESH_MS = 2_000;

export function usageGroupLabel(groupBy: UsageGroupBy, group: Pick<UsageGroup, "key" | "label">): string {
  if (group.key === "routine:private") return t("usage.history.privateRoutine");
  if (group.key === "bot:private") return t("usage.history.privateBot");
  if (groupBy === "routine") return group.key === "manual" ? t("usage.history.notRoutine") : group.label;
  if (groupBy === "department") return group.label || t("usage.history.noDepartment");
  if (groupBy !== "user") return group.label;
  if (group.key === "owner") return t("usage.history.owner");
  if (group.key === "bot") return t("usage.history.botToBot");
  if (group.key.startsWith("routine:")) return t("usage.history.routine", { name: group.label.replace(/^Routine: /, "") });
  return group.label;
}

function useUsageGroups(range: { from: string; to: string }, groupBy: UsageGroupBy, version: number): UsageSummary | null {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  useEffect(() => {
    let current = true;
    void api(`/api/usage?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&groupBy=${groupBy}`)
      .then((next: UsageSummary) => { if (current) setSummary(next); })
      .catch(() => { if (current) setSummary(null); });
    return () => { current = false; };
  }, [range.from, range.to, groupBy, version]);
  return summary;
}

export function GroupBars({ groupBy, groups }: { groupBy: UsageGroupBy; groups: readonly UsageGroup[] }) {
  const { state } = useStore();
  const top = [...groups].sort((a, b) => headlineTokens(b) - headlineTokens(a)).slice(0, 6);
  const max = Math.max(...top.map(headlineTokens), 0);
  if (!top.length || max <= 0) return <p className="py-2 text-[13px] text-ink-tertiary">{t("usage.page.whereEmpty")}</p>;
  return (
    <ul className="flex flex-col gap-2.5">
      {top.map((group) => {
        const tokens = headlineTokens(group);
        const pct = tokens > 0 ? Math.max(3, (tokens / max) * 100) : 0;
        const bot = groupBy === "bot" ? state.bots.find((item) => `bot:${item.id}` === group.key) : undefined;
        return (
          <li
            key={group.key}
            className="grid grid-cols-[minmax(0,10.5rem)_1fr_auto] items-center gap-3 text-[13px]"
            title={t("usage.page.turns", { count: String(group.turns) })}
          >
            <span className="flex min-w-0 items-center gap-2 text-ink">
              {bot && <BotAvatar bot={bot} state="idle" size={18} animated={false} />}
              <span className={cn("truncate", tokens <= 0 && "text-ink-tertiary")}>
                {groupBy === "model" ? modelName(group.label, state.instances) : usageGroupLabel(groupBy, group)}
              </span>
            </span>
            <span className="h-1.5 overflow-hidden rounded-full bg-inset">
              {pct > 0 && <span className="block h-full rounded-full bg-accent/80 transition-[width] duration-200" style={{ width: `${pct}%` }} />}
            </span>
            <span className={cn("min-w-[3.75rem] whitespace-nowrap text-right tabular-nums", tokens > 0 ? "text-ink-secondary" : "text-ink-tertiary")}>
              {formatTokens(tokens)}
              {hasFiniteCost(group.costUsd) && group.costUsd > 0 && ` · ${formatCost(group.costUsd)}`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function GatewaySpendCard({ spend, periodLabel }: { spend: OpcSpendResponse; periodLabel: string }) {
  const items = [
    { label: "LLM 对话", value: spend.llmCost },
    { label: "图片生成", value: spend.imageCost },
    { label: "视频生成", value: spend.videoCost },
    { label: "音乐生成", value: spend.musicCost },
  ];
  return (
    <section className="@container overflow-hidden rounded-2xl border border-hairline/55 bg-card" aria-label="网关真实算力消费">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hairline/40 px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h3 className="text-[14px] font-semibold text-ink">真实算力消费</h3>
          <span className="text-[12px] text-ink-tertiary">{periodLabel} · 网关实时结算</span>
        </div>
        <span className="whitespace-nowrap text-[20px] font-semibold tracking-tight tabular-nums text-ink">
          {formatCny(spend.totalCost)}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-px bg-hairline/35 @[420px]:grid-cols-4">
        {items.map((item) => (
          <div key={item.label} className="min-w-0 bg-card px-4 py-2.5">
            <dt className="truncate text-[11px] text-ink-tertiary">{item.label}</dt>
            <dd className={cn("mt-0.5 whitespace-nowrap text-[14px] font-medium tabular-nums", item.value > 0 ? "text-ink" : "text-ink-tertiary")}>
              {formatCny(item.value)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function WhereItWent({
  range,
  version,
  donebotGateway,
  onBudget,
}: {
  range: { from: string; to: string };
  version: number;
  donebotGateway: boolean;
  onBudget: (budget: BudgetState | null) => void;
}) {
  const groupings = donebotGateway ? DONEBOT_OTHER_GROUPINGS : ALL_OTHER_GROUPINGS;
  const [other, setOther] = useState<UsageGroupBy>("model");
  const activeOther = groupings.includes(other) ? other : "model";
  const byBot = useUsageGroups(range, "bot", version);
  const byOther = useUsageGroups(range, activeOther, version);
  useEffect(() => { onBudget(byBot?.budget ?? null); }, [byBot, onBudget]);
  return (
    <section className="@container rounded-2xl border border-hairline/55 bg-card p-4 sm:p-5" aria-label={t("usage.page.where")}>
      <h3 className="text-[14px] font-semibold text-ink">{t("usage.page.where")}</h3>
      <div className="mt-4 grid grid-cols-1 gap-5 @[680px]:grid-cols-2 @[680px]:gap-6">
        <div className="min-w-0">
          <div className="mb-3 text-[12px] font-medium text-ink-tertiary">{t(GROUP_LABEL_KEYS.bot)}</div>
          {byBot ? <GroupBars groupBy="bot" groups={byBot.groups} /> : <Loader2 size={14} className="animate-spin text-ink-secondary" />}
        </div>
        <div className="min-w-0 border-t border-hairline/40 pt-4 @[680px]:border-l @[680px]:border-t-0 @[680px]:pl-6 @[680px]:pt-0">
          <div
            role="tablist"
            aria-label={t("usage.history.groupBy")}
            className="mb-3 inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-lg bg-inset/80 p-0.5"
          >
            {groupings.map((option) => (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={activeOther === option}
                onClick={() => setOther(option)}
                className={cn(
                  "whitespace-nowrap rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
                  activeOther === option
                    ? "bg-card text-ink shadow-2xs ring-[0.5px] ring-hairline/60"
                    : "text-ink-secondary hover:text-ink",
                )}
              >
                {t(GROUP_LABEL_KEYS[option])}
              </button>
            ))}
          </div>
          {byOther?.groupBy === activeOther ? <GroupBars groupBy={activeOther} groups={byOther.groups} /> : <Loader2 size={14} className="animate-spin text-ink-secondary" />}
        </div>
      </div>
    </section>
  );
}

function startedLabel(at: number): string {
  return new Date(at).toLocaleString(documentLanguage(activeLocale()), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function RunRow({ root, onOpen }: { root: TraceRootSummary; onOpen: () => void }) {
  const { state } = useStore();
  const title = root.title || t(`trace.source.${root.source}`, { bot: root.bots[0]?.name ?? "" });
  const showCost = hasFiniteCost(root.costUsd);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-raised/60"
        data-testid="usage-run"
      >
        <span className="flex min-w-7 shrink-0 items-center -space-x-1.5">
          {root.bots.slice(0, 3).map((entry, index) => {
            const bot = state.bots.find((item) => item.id === entry.id);
            return bot
              ? <span key={entry.id} className={cn("rounded-full ring-2 ring-card", index > 1 && "hidden sm:block")}><BotAvatar bot={bot} state="idle" size={24} animated={false} /></span>
              : <span key={entry.id} className={cn("flex size-6 items-center justify-center rounded-full bg-raised text-[10px] font-semibold text-ink-secondary ring-2 ring-card", index > 1 && "hidden sm:flex")}>{entry.name.slice(0, 1).toUpperCase()}</span>;
          })}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[14px] font-medium text-ink">{title}</span>
          <span className="mt-0.5 block truncate text-[12px] text-ink-tertiary">
            {startedLabel(root.startedAt)} · {root.bots.map((bot) => bot.name).join("、")}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-[12px] tabular-nums text-ink-secondary">
          {root.running && <LiveBadge />}
          {root.errors > 0 && (
            <span className="whitespace-nowrap rounded-md bg-danger/12 px-1.5 py-0.5 text-[11px] font-medium text-danger">
              {t("trace.groupErrors", { count: String(root.errors) })}
            </span>
          )}
          {root.timed ? (
            <span className="whitespace-nowrap text-ink-tertiary">{formatDuration(root.durationMs)}</span>
          ) : (
            <span className="whitespace-nowrap rounded bg-raised px-1.5 py-0.5 text-[11px] text-ink-tertiary">{t("trace.notTimed")}</span>
          )}
          {showCost && <span className="min-w-[3.25rem] whitespace-nowrap text-right font-medium text-ink">{formatCost(root.costUsd)}</span>}
          <ChevronRight size={14} className="text-ink-tertiary" aria-hidden="true" />
        </span>
      </button>
    </li>
  );
}

/** The Usage page: a period's totals, where tokens/spend went, and every run as a trace. */
export function UsageSection() {
  const { state } = useStore();
  const donebotGateway = Boolean(state.config?.donebot?.enabled);
  const [period, setPeriod] = useState<UsagePeriod>("month");
  const range = useMemo(() => usagePeriodRange(period), [period]);
  const [list, setList] = useState<TraceList | null>(null);
  const [spend, setSpend] = useState<OpcSpendResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [budget, setBudget] = useState<BudgetState | null>(null);
  const [open, setOpen] = useState<{ id: string; at: number } | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let current = true;
    void fetchTraces(range)
      .then((next) => { if (current) { setList(next); setError(null); } })
      .catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { current = false; };
  }, [range, version]);

  useEffect(() => {
    if (!donebotGateway) { setSpend(null); return; }
    let current = true;
    void opcApi.getSpend(PERIOD_SPEND_DAYS[period])
      .then((next) => { if (current) setSpend(next.available ? next : null); })
      .catch(() => { if (current) setSpend(null); });
    return () => { current = false; };
  }, [donebotGateway, period, version]);

  useEffect(() => listenLiveFrames({
    onFrame: (frame) => {
      if (frame.kind !== "runtime" || pending.current) return;
      const type = (frame.event as { type?: string } | undefined)?.type;
      if (type !== "turn.started" && type !== "turn.completed") return;
      pending.current = setTimeout(() => { pending.current = null; setVersion((value) => value + 1); }, LIVE_REFRESH_MS);
    },
    onMissedFrames: () => setVersion((value) => value + 1),
  }), []);
  useEffect(() => () => { if (pending.current) clearTimeout(pending.current); }, []);

  const more = () => {
    if (!list?.next) return;
    void fetchTraces(range, list.next).then((page) => setList((current) => current ? { ...page, roots: [...current.roots, ...page.roots] } : page));
  };
  const untimed = list?.roots.some((root) => !root.timed);

  const statItems = useMemo(() => {
    if (!list) return null;
    const base = totalsStats(list.totals, t("trace.stat.time"));
    if (spend && !hasFiniteCost(list.totals.costUsd)) {
      return base.map((item, idx) => (idx === 1 ? { ...item, value: formatCny(spend.totalCost) } : item));
    }
    return base;
  }, [list, spend]);

  return (
    <div className="@container flex flex-col gap-4" data-testid="usage-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-ink-secondary">{t("usage.page.subtitle")}</p>
        <div className="flex shrink-0 items-center gap-2">
          <Select size="sm" value={period} onChange={(event) => { setPeriod(event.target.value as UsagePeriod); setOpen(null); }} aria-label={t("usage.history.period")}>
            {USAGE_PERIODS.map((option) => <option key={option} value={option}>{t(PERIOD_LABEL_KEYS[option])}</option>)}
          </Select>
          <a
            href={usageExportHref(range)}
            download
            className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-hairline/55 bg-card px-2.5 py-1.5 text-[12px] font-medium text-ink-secondary transition-colors hover:bg-raised/60 hover:text-ink"
          >
            <Download size={13} aria-hidden="true" />
            {t("usage.history.export")}
          </a>
        </div>
      </div>
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      {open ? (
        <TraceView id={open.id} at={open.at} actions={(
          <button type="button" onClick={() => setOpen(null)} className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink">
            <ArrowLeft size={13} />{t("trace.back")}
          </button>
        )} />
      ) : (
        <>
          {spend && <GatewaySpendCard spend={spend} periodLabel={PERIOD_SPEND_LABELS[period]} />}
          <section className="overflow-hidden rounded-2xl border border-hairline/55 bg-card" data-testid="usage-totals">
            {statItems ? <StatStrip items={statItems} />
              : <div className="flex items-center gap-2 p-5 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin" />{t("common.checking")}</div>}
          </section>
          <WhereItWent range={range} version={version} donebotGateway={donebotGateway} onBudget={setBudget} />
          <section className="rounded-2xl border border-hairline/55 bg-card p-2" aria-label={t("usage.page.runs")}>
            <div className="px-3 pb-2 pt-2.5">
              <h3 className="text-[14px] font-semibold text-ink">{t("usage.page.runs")}</h3>
              <p className="mt-0.5 text-[12px] text-ink-tertiary">{t("usage.page.runsHint")}</p>
            </div>
            {list && !list.roots.length && <p className="px-3 py-4 text-[13px] text-ink-tertiary">{t("usage.page.runsEmpty")}</p>}
            <ul className="flex flex-col divide-y divide-hairline/30">
              {list?.roots.map((root) => <RunRow key={root.id} root={root} onOpen={() => setOpen({ id: root.id, at: root.startedAt })} />)}
            </ul>
            {list?.next !== undefined && (
              <button type="button" onClick={more} className="m-2 rounded-lg px-3 py-1.5 text-[13px] font-medium text-accent hover:bg-raised/60">{t("usage.page.more")}</button>
            )}
            {untimed && <p className="px-3 pb-3 pt-1 text-[12px] text-ink-tertiary">{t("usage.page.untimedNote")}</p>}
          </section>
        </>
      )}
      <UsageBudgetCards budget={budget} />
    </div>
  );
}
