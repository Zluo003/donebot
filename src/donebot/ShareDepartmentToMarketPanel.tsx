import { useEffect, useId, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, ShieldCheck, Store, Users } from "lucide-react";
import { isExternalCodingAgentBot } from "../../shared/coding-agents";
import type { MarketCategory, MarketCostTier, MarketListingDetail } from "../../shared/donebot-market";
import type { Bot } from "@/state/store";
import { Select } from "@/components/Select";
import { cn } from "@/lib/cn";
import { marketApi, marketStatusMeta } from "./market-api";

export interface ShareDepartmentToMarketPanelProps {
  team: string;
  teamBots: readonly Bot[];
  routineCount: number;
  selectedSkills?: string[];
  avatars?: Record<string, string>;
  initialName: string;
  initialTagline: string;
  initialDescription: string;
  initialChangelog: string;
  onBack: () => void;
  onOpenMarket: () => void;
  onClose: () => void;
  onResultChange?: (result: MarketListingDetail | null) => void;
}

export function ShareDepartmentToMarketPanel({
  team,
  teamBots,
  routineCount,
  selectedSkills,
  avatars,
  initialName,
  initialTagline,
  initialDescription,
  initialChangelog,
  onBack,
  onOpenMarket,
  onClose,
  onResultChange,
}: ShareDepartmentToMarketPanelProps) {
  const nameId = useId();
  const catId = useId();
  const taglineId = useId();
  const descId = useId();
  const tierId = useId();
  const tagsId = useId();
  const changelogId = useId();

  const [categories, setCategories] = useState<MarketCategory[]>([]);
  const [loadingCats, setLoadingCats] = useState(true);
  const [categoryId, setCategoryId] = useState<number>(0);
  const [name, setName] = useState(initialName.slice(0, 60));
  const [tagline, setTagline] = useState(initialTagline.slice(0, 160));
  const [description, setDescription] = useState(initialDescription.slice(0, 4000));
  const [tagsText, setTagsText] = useState("");
  const [changelog, setChangelog] = useState(initialChangelog.slice(0, 1000));
  const [costTier, setCostTier] = useState<MarketCostTier>("standard");
  const [includeRoutines, setIncludeRoutines] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<MarketListingDetail | null>(null);

  useEffect(() => {
    let alive = true;
    setLoadingCats(true);
    marketApi.listCategories()
      .then(list => {
        if (!alive) return;
        setCategories(list);
        if (list.length > 0) setCategoryId(prev => prev || list[0]!.id);
      })
      .catch(cause => {
        if (alive) setError(cause instanceof Error ? cause.message : "加载 Bot 广场分类失败，请确认已登录 DoneBot 账号。");
      })
      .finally(() => {
        if (alive) setLoadingCats(false);
      });
    return () => { alive = false; };
  }, []);

  const memberChecks = useMemo(() => teamBots.map(bot => {
    const external = isExternalCodingAgentBot(bot);
    const soulRunes = Array.from((bot.soul ?? "").trim()).length;
    return { bot, external, soulRunes, soulTooShort: !external && soulRunes < 20 };
  }), [teamBots]);

  const externalNames = useMemo(
    () => memberChecks.filter(m => m.external).map(m => m.bot.name),
    [memberChecks],
  );
  const shortSoulNames = useMemo(
    () => memberChecks.filter(m => m.soulTooShort).map(m => m.bot.name),
    [memberChecks],
  );

  const precheckBlocker = useMemo(() => {
    if (teamBots.length === 0) return "该部门暂无可发布的机器人成员。";
    if (externalNames.length > 0) {
      return `部门包含暂不支持发布到 Bot 广场的外部编码代理（${externalNames.join("、")}），请先将其移出该部门后再发布。`;
    }
    if (teamBots.length > 8) return "发布到 Bot 广场的部门最多包含 8 位成员。";
    if (shortSoulNames.length > 0) {
      return `以下成员的 SOUL.md 内容不足 20 字，请先完善人设设定：${shortSoulNames.join("、")}。`;
    }
    return "";
  }, [teamBots.length, externalNames, shortSoulNames]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting || precheckBlocker) return;
    setError("");
    if (!categoryId) { setError("请选择 Bot 广场分类。"); return; }
    if (Array.from(name.trim()).length < 2) { setError("展示名称至少需要 2 个字。"); return; }
    if (Array.from(tagline.trim()).length < 4) { setError("一句话简介至少需要 4 个字。"); return; }

    const tags = tagsText
      .split(/[,，、\s]+/)
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 6);

    setSubmitting(true);
    try {
      const detail = await marketApi.publishDepartment({
        team,
        category_id: categoryId,
        name: name.trim(),
        tagline: tagline.trim(),
        description: description.trim(),
        tags,
        ...(selectedSkills !== undefined ? { skill_names: selectedSkills } : {}),
        cost_tier: costTier,
        include_routines: includeRoutines,
        ...(avatars && Object.keys(avatars).length > 0 ? { avatars } : {}),
        ...(changelog.trim() ? { changelog: changelog.trim() } : {}),
      });
      setResult(detail);
      onResultChange?.(detail);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提交发布失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  };

  if (result) {
    const status = marketStatusMeta(result.status);
    return (
      <>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4 pt-2">
          <div className="flex items-start gap-3 rounded-xl border border-hairline bg-card p-4">
            <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-emerald-500" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[15px] font-semibold text-ink">{result.name}</span>
                <span className={cn("rounded-full px-2 py-0.5 text-[12px] font-medium", status.className)}>
                  {status.label}
                </span>
                <span className="text-[12px] text-ink-secondary">v{result.latest_version}</span>
              </div>
              <p className="text-[13px] leading-relaxed text-ink-secondary">
                {result.status === "published"
                  ? "已通过网关部门专项 AI 安全审核并上架至 Bot 广场！其他用户雇佣使用后，你将持续获得四品类算力分润（本人安装不计返利）。"
                  : result.status === "rejected"
                    ? "未通过部门专项安全审核，请根据下方整改建议调整后重新提交。"
                    : "已提交至网关部门专项 AI 安全审核队列，系统将自动校验全员 SOUL、部门共享说明、例行任务与组织交接拓扑，可在「Bot 广场 → 我的发布」查看进度。"}
              </p>
            </div>
          </div>

          {result.status !== "published" && result.latest_release?.ai_report && (
            <div className="mt-3 space-y-2 rounded-xl border border-hairline bg-card p-4 text-[13px]">
              <div className="font-medium text-ink">
                AI 审核反馈（风险分：{result.latest_release.ai_report.risk_score}）
              </div>
              <p className="text-ink-secondary">{result.latest_release.ai_report.summary}</p>
              {result.latest_release.ai_report.rejection_reasons?.length ? (
                <div className="space-y-1">
                  <div className="font-medium text-danger">未通过原因</div>
                  <ul className="list-disc pl-5 text-danger/90">
                    {result.latest_release.ai_report.rejection_reasons.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                </div>
              ) : null}
              {result.latest_release.ai_report.fix_suggestions?.length ? (
                <div className="space-y-1">
                  <div className="font-medium text-ink">整改建议</div>
                  <ul className="list-disc pl-5 text-ink-secondary">
                    {result.latest_release.ai_report.fix_suggestions.map((s, i) => <li key={i}>{s}</li>)}
                  </ul>
                </div>
              ) : null}
            </div>
          )}
        </div>
        <footer className="flex justify-end gap-2 border-t border-hairline/35 px-6 py-3">
          <button type="button" onClick={onOpenMarket} className="inline-flex items-center gap-1.5 rounded-lg border border-hairline px-3.5 py-2 text-[13px] text-ink hover:bg-raised">
            <Store size={14} />前往 Bot 广场
          </button>
          <button type="button" onClick={onClose} className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white">
            完成
          </button>
        </footer>
      </>
    );
  }

  const field = "mt-1 w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[14px] text-ink disabled:opacity-60";

  return (
    <>
      <form id="share-dept-market-form" onSubmit={handleSubmit} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-4 pt-2">
        <div className="flex items-start gap-2.5 rounded-xl bg-accent/10 px-3.5 py-2.5 text-[13px] leading-relaxed text-ink-secondary">
          <ShieldCheck size={16} className="mt-0.5 shrink-0 text-accent" />
          <div>
            <span className="font-medium text-ink">部门专项脱敏与 AI 自动审核：</span>
            发布到 Bot 广场会自动剔除私有 <code className="rounded bg-raised px-1">MEMORY.md</code>、初始笔记、聊天记录与本地连接密钥，仅提交部门编制、人设、技能、群聊、例行任务与组织交接架构；网关审核 Agent 将执行防跨 Bot 乒乓循环、定时频率与组织分工 7 维专项自动审核。审核通过上架后不支持自助下架，本人安装不计返利。
          </div>
        </div>

        <div className="rounded-xl border border-hairline/60 bg-raised/35 p-3.5">
          <div className="flex items-center justify-between text-[13px]">
            <span className="inline-flex items-center gap-1.5 font-medium text-ink">
              <Users size={14} className="text-accent" />
              待发布成员（{teamBots.length} 位 · {teamBots.length >= 2 ? "部门整包" : "专家 Bot"}）
            </span>
            {routineCount > 0 && (
              <span className="text-[12px] text-ink-secondary">{routineCount} 条例行任务（安装后默认暂停）</span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {memberChecks.map(({ bot, external, soulRunes, soulTooShort }) => (
              <span
                key={bot.id}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px]",
                  external || soulTooShort
                    ? "border-danger/40 bg-danger/10 text-danger"
                    : "border-hairline/60 bg-panel text-ink",
                )}
              >
                <span className="font-medium">{bot.name}</span>
                {bot.chiefOfStaff && <span className="rounded bg-accent/15 px-1 text-[11px] text-accent">部门主 Bot</span>}
                <span className="text-[11px] opacity-80">
                  {external ? "外部代理不可发布" : `SOUL ${soulRunes} 字`}
                </span>
              </span>
            ))}
          </div>
        </div>

        {precheckBlocker && (
          <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3.5 py-2.5 text-[13px] text-danger">
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            <span>{precheckBlocker}</span>
          </div>
        )}

        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3.5 py-2.5 text-[13px] text-danger">
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={nameId} className="block text-[13px] text-ink-secondary">展示名称 *</label>
            <input id={nameId} value={name} maxLength={60} disabled={submitting} onChange={e => setName(e.target.value)} className={field} required />
          </div>
          <div>
            <label htmlFor={catId} className="block text-[13px] text-ink-secondary">广场分类 *</label>
            {loadingCats ? (
              <div className="mt-2 flex items-center gap-1.5 text-[13px] text-ink-secondary">
                <Loader2 size={13} className="animate-spin" />正在加载分类…
              </div>
            ) : (
              <Select id={catId} value={categoryId} disabled={submitting || categories.length === 0} onChange={e => setCategoryId(Number(e.target.value))} className="mt-1 w-full" required>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            )}
          </div>
        </div>

        <div>
          <label htmlFor={taglineId} className="block text-[13px] text-ink-secondary">一句话简介 *（4–160 字）</label>
          <input
            id={taglineId}
            value={tagline}
            maxLength={160}
            disabled={submitting}
            placeholder="简明说明这个部门擅长完成什么任务与协同流程"
            onChange={e => setTagline(e.target.value)}
            className={field}
            required
          />
        </div>

        <div>
          <label htmlFor={descId} className="block text-[13px] text-ink-secondary">详细说明</label>
          <textarea
            id={descId}
            value={description}
            maxLength={4000}
            rows={2}
            disabled={submitting}
            placeholder="介绍成员分工、协作流程与适用场景（选填）"
            onChange={e => setDescription(e.target.value)}
            className={field}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={tierId} className="block text-[13px] text-ink-secondary">预估算力档位</label>
            <Select id={tierId} value={costTier} disabled={submitting} onChange={e => setCostTier(e.target.value as MarketCostTier)} className="mt-1 w-full">
              <option value="light">省流（轻量文本为主）</option>
              <option value="standard">标准算力（常规多步协作）</option>
              <option value="heavy">高算力（含深度调研或媒体生成）</option>
            </Select>
          </div>
          <div>
            <label htmlFor={tagsId} className="block text-[13px] text-ink-secondary">标签（逗号分隔，最多 6 个）</label>
            <input id={tagsId} value={tagsText} disabled={submitting} placeholder="部门协作，自媒体，运营" onChange={e => setTagsText(e.target.value)} className={field} />
          </div>
        </div>

        <div>
          <label htmlFor={changelogId} className="block text-[13px] text-ink-secondary">发布说明</label>
          <input id={changelogId} value={changelog} maxLength={1000} disabled={submitting} placeholder="说明本部门配置特点或更新内容（选填）" onChange={e => setChangelog(e.target.value)} className={field} />
        </div>

        {routineCount > 0 && (
          <label className="flex items-center gap-2 text-[13px] text-ink">
            <input type="checkbox" className="size-4 accent-accent" checked={includeRoutines} disabled={submitting} onChange={e => setIncludeRoutines(e.target.checked)} />
            包含部门的 {routineCount} 条定时例行任务（他人安装后默认暂停，且须满足每小时最多触发 1 次）
          </label>
        )}
      </form>

      <footer className="flex justify-end gap-2 border-t border-hairline/35 px-6 py-3">
        <button type="button" disabled={submitting} onClick={onBack} className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised">
          返回
        </button>
        <button
          type="submit"
          form="share-dept-market-form"
          disabled={submitting || loadingCats || categories.length === 0 || Boolean(precheckBlocker)}
          className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40"
        >
          {submitting && <Loader2 size={14} className="animate-spin" />}
          {submitting ? "正在提交审核…" : "提交发布审核"}
        </button>
      </footer>
    </>
  );
}
