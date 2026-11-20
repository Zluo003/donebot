export type RunPreparation<R> = (run: R, signal: AbortSignal) => Promise<string | null> | null;

const MAX_SETTLED = 200;
export const PREPARATION_FAILED = "This run could not be prepared, so it did not start. Check the connection before trying again.";

export function createRunGate<R extends { id: string }>(prepare: RunPreparation<R> | undefined, settled: () => void) {
  const pending = new Map<string, AbortController>();
  const results = new Map<string, string | null>();

  return {
    hold(run: R): boolean | string {
      if (results.has(run.id)) {
        const reason = results.get(run.id)!;
        results.delete(run.id);
        return reason ?? false;
      }
      if (pending.has(run.id)) return true;
      const stop = new AbortController();
      let work: Promise<string | null> | null | undefined;
      try { work = prepare?.(run, stop.signal); }
      catch { return PREPARATION_FAILED; }
      if (!work) return false;
      pending.set(run.id, stop);
      void work.catch(() => PREPARATION_FAILED).then((reason) => {
        if (pending.get(run.id) !== stop) return;
        pending.delete(run.id);
        if (stop.signal.aborted) return;
        if (results.size >= MAX_SETTLED) results.delete(results.keys().next().value!);
        results.set(run.id, reason);
        settled();
      });
      return true;
    },
    sweep(waiting: (runId: string) => boolean): void {
      for (const [runId, stop] of pending) {
        if (waiting(runId)) continue;
        stop.abort();
        pending.delete(runId);
      }
      for (const runId of results.keys()) if (!waiting(runId)) results.delete(runId);
    },
    waiting: (runId: string): boolean => pending.has(runId),
  };
}
