import { ROUTINE_GOAL_RUN_LIMIT_MINUTES, ROUTINE_RUN_LIMIT_MINUTES } from "../shared/routines.ts";
import { DUE_CLOCK_MS } from "./due-timer.ts";
import { codedLine, fittedLine, type RoutineLine } from "./routine-lines.ts";
import { ROUTINE_BUSY_WAIT_MS } from "./routine-recovery.ts";
import { activeMs } from "./routine-waits.ts";
import type { RoutineManagerOptions, RoutineRun } from "./routines.ts";

export const COUNT_STEP_MS = DUE_CLOCK_MS;
export const COUNT_STEP_CAP_MS = 2 * COUNT_STEP_MS;
export const SCHEDULER_STOP_WAIT_MS = 10_000;
export const STOP_CONFIRM_WAIT_MS = 5 * 60_000;
export const STOP_RETRY_MS = 60_000;

type Counted = "workedMs" | "busyMs";

export class RunClock {
  private readonly counted = new WeakMap<RoutineRun, Partial<Record<Counted, number>>>();

  count(run: RoutineRun, field: Counted, now: number): number {
    const at = this.counted.get(run) ?? {}, since = at[field];
    this.counted.set(run, { ...at, [field]: now });
    run[field] = (run[field] ?? 0) + (since === undefined ? 0 : Math.min(COUNT_STEP_CAP_MS, Math.max(0, now - since)));
    return run[field];
  }

  from(run: RoutineRun, field: Counted, now: number): void { this.counted.set(run, { ...this.counted.get(run), [field]: now }); }

  stop(run: RoutineRun, field: Counted, forget = false): void {
    const { [field]: _stopped, ...rest } = this.counted.get(run) ?? {};
    this.counted.set(run, rest);
    if (forget) delete run[field];
  }

  work(run: RoutineRun, now: number): void {
    this.from(run, "workedMs", now);
    Object.assign(run, { status: "running", attention: undefined } satisfies Partial<RoutineRun>);
  }

  rest(run: RoutineRun, now: number): void {
    if (run.status === "running") this.count(run, "workedMs", now);
    this.stop(run, "workedMs");
  }
}

type Started = Pick<RoutineRun, "status" | "startedAt" | "timeoutMinutes" | "waitedMs" | "workedMs" | "asked" | "target">;
const defaultLimitMs = (run: Pick<RoutineRun, "target">) => (run.target === "room-goal" ? ROUTINE_GOAL_RUN_LIMIT_MINUTES : ROUTINE_RUN_LIMIT_MINUTES) * 60_000;
const started = (run: Started) => run.startedAt != null && (run.status === "running" || run.status === "waiting");

export function runLimitAt(run: Started, now: number): number | null {
  if (!started(run)) return null;
  if (run.timeoutMinutes != null) return run.asked ? null : now + Math.max(0, run.timeoutMinutes * 60_000 - activeMs(run, now));
  return run.status === "running" ? now + Math.min(COUNT_STEP_MS, Math.max(0, defaultLimitMs(run) - (run.workedMs ?? 0))) : null;
}

export function runOverLimit(run: RoutineRun, clock: RunClock, now: number): RoutineLine | null {
  if (!started(run)) return null;
  const worked = run.status === "running" ? clock.count(run, "workedMs", now) : run.workedMs ?? 0;
  if (run.timeoutMinutes != null) return activeMs(run, now) >= run.timeoutMinutes * 60_000 ? fittedLine("error", `Stopped after reaching the ${run.timeoutMinutes}-minute run limit`, undefined) : null;
  return run.status === "running" && worked >= defaultLimitMs(run) ? codedLine("error", "routines.server.overLimit", { hours: defaultLimitMs(run) / 3_600_000 }) : null;
}

export function busyWait(run: RoutineRun, clock: RunClock, counts: boolean, now: number): { changed: boolean; missed: RoutineLine | null } {
  const before = run.busyMs;
  if (!counts) {
    clock.stop(run, "busyMs", true);
    return { changed: before !== undefined, missed: null };
  }
  const total = clock.count(run, "busyMs", now);
  const changed = before === undefined || Math.floor(before / 60_000) !== Math.floor(total / 60_000);
  return { changed, missed: total >= ROUTINE_BUSY_WAIT_MS ? codedLine("error", "routines.server.busyTooLong", { minutes: ROUTINE_BUSY_WAIT_MS / 60_000 }) : null };
}

export type StopState = "pending" | "confirmed" | "unconfirmed";

export class SlowStops {
  count = 0;
  private readonly open = new Map<string, { since: number; triedAt: number }>();
  private readonly now: () => number;
  private readonly changed: (threadId: string, state: StopState) => void;

  constructor(now: () => number, changed: (threadId: string, state: StopState) => void) {
    this.now = now;
    this.changed = changed;
  }

  timedOut(threadId: string): void {
    this.count += 1;
    console.warn(`routines: stopping a turn did not finish in ${SCHEDULER_STOP_WAIT_MS / 1000} s; the scheduler went on without it`);
    if (this.open.has(threadId)) return;
    this.open.set(threadId, { since: this.now(), triedAt: this.now() });
    this.changed(threadId, "pending");
  }

  confirmed(threadId: string): void {
    if (this.open.delete(threadId)) this.changed(threadId, "confirmed");
  }

  holds(threadId: string | undefined): boolean {
    return threadId !== undefined && this.open.has(threadId);
  }

  sweep(): string[] {
    const now = this.now(), again: string[] = [];
    for (const [threadId, stop] of this.open) {
      if (now - stop.since >= STOP_CONFIRM_WAIT_MS) {
        this.open.delete(threadId);
        this.changed(threadId, "unconfirmed");
      } else if (now - stop.triedAt >= STOP_RETRY_MS) {
        stop.triedAt = now;
        again.push(threadId);
      }
    }
    return again;
  }
}

export function markStop(run: RoutineRun, state: StopState): boolean {
  if (["queued", "running", "waiting"].includes(run.status)) return false;
  if (state === "confirmed") {
    if (run.attentionCode !== "routines.server.stopPending") return false;
    Object.assign(run, { attention: undefined, attentionCode: undefined, attentionParams: undefined } satisfies Partial<RoutineRun>);
    return true;
  }
  const line = state === "pending" ? codedLine("attention", "routines.server.stopPending", { minutes: STOP_CONFIRM_WAIT_MS / 60_000 }) : codedLine("attention", "routines.server.stopUnconfirmed");
  Object.assign(run, line.codes, { attention: line.text } satisfies Partial<RoutineRun>);
  return true;
}

async function within(work: Promise<void>, slow: SlowStops, threadId: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), SCHEDULER_STOP_WAIT_MS); timer.unref?.(); });
  try {
    if (await Promise.race([work, late]) !== "late") return slow.confirmed(threadId);
    slow.timedOut(threadId);
    work.then(() => slow.confirmed(threadId), () => {});
  } finally {
    clearTimeout(timer);
  }
}

export function withBoundedStops(options: RoutineManagerOptions, slow: SlowStops): RoutineManagerOptions {
  return Object.create(options, {
    interruptTurn: { get: () => options.interruptTurn && (async (botId: string, threadId: string) => within(options.interruptTurn!(botId, threadId), slow, threadId)) },
    interruptGoal: { get: () => options.interruptGoal && (async (groupId: string | undefined, threadId: string, outcome?: { status: "stopped" | "limit-reached"; detail: string }) =>
      within(options.interruptGoal!(groupId, threadId, outcome), slow, threadId)) },
  }) as RoutineManagerOptions;
}
