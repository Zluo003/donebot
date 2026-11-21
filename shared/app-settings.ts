export type SettingTier = "safe" | "owner-only";

/** Display values for an applied workspace setting; never credentials or raw configuration. */
export interface AppSettingRequest {
  settingId: string;
  label: string;
  before?: string;
  after: string;
  tier: SettingTier;
}
