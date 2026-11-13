/** Cloud billing uses the gateway account's balance units; monthly_price stays an exact decimal string. */
export interface DoneBotCloudPlan { enabled: boolean; monthly_price: string; retention_days: number }
export interface DoneBotCloudInstance {
  id: string;
  desired: string;
  actual: string;
  error: string;
  paid_until: string | null;
  subscription_state: string;
  purge_locked: boolean;
}
export interface DoneBotCloudOperation { id: string; action: string; state: string; error: string }
export interface DoneBotCloudMutationResult { instance: DoneBotCloudInstance; operation: DoneBotCloudOperation }
/** Safe account snapshot: login and installation credentials never cross into the renderer. */
export interface DoneBotCloudSnapshot {
  account_id: string;
  email: string;
  balance_cents: number | string | null;
  plan: DoneBotCloudPlan;
  instance: DoneBotCloudInstance | null;
  operations: DoneBotCloudOperation[];
  connection_available: boolean;
}
export type DoneBotCloudAction = "start" | "stop" | "cancel";
export interface DoneBotCloudMutation {
  account_id: string;
  id?: string;
  action: DoneBotCloudAction;
  key: string;
  monthly_price: string;
}
