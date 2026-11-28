import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Coins,
  Download,
  Eye,
  Loader2,
  PackagePlus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Store,
  Upload,
  Users,
} from "lucide-react";
import type {
  MarketCategory,
  MarketInstalledBotInfo,
  MarketListingSummary,
  MarketListingType,
} from "../../shared/donebot-market";
import { BotAvatar } from "@/components/Avatar";
import { Select } from "@/components/Select";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { cn } from "@/lib/cn";
import { useStore } from "@/state/store";
import { costTierLabel, formatCny, marketApi, marketStatusMeta, safeMarketColor } from "./market-api";
import { BotMarketCreatorPanel } from "./BotMarketCreatorPanel";
import { BotMarketDetailModal } from "./BotMarketDetailModal";
import { BotMarketPublishModal } from "./BotMarketPublishModal";

type MarketTab = "browse" | "mine" | "earnings";

export const MARKET_PAGE_SIZE = 12;

export function buildPaginationItems(currentPage: number, totalPages: number): Array<number | "ellipsis"> {
  if (totalPages <= 1) return [1];
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);

  const pages = new Set<number>([1, totalPages]);
  const start = currentPage <= 4 ? 2 : currentPage >= totalPages - 3 ? totalPages - 4 : currentPage - 1;
  const end = currentPage <= 4 ? 5 : currentPage >= totalPages - 3 ? totalPages - 1 : currentPage + 1;
  for (let p = start; p <= end; p++) {
    if (p > 1 && p < totalPages) pages.add(p);
  }

  const sorted = Array.from(pages).sort((a, b) => a - b);
  const out: Array<number | "ellipsis"> = [];
  for (const p of sorted) {
    const prev = out.at(-1);
    if (typeof prev === "number" && p - prev > 1) out.push("ellipsis");
    out.push(p);
  }
  return out;
}

