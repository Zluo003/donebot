// Adapted from Paperclip (https://github.com/paperclipai/paperclip)
// Copyright (c) 2025 Paperclip AI — Licensed under the MIT License.

/** Consecutive no-progress runs required before the cooldown engages. */
export const ISSUE_REWAKE_NO_PROGRESS_THRESHOLD = 2;

/** Cooldown after the threshold streak; doubles per additional no-progress run. */
export const ISSUE_REWAKE_BASE_COOLDOWN_MS = 120_000;

/** Upper bound for the escalating cooldown. */
export const ISSUE_REWAKE_MAX_COOLDOWN_MS = 30 * 60_000;

export interface RecentRunSample {
  id: string;
  status: string;
  finishedAt: Date | null;
}

export interface RewakeThrottleInput {
  now: Date;
  /** Terminal runs for the same target, newest finish first. */
  recentTerminalRuns: RecentRunSample[];
  /** Runs among the sample that produced visible progress. */
  runIdsWithProgress: ReadonlySet<string>;
  /** New human/external input landed after the newest run finished. */
  hasNewInputSinceLastRun: boolean;
}

export type RewakeThrottleDecision =
  | { blocked: false; noProgressStreak: number }
  | {
      blocked: true;
      noProgressStreak: number;
      cooldownMs: number;
      lastRunFinishedAt: Date;
      nextAllowedAt: Date;
    };

export function computeRewakeCooldownMs(noProgressStreak: number): number {
  const doublings = Math.max(0, noProgressStreak - ISSUE_REWAKE_NO_PROGRESS_THRESHOLD);
  const factor = 2 ** Math.min(doublings, 16);
  return Math.min(ISSUE_REWAKE_BASE_COOLDOWN_MS * factor, ISSUE_REWAKE_MAX_COOLDOWN_MS);
}

export function evaluateRewakeThrottle(input: RewakeThrottleInput): RewakeThrottleDecision {
  const runs = input.recentTerminalRuns;
  if (runs.length === 0) return { blocked: false, noProgressStreak: 0 };
  if (input.hasNewInputSinceLastRun) return { blocked: false, noProgressStreak: 0 };

  let noProgressStreak = 0;
  for (const run of runs) {
    if (run.status !== "succeeded" || !run.finishedAt) break;
    if (input.runIdsWithProgress.has(run.id)) break;
    noProgressStreak += 1;
  }

  if (noProgressStreak < ISSUE_REWAKE_NO_PROGRESS_THRESHOLD) {
    return { blocked: false, noProgressStreak };
  }

  const lastRunFinishedAt = runs[0]?.finishedAt;
  if (!lastRunFinishedAt) return { blocked: false, noProgressStreak };

  const cooldownMs = computeRewakeCooldownMs(noProgressStreak);
  const nextAllowedAt = new Date(lastRunFinishedAt.getTime() + cooldownMs);
  if (input.now.getTime() < nextAllowedAt.getTime()) {
    return { blocked: true, noProgressStreak, cooldownMs, lastRunFinishedAt, nextAllowedAt };
  }
  return { blocked: false, noProgressStreak };
}
