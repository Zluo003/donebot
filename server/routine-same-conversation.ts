import type { RoutineRun } from "./routines.ts";

export function previousEventThread(runs: readonly RoutineRun[], run: Pick<RoutineRun, "id" | "webhookId" | "botId">): string | null {
  if (!run.webhookId) return null;
  return runs.find((other) => other.id !== run.id && other.webhookId === run.webhookId && other.botId === run.botId && other.threadId)?.threadId ?? null;
}

export function continuedConversation(runs: readonly RoutineRun[], run: RoutineRun, exists: (threadId: string) => boolean): string | null {
  const previous = run.target === "bot" ? previousEventThread(runs, run) : null;
  return previous && exists(previous) ? previous : null;
}
