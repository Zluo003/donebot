import type {
  MarketCategory,
  MarketCreatorWallet,
  MarketListingDetail,
  MarketListingSummary,
  MarketRewardLedgerEntry,
  MarketSkillDoc,
  MarketTransferResult,
  MarketWithdrawalRecord,
} from "../../shared/donebot-market.ts";
import { fetchWithTransientGetRetry, type CollabGatewayTransport } from "./collab-gateway.ts";
import { DoneBotGatewayError } from "./gateway.ts";

export interface GatewayMarketInstallPayload {
  install_id: string;
  listing_id: string;
  release_id: string;
  version: number;
  name: string;
  install_token: string;
  expires_at: string;
  package: unknown;
  skills: MarketSkillDoc[];
  soul_text: string;
  sample_prompts?: string[];
}

function extractMarketError(value: unknown, status: number, fallback: string): string {
  if (status === 429) return "请求过于频繁，请稍候几秒再试。";
  if (value && typeof value === "object") {
    const rec = value as { message?: unknown; error?: unknown };
    if (typeof rec.message === "string" && rec.message.trim()) return rec.message.trim();
    if (typeof rec.error === "string" && rec.error.trim()) return rec.error.trim();
  }
  return status === 401 ? "登录已失效，请先重新登录 DoneBot 账号。" : fallback;
}

async function marketJsonCall<T>(
  ctx: CollabGatewayTransport,
  path: string,
  method: string,
  body?: unknown,
  timeoutMs = 20_000,
): Promise<T> {
  const epoch = ctx.epoch();
  const session = await ctx.validSession();
  ctx.checkEpoch(epoch);
  if (session.mode === "installation") {
    throw new DoneBotGatewayError(403, "market_login_required", "请先在本机登录 DoneBot 账号后再使用 Bot 广场。");
  }
  const controller = new AbortController();
  ctx.controllers.add(controller);
  const headers: Record<string, string> = {
    authorization: `Bearer ${session.accessToken}`,
    "content-type": "application/json",
    ...(session.installationId ? { "X-DoneBot-Installation": session.installationId } : {}),
  };
  try {
    const response = await fetchWithTransientGetRetry(
      ctx.fetcher,
      `${ctx.origin}/api/v1/donebot/market${path}`,
      { method, redirect: "error", credentials: "omit", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      controller,
      timeoutMs,
      () => ctx.checkEpoch(epoch),
    );
    const value = await ctx.readGatewayJson(response) as { code?: number; data?: unknown };
    ctx.checkEpoch(epoch);
    if (!response.ok || (value.code !== undefined && value.code !== 0)) {
      throw new DoneBotGatewayError(
        response.status,
        "market_request_failed",
        extractMarketError(value, response.status, "Bot 广场请求失败，请稍后重试。"),
      );
    }
    return (value.code === 0 && "data" in value ? value.data : value) as T;
  } finally {
    ctx.controllers.delete(controller);
  }
}

export function createDoneBotMarketClient(ctx: () => CollabGatewayTransport) {
  return {
    async listCategories(): Promise<{ categories: MarketCategory[] }> {
      return marketJsonCall(ctx(), "/categories", "GET");
    },
    async listMarketplace(params: URLSearchParams): Promise<{ items: MarketListingSummary[]; total: number; page: number; page_size: number }> {
      const qs = params.toString();
      return marketJsonCall(ctx(), `/bots${qs ? `?${qs}` : ""}`, "GET");
    },
    async listMine(): Promise<{ items: MarketListingSummary[] }> {
      return marketJsonCall(ctx(), "/bots/mine", "GET");
    },
    async getDetail(id: string): Promise<MarketListingDetail> {
      return marketJsonCall(ctx(), `/bots/${encodeURIComponent(id)}`, "GET");
    },
    async publish(payload: Record<string, unknown>): Promise<MarketListingDetail> {
      return marketJsonCall(ctx(), "/bots", "POST", payload, 35_000);
    },
    async setVisibility(id: string, listed: boolean): Promise<{ ok: boolean }> {
      return marketJsonCall(ctx(), `/bots/${encodeURIComponent(id)}/visibility`, "PATCH", { listed });
    },
    async install(id: string): Promise<GatewayMarketInstallPayload> {
      return marketJsonCall(ctx(), `/bots/${encodeURIComponent(id)}/install`, "POST", {}, 30_000);
    },
    async report(id: string, payload: { reason_type: string; detail: string }): Promise<{ ok: boolean }> {
      return marketJsonCall(ctx(), `/bots/${encodeURIComponent(id)}/report`, "POST", payload);
    },
    async getCreatorWallet(): Promise<MarketCreatorWallet> {
      return marketJsonCall(ctx(), "/creator/wallet", "GET");
    },
    async listCreatorLedger(params: URLSearchParams): Promise<{ items: MarketRewardLedgerEntry[]; total: number; page: number; page_size: number }> {
      const qs = params.toString();
      return marketJsonCall(ctx(), `/creator/ledger${qs ? `?${qs}` : ""}`, "GET");
    },
    async transferToBalance(amount?: number): Promise<MarketTransferResult> {
      return marketJsonCall(ctx(), "/creator/transfer", "POST", amount !== undefined ? { amount } : {});
    },
    async listCreatorWithdrawals(params: URLSearchParams): Promise<{ items: MarketWithdrawalRecord[]; total: number; page: number; page_size: number }> {
      const qs = params.toString();
      return marketJsonCall(ctx(), `/creator/withdrawals${qs ? `?${qs}` : ""}`, "GET");
    },
    async requestWithdrawal(payload: { amount: number; alipay_account: string; alipay_real_name: string }): Promise<MarketWithdrawalRecord> {
      return marketJsonCall(ctx(), "/creator/withdrawals", "POST", payload);
    },
  };
}
