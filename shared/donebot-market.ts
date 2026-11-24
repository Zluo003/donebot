export const MARKET_INSTALL_HEADER = "X-DoneBot-Market-Install";
export const MARKET_BOT_ID_HEADER = "X-DoneBot-Bot-Id";

export type MarketListingType = "bot" | "studio";
export type MarketCostTier = "light" | "standard" | "heavy";

export interface MarketStudioBotSummary {
  name: string;
  role?: string;
  avatar?: string;
  color?: string;
  skill_count?: number;
}

export interface MarketEvalSample {
  title?: string;
  prompt: string;
  output_preview: string;
  model?: string;
  latency_ms?: number;
  verified_at?: string;
}

export interface MarketBotSpendRow {
  bot_id: string;
  total_cost: number;
  llm_cost: number;
  image_cost: number;
  video_cost: number;
  music_cost: number;
  event_count: number;
  last_used_at: string;
}

export interface MarketBotSpendSummary {
  days: number;
  total_cost: number;
  llm_cost: number;
  image_cost: number;
  video_cost: number;
  music_cost: number;
  bots: MarketBotSpendRow[];
}

export interface MarketCategory {
  id: number;
  slug: string;
  name: string;
  description: string;
  sort_order: number;
  enabled: boolean;
  listing_count?: number;
  created_at?: string;
  updated_at?: string;
}

export interface MarketSkillSupportFile {
  path: string;
  content: string;
}

export interface MarketSkillDoc {
  name: string;
  description?: string;
  instructions: string;
  files?: MarketSkillSupportFile[];
}

export interface MarketAIReviewDimension {
  passed: boolean;
  score: number;
  finding: string;
}

export interface MarketAIReviewReport {
  verdict: "approve" | "manual_review" | "reject" | string;
  risk_score: number;
  summary: string;
  dimensions?: Record<string, MarketAIReviewDimension>;
  rejection_reasons?: string[];
  fix_suggestions?: string[];
  flagged_snippets?: string[];
  model?: string;
  checked_at?: string;
}

export interface MarketReleaseDetail {
  id: string;
  listing_id: string;
  version: number;
  changelog: string;
  soul_text: string;
  skills: MarketSkillDoc[];
  package_sha256: string;
  package_bytes: number;
  review_status: string;
  ai_verdict?: string;
  ai_risk_score: number;
  ai_report?: MarketAIReviewReport | null;
  review_note?: string;
  reviewed_at?: string | null;
  created_at: string;
}

export interface MarketBotAppearance {
  color?: string;
  mascot_body?: string;
  mascot_face_color?: string;
  mascot_expression?: string;
}

export interface MarketListingSummary {
  id: string;
  listing_type?: MarketListingType;
  bot_count?: number;
  bots_summary?: MarketStudioBotSummary[];
  eval_verified?: boolean;
  eval_samples?: MarketEvalSample[];
  cost_tier?: MarketCostTier;
  author_user_id: number;
  author_name: string;
  author_avatar_url?: string;
  category_id: number;
  category_name: string;
  category_slug: string;
  source_bot_id?: string;
  name: string;
  tagline: string;
  description: string;
  tags: string[];
  sample_prompts: string[];
  appearance?: MarketBotAppearance;
  has_soul: boolean;
  skill_count: number;
  skill_names: string[];
  latest_release_id?: string;
  published_release_id?: string;
  latest_version: number;
  published_version: number;
  status: string;
  featured: boolean;
  install_count: number;
  total_attributed_cost?: number;
  total_creator_reward?: number;
  report_count?: number;
  last_review_note?: string;
  published_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface MarketListingDetail extends MarketListingSummary {
  soul_preview: string;
  skills: MarketSkillDoc[];
  latest_release?: MarketReleaseDetail | null;
}

export interface MarketInstalledBotInfo {
  bot_id: string;
  bot_ids?: string[];
  install_id: string;
  listing_id: string;
  release_id: string;
  version: number;
  expires_at: string;
  installed_at: number;
}

export interface MarketListResponse {
  items: MarketListingSummary[];
  total: number;
  page: number;
  page_size: number;
  installed_by_listing?: Record<string, MarketInstalledBotInfo>;
}

export interface MarketLocalSkillOption {
  name: string;
  description: string;
  enabled: boolean;
  files?: string[];
}

export interface MarketLocalBotOption {
  id: string;
  name: string;
  title: string;
  description: string;
  color: string;
  mascot_body?: string;
  mascot_face_color?: string;
  mascot_expression?: string;
  soul: string;
  soul_length: number;
  has_soul: boolean;
  skills: MarketLocalSkillOption[];
}

export interface MarketPublishPayload {
  bot_id?: string;
  bot_ids?: string[];
  listing_type?: MarketListingType;
  listing_id?: string;
  category_id: number;
  name: string;
  tagline: string;
  description: string;
  tags?: string[];
  sample_prompts?: string[];
  skill_names?: string[];
  cost_tier?: MarketCostTier;
  eval_verified?: boolean;
  eval_samples?: MarketEvalSample[];
  changelog?: string;
}

export interface MarketDepartmentPublishPayload {
  team: string;
  category_id: number;
  name: string;
  tagline: string;
  description?: string;
  tags?: string[];
  sample_prompts?: string[];
  skill_names?: string[];
  cost_tier?: MarketCostTier;
  include_routines?: boolean;
  avatars?: Record<string, string>;
  changelog?: string;
}

export interface MarketCreatorWallet {
  user_id: number;
  frozen_amount: number;
  available_amount: number;
  total_earned: number;
  total_transferred: number;
  total_withdrawn: number;
  min_withdraw_amount: number;
  freeze_days: number;
  transfer_bonus_percent: number;
  rebate_llm_percent: number;
  rebate_image_percent: number;
  rebate_video_percent: number;
  rebate_music_percent: number;
  pending_withdraw_count: number;
  updated_at: string;
}

export interface MarketRewardLedgerEntry {
  id: number;
  listing_id?: string;
  listing_name?: string;
  entry_type: string;
  category: string;
  tokens?: number;
  base_cost: number;
  rate_percent: number;
  reward_amount: number;
  bonus_amount: number;
  status: string;
  available_at?: string | null;
  note?: string;
  created_at: string;
}

export interface MarketDailyRewardSummary {
  date: string;
  installed_count: number;
  new_installs: number;
  llm_tokens: number;
  llm_calls: number;
  media_count: number;
  image_count: number;
  video_count: number;
  music_count: number;
  base_cost: number;
  reward_amount: number;
  status: string;
  available_at?: string | null;
}

export interface MarketWithdrawalRecord {
  id: number;
  creator_user_id: number;
  amount: number;
  alipay_account: string;
  alipay_real_name: string;
  status: string;
  payout_trade_no?: string;
  admin_note?: string;
  reviewed_at?: string | null;
  created_at: string;
}

export interface MarketTransferResult {
  amount: number;
  bonus_amount: number;
  credit_amount: number;
  new_balance: number;
  available_amount: number;
}
