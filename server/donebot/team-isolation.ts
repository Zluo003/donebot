import { botBox, type BoxReport } from "../bot-box/box.ts";
import type { ProviderInstance } from "../contracts.ts";

export function teamIsolationReady(report: BoxReport = botBox.report()): boolean {
  const checks = report.checks;
  return report.box === "bwrap" && report.hardening.seccomp === "on" && report.broker.on && checks !== null &&
    checks.total > 0 && checks.passed === checks.total && checks.failed.length === 0;
}

/** Team execution must never fall back to an unboxed process, including while the boot self-check is pending. */
export function assertTeamIsolation(required = process.env.DONEBOT_TEAM_RUNTIME === "1", report?: BoxReport): void {
  if (required && !teamIsolationReady(report)) throw Object.assign(new Error("Team execution is unavailable until the runtime isolation checks pass."),
    { status: 503, code: "TEAM_ISOLATION_UNAVAILABLE" });
}

export function withTeamIsolation(instance: ProviderInstance, required = process.env.DONEBOT_TEAM_RUNTIME === "1", check = assertTeamIsolation): ProviderInstance {
  if (!required) return instance;
  const adapter = instance.adapter;
  (instance as { adapter: ProviderInstance["adapter"] }).adapter = { ...adapter, sendTurn: async (input) => {
    check(true);
    return adapter.sendTurn(input);
  } };
  const guarded = <A extends unknown[]>(generate: (...args: A) => Promise<string>) => async (...args: A): Promise<string> => {
    check(true);
    return generate.apply(instance, args);
  };
  if (instance.generateText) instance.generateText = guarded(instance.generateText);
  if (instance.generateMemoryText) instance.generateMemoryText = guarded(instance.generateMemoryText);
  if (instance.reviewPermission) instance.reviewPermission = guarded(instance.reviewPermission);
  return instance;
}
