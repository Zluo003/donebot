/** Recharge uses the gateway account balance; pay_amount is in the payment method's currency. */
export interface DoneBotPaymentMethod {
  id: "alipay" | "wxpay";
  name: string;
  currency: string;
  available: boolean;
  min: number;
  max: number;
  remaining: number | null;
  fee_rate: number;
}

export interface DoneBotPaymentOrder {
  id: number;
  amount: number;
  pay_amount: number;
  currency: string;
  payment_type: string;
  out_trade_no: string;
  status: string;
  expires_at: string;
  created_at: string;
  qr_code?: string;
}

export interface DoneBotPaymentSnapshot {
  account_id: string;
  email: string;
  balance: number | null;
  enabled: boolean;
  methods: DoneBotPaymentMethod[];
  multiplier: number;
  bonus_mode: "bonus" | "discount";
  bonus_tiers: Array<{ min_amount: number; bonus_percent: number }>;
  notice: string;
  orders: DoneBotPaymentOrder[];
}

export interface DoneBotPaymentInput {
  account_id: string;
  amount: number;
  payment_type: "alipay" | "wxpay";
}

export const doneBotPaymentPending = (status: string): boolean => ["PENDING", "PAID", "RECHARGING"].includes(status);

export function doneBotPaymentQuote(snapshot: Pick<DoneBotPaymentSnapshot, "multiplier" | "bonus_mode" | "bonus_tiers">, amount: number, fee: number) {
  const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
  const tier = snapshot.bonus_tiers.filter(tier => tier.min_amount <= amount + 1e-9).sort((a, b) => b.min_amount - a.min_amount)[0];
  const percent = tier?.bonus_percent ?? 0;
  const base = round(amount * snapshot.multiplier);
  const discounted = snapshot.bonus_mode === "discount" && percent > 0 && percent < 100 ? round(amount * (100 - percent) / 100) : amount;
  const payBase = discounted > 0 ? discounted : amount;
  return {
    credited: snapshot.bonus_mode === "bonus" ? round(base + round(base * percent / 100)) : base,
    payable: round(payBase * (1 + fee / 100)),
  };
}
