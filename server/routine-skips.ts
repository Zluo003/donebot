import { ROUTINE_DEFERRAL_NOTICE_MS } from "./routine-execution.ts";
import { codedLine, type RoutineLineKey } from "./routine-lines.ts";
import type { RoutineRun } from "./routines.ts";

export interface RoutineSkips {
  count: number;
  firstAt: number;
  lastAt: number;
  behind: string;
  told?: true;
}

export type SkipWhy = Extract<RoutineLineKey, "routines.server.part.stillWaiting" | "routines.server.part.stillRunning" | "routines.server.part.notStarted" | "routines.server.part.computerNoStart">;

export function blockingRun(runs: readonly RoutineRun[], routineId: string): { run: RoutineRun; why: SkipWhy; waitingSince?: number } | undefined {
  const active = runs.filter((run) => run.routineId === routineId && ["queued", "running", "waiting"].includes(run.status));
  const run = active.find((candidate) => candidate.status === "waiting" && candidate.waitingSince !== undefined) ?? active.find((candidate) => candidate.status !== "queued") ?? active[0];
  if (!run) return undefined;
  if (run.status === "waiting" && run.waitingSince !== undefined) return { run, why: "routines.server.part.stillWaiting", waitingSince: run.waitingSince };
  return { run, why: run.status === "queued" ? "routines.server.part.notStarted" : "routines.server.part.stillRunning" };
}

export function recordSkip(runs: readonly RoutineRun[], make: () => RoutineRun, cause: { behind: string; why: SkipWhy; waitingSince?: number }, scheduledFor: number, now: number): { row: RoutineRun; added: boolean; tell: boolean } {
  const found = runs.findLast((run) => run.status === "missed" && run.skipped?.behind === cause.behind);
  const row = found ?? make();
  const skipped: RoutineSkips = found?.skipped
    ? { ...found.skipped, count: found.skipped.count + 1, lastAt: Math.max(found.skipped.lastAt, scheduledFor) }
    : { count: 1, firstAt: scheduledFor, lastAt: scheduledFor, behind: cause.behind };
  const tell = !skipped.told && cause.waitingSince !== undefined && scheduledFor >= cause.waitingSince + ROUTINE_DEFERRAL_NOTICE_MS;
  if (tell) skipped.told = true;
  const line = skipped.count === 1 ? codedLine("error", "routines.server.skippedOne", { why: cause.why }) : codedLine("error", "routines.server.skippedMany", { count: skipped.count, why: cause.why });
  Object.assign(row, line.codes, { status: "missed", error: line.text, finishedAt: now, skipped } satisfies Partial<RoutineRun>);
  if (tell) delete row.seenAt;
  else if (!found) row.seenAt = now;
  return { row, added: !found, tell };
}

export function loadSkips(value: unknown): RoutineSkips | undefined {
  const skips = value as Partial<RoutineSkips> | null | undefined;
  if (!skips || typeof skips !== "object" || !Number.isSafeInteger(skips.count) || skips.count! < 1 || !Number.isSafeInteger(skips.firstAt) || !Number.isSafeInteger(skips.lastAt) ||
    typeof skips.behind !== "string" || !/^[\w:-]{1,160}$/.test(skips.behind)) return undefined;
  return { count: skips.count!, firstAt: skips.firstAt!, lastAt: skips.lastAt!, behind: skips.behind, ...(skips.told === true ? { told: true } : {}) };
}
