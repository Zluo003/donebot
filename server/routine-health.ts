import { isCountedSkip, type RoutineRunStatus } from "../shared/routines.ts";
import type { Routine, RoutineRun } from "./routines.ts";

/** An id and counts only: nothing of the routine's name, prompt or output. */
export interface RoutineHealth { routineId: string; status: RoutineRunStatus; at: number; consecutiveFailures: number }

const ENDED = new Set<RoutineRunStatus>(["completed", "failed", "missed", "cancelled"]);
const endedAt = (run: RoutineRun) => run.finishedAt ?? run.createdAt;

export function routineHealthOf(routines: readonly Pick<Routine, "id" | "enabled">[], runs: readonly RoutineRun[], cap: number): RoutineHealth[] {
  const on = new Set(routines.filter((routine) => routine.enabled).map((routine) => routine.id));
  const ended = new Map<string, RoutineRun[]>();
  for (const run of runs) {
    if (!ENDED.has(run.status) || isCountedSkip(run) || !(on.has(run.routineId) || run.webhookId === run.routineId)) continue;
    const rows = ended.get(run.routineId);
    if (rows) rows.push(run); else ended.set(run.routineId, [run]);
  }
  const health: RoutineHealth[] = [];
  for (const [routineId, rows] of ended) {
    rows.sort((a, b) => endedAt(b) - endedAt(a) || b.createdAt - a.createdAt);
    let consecutiveFailures = 0;
    for (const run of rows) {
      if (run.status === "completed") break;
      if (run.status !== "cancelled") consecutiveFailures += 1;
    }
    health.push({ routineId, status: rows[0]!.status, at: endedAt(rows[0]!), consecutiveFailures });
  }
  return health.sort((a, b) => b.at - a.at).slice(0, cap);
}
