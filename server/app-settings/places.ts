export const SETTINGS_PLACES = {
  general: "Settings → General (设置 → 通用)",
  limits: "Settings → General → More settings → Limits (设置 → 通用 → 更多设置 → 限额)",
  account: "Settings → Account & models (设置 → 账户与模型)",
  pricing: "Settings → Models & pricing (设置 → 模型与价格)",
  usage: "Settings → Usage & billing (设置 → 用量与账单)",
  updates: "Settings → Updates (设置 → 更新)",
} as const;
export type SettingsPlaceId = keyof typeof SETTINGS_PLACES;
export const placePath = (id: SettingsPlaceId): string => SETTINGS_PLACES[id];
export const placesList = (): string => Object.values(SETTINGS_PLACES).join("\n");
export function findPlaces(query: string): string[] {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return Object.values(SETTINGS_PLACES).filter(path => words.some(word => path.toLowerCase().includes(word)));
}