export function BotMarketPage() {
  const { state, dispatch } = useStore();
  const { dragProps } = useCaptionChrome();
  const scrollRef = useRef<HTMLDivElement>(null);
  const browseReqRef = useRef(0);
  const [tab, setTab] = useState<MarketTab>("browse");
  const [categories, setCategories] = useState<MarketCategory[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<number>(0);
  const [listingTypeFilter, setListingTypeFilter] = useState<"all" | MarketListingType>("all");
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"installs" | "newest">("installs");
  const [page, setPage] = useState(1);

  const [listings, setListings] = useState<MarketListingSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [installedMap, setInstalledMap] = useState<Record<string, MarketInstalledBotInfo>>({});
  const [myListings, setMyListings] = useState<MarketListingSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState("");

  const [detailId, setDetailId] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishBotId, setPublishBotId] = useState<string | null>(null);
  const [updatingListing, setUpdatingListing] = useState<MarketListingSummary | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / MARKET_PAGE_SIZE));

  const goToPage = useCallback((nextPage: number) => {
    const clamped = Math.max(1, Math.min(totalPages, nextPage));
    if (clamped === page || loading) return;
    setPage(clamped);
    if (typeof scrollRef.current?.scrollTo === "function") {
      scrollRef.current.scrollTo({ top: 0 });
    }
  }, [totalPages, page, loading]);

  useEffect(() => {
    if (state.marketPublishBotId) {
      setPublishBotId(state.marketPublishBotId);
      setUpdatingListing(null);
      setPublishOpen(true);
      dispatch({ type: "clearMarketPublishBot" });
    }
  }, [state.marketPublishBotId, dispatch]);

  const loadCategories = useCallback(async () => {
    try {
      const cats = await marketApi.listCategories();
      setCategories(cats);
    } catch {
      // Handled when loading listings
    }
  }, []);

  const loadBrowse = useCallback(async () => {
    const reqId = ++browseReqRef.current;
    setLoading(true);
    setError("");
    try {
      const res = await marketApi.listBots({
        category_id: selectedCategoryId || undefined,
        listing_type: listingTypeFilter === "all" ? undefined : listingTypeFilter,
        q: query || undefined,
        sort,
        page,
        page_size: MARKET_PAGE_SIZE,
      });
      if (reqId !== browseReqRef.current) return;
      const items = res.items ?? [];
      const nextTotal = typeof res.total === "number" && res.total >= 0 ? res.total : items.length;
      const maxPage = Math.max(1, Math.ceil(nextTotal / MARKET_PAGE_SIZE));
      if (page > maxPage) {
        setTotal(nextTotal);
        setPage(maxPage);
        return;
      }
      setListings(items);
      setTotal(nextTotal);
      setInstalledMap(res.installed_by_listing ?? {});
    } catch (err) {
      if (reqId !== browseReqRef.current) return;
      setError(err instanceof Error ? err.message : "加载 Bot 广场失败，请确认已登录 DoneBot 账号。");
    } finally {
      if (reqId === browseReqRef.current) setLoading(false);
    }
  }, [selectedCategoryId, listingTypeFilter, query, sort, page]);

  const loadMine = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setMyListings(await marketApi.listMine());
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载我的发布失败。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadCategories(); }, [loadCategories]);

  useEffect(() => {
    if (tab === "browse") void loadBrowse();
    else if (tab === "mine") void loadMine();
  }, [tab, loadBrowse, loadMine]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(current => (current === msg ? "" : current)), 4000);
  };

  const handleQuickInstall = async (item: MarketListingSummary) => {
    setBusyId(item.id);
    setError("");
    try {
      const res = await marketApi.install(item.id);
      setInstalledMap(prev => ({ ...prev, [item.id]: res.install }));
      setListings(prev => prev.map(x => (x.id === item.id ? { ...x, install_count: x.install_count + 1 } : x)));
      const isStudio = item.listing_type === "studio" || (res.bot_ids?.length ?? 0) > 1;
      const countMsg = isStudio ? `（已入职 ${res.bot_ids?.length ?? item.bot_count ?? 2} 位 AI 员工）` : "";
      const skillsMsg = res.enabled_skills.length > 0 ? `，启用 ${res.enabled_skills.length} 个 Skill` : "";
      showToast(`已雇佣「${item.name}」${countMsg}${skillsMsg}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "安装失败，请稍后重试。");
    } finally {
      setBusyId(null);
    }
  };

  const handleRelist = async (item: MarketListingSummary) => {
    setBusyId(item.id);
    setError("");
    try {
      await marketApi.setVisibility(item.id, true);
      await loadMine();
      showToast(`已重新上架「${item.name}」`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "重新上架失败。");
    } finally {
      setBusyId(null);
    }
  };

  const openBotChat = (botId: string) => {
    setDetailId(null);
    dispatch({ type: "select", id: botId });
  };

  return (
    <main data-bot-market="" className="flex min-w-0 flex-1 flex-col bg-app text-ink">
      <header {...dragProps} className="flex h-[54px] shrink-0 items-center justify-between border-b border-hairline px-6">
        <div className="flex items-center gap-2.5">
          <Store size={18} className="text-accent" />
          <h1 className="text-[16px] font-semibold">Bot 广场</h1>
          <span className="hidden text-[12px] text-ink-secondary sm:inline">
            一键雇佣整套部门或专家员工 · 分享作品持续赚取算力分润
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setPublishBotId(null);
              setUpdatingListing(null);
              setPublishOpen(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-1.5 text-[13px] font-medium text-white hover:opacity-90"
          >
            <Upload size={14} /> 分享我的 Bot
          </button>
          <button
            type="button"
            onClick={() => {
              void loadCategories();
              if (tab === "browse") void loadBrowse();
              else if (tab === "mine") void loadMine();
            }}
            className="rounded-xl border border-hairline p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
            aria-label="刷新"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </header>

      <div className="flex items-center justify-between border-b border-hairline px-6">
        <div className="flex items-center gap-1">
          {([
            { key: "browse", label: "逛广场", icon: <Store size={14} /> },
            { key: "mine", label: "我的发布", icon: <PackagePlus size={14} /> },
            { key: "earnings", label: "创作者收益", icon: <Coins size={14} /> },
          ] as const).map(item => (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              className={cn(
                "inline-flex items-center gap-1.5 border-b-2 px-3.5 py-3 text-[13px] font-medium transition-colors",
                tab === item.key ? "border-accent text-ink" : "border-transparent text-ink-secondary hover:text-ink",
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-5xl space-y-4">
          {toast && (
            <div className="flex items-center gap-2 rounded-xl bg-emerald-500/12 px-4 py-2.5 text-[13px] text-emerald-500">
              <CheckCircle2 size={15} className="shrink-0" />
              <span>{toast}</span>
            </div>
          )}
          {error && tab !== "earnings" && (
            <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-4 py-3 text-[13px] text-danger">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {tab === "browse" && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div role="group" aria-label="类型筛选" className="inline-flex items-center rounded-xl bg-card p-0.5 ring-[0.5px] ring-hairline/70">
                    {([
                      { key: "all", label: "全部" },
                      { key: "studio", label: "部门" },
                      { key: "bot", label: "专家 Bot" },
                    ] as const).map(opt => (
                      <button
                        key={opt.key}
                        type="button"
                        onClick={() => { setListingTypeFilter(opt.key); setPage(1); }}
                        className={cn(
                          "rounded-lg px-2.5 py-1 text-[12px] font-medium transition-colors",
                          listingTypeFilter === opt.key ? "bg-raised text-ink shadow-xs" : "text-ink-secondary hover:text-ink",
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => { setSelectedCategoryId(0); setPage(1); }}
                      className={cn(
                        "rounded-full px-3 py-1 text-[12px] transition-colors",
                        selectedCategoryId === 0 ? "bg-accent text-white" : "bg-card text-ink-secondary hover:bg-raised hover:text-ink",
                      )}
                    >
                      全部分类
                    </button>
                    {categories.map(cat => (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => { setSelectedCategoryId(cat.id); setPage(1); }}
                        className={cn(
                          "rounded-full px-3 py-1 text-[12px] transition-colors",
                          selectedCategoryId === cat.id ? "bg-accent text-white" : "bg-card text-ink-secondary hover:bg-raised hover:text-ink",
                        )}
                      >
                        {cat.name}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <form
                    onSubmit={e => { e.preventDefault(); setQuery(searchInput.trim()); setPage(1); }}
                    className="relative"
                  >
                    <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-secondary" />
                    <input
                      value={searchInput}
                      onChange={e => {
                        setSearchInput(e.target.value);
                        if (!e.target.value.trim()) {
                          setQuery("");
                          setPage(1);
                        }
                      }}
                      placeholder="搜索 Bot 名称或简介…"
                      className="w-52 rounded-xl border border-hairline bg-card py-1.5 pl-8 pr-3 text-[13px] text-ink outline-none focus:border-accent"
                    />
                  </form>
                  <Select
                    value={sort}
                    onChange={e => { setSort(e.target.value as "installs" | "newest"); setPage(1); }}
                    size="sm"
                    className="shrink-0"
                  >
                    <option value="installs">按热门安装</option>
                    <option value="newest">按最新发布</option>
                  </Select>
                </div>
              </div>

              {loading && listings.length === 0 ? (
                <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-ink-secondary">
                  <Loader2 size={16} className="animate-spin" /> 正在逛 Bot 广场…
                </div>
              ) : listings.length === 0 ? (
                <div className="rounded-2xl border border-hairline bg-card px-6 py-14 text-center space-y-3">
                  <div className="text-[15px] font-medium text-ink">该分类下暂时还没有上架的 Bot</div>
                  <p className="text-[13px] text-ink-secondary">
                    成为第一个分享者，其他人安装使用后即可持续获得四品类消费分润！
                  </p>
                  <button
                    type="button"
                    onClick={() => { setPublishBotId(null); setUpdatingListing(null); setPublishOpen(true); }}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:opacity-90"
                  >
                    <Upload size={14} /> 立即分享我的 Bot
                  </button>
                </div>
              ) : (
                <>
                  <div
                    className={cn(
                      "grid grid-cols-1 gap-3.5 transition-opacity md:grid-cols-2 lg:grid-cols-3",
                      loading && "pointer-events-none opacity-60",
                    )}
                  >
                  {listings.map(item => {
                    const installed = installedMap[item.id];
                    const hasUpdate = Boolean(installed && item.published_version > installed.version);
                    const isStudio = item.listing_type === "studio" && (item.bot_count ?? 1) > 1;
                    const studioMembers = item.bots_summary ?? [];
                    return (
                      <article
                        key={item.id}
                        className="flex flex-col justify-between rounded-2xl border border-hairline/70 bg-card p-4 transition-colors hover:border-accent/45"
                      >
                        <div className="space-y-3">
                          <div className="flex items-start gap-3">
                            {isStudio && studioMembers.length > 0 ? (
                              <div className="flex shrink-0 items-center -space-x-2.5 pt-0.5">
                                {studioMembers.slice(0, 3).map((member, mIdx) => (
                                  <div key={mIdx} className="rounded-full ring-2 ring-card">
                                    <BotAvatar
                                      bot={{ name: member.name, color: safeMarketColor(member.color) }}
                                      size={30}
                                    />
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <BotAvatar
                                bot={{
                                  name: item.name,
                                  color: safeMarketColor(item.appearance?.color),
                                  mascotBody: item.appearance?.mascot_body as never,
                                  mascotFaceColor: item.appearance?.mascot_face_color as never,
                                }}
                                expression={item.appearance?.mascot_expression as never}
                                size={40}
                              />
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => setDetailId(item.id)}
                                  className="truncate text-left text-[15px] font-semibold text-ink hover:text-accent"
                                >
                                  {item.name}
                                </button>
                                {item.featured && (
                                  <span className="shrink-0 rounded bg-amber-500/12 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                                    精选
                                  </span>
                                )}
                              </div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-tertiary">
                                {isStudio && (
                                  <span className="inline-flex items-center gap-1 font-medium text-accent">
                                    <Users size={11} /> 部门 · {item.bot_count} 位员工
                                  </span>
                                )}
                                {!isStudio && <span>{item.category_name}</span>}
                                <span>· {item.author_name || "DoneBot 用户"}</span>
                                {item.eval_verified && (
                                  <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400" title="已附带能力实验室实测样例">
                                    <ShieldCheck size={11} /> 已实测
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          <p className="line-clamp-2 text-[13px] leading-relaxed text-ink-secondary">
                            {item.tagline}
                          </p>

                          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] tabular-nums text-ink-tertiary">
                            <span className="inline-flex items-center gap-1 text-ink-secondary">
                              <Sparkles size={11} className="text-accent" />
                              SOUL + {item.skill_count} 技能
                            </span>
                            <span>{costTierLabel(item.cost_tier)}</span>
                            <span>{item.install_count} 次雇佣</span>
                            {installed && (
                              <span className={cn(
                                "font-medium",
                                hasUpdate ? "text-amber-500" : "text-emerald-500",
                              )}>
                                {hasUpdate ? `可更新 v${item.published_version}` : "已入职"}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="mt-4 flex items-center justify-between gap-2 border-t border-hairline/50 pt-3">
                          <button
                            type="button"
                            onClick={() => setDetailId(item.id)}
                            className="rounded-xl px-2.5 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
                          >
                            查看详情
                          </button>
                          {installed ? (
                            <button
                              type="button"
                              onClick={() => hasUpdate ? setDetailId(item.id) : openBotChat(installed.bot_id)}
                              className="rounded-xl bg-accent/12 px-3 py-1.5 text-[13px] font-medium text-accent hover:bg-accent/20"
                            >
                              {hasUpdate ? "查看更新" : "去对话"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => void handleQuickInstall(item)}
                              disabled={busyId === item.id}
                              className="inline-flex items-center gap-1 rounded-xl bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                            >
                              {busyId === item.id ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                              {isStudio ? "雇佣部门" : "安装"}
                            </button>
                          )}
                        </div>
                      </article>
                    );
                  })}
                  </div>

                  <nav
                    aria-label="Bot 广场分页"
                    className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline/70 pt-4"
                  >
                    <div className="text-[12px] tabular-nums text-ink-secondary">
                      共 {total} 个 · 第 {page} / {totalPages} 页
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        aria-disabled={page <= 1 || loading}
                        onClick={() => goToPage(page - 1)}
                        className={cn(
                          "inline-flex min-h-8 items-center gap-1 rounded-xl border border-hairline bg-card px-2.5 text-[12px] text-ink-secondary transition-colors",
                          page <= 1 || loading ? "cursor-not-allowed opacity-45" : "hover:bg-raised hover:text-ink",
                        )}
                      >
                        <ChevronLeft size={14} aria-hidden="true" />
                        上一页
                      </button>
                      {buildPaginationItems(page, totalPages).map((entry, idx) => (
                        entry === "ellipsis" ? (
                          <span
                            key={`ellipsis-${idx}`}
                            aria-hidden="true"
                            className="inline-flex min-h-8 min-w-6 items-center justify-center text-[12px] text-ink-tertiary"
                          >
                            …
                          </span>
                        ) : (
                          <button
                            key={entry}
                            type="button"
                            aria-label={`第 ${entry} 页`}
                            aria-current={entry === page ? "page" : undefined}
                            aria-disabled={loading && entry !== page ? true : undefined}
                            onClick={() => goToPage(entry)}
                            className={cn(
                              "inline-flex min-h-8 min-w-8 items-center justify-center rounded-xl px-2 text-[12px] font-medium tabular-nums transition-colors",
                              entry === page
                                ? "bg-accent text-white"
                                : "border border-hairline bg-card text-ink-secondary hover:bg-raised hover:text-ink",
                              loading && entry !== page && "cursor-not-allowed opacity-45",
                            )}
                          >
                            {entry}
                          </button>
                        )
                      ))}
                      <button
                        type="button"
                        aria-disabled={page >= totalPages || loading}
                        onClick={() => goToPage(page + 1)}
                        className={cn(
                          "inline-flex min-h-8 items-center gap-1 rounded-xl border border-hairline bg-card px-2.5 text-[12px] text-ink-secondary transition-colors",
                          page >= totalPages || loading ? "cursor-not-allowed opacity-45" : "hover:bg-raised hover:text-ink",
                        )}
                      >
                        下一页
                        <ChevronRight size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </nav>
                </>
              )}
            </>
          )}

          {tab === "mine" && (
            loading ? (
              <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-ink-secondary">
                <Loader2 size={16} className="animate-spin" /> 正在加载我的发布…
              </div>
            ) : myListings.length === 0 ? (
              <div className="rounded-2xl border border-hairline bg-card px-6 py-14 text-center space-y-3">
                <div className="text-[15px] font-medium text-ink">你还没有发布过 Bot</div>
                <p className="text-[13px] text-ink-secondary">
                  将自己打磨好的 SOUL.md 和 SKILL.md 分享出来，自动脱敏、免传截图、AI 极速审核上架！
                </p>
                <button
                  type="button"
                  onClick={() => { setPublishBotId(null); setUpdatingListing(null); setPublishOpen(true); }}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:opacity-90"
                >
                  <Upload size={14} /> 发布第一个 Bot
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {myListings.map(item => {
                  const status = marketStatusMeta(item.status);
                  return (
                    <div key={item.id} className="rounded-2xl border border-hairline bg-card p-4 space-y-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="flex min-w-0 items-start gap-3">
                          <BotAvatar
                            bot={{
                              name: item.name,
                              color: safeMarketColor(item.appearance?.color),
                              mascotBody: item.appearance?.mascot_body as never,
                              mascotFaceColor: item.appearance?.mascot_face_color as never,
                            }}
                            expression={item.appearance?.mascot_expression as never}
                            size={40}
                          />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-[15px] font-semibold text-ink">{item.name}</span>
                              <span className={cn("rounded-full px-2 py-0.5 text-[12px] font-medium", status.className)}>
                                {status.label}
                              </span>
                              <span className="text-[12px] text-ink-secondary">
                                {item.category_name} · v{item.latest_version}
                              </span>
                            </div>
                            <p className="mt-1 text-[13px] text-ink-secondary">{item.tagline}</p>
                            <div className="mt-1.5 flex flex-wrap gap-3 text-[12px] text-ink-secondary">
                              <span>安装量：<strong className="text-ink">{item.install_count}</strong></span>
                              <span>归因消费：<strong className="text-ink">{formatCny(item.total_attributed_cost)}</strong></span>
                              <span>累计收益：<strong className="text-emerald-500">{formatCny(item.total_creator_reward)}</strong></span>
                              <span>内置 Skill：<strong className="text-ink">{item.skill_count}</strong></span>
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setDetailId(item.id)}
                            className="rounded-xl border border-hairline px-3 py-1.5 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"
                          >
                            查看详情
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setUpdatingListing(item);
                              setPublishBotId(item.source_bot_id || null);
                              setPublishOpen(true);
                            }}
                            className="rounded-xl border border-accent/40 bg-accent/10 px-3 py-1.5 text-[12px] font-medium text-accent hover:bg-accent/20"
                          >
                            发布新版本
                          </button>
                          {item.status === "unlisted" && (
                            <button
                              type="button"
                              onClick={() => void handleRelist(item)}
                              disabled={busyId === item.id}
                              className="inline-flex items-center gap-1 rounded-xl border border-hairline px-3 py-1.5 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
                            >
                              <Eye size={13} />
                              重新上架
                            </button>
                          )}
                        </div>
                      </div>

                      {item.last_review_note && item.status !== "published" && (
                        <div className={cn(
                          "rounded-xl px-3.5 py-2.5 text-[12px] leading-relaxed",
                          item.status === "rejected" ? "bg-danger/10 text-danger" : "bg-app text-ink-secondary",
                        )}>
                          <span className="font-medium">审核意见：</span>{item.last_review_note}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )
          )}

          {tab === "earnings" && <BotMarketCreatorPanel cloudManaged={state.config?.donebot?.cloudManaged === true} />}
        </div>
      </div>

      {detailId && (
        <BotMarketDetailModal
          listingId={detailId}
          installedHint={installedMap[detailId]}
          onClose={() => setDetailId(null)}
          onInstalled={(id, info) => {
            setInstalledMap(prev => ({ ...prev, [id]: info }));
            setListings(prev => prev.map(x => (x.id === id ? { ...x, install_count: x.install_count + 1 } : x)));
          }}
          onOpenBot={openBotChat}
        />
      )}

      {publishOpen && (
        <BotMarketPublishModal
          categories={categories}
          initialBotId={publishBotId}
          updatingListing={updatingListing}
          onClose={() => {
            setPublishOpen(false);
            setPublishBotId(null);
            setUpdatingListing(null);
          }}
          onPublished={() => {
            setPage(1);
            setTab("mine");
            void loadMine();
          }}
        />
      )}
    </main>
  );
}
