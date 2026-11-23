import { useCallback, useEffect, useState } from "react";
import { AlertCircle, ArrowRightLeft, CheckCircle2, Coins, Loader2, RefreshCw, Wallet } from "lucide-react";
import type {
  MarketCreatorWallet,
  MarketRewardLedgerEntry,
  MarketWithdrawalRecord,
} from "../../shared/donebot-market";
import { cn } from "@/lib/cn";
import { formatCny, marketApi, marketCategoryLabel } from "./market-api";

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

function ledgerTypeLabel(entry: MarketRewardLedgerEntry): string {
  switch (entry.entry_type) {
    case "accrual":
      return `分润 · ${marketCategoryLabel(entry.category)}`;
    case "transfer_to_balance":
      return "转入算力余额";
    case "withdraw_request":
      return "申请支付宝提现";
    case "withdraw_refund":
      return "提现驳回退回";
    default:
      return entry.entry_type;
  }
}

export function BotMarketCreatorPanel() {
  const [wallet, setWallet] = useState<MarketCreatorWallet | null>(null);
  const [ledger, setLedger] = useState<MarketRewardLedgerEntry[]>([]);
  const [withdrawals, setWithdrawals] = useState<MarketWithdrawalRecord[]>([]);
  const [subTab, setSubTab] = useState<"ledger" | "withdrawals">("ledger");
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
      const [w, l, wd] = await Promise.all([
        marketApi.getWallet(),
        marketApi.listLedger(1, 50),
        marketApi.listWithdrawals(1, 30),
      ]);
      setWallet(w);
      setLedger(l.items ?? []);
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
                  placeholder={`留空全部转入（可用 ${formatCny(wallet.available_amount)}）`}
                  className="w-full rounded-xl border border-hairline bg-app px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
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
                disabled={transferring || wallet.available_amount < 1}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {transferring && <Loader2 size={14} className="animate-spin" />}
                立即转入算力余额
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
                    placeholder="支付宝账号（手机号或邮箱）"
                    className="w-full rounded-xl border border-hairline bg-app px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
                    required
                  />
                  <input
                    value={alipayRealName}
                    onChange={e => setAlipayRealName(e.target.value)}
                    placeholder="支付宝实名姓名"
                    className="w-full rounded-xl border border-hairline bg-app px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
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
                  placeholder={`提现金额（>= ${formatCny(wallet.min_withdraw_amount)}）`}
                  className="w-full rounded-xl border border-hairline bg-app px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={withdrawing || wallet.available_amount < wallet.min_withdraw_amount}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-accent bg-accent/10 px-4 py-2 text-[13px] font-medium text-accent hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {withdrawing && <Loader2 size={14} className="animate-spin" />}
                {wallet.available_amount < wallet.min_withdraw_amount
                  ? `满 ${formatCny(wallet.min_withdraw_amount)} 可申请提现`
                  : "提交支付宝提现申请"}
              </button>
            </form>
          </div>
        </>
      )}

      <div className="rounded-2xl border border-hairline bg-card overflow-hidden">
        <div className="flex items-center gap-1 border-b border-hairline px-4 pt-3">
          <button
            type="button"
            onClick={() => setSubTab("ledger")}
            className={cn(
              "border-b-2 px-3 pb-2.5 text-[13px] font-medium transition-colors",
              subTab === "ledger" ? "border-accent text-ink" : "border-transparent text-ink-secondary hover:text-ink",
            )}
          >
            收益流水明细（{ledger.length}）
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

        {subTab === "ledger" ? (
          ledger.length === 0 ? (
            <div className="px-4 py-10 text-center text-[13px] text-ink-secondary">
              暂无收益流水。分享你调教好的 Bot，其他用户安装并在网关消费后即可获得分润！
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[12.5px]">
                <thead className="border-b border-hairline text-ink-secondary">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">时间</th>
                    <th className="px-4 py-2.5 font-medium">类型</th>
                    <th className="px-4 py-2.5 font-medium">关联 Bot</th>
                    <th className="px-4 py-2.5 font-medium">消费基数 / 比例</th>
                    <th className="px-4 py-2.5 font-medium">金额变化</th>
                    <th className="px-4 py-2.5 font-medium">状态</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {ledger.map(row => (
                    <tr key={row.id} className="hover:bg-raised/40">
                      <td className="whitespace-nowrap px-4 py-2.5 text-ink-secondary">
                        {new Date(row.created_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-2.5 font-medium text-ink">{ledgerTypeLabel(row)}</td>
                      <td className="px-4 py-2.5 text-ink-secondary">{row.listing_name || "-"}</td>
                      <td className="px-4 py-2.5 text-ink-secondary">
                        {row.entry_type === "accrual" ? `${formatCny(row.base_cost)} × ${row.rate_percent}%` : (row.note || "-")}
                      </td>
                      <td className={cn("whitespace-nowrap px-4 py-2.5 font-semibold", row.reward_amount >= 0 ? "text-emerald-500" : "text-ink")}>
                        {row.reward_amount >= 0 ? "+" : ""}{formatCny(row.reward_amount)}
                        {row.bonus_amount > 0 ? <span className="ml-1 text-[11px] font-normal text-emerald-500">(+{formatCny(row.bonus_amount)} 加成)</span> : null}
                      </td>
                      <td className="px-4 py-2.5 text-ink-secondary">
                        {row.status === "frozen"
                          ? `冻结中${row.available_at ? `（${new Date(row.available_at).toLocaleDateString()} 解冻）` : ""}`
                          : row.status === "available"
                            ? "已解冻"
                            : "已结算"}
                      </td>
                    </tr>
                  ))}
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
