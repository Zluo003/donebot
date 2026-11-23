import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Download, Flag, FlaskConical, Loader2, MessageSquare, RefreshCw, ShieldCheck, Sparkles, Users, X } from "lucide-react";
import type { MarketInstalledBotInfo } from "../../shared/donebot-market";
import { BotAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import { costTierLabel, marketApi, safeMarketColor, type MarketDetailResponse } from "./market-api";

const REPORT_REASONS = [
  { value: "token_abuse", label: "恶意刷 Token / 过度消耗算力" },
  { value: "malicious_loop", label: "死循环 / 自动化滥用" },
  { value: "data_exfiltration", label: "诱导泄露隐私或敏感文件" },
  { value: "illegal_content", label: "色情 / 暴力 / 诈骗等违规内容" },
  { value: "spam_low_quality", label: "垃圾灌水 / 名不副实" },
  { value: "other", label: "其他原因" },
] as const;

export function BotMarketDetailModal({
  listingId,
  installedHint,
  onClose,
  onInstalled,
  onOpenBot,
}: {
  listingId: string;
  installedHint?: MarketInstalledBotInfo;
  onClose: () => void;
  onInstalled: (listingId: string, info: MarketInstalledBotInfo) => void;
  onOpenBot: (botId: string) => void;
}) {
  const [detail, setDetail] = useState<MarketDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyAction, setBusyAction] = useState<"install" | "update" | "report" | null>(null);
  const [notice, setNotice] = useState("");
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState<string>("token_abuse");
  const [reportDetail, setReportDetail] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    marketApi.getDetail(listingId)
      .then(res => { if (alive) setDetail(res); })
      .catch(err => { if (alive) setError(err instanceof Error ? err.message : "加载 Bot 详情失败。"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [listingId]);

  const installed = detail?.installed_local ?? installedHint;
  const hasNewVersion = Boolean(detail && installed && detail.published_version > installed.version);

  const handleInstall = async () => {
    setBusyAction("install");
    setError("");
    setNotice("");
    try {
      const res = await marketApi.install(listingId);
      onInstalled(listingId, res.install);
      setDetail(prev => prev ? { ...prev, installed_local: res.install, install_count: prev.install_count + 1 } : prev);
      const skillText = res.enabled_skills.length > 0 ? `，已默认启用 ${res.enabled_skills.length} 个 Skill` : "";
      setNotice(`安装成功${skillText}！你现在可以直接开始对话。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "安装失败，请稍后重试。");
    } finally {
      setBusyAction(null);
    }
  };

  const handleUpdate = async () => {
    if (!installed) return;
    setBusyAction("update");
    setError("");
    setNotice("");
    try {
      const res = await marketApi.updateInstalled(listingId, installed.bot_id);
      onInstalled(listingId, res.install);
      setDetail(prev => prev ? { ...prev, installed_local: res.install } : prev);
      setNotice(`已更新至 v${res.install.version}，原聊天记录与私有记忆已保留。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新失败，请稍后重试。");
    } finally {
      setBusyAction(null);
    }
  };

  const handleReport = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyAction("report");
    setError("");
    try {
      await marketApi.report(listingId, reportReason, reportDetail.trim());
      setReportOpen(false);
      setReportDetail("");
      setNotice("举报已提交，感谢你共同维护 Bot 广场内容安全。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交举报失败。");
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busyAction) onClose(); }}
    >
      <div className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-hairline bg-panel text-ink shadow-2xl">
        <div className="flex items-center justify-between border-b border-hairline px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            {detail && (
              <BotAvatar
                bot={{
                  name: detail.name,
                  color: safeMarketColor(detail.appearance?.color),
                  mascotBody: detail.appearance?.mascot_body as never,
                  mascotFaceColor: detail.appearance?.mascot_face_color as never,
                }}
                expression={detail.appearance?.mascot_expression as never}
                size={40}
              />
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-[15.5px] font-semibold">{detail?.name || "Bot 详情"}</h2>
                {detail && (
                  <span className="rounded-full bg-accent/12 px-2 py-0.5 text-[11px] font-medium text-accent">
                    {detail.category_name}
                  </span>
                )}
              </div>
              {detail && (
                <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-secondary">
                  <span>创作者：{detail.author_name || "DoneBot 用户"}</span>
                  <span>· v{detail.published_version || detail.latest_version}</span>
                  <span>· {costTierLabel(detail.cost_tier)}</span>
                  <span>· {detail.install_count} 次雇佣</span>
                  {detail.eval_verified && (
                    <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                      · <ShieldCheck size={12} /> 已实测认证
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-ink-secondary">
              <Loader2 size={16} className="animate-spin" /> 正在加载详情…
            </div>
          ) : error && !detail ? (
            <div className="flex items-start gap-2 rounded-xl bg-danger/10 p-3.5 text-[13px] text-danger">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          ) : detail ? (
            <>
              {error && (
                <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3.5 py-2.5 text-[12.5px] text-danger">
                  <AlertCircle size={15} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
              {notice && (
                <div className="flex items-start gap-2 rounded-xl bg-emerald-500/12 px-3.5 py-2.5 text-[12.5px] text-emerald-500">
                  <CheckCircle2 size={15} className="mt-0.5 shrink-0" />
                  <span>{notice}</span>
                </div>
              )}

              <div className="space-y-2">
                <p className="text-[14px] font-medium text-ink">{detail.tagline}</p>
                {detail.description && (
                  <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-secondary">
                    {detail.description}
                  </p>
                )}
                {detail.tags?.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {detail.tags.map(tag => (
                      <span key={tag} className="rounded-full bg-raised px-2.5 py-0.5 text-[11.5px] text-ink-secondary">
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {detail.listing_type === "studio" && (detail.bots_summary?.length ?? 0) > 0 && (
                <div className="rounded-xl border border-hairline bg-card p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between text-[12.5px]">
                    <span className="flex items-center gap-1.5 font-medium text-ink">
                      <Users size={14} className="text-accent" />
                      AI 工作室成员编制（{detail.bot_count ?? detail.bots_summary?.length} 位员工）
                    </span>
                    <span className="text-[11.5px] text-ink-tertiary">一键入职，按实际算力消耗计费</span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {detail.bots_summary?.map((member, idx) => (
                      <div key={idx} className="flex items-center gap-2.5 rounded-lg bg-app/75 px-3 py-2">
                        <BotAvatar bot={{ name: member.name, color: safeMarketColor(member.color) }} size={28} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12.5px] font-medium text-ink">{member.name}</div>
                          <div className="truncate text-[11px] text-ink-secondary">
                            {member.role || "专业 AI 员工"}{member.skill_count ? ` · ${member.skill_count} 技能` : ""}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {detail.eval_verified && (detail.eval_samples?.length ?? 0) > 0 && (
                <div className="rounded-xl border border-hairline bg-card p-3.5 space-y-2">
                  <div className="flex items-center justify-between text-[12.5px]">
                    <span className="flex items-center gap-1.5 font-medium text-ink">
                      <FlaskConical size={14} className="text-emerald-500" />
                      能力实验室实测认证样例（{detail.eval_samples?.length}）
                    </span>
                    <span className="text-[11px] text-ink-tertiary">真实跑通交付参考</span>
                  </div>
                  <div className="space-y-1.5">
                    {detail.eval_samples?.map((sample, idx) => (
                      <details key={idx} className="rounded-lg bg-app/70 px-3 py-2">
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[12px] font-medium text-ink [&::-webkit-details-marker]:hidden">
                          <span className="truncate">{sample.title || `实测样例 ${idx + 1}`}：{sample.prompt}</span>
                          {sample.model && (
                            <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-ink-tertiary">
                              {sample.model}{sample.latency_ms ? ` · ${(sample.latency_ms / 1000).toFixed(1)}s` : ""}
                            </span>
                          )}
                        </summary>
                        <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-words border-t border-hairline/40 pt-2 font-sans text-[12px] leading-relaxed text-ink-secondary">
                          {sample.output_preview}
                        </pre>
                      </details>
                    ))}
                  </div>
                </div>
              )}

              {detail.sample_prompts?.length > 0 && (
                <div className="rounded-xl border border-hairline bg-card p-3.5 space-y-2">
                  <div className="text-[12.5px] font-medium text-ink">示例提问</div>
                  <div className="flex flex-col gap-1.5">
                    {detail.sample_prompts.map((prompt, idx) => (
                      <div key={idx} className="rounded-lg bg-app/70 px-3 py-2 text-[12.5px] text-ink-secondary">
                        “{prompt}”
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="rounded-xl border border-hairline bg-card p-3.5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[12.5px] font-medium text-ink">SOUL.md 人设与规则</span>
                  <span className="text-[11.5px] text-ink-secondary">安装后可自由迭代调整</span>
                </div>
                <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg bg-app/70 p-3 text-[12px] leading-relaxed text-ink-secondary">
                  {detail.soul_preview || "（暂无 SOUL 预览）"}
                </pre>
              </div>

              <div className="rounded-xl border border-hairline bg-card p-3.5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
                    <Sparkles size={14} className="text-accent" />
                    内置 SKILL.md（{detail.skills?.length ?? 0}）
                  </span>
                  <span className="text-[11.5px] text-emerald-500">安装后默认启用</span>
                </div>
                {!detail.skills?.length ? (
                  <p className="text-[12px] text-ink-secondary">该 Bot 未附带额外 Skill，纯 SOUL 驱动。</p>
                ) : (
                  <div className="divide-y divide-hairline overflow-hidden rounded-lg border border-hairline">
                    {detail.skills.map(sk => {
                      const open = expandedSkill === sk.name;
                      return (
                        <div key={sk.name} className="bg-app/50">
                          <button
                            type="button"
                            onClick={() => setExpandedSkill(open ? null : sk.name)}
                            className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-raised/60"
                          >
                            <div className="min-w-0">
                              <div className="text-[12.5px] font-medium text-ink">{sk.name}</div>
                              {sk.description && (
                                <div className="truncate text-[11.5px] text-ink-secondary">{sk.description}</div>
                              )}
                            </div>
                            {open ? <ChevronDown size={14} className="shrink-0 text-ink-secondary" /> : <ChevronRight size={14} className="shrink-0 text-ink-secondary" />}
                          </button>
                          {open && (
                            <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap border-t border-hairline bg-app px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-secondary">
                              {sk.instructions}
                            </pre>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {reportOpen && (
                <form onSubmit={handleReport} className="rounded-xl border border-danger/30 bg-danger/5 p-3.5 space-y-2.5">
                  <div className="text-[12.5px] font-medium text-danger">举报该 Bot</div>
                  <select
                    value={reportReason}
                    onChange={e => setReportReason(e.target.value)}
                    className="w-full rounded-lg border border-hairline bg-app px-3 py-1.5 text-[12.5px] text-ink"
                  >
                    {REPORT_REASONS.map(r => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                  <textarea
                    value={reportDetail}
                    onChange={e => setReportDetail(e.target.value)}
                    rows={2}
                    placeholder="请补充具体异常表现（选填）"
                    className="w-full rounded-lg border border-hairline bg-app px-3 py-1.5 text-[12.5px] text-ink"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setReportOpen(false)}
                      className="rounded-lg border border-hairline px-3 py-1 text-[12px] text-ink-secondary hover:bg-raised"
                    >
                      取消
                    </button>
                    <button
                      type="submit"
                      disabled={busyAction === "report"}
                      className="rounded-lg bg-danger px-3 py-1 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                    >
                      {busyAction === "report" ? "提交中…" : "确认举报"}
                    </button>
                  </div>
                </form>
              )}
            </>
          ) : null}
        </div>

        {detail && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline px-5 py-3.5">
            <button
              type="button"
              onClick={() => setReportOpen(v => !v)}
              className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-danger"
            >
              <Flag size={14} /> 举报违规
            </button>
            <div className="flex flex-wrap items-center gap-2">
              {installed && (
                <>
                  {hasNewVersion && (
                    <button
                      type="button"
                      onClick={() => void handleUpdate()}
                      disabled={busyAction !== null}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-accent px-3.5 py-2 text-[13px] font-medium text-accent hover:bg-accent/10 disabled:opacity-50"
                    >
                      {busyAction === "update" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                      更新至 v{detail.published_version}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onOpenBot(installed.bot_id)}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:opacity-90"
                  >
                    <MessageSquare size={14} /> 去对话
                  </button>
                </>
              )}
              {(!installed || detail.status === "published") && (
                <button
                  type="button"
                  onClick={() => void handleInstall()}
                  disabled={busyAction !== null || detail.status !== "published"}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-[13px] font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50",
                    installed
                      ? "border border-hairline text-ink hover:bg-raised"
                      : "bg-accent text-white hover:opacity-90",
                  )}
                >
                  {busyAction === "install" ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                  {installed
                    ? "再安装一个副本"
                    : detail.listing_type === "studio"
                      ? `一键雇佣整套工作室（${detail.bot_count ?? 2} 位员工）`
                      : "一键安装"}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
