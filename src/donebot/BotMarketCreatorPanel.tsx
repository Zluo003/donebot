import { useCallback, useEffect, useState } from "react";
import { AlertCircle, ArrowRightLeft, CheckCircle2, Coins, Loader2, RefreshCw, Wallet } from "lucide-react";
import type {
  MarketCreatorWallet,
  MarketDailyRewardSummary,
  MarketWithdrawalRecord,
} from "../../shared/donebot-market";
import { cn } from "@/lib/cn";
import { formatCny, marketApi } from "./market-api";

function withdrawalStatusBadge(status: string): { label: string; className: string } {
  switch (status) {
    case "paid":
      return { label: "已打款", className: "bg-emerald-500/15 text-emerald-500" };
    case "rejected":
      return { label: "已驳回（已退回）", className: "bg-danger/15 text-danger" };
    default:
      return { label: "待审核打款", className: "bg-amber-500/15 text-amber-500" };
  }
}

function formatTokenCount(tokens: number): string {
  const n = Math.max(0, Math.round(Number(tokens) || 0));
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return n.toLocaleString();
}

function formatMediaBreakdown(row: MarketDailyRewardSummary): string {
  const parts: string[] = [];
  if (row.image_count > 0) parts.push(`图 ${row.image_count}`);
  if (row.video_count > 0) parts.push(`视 ${row.video_count}`);
  if (row.music_count > 0) parts.push(`乐 ${row.music_count}`);
  return parts.join(" · ");
}

