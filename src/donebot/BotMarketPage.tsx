import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Coins,
  Download,
  Eye,
  EyeOff,
  Loader2,
  PackagePlus,
  RefreshCw,
  Search,
  Sparkles,
  Store,
  Upload,
} from "lucide-react";
import type {
  MarketCategory,
  MarketInstalledBotInfo,
  MarketListingSummary,
} from "../../shared/donebot-market";
import { BotAvatar } from "@/components/Avatar";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { cn } from "@/lib/cn";
import { useStore } from "@/state/store";
import { formatCny, marketApi, marketStatusMeta, safeMarketColor } from "./market-api";
import { BotMarketCreatorPanel } from "./BotMarketCreatorPanel";
import { BotMarketDetailModal } from "./BotMarketDetailModal";
import { BotMarketPublishModal } from "./BotMarketPublishModal";

type MarketTab = "browse" | "mine" | "earnings";

export function BotMarketPage() {
  const { state, dispatch } = useStore();
  const { dragProps } = useCaptionChrome();
  const [tab, setTab] = useState<MarketTab>("browse");
  const [categories, setCategories] = useState<MarketCategory[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<number>(0);
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"installs" | "newest">("installs");

  const [listings, setListings] = useState<MarketListingSummary[]>([]);
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
    setLoading(true);
    setError("");
    try {
      const res = await marketApi.listBots({
        category_id: selectedCategoryId || undefined,
        q: query || undefined,
        sort,
        page: 1,
        page_size: 40,
      });
      setListings(res.items ?? []);
      setInstalledMap(res.installed_by_listing ?? {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载 Bot 广场失败，请确认已登录 DoneBot 账号。");
    } finally {
      setLoading(false);
    }
  }, [selectedCategoryId, query, sort]);

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
      const skillsMsg = res.enabled_skills.length > 0 ? `并默认启用 ${res.enabled_skills.length} 个 Skill` : "";
      showToast(`已安装「${item.name}」${skillsMsg}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "安装失败，请稍后重试。");
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleVisibility = async (item: MarketListingSummary) => {
    const nextListed = item.status === "unlisted";
    setBusyId(item.id);
    setError("");
    try {
      await marketApi.setVisibility(item.id, nextListed);
      await loadMine();
      showToast(nextListed ? `已重新上架「${item.name}」` : `已下架「${item.name}」`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "修改上架状态失败。");
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
          <h1 className="text-[15.5px] font-semibold">Bot 广场</h1>
          <span className="hidden text-[12px] text-ink-secondary sm:inline">
            发现高水平 Bot · 分享你调教的专家并赚取算力分润
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
            className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90"
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

      <div className="flex-1 overflow-y-auto px-6 py-5">
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
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setSelectedCategoryId(0)}
                    className={cn(
                      "rounded-full px-3 py-1 text-[12.5px] transition-colors",
                      selectedCategoryId === 0 ? "bg-accent text-white" : "bg-card text-ink-secondary hover:bg-raised hover:text-ink",
                    )}
                  >
                    全部
                  </button>
                  {categories.map(cat => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setSelectedCategoryId(cat.id)}
                      className={cn(
                        "rounded-full px-3 py-1 text-[12.5px] transition-colors",
                        selectedCategoryId === cat.id ? "bg-accent text-white" : "bg-card text-ink-secondary hover:bg-raised hover:text-ink",
                      )}
                    >
                      {cat.name}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-2">
                  <form
                    onSubmit={e => { e.preventDefault(); setQuery(searchInput); }}
                    className="relative"
                  >
                    <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-secondary" />
                    <input
                      value={searchInput}
                      onChange={e => {
                        setSearchInput(e.target.value);
                        if (!e.target.value.trim()) setQuery("");
                      }}
                      placeholder="搜索 Bot 名称或简介…"
                      className="w-52 rounded-xl border border-hairline bg-card py-1.5 pl-8 pr-3 text-[12.5px] text-ink outline-none focus:border-accent"
                    />
                  </form>
                  <select
                    value={sort}
                    onChange={e => setSort(e.target.value as "installs" | "newest")}
                    className="rounded-xl border border-hairline bg-card px-2.5 py-1.5 text-[12.5px] text-ink outline-none"
                  >
                    <option value="installs">按热门安装</option>
                    <option value="newest">按最新发布</option>
                  </select>
                </div>
              </div>

              {loading ? (
                <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-ink-secondary">
                  <Loader2 size={16} className="animate-spin" /> 正在逛 Bot 广场…
                </div>
              ) : listings.length === 0 ? (
                <div className="rounded-2xl border border-hairline bg-card px-6 py-14 text-center space-y-3">
                  <div className="text-[14.5px] font-medium text-ink">该分类下暂时还没有上架的 Bot</div>
                  <p className="text-[12.5px] text-ink-secondary">
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
                <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 lg:grid-cols-3">
                  {listings.map(item => {
                    const installed = installedMap[item.id];
                    const hasUpdate = Boolean(installed && item.published_version > installed.version);
                    return (
                      <article
                        key={item.id}
                        className="flex flex-col justify-between rounded-2xl border border-hairline bg-card p-4 transition-colors hover:border-accent/40"
                      >
                        <div className="space-y-3">
                          <div className="flex items-start gap-3">
                            <BotAvatar
                              bot={{
                                name: item.name,
                                color: safeMarketColor(item.appearance?.color),
                                mascotBody: item.appearance?.mascot_body as never,
                                mascotFaceColor: item.appearance?.mascot_face_color as never,
                              }}
                              expression={item.appearance?.mascot_expression as never}
                              size={42}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => setDetailId(item.id)}
                                  className="truncate text-left text-[14.5px] font-semibold text-ink hover:text-accent"
                                >
                                  {item.name}
                                </button>
                                {item.featured && (
                                  <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-500">
                                    精选
                                  </span>
                                )}
                              </div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-secondary">
                                <span className="rounded bg-raised px-1.5 py-0.5">{item.category_name}</span>
                                <span>· {item.author_name || "DoneBot 用户"}</span>
                              </div>
                            </div>
                          </div>

                          <p className="line-clamp-2 text-[12.5px] leading-relaxed text-ink-secondary">
                            {item.tagline}
                          </p>

                          <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-secondary">
                            <span className="inline-flex items-center gap-1 rounded-md bg-app px-2 py-0.5">
                              <Sparkles size={11} className="text-accent" />
                              SOUL + {item.skill_count} Skill
                            </span>
                            <span className="rounded-md bg-app px-2 py-0.5">
                              {item.install_count} 次安装
                            </span>
                            {installed && (
                              <span className={cn(
                                "rounded-md px-2 py-0.5 font-medium",
                                hasUpdate ? "bg-amber-500/15 text-amber-500" : "bg-emerald-500/15 text-emerald-500",
                              )}>
                                {hasUpdate ? `可更新至 v${item.published_version}` : "已安装"}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="mt-4 flex items-center justify-between gap-2 border-t border-hairline pt-3">
                          <button
                            type="button"
                            onClick={() => setDetailId(item.id)}
                            className="rounded-xl px-2.5 py-1.5 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
                          >
                            查看详情
                          </button>
                          {installed ? (
                            <button
                              type="button"
                              onClick={() => hasUpdate ? setDetailId(item.id) : openBotChat(installed.bot_id)}
                              className="rounded-xl bg-accent/12 px-3 py-1.5 text-[12.5px] font-medium text-accent hover:bg-accent/20"
                            >
                              {hasUpdate ? "查看更新" : "去对话"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => void handleQuickInstall(item)}
                              disabled={busyId === item.id}
                              className="inline-flex items-center gap-1 rounded-xl bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                            >
                              {busyId === item.id ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                              安装
                            </button>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
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
                <div className="text-[14.5px] font-medium text-ink">你还没有发布过 Bot</div>
                <p className="text-[12.5px] text-ink-secondary">
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
                              <span className="text-[14.5px] font-semibold text-ink">{item.name}</span>
                              <span className={cn("rounded-full px-2 py-0.5 text-[11.5px] font-medium", status.className)}>
                                {status.label}
                              </span>
                              <span className="text-[12px] text-ink-secondary">
                                {item.category_name} · v{item.latest_version}
                              </span>
                            </div>
                            <p className="mt-1 text-[12.5px] text-ink-secondary">{item.tagline}</p>
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
                          {(item.status === "published" || item.status === "unlisted") && (
                            <button
                              type="button"
                              onClick={() => void handleToggleVisibility(item)}
                              disabled={busyId === item.id}
                              className="inline-flex items-center gap-1 rounded-xl border border-hairline px-3 py-1.5 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
                            >
                              {item.status === "published" ? <EyeOff size={13} /> : <Eye size={13} />}
                              {item.status === "published" ? "下架" : "重新上架"}
                            </button>
                          )}
                        </div>
                      </div>

                      {item.last_review_note && (
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

          {tab === "earnings" && <BotMarketCreatorPanel />}
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
            setTab("mine");
            void loadMine();
            void loadBrowse();
          }}
        />
      )}
    </main>
  );
}
