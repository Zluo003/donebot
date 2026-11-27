import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, FlaskConical, Loader2, ShieldCheck, Sparkles, Users, X } from "lucide-react";
import type {
  MarketCategory,
  MarketCostTier,
  MarketEvalSample,
  MarketListingDetail,
  MarketListingSummary,
  MarketListingType,
  MarketLocalBotOption,
} from "../../shared/donebot-market";
import { BotAvatar } from "@/components/Avatar";
import { Select } from "@/components/Select";
import { cn } from "@/lib/cn";
import { marketApi, marketStatusMeta, safeMarketColor } from "./market-api";
import { opcApi } from "./opc-api";

export function BotMarketPublishModal({
  categories,
  initialBotId,
  updatingListing,
  onClose,
  onPublished,
}: {
  categories: MarketCategory[];
  initialBotId?: string | null;
  updatingListing?: MarketListingSummary | null;
  onClose: () => void;
  onPublished: (detail: MarketListingDetail) => void;
}) {
  const [localBots, setLocalBots] = useState<MarketLocalBotOption[]>([]);
  const [loadingBots, setLoadingBots] = useState(true);
  const [listingType, setListingType] = useState<MarketListingType>(updatingListing?.listing_type === "studio" ? "studio" : "bot");
  const [selectedBotId, setSelectedBotId] = useState(initialBotId || updatingListing?.source_bot_id || "");
  const [selectedStudioBotIds, setSelectedStudioBotIds] = useState<string[]>([]);
  const [costTier, setCostTier] = useState<MarketCostTier>(updatingListing?.cost_tier ?? "standard");
  const [evalSamples, setEvalSamples] = useState<MarketEvalSample[]>([]);
  const [attachEvalSamples, setAttachEvalSamples] = useState(true);
  const [categoryId, setCategoryId] = useState<number>(updatingListing?.category_id || categories[0]?.id || 0);
  const [name, setName] = useState(updatingListing?.name || "");
  const [tagline, setTagline] = useState(updatingListing?.tagline || "");
  const [description, setDescription] = useState(updatingListing?.description || "");
  const [tagsText, setTagsText] = useState((updatingListing?.tags ?? []).join("，"));
  const [promptsText, setPromptsText] = useState((updatingListing?.sample_prompts ?? []).join("\n"));
  const [changelog, setChangelog] = useState("");
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<MarketListingDetail | null>(null);

  useEffect(() => {
    let alive = true;
    setLoadingBots(true);
    marketApi.listLocalBots()
      .then(list => {
        if (!alive) return;
        setLocalBots(list);
        const preferred = list.find(b => b.id === (initialBotId || updatingListing?.source_bot_id))
          ?? list.find(b => b.soul_length >= 20)
          ?? list[0];
        if (preferred) {
          setSelectedBotId(preferred.id);
          setSelectedSkills(preferred.skills.map(s => s.name));
          if (!updatingListing) {
            setName(preferred.name.slice(0, 60));
            setTagline((preferred.title || preferred.description || `${preferred.name} 智能助手`).slice(0, 160));
            setDescription((preferred.description || "").slice(0, 4000));
          }
        }
      })
      .catch(err => {
        if (alive) setError(err instanceof Error ? err.message : "加载本地 Bot 列表失败。");
      })
      .finally(() => {
        if (alive) setLoadingBots(false);
      });
    return () => { alive = false; };
  }, [initialBotId, updatingListing]);

  useEffect(() => {
    if (!categoryId && categories.length > 0) setCategoryId(categories[0]!.id);
  }, [categories, categoryId]);

  const currentBot = useMemo(
    () => localBots.find(b => b.id === selectedBotId) ?? null,
    [localBots, selectedBotId],
  );

  const selectedStudioBots = useMemo(
    () => localBots.filter(b => selectedStudioBotIds.includes(b.id)),
    [localBots, selectedStudioBotIds],
  );

  const primaryEvalBotId = listingType === "studio" ? selectedStudioBots[0]?.id : currentBot?.id;
  useEffect(() => {
    if (!primaryEvalBotId) {
      setEvalSamples([]);
      return;
    }
    let alive = true;
    opcApi.getEvals(primaryEvalBotId)
      .then(res => { if (alive) setEvalSamples(res.verifiedSamples ?? []); })
      .catch(() => { if (alive) setEvalSamples([]); });
    return () => { alive = false; };
  }, [primaryEvalBotId]);

  const toggleStudioBot = (botId: string) => {
    setSelectedStudioBotIds(prev => {
      if (prev.includes(botId)) return prev.filter(id => id !== botId);
      if (prev.length >= 8) return prev;
      return [...prev, botId];
    });
  };

  const handleSelectBot = (botId: string) => {
    setSelectedBotId(botId);
    const bot = localBots.find(b => b.id === botId);
    if (!bot) return;
    setSelectedSkills(bot.skills.map(s => s.name));
    if (!updatingListing) {
      setName(bot.name.slice(0, 60));
      setTagline((bot.title || bot.description || `${bot.name} 智能助手`).slice(0, 160));
      setDescription((bot.description || "").slice(0, 4000));
    }
  };

  const toggleSkill = (skillName: string) => {
    setSelectedSkills(prev => (
      prev.includes(skillName) ? prev.filter(n => n !== skillName) : [...prev, skillName]
    ));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const isStudio = listingType === "studio";
    if (isStudio) {
      if (selectedStudioBots.length < 2) {
        setError("部门整包至少需要勾选 2 位本地 Bot 员工。");
        return;
      }
      const weak = selectedStudioBots.find(b => b.soul_length < 20);
      if (weak) {
        setError(`「${weak.name}」的 SOUL.md 不足 20 字，请先完善人设后再打包发布。`);
        return;
      }
    } else {
      if (!currentBot) { setError("请先选择一个本地 Bot。"); return; }
      if (currentBot.soul_length < 20) {
        setError("该 Bot 的 SOUL.md 内容不足 20 字，请先在 Bot 设置中完善人设与能力规则后再分享。");
        return;
      }
    }
    if (!categoryId) { setError("请选择分类。"); return; }
    if (name.trim().length < 2) { setError("名称至少需要 2 个字。"); return; }
    if (tagline.trim().length < 4) { setError("一句话简介至少需要 4 个字。"); return; }

    const tags = tagsText
      .split(/[,，、\s]+/)
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 6);
    const samplePrompts = promptsText
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 3);

    const includedSamples = attachEvalSamples && evalSamples.length > 0 ? evalSamples : [];

    setSubmitting(true);
    try {
      const detail = await marketApi.publish({
        listing_type: listingType,
        ...(isStudio ? { bot_ids: selectedStudioBots.map(b => b.id) } : { bot_id: currentBot!.id }),
        ...(updatingListing ? { listing_id: updatingListing.id } : {}),
        category_id: categoryId,
        name: name.trim(),
        tagline: tagline.trim(),
        description: description.trim(),
        tags,
        sample_prompts: samplePrompts,
        ...(!isStudio ? { skill_names: selectedSkills } : {}),
        cost_tier: costTier,
        eval_verified: includedSamples.length > 0,
        eval_samples: includedSamples,
        ...(changelog.trim() ? { changelog: changelog.trim() } : {}),
      });
      setResult(detail);
      onPublished(detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交发布失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !submitting) onClose(); }}
    >
      <div className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-hairline bg-panel text-ink shadow-2xl">
        <div className="flex items-center justify-between border-b border-hairline px-5 py-4">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-accent" />
            <h2 className="text-[15.5px] font-semibold">
              {updatingListing ? `发布新版本 · ${updatingListing.name}` : "分享 Bot 到广场"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {result ? (
            <div className="flex flex-col gap-4 py-2">
              <div className="flex items-start gap-3 rounded-xl border border-hairline bg-card p-4">
                <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-emerald-500" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14.5px] font-semibold">{result.name}</span>
                    <span className={cn("rounded-full px-2 py-0.5 text-[11.5px] font-medium", marketStatusMeta(result.status).className)}>
                      {marketStatusMeta(result.status).label}
                    </span>
                    <span className="text-[12px] text-ink-secondary">v{result.latest_version}</span>
                  </div>
                  <p className="text-[13px] leading-relaxed text-ink-secondary">
                    {result.status === "published"
                      ? "已通过 AI 内容安全审核并自动上架至 Bot 广场！其他用户安装使用后，你将持续获得四品类算力分润。"
                      : result.status === "rejected"
                        ? "AI 内容安全审核未通过，请根据下方提示修改 SOUL.md 或 SKILL.md 后重新提交。"
                        : "已提交至网关专业 AI 安全审核队列，通常在数秒内完成审核（可在「我的发布」查看结果）。"}
                  </p>
                </div>
              </div>

              {result.status !== "published" && result.latest_release?.ai_report && (
                <div className="rounded-xl border border-hairline bg-card p-4 text-[12.5px] space-y-2">
                  <div className="font-medium text-ink">
                    AI 审核摘要（风险分：{result.latest_release.ai_risk_score}）
                  </div>
                  <p className="text-ink-secondary">{result.latest_release.ai_report.summary}</p>
                  {result.latest_release.ai_report.rejection_reasons?.length ? (
                    <div className="space-y-1">
                      <div className="font-medium text-danger">驳回原因</div>
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

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={onClose}
                  className="ui-button rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:opacity-90"
                >
                  完成
                </button>
              </div>
            </div>
          ) : (
            <form id="market-publish-form" onSubmit={handleSubmit} className="space-y-4">
              <div className="flex items-start gap-2.5 rounded-xl bg-accent/10 px-3.5 py-2.5 text-[12px] leading-relaxed text-ink-secondary">
                <ShieldCheck size={16} className="mt-0.5 shrink-0 text-accent" />
                <div>
                  <span className="font-medium text-ink">自动隐私脱敏：</span>
                  仅发布所选 Bot 的 <code className="rounded bg-raised px-1">SOUL.md</code>、勾选的 <code className="rounded bg-raised px-1">Skill</code>（含 <code className="rounded bg-raised px-1">SKILL.md</code> 及附属文本脚本/参考文件）与基础介绍；自动剔除聊天记录、私有 <code className="rounded bg-raised px-1">MEMORY.md</code>、密钥与本机工具权限，且无需上传截图。
                </div>
              </div>

              {error && (
                <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3.5 py-2.5 text-[12.5px] text-danger">
                  <AlertCircle size={15} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              {!updatingListing && (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[12.5px] font-medium text-ink">发布形态</span>
                  <div className="inline-flex rounded-xl bg-card p-0.5 ring-[0.5px] ring-hairline/70">
                    {([
                      { key: "bot", label: "单个专家 Bot" },
                      { key: "studio", label: "部门整包（2–8 位员工）" },
                    ] as const).map(opt => (
                      <button
                        key={opt.key}
                        type="button"
                        onClick={() => {
                          setListingType(opt.key);
                          if (opt.key === "studio" && selectedStudioBotIds.length === 0) {
                            const eligible = localBots.filter(b => b.soul_length >= 20).slice(0, 3).map(b => b.id);
                            setSelectedStudioBotIds(eligible);
                          }
                        }}
                        className={cn(
                          "rounded-lg px-3 py-1 text-[12px] font-medium transition-colors",
                          listingType === opt.key ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink",
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className="mb-1.5 block text-[12.5px] font-medium text-ink">
                  {listingType === "studio"
                    ? `勾选部门成员（已选 ${selectedStudioBotIds.length}/8，至少 2 位）`
                    : "选择要分享的本地 Bot"}
                </label>
                {loadingBots ? (
                  <div className="flex items-center gap-2 text-[12.5px] text-ink-secondary">
                    <Loader2 size={14} className="animate-spin" /> 正在读取本地 Bot…
                  </div>
                ) : localBots.length === 0 ? (
                  <div className="rounded-xl border border-hairline bg-card px-3 py-2.5 text-[12.5px] text-ink-secondary">
                    暂无可分享的本地 Bot（外部编码代理暂不支持分享）。
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {localBots.map(bot => {
                      const active = listingType === "studio"
                        ? selectedStudioBotIds.includes(bot.id)
                        : bot.id === selectedBotId;
                      return (
                        <button
                          key={bot.id}
                          type="button"
                          onClick={() => listingType === "studio" ? toggleStudioBot(bot.id) : handleSelectBot(bot.id)}
                          className={cn(
                            "flex items-center gap-2.5 rounded-xl border p-2.5 text-left transition-colors",
                            active ? "border-accent bg-accent/10" : "border-hairline bg-card hover:bg-raised/60",
                          )}
                        >
                          <BotAvatar
                            bot={{
                              name: bot.name,
                              color: safeMarketColor(bot.color),
                              mascotBody: bot.mascot_body as never,
                              mascotFaceColor: bot.mascot_face_color as never,
                            }}
                            expression={bot.mascot_expression as never}
                            size={32}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px] font-medium text-ink">{bot.name}</div>
                            <div className="truncate text-[11.5px] text-ink-secondary">
                              SOUL {bot.soul_length} 字 · {bot.skills.length} 个 Skill
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {listingType === "studio" && selectedStudioBots.length > 0 && (
                <div className="rounded-xl border border-hairline bg-card p-3 text-[12px] text-ink-secondary space-y-1">
                  <div className="flex items-center gap-1.5 font-medium text-ink">
                    <Users size={13} className="text-accent" />
                    部门编制预览（{selectedStudioBots.length} 位 AI 员工 · 按实际消耗自动归因分润）
                  </div>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {selectedStudioBots.map(b => (
                      <span key={b.id} className="rounded-md bg-app px-2 py-0.5 text-[11.5px] text-ink">
                        {b.name} · {b.skills.length} 技能
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {listingType === "bot" && currentBot && (
                <div className="rounded-xl border border-hairline bg-card p-3 space-y-2.5">
                  <div className="flex items-center justify-between text-[12px]">
                    <span className="font-medium text-ink">将打包的 SOUL.md</span>
                    <span className={currentBot.soul_length >= 20 ? "text-emerald-500" : "text-danger"}>
                      {currentBot.soul_length} 字{currentBot.soul_length < 20 ? "（需不少于 20 字）" : ""}
                    </span>
                  </div>
                  <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded-lg bg-app/70 p-2.5 text-[11.5px] leading-relaxed text-ink-secondary">
                    {currentBot.soul || "（未设置 SOUL.md）"}
                  </pre>

                  <div>
                    <div className="mb-1.5 flex items-center justify-between text-[12px]">
                      <span className="font-medium text-ink">
                        内置 SKILL.md（已选 {selectedSkills.length}/{currentBot.skills.length}，安装后默认启用）
                      </span>
                      {currentBot.skills.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setSelectedSkills(selectedSkills.length === currentBot.skills.length ? [] : currentBot.skills.map(s => s.name))}
                          className="text-accent hover:underline"
                        >
                          {selectedSkills.length === currentBot.skills.length ? "取消全选" : "全选"}
                        </button>
                      )}
                    </div>
                    {currentBot.skills.length === 0 ? (
                      <div className="text-[11.5px] text-ink-secondary">该 Bot 暂未安装任何 SKILL.md（可直接仅发布 SOUL.md）。</div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {currentBot.skills.map(sk => {
                          const checked = selectedSkills.includes(sk.name);
                          return (
                            <label
                              key={sk.name}
                              className={cn(
                                "inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] transition-colors",
                                checked ? "border-accent bg-accent/10 text-ink" : "border-hairline bg-app text-ink-secondary",
                              )}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleSkill(sk.name)}
                                className="accent-accent"
                              />
                              <span>{sk.name}</span>
                              {sk.files && sk.files.length > 0 && (
                                <span className="rounded bg-raised px-1 py-0.5 text-[10.5px] text-ink-tertiary">
                                  +{sk.files.length} 文件
                                </span>
                              )}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-[12.5px] font-medium text-ink">展示名称 *</label>
                  <input
                    value={name}
                    onChange={e => setName(e.target.value)}
                    maxLength={60}
                    placeholder="例如：爆款小红书图文运营专家"
                    className="w-full rounded-xl border border-hairline bg-app px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
                    required
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[12.5px] font-medium text-ink">分类 *</label>
                  <Select
                    value={categoryId}
                    onChange={e => setCategoryId(Number(e.target.value))}
                    className="w-full"
                    required
                  >
                    {categories.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </Select>
                </div>
              </div>

              <div>
                <label className="mb-1 block text-[12.5px] font-medium text-ink">一句话简介 *</label>
                <input
                  value={tagline}
                  onChange={e => setTagline(e.target.value)}
                  maxLength={160}
                  placeholder="一句话说明这个 Bot 擅长解决什么问题（4–160 字）"
                  className="w-full rounded-xl border border-hairline bg-app px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
                  required
                />
              </div>

              <div>
                <label className="mb-1 block text-[12.5px] font-medium text-ink">详细说明</label>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  rows={3}
                  maxLength={4000}
                  placeholder="介绍适用场景、核心工作流与使用技巧（选填）"
                  className="w-full rounded-xl border border-hairline bg-app px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
                />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-[12.5px] font-medium text-ink">标签（逗号分隔，最多 6 个）</label>
                  <input
                    value={tagsText}
                    onChange={e => setTagsText(e.target.value)}
                    placeholder="文案，自媒体，小红书"
                    className="w-full rounded-xl border border-hairline bg-app px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[12.5px] font-medium text-ink">示例提问（每行 1 条，最多 3 条）</label>
                  <textarea
                    value={promptsText}
                    onChange={e => setPromptsText(e.target.value)}
                    rows={2}
                    placeholder={"帮我写一篇咖啡探店笔记\n把这段口播改写成爆款标题"}
                    className="w-full rounded-xl border border-hairline bg-app px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-[12.5px] font-medium text-ink">预估算力档位</label>
                  <Select
                    value={costTier}
                    onChange={e => setCostTier(e.target.value as MarketCostTier)}
                    className="w-full"
                  >
                    <option value="light">省流（轻量文本为主）</option>
                    <option value="standard">标准算力（常规多步任务）</option>
                    <option value="heavy">高算力（重度生图 / 视频 / 深度调研）</option>
                  </Select>
                </div>
                {evalSamples.length > 0 && (
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-[12px]">
                    <input
                      type="checkbox"
                      checked={attachEvalSamples}
                      onChange={e => setAttachEvalSamples(e.target.checked)}
                      className="accent-accent"
                    />
                    <FlaskConical size={14} className="shrink-0 text-emerald-500" />
                    <span className="text-ink">
                      附带能力实验室实测样例（{evalSamples.length} 条，上架获「已实测」标识）
                    </span>
                  </label>
                )}
              </div>

              {updatingListing && (
                <div>
                  <label className="mb-1 block text-[12.5px] font-medium text-ink">版本更新日志</label>
                  <input
                    value={changelog}
                    onChange={e => setChangelog(e.target.value)}
                    maxLength={500}
                    placeholder="说明本版本优化了哪些人设或新增了什么技能"
                    className="w-full rounded-xl border border-hairline bg-app px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
                  />
                </div>
              )}
            </form>
          )}
        </div>

        {!result && (
          <div className="flex items-center justify-end gap-2 border-t border-hairline px-5 py-3.5">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-xl border border-hairline px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
            >
              取消
            </button>
            <button
              type="submit"
              form="market-publish-form"
              disabled={
                submitting
                || categories.length === 0
                || (listingType === "studio"
                  ? selectedStudioBots.length < 2 || selectedStudioBots.some(b => b.soul_length < 20)
                  : !currentBot || currentBot.soul_length < 20)
              }
              className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting && <Loader2 size={14} className="animate-spin" />}
              {updatingListing ? "提交新版本审核" : "提交发布审核"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
