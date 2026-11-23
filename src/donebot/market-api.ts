import type {
  MarketCategory,
  MarketCostTier,
  MarketCreatorWallet,
  MarketInstalledBotInfo,
  MarketListResponse,
  MarketListingDetail,
  MarketListingSummary,
  MarketListingType,
  MarketLocalBotOption,
  MarketPublishPayload,
  MarketRewardLedgerEntry,
  MarketTransferResult,
  MarketWithdrawalRecord,
} from "../../shared/donebot-market";
import type { MausColor } from "../../shared/wire";
import { api } from "@/state/api";

const VALID_MAUS_COLORS = new Set<MausColor>([
  "green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral", "silver", "chrome",
]);

export function safeMarketColor(raw?: string | null): MausColor {
  return raw && VALID_MAUS_COLORS.has(raw as MausColor) ? (raw as MausColor) : "blue";
}

export interface MarketDetailResponse extends MarketListingDetail {
  installed_local?: MarketInstalledBotInfo;
}

export interface MarketInstallActionResponse {
  ok: boolean;
  listing_type?: MarketListingType;
  bot_id: string;
  bot_ids?: string[];
  enabled_skills: string[];
  install: MarketInstalledBotInfo;
}

export const marketApi = {
  async listCategories(): Promise<MarketCategory[]> {
    const res = await api<{ categories?: MarketCategory[] }>("/api/donebot/market/categories");
    return Array.isArray(res?.categories) ? res.categories : [];
  },

  async listLocalBots(): Promise<MarketLocalBotOption[]> {
    const res = await api<{ bots?: MarketLocalBotOption[] }>("/api/donebot/market/local-bots");
    return Array.isArray(res?.bots) ? res.bots : [];
  },

  async listBots(params: {
    category_id?: number;
    listing_type?: MarketListingType;
    q?: string;
    sort?: string;
    page?: number;
    page_size?: number;
  } = {}): Promise<MarketListResponse> {
    const qs = new URLSearchParams();
    if (params.category_id) qs.set("category_id", String(params.category_id));
    if (params.listing_type) qs.set("listing_type", params.listing_type);
    if (params.q?.trim()) qs.set("q", params.q.trim());
    if (params.sort) qs.set("sort", params.sort);
    if (params.page) qs.set("page", String(params.page));
    if (params.page_size) qs.set("page_size", String(params.page_size));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return api<MarketListResponse>(`/api/donebot/market/bots${suffix}`);
  },

  async listMine(): Promise<MarketListingSummary[]> {
    const res = await api<{ items?: MarketListingSummary[] }>("/api/donebot/market/bots/mine");
    return Array.isArray(res?.items) ? res.items : [];
  },

  getDetail(id: string): Promise<MarketDetailResponse> {
    return api<MarketDetailResponse>(`/api/donebot/market/bots/${encodeURIComponent(id)}`);
  },

  publish(payload: MarketPublishPayload): Promise<MarketListingDetail> {
    return api<MarketListingDetail>("/api/donebot/market/publish", {
      method: "POST",
      body: JSON.stringify(payload),
      timeoutMs: 40_000,
    });
  },

  setVisibility(id: string, listed: boolean): Promise<{ ok: boolean }> {
    return api<{ ok: boolean }>(`/api/donebot/market/bots/${encodeURIComponent(id)}/visibility`, {
      method: "PATCH",
      body: JSON.stringify({ listed }),
      timeoutMs: 20_000,
    });
  },

  install(id: string): Promise<MarketInstallActionResponse> {
    return api<MarketInstallActionResponse>(`/api/donebot/market/bots/${encodeURIComponent(id)}/install`, {
      method: "POST",
      body: JSON.stringify({}),
      timeoutMs: 35_000,
    });
  },

  updateInstalled(id: string, botId?: string): Promise<MarketInstallActionResponse> {
    return api<MarketInstallActionResponse>(`/api/donebot/market/bots/${encodeURIComponent(id)}/update`, {
      method: "POST",
      body: JSON.stringify(botId ? { bot_id: botId } : {}),
      timeoutMs: 35_000,
    });
  },

  report(id: string, reason_type: string, detail: string): Promise<{ ok: boolean }> {
    return api<{ ok: boolean }>(`/api/donebot/market/bots/${encodeURIComponent(id)}/report`, {
      method: "POST",
      body: JSON.stringify({ reason_type, detail }),
    });
  },

  getWallet(): Promise<MarketCreatorWallet> {
    return api<MarketCreatorWallet>("/api/donebot/market/creator/wallet");
  },

  async listLedger(page = 1, pageSize = 20): Promise<{ items: MarketRewardLedgerEntry[]; total: number }> {
    return api<{ items: MarketRewardLedgerEntry[]; total: number }>(
      `/api/donebot/market/creator/ledger?page=${page}&page_size=${pageSize}`,
    );
  },

  transferToBalance(amount?: number): Promise<MarketTransferResult> {
    return api<MarketTransferResult>("/api/donebot/market/creator/transfer", {
      method: "POST",
      body: JSON.stringify(amount !== undefined ? { amount } : {}),
    });
  },

  async listWithdrawals(page = 1, pageSize = 20): Promise<{ items: MarketWithdrawalRecord[]; total: number }> {
    return api<{ items: MarketWithdrawalRecord[]; total: number }>(
      `/api/donebot/market/creator/withdrawals?page=${page}&page_size=${pageSize}`,
    );
  },

  requestWithdrawal(payload: {
    amount: number;
    alipay_account: string;
    alipay_real_name: string;
  }): Promise<MarketWithdrawalRecord> {
    return api<MarketWithdrawalRecord>("/api/donebot/market/creator/withdrawals", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
};

export function marketStatusMeta(status: string): { label: string; className: string } {
  switch (status) {
    case "published":
      return { label: "已上架", className: "bg-emerald-500/15 text-emerald-500" };
    case "pending_review":
    case "ai_reviewing":
      return { label: "AI 审核中", className: "bg-sky-500/15 text-sky-500" };
    case "manual_review":
    case "pending_manual":
      return { label: "人工复审中", className: "bg-amber-500/15 text-amber-500" };
    case "rejected":
      return { label: "审核驳回", className: "bg-danger/15 text-danger" };
    case "unlisted":
      return { label: "已自行下架", className: "bg-ink-secondary/15 text-ink-secondary" };
    case "suspended":
    case "removed":
      return { label: "管理员封禁", className: "bg-danger/15 text-danger" };
    default:
      return { label: status || "未知", className: "bg-ink-secondary/15 text-ink-secondary" };
  }
}

export function marketCategoryLabel(cat: string): string {
  switch (cat) {
    case "llm": return "LLM 对话";
    case "image": return "图片生成";
    case "video": return "视频生成";
    case "music": return "音乐生成";
    default: return cat || "综合";
  }
}

export function formatCny(value: number | undefined | null): string {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return `¥${n.toFixed(2)}`;
}

export function costTierLabel(tier?: MarketCostTier | string): string {
  switch (tier) {
    case "light": return "省流";
    case "heavy": return "高算力";
    default: return "标准算力";
  }
}
