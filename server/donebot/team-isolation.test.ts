import { afterEach, expect, it, vi } from "vitest";
import { botBox, type BoxReport } from "../bot-box/box.ts";
import type { ProviderInstance } from "../contracts.ts";
import { boxedSpawn } from "../procs.ts";
import { assertTeamIsolation, teamIsolationReady, withTeamIsolation } from "./team-isolation.ts";

const ready: BoxReport = { box: "bwrap", reason: null, checks: { passed: 24, total: 24, failed: [], at: Date.now() }, bridge: "socat", boxed: 0,
  refused: { egress: 0, harness: 0 }, broker: { on: true, tokens: 0, forwarded: 0, refused: 0, unbrokered: [] },
  hardening: { seccomp: "on", denied: 1, hidepid: false, flyApiPrivate: true } };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("requires completed isolation checks, namespaces, seccomp and credential broker", () => {
  expect(teamIsolationReady(ready)).toBe(true);
  for (const report of [{ ...ready, box: "off" as const }, { ...ready, checks: null },
    { ...ready, checks: { passed: 0, total: 0, failed: [], at: 1 } },
    { ...ready, checks: { ...ready.checks!, passed: 23, failed: ["other-bot-files"] } },
    { ...ready, hardening: { ...ready.hardening, seccomp: "unsupported" as const } },
    { ...ready, broker: { ...ready.broker, on: false } }]) {
    expect(teamIsolationReady(report)).toBe(false);
    expect(() => assertTeamIsolation(true, report)).toThrow(expect.objectContaining({ status: 503, code: "TEAM_ISOLATION_UNAVAILABLE" }));
    expect(() => assertTeamIsolation(false, report)).not.toThrow();
  }
});

it("fences chat and all background model work before the adapter can run", async () => {
  let report = { ...ready, checks: null } as BoxReport;
  const check = () => assertTeamIsolation(true, report);
  const sendTurn = vi.fn(async () => ({ turnId: "fixture" })), text = vi.fn(async () => "fixture");
  const instance = { adapter: { sendTurn }, generateText: text, generateMemoryText: text, reviewPermission: text } as unknown as ProviderInstance;
  withTeamIsolation(instance, true, check);
  await expect(instance.adapter.sendTurn({ threadId: "fixture" } as never)).rejects.toMatchObject({ code: "TEAM_ISOLATION_UNAVAILABLE" });
  for (const name of ["generateText", "generateMemoryText", "reviewPermission"] as const) await expect(instance[name]!("fixture")).rejects.toMatchObject({ code: "TEAM_ISOLATION_UNAVAILABLE" });
  expect(sendTurn).not.toHaveBeenCalled(); expect(text).not.toHaveBeenCalled();
  report = ready;
  await expect(instance.adapter.sendTurn({ threadId: "fixture" } as never)).resolves.toEqual({ turnId: "fixture" });
  await expect(instance.generateText!("fixture")).resolves.toBe("fixture");
  report = { ...ready, checks: null };
  await expect(instance.generateText!("fixture")).rejects.toThrow();
});

it("refuses explicit unboxed bot spawns even after the team isolation check passed", () => {
  vi.stubEnv("DONEBOT_TEAM_RUNTIME", "1");
  vi.spyOn(botBox, "report").mockReturnValue(ready);
  expect(() => boxedSpawn({ command: "/bin/true", args: [] }, { box: false }, "bot")).toThrow(/require isolation/);
  vi.spyOn(botBox, "report").mockReturnValue({ ...ready, checks: null });
  expect(() => boxedSpawn({ command: "/bin/true", args: [] }, {}, "bot")).toThrow(/isolation checks/);
  expect(boxedSpawn({ command: "/bin/true", args: [] }, {}, "donebot")).toBeNull();
});