export function BotMarketCreatorPanel({ cloudManaged = false }: { cloudManaged?: boolean }) {
  const [wallet, setWallet] = useState<MarketCreatorWallet | null>(null);
  const [dailySummaries, setDailySummaries] = useState<MarketDailyRewardSummary[]>([]);
  const [withdrawals, setWithdrawals] = useState<MarketWithdrawalRecord[]>([]);
  const [subTab, setSubTab] = useState<"daily" | "withdrawals">("daily");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [transferAmount, setTransferAmount] = useState("");
  const [transferring, setTransferring] = useState(false);

  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [alipayAccount, setAlipayAccount] = useState("");
  const [alipayRealName, setAlipayRealName] = useState("");
  const [withdrawing, setWithdrawing] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [w, d, wd] = await Promise.all([
        marketApi.getWallet(),
        marketApi.listDailySummaries(1, 60),
        marketApi.listWithdrawals(1, 30),
      ]);
      setWallet(w);
      setDailySummaries(d.items ?? []);
      setWithdrawals(wd.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载创作者收益失败。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadAll(); }, [loadAll]);

  const parsedTransfer = Number(transferAmount);
  const transferPreviewBase = transferAmount.trim() === ""
    ? (wallet?.available_amount ?? 0)
    : (Number.isFinite(parsedTransfer) && parsedTransfer > 0 ? parsedTransfer : 0);
  const transferBonusRate = wallet?.transfer_bonus_percent ?? 0;
  const transferPreviewBonus = transferPreviewBase * (transferBonusRate / 100);
  const transferPreviewTotal = transferPreviewBase + transferPreviewBonus;

  const handleTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wallet) return;
    setError("");
    setNotice("");
    const amt = transferAmount.trim() === "" ? undefined : Number(transferAmount);
    if (amt !== undefined && (!Number.isFinite(amt) || amt < 1)) {
      setError("单次转入算力余额不能少于 ¥1.00。");
      return;
    }
    setTransferring(true);
    try {
      const res = await marketApi.transferToBalance(amt);
      setTransferAmount("");
      setNotice(
        `已成功转入 ${formatCny(res.amount)}${res.bonus_amount > 0 ? `（含加成 ${formatCny(res.bonus_amount)}）` : ""}，实际到账算力余额 ${formatCny(res.credit_amount)}！`,
      );
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "转入算力余额失败。");
    } finally {
      setTransferring(false);
    }
  };

  const handleWithdraw = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wallet) return;
    setError("");
    setNotice("");
    const amt = Number(withdrawAmount);
    if (!Number.isFinite(amt) || amt < wallet.min_withdraw_amount) {
      setError(`提现金额不能低于最低门槛 ${formatCny(wallet.min_withdraw_amount)}。`);
      return;
    }
    if (!alipayAccount.trim() || !alipayRealName.trim()) {
      setError("请填写完整的支付宝收款账号和实名姓名。");
      return;
    }
    setWithdrawing(true);
    try {
      await marketApi.requestWithdrawal({
        amount: amt,
        alipay_account: alipayAccount.trim(),
        alipay_real_name: alipayRealName.trim(),
      });
      setWithdrawAmount("");
      setNotice(`已提交 ${formatCny(amt)} 支付宝提现申请，审核通过后将打款至 ${alipayAccount.trim()}。`);
      setSubTab("withdrawals");
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交提现申请失败。");
    } finally {
      setWithdrawing(false);
    }
  };

  if (loading && !wallet) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-ink-secondary">
        <Loader2 size={16} className="animate-spin" /> 正在加载收益账户…
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-4 py-3 text-[13px] text-danger">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 rounded-xl bg-emerald-500/12 px-4 py-3 text-[13px] text-emerald-500">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {wallet && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="rounded-2xl border border-hairline bg-card p-4">
              <div className="text-[12px] text-ink-secondary">可支配收益</div>
              <div className="mt-1 text-[22px] font-semibold text-emerald-500">{formatCny(wallet.available_amount)}</div>
              <div className="mt-1 text-[11.5px] text-ink-secondary">可转算力或申请提现</div>
            </div>
            <div className="rounded-2xl border border-hairline bg-card p-4">
              <div className="text-[12px] text-ink-secondary">冻结中收益</div>
              <div className="mt-1 text-[22px] font-semibold text-amber-500">{formatCny(wallet.frozen_amount)}</div>
              <div className="mt-1 text-[11.5px] text-ink-secondary">消费满 {wallet.freeze_days} 天自动解冻</div>
            </div>
            <div className="rounded-2xl border border-hairline bg-card p-4">
              <div className="text-[12px] text-ink-secondary">累计获得分润</div>
              <div className="mt-1 text-[22px] font-semibold text-ink">{formatCny(wallet.total_earned)}</div>
              <div className="mt-1 text-[11.5px] text-ink-secondary">仅统计网关真实结算消费</div>
            </div>
            <div className="rounded-2xl border border-hairline bg-card p-4">
              <div className="text-[12px] text-ink-secondary">已转算力 / 已提现</div>
              <div className="mt-1 text-[18px] font-semibold text-ink">
                {formatCny(wallet.total_transferred)} / {formatCny(wallet.total_withdrawn)}
              </div>
              <div className="mt-1 text-[11.5px] text-ink-secondary">
                待处理提现：{wallet.pending_withdraw_count} 笔
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-hairline bg-card px-4 py-3 text-[12.5px]">
            <div className="flex flex-wrap items-center gap-2 text-ink-secondary">
              <Coins size={15} className="text-accent" />
              <span className="font-medium text-ink">当前各品类分润比例：</span>
              <span className="rounded-md bg-app px-2 py-0.5 text-ink">LLM {wallet.rebate_llm_percent}%</span>
              <span className="rounded-md bg-app px-2 py-0.5 text-ink">图片 {wallet.rebate_image_percent}%</span>
              <span className="rounded-md bg-app px-2 py-0.5 text-ink">视频 {wallet.rebate_video_percent}%</span>
              <span className="rounded-md bg-app px-2 py-0.5 text-ink">音乐 {wallet.rebate_music_percent}%</span>
            </div>
            <button
              type="button"
              onClick={() => void loadAll()}
              disabled={loading}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> 刷新
            </button>
          </div>

          {cloudManaged && (
            <div className="flex items-start gap-2 rounded-xl bg-amber-500/10 px-4 py-3 text-[12.5px] text-amber-500">
              <AlertCircle size={15} className="mt-0.5 shrink-0" />
              <span>当前位于云空间，可随时查看创作者收益与明细；为保障资金安全，转入算力余额与申请支付宝提现请切回「这台电脑」本机登录空间操作。</span>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <form onSubmit={handleTransfer} className="flex flex-col justify-between rounded-2xl border border-hairline bg-card p-4 space-y-3">
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[14px] font-semibold text-ink">
                    <ArrowRightLeft size={16} className="text-accent" /> 转为算力余额
                  </div>
                  {transferBonusRate > 0 && (
                    <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11.5px] font-medium text-emerald-500">
                      额外赠送 +{transferBonusRate}%
                    </span>
                  )}
                </div>
                <p className="text-[12px] text-ink-secondary">
                  即时到账你的 DoneBot 算力账户（最低 ¥1.00，留空即全部转入），立即可用于调用模型。
                </p>
                <input
                  type="number"
                  step="0.01"
                  min="1"
                  max={wallet.available_amount || undefined}
                  value={transferAmount}
                  onChange={e => setTransferAmount(e.target.value)}
                  disabled={cloudManaged}
                  placeholder={`留空全部转入（可用 ${formatCny(wallet.available_amount)}）`}
                  className="w-full rounded-xl border border-hairline bg-app px-3 py-2 text-[13px] text-ink outline-none focus:border-accent disabled:opacity-50"
                />
                {transferPreviewBase >= 1 && (
                  <div className="rounded-xl bg-app/70 px-3 py-2 text-[12px] text-ink-secondary">
                    预计到账算力余额：<span className="font-semibold text-emerald-500">{formatCny(transferPreviewTotal)}</span>
                    {transferPreviewBonus > 0 && `（本金 ${formatCny(transferPreviewBase)} + 加成 ${formatCny(transferPreviewBonus)}）`}
                  </div>
                )}
              </div>
              <button
                type="submit"
                disabled={cloudManaged || transferring || wallet.available_amount < 1}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {transferring && <Loader2 size={14} className="animate-spin" />}
                {cloudManaged ? "请在本机空间操作转入" : "立即转入算力余额"}
              </button>
            </form>

            <form onSubmit={handleWithdraw} className="flex flex-col justify-between rounded-2xl border border-hairline bg-card p-4 space-y-3">
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[14px] font-semibold text-ink">
                    <Wallet size={16} className="text-accent" /> 申请支付宝提现
                  </div>
                  <span className="text-[11.5px] text-ink-secondary">
                    最低门槛 {formatCny(wallet.min_withdraw_amount)}
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <input
                    value={alipayAccount}
                    onChange={e => setAlipayAccount(e.target.value)}
                    disabled={cloudManaged}
                    placeholder="支付宝账号（手机号或邮箱）"
                    className="w-full rounded-xl border border-hairline bg-app px-3 py-2 text-[13px] text-ink outline-none focus:border-accent disabled:opacity-50"
                    required
                  />
                  <input
                    value={alipayRealName}
                    onChange={e => setAlipayRealName(e.target.value)}
                    disabled={cloudManaged}
                    placeholder="支付宝实名姓名"
                    className="w-full rounded-xl border border-hairline bg-app px-3 py-2 text-[13px] text-ink outline-none focus:border-accent disabled:opacity-50"
                    required
                  />
                </div>
                <input
                  type="number"
                  step="0.01"
                  min={wallet.min_withdraw_amount}
                  max={wallet.available_amount || undefined}
                  value={withdrawAmount}
                  onChange={e => setWithdrawAmount(e.target.value)}
                  disabled={cloudManaged}
                  placeholder={`提现金额（>= ${formatCny(wallet.min_withdraw_amount)}）`}
                  className="w-full rounded-xl border border-hairline bg-app px-3 py-2 text-[13px] text-ink outline-none focus:border-accent disabled:opacity-50"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={cloudManaged || withdrawing || wallet.available_amount < wallet.min_withdraw_amount}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-accent bg-accent/10 px-4 py-2 text-[13px] font-medium text-accent hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {withdrawing && <Loader2 size={14} className="animate-spin" />}
                {cloudManaged
                  ? "请在本机空间申请提现"
                  : wallet.available_amount < wallet.min_withdraw_amount
                    ? `满 ${formatCny(wallet.min_withdraw_amount)} 可申请提现`
                    : "提交支付宝提现申请"}
              </button>
            </form>
          </div>
        </>
      )}

      <div className="rounded-2xl border border-hairline bg-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-4 pt-3">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setSubTab("daily")}
              className={cn(
                "border-b-2 px-3 pb-2.5 text-[13px] font-medium transition-colors",
                subTab === "daily" ? "border-accent text-ink" : "border-transparent text-ink-secondary hover:text-ink",
              )}
            >
              每日收益汇总（{dailySummaries.length}）
            </button>
            <button
              type="button"
              onClick={() => setSubTab("withdrawals")}
              className={cn(
                "border-b-2 px-3 pb-2.5 text-[13px] font-medium transition-colors",
                subTab === "withdrawals" ? "border-accent text-ink" : "border-transparent text-ink-secondary hover:text-ink",
              )}
            >
              提现申请记录（{withdrawals.length}）
            </button>
          </div>
          {subTab === "daily" && (
            <span className="pb-2.5 text-[11.5px] text-ink-secondary">
              每天汇总前一日数据（次日生成，不实时刷新）
            </span>
          )}
        </div>

        {subTab === "daily" ? (
          dailySummaries.length === 0 ? (
            <div className="px-4 py-10 text-center text-[13px] text-ink-secondary">
              暂无每日收益记录。分享你调教好的 Bot 或部门，其他用户安装并在网关消费后，次日将自动汇总生成一条记录！
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[12.5px]">
                <thead className="border-b border-hairline text-ink-secondary">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">日期</th>
                    <th className="px-4 py-2.5 font-medium">已安装数量</th>
                    <th className="px-4 py-2.5 font-medium">当日消耗 Token（LLM）</th>
                    <th className="px-4 py-2.5 font-medium">当日媒体生成</th>
                    <th className="px-4 py-2.5 font-medium">获得分润</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {dailySummaries.map(row => {
                    const mediaDetail = formatMediaBreakdown(row);
                    return (
                      <tr key={row.date} className="hover:bg-raised/40">
                        <td className="whitespace-nowrap px-4 py-2.5 font-medium text-ink">
                          {row.date}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-ink">
                          {row.installed_count}
                          {row.new_installs > 0 ? (
                            <span className="ml-1.5 text-[11px] text-emerald-500">+{row.new_installs}</span>
                          ) : null}
                        </td>
                        <td
                          className="whitespace-nowrap px-4 py-2.5 text-ink"
                          title={row.llm_tokens > 0 ? `${row.llm_tokens.toLocaleString()} tokens` : undefined}
                        >
                          {formatTokenCount(row.llm_tokens)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-ink">
                          {row.media_count > 0 ? (
                            <>
                              <span>{row.media_count} 次</span>
                              {mediaDetail ? (
                                <span className="ml-1.5 text-[11px] text-ink-secondary">（{mediaDetail}）</span>
                              ) : null}
                            </>
                          ) : (
                            <span className="text-ink-secondary">0</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5">
                          <span className={cn("font-semibold", row.reward_amount > 0 ? "text-emerald-500" : "text-ink-secondary")}>
                            {row.reward_amount > 0 ? `+${formatCny(row.reward_amount)}` : formatCny(0)}
                          </span>
                          {row.reward_amount > 0 ? (
                            <span className="ml-2 text-[11px] text-ink-secondary">
                              {row.status === "frozen" ? "冻结中" : "已解冻"}
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        ) : withdrawals.length === 0 ? (
          <div className="px-4 py-10 text-center text-[13px] text-ink-secondary">暂无提现申请记录。</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead className="border-b border-hairline text-ink-secondary">
                <tr>
                  <th className="px-4 py-2.5 font-medium">申请时间</th>
                  <th className="px-4 py-2.5 font-medium">提现金额</th>
                  <th className="px-4 py-2.5 font-medium">收款支付宝</th>
                  <th className="px-4 py-2.5 font-medium">状态</th>
                  <th className="px-4 py-2.5 font-medium">打款流水 / 备注</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {withdrawals.map(w => {
                  const badge = withdrawalStatusBadge(w.status);
                  return (
                    <tr key={w.id} className="hover:bg-raised/40">
                      <td className="whitespace-nowrap px-4 py-2.5 text-ink-secondary">
                        {new Date(w.created_at).toLocaleString()}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 font-semibold text-ink">{formatCny(w.amount)}</td>
                      <td className="px-4 py-2.5 text-ink">
                        {w.alipay_account} <span className="text-ink-secondary">（{w.alipay_real_name}）</span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={cn("rounded-full px-2 py-0.5 text-[11.5px] font-medium", badge.className)}>
                          {badge.label}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-ink-secondary">
                        {w.payout_trade_no ? `流水号：${w.payout_trade_no}` : (w.admin_note || "-")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
