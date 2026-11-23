import { mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DoneBotCollabTaskPrefs } from "../../shared/donebot-collab.ts";
import { writeFileAtomic } from "../atomic.ts";

const DEFAULT_PREFS: DoneBotCollabTaskPrefs = {
  chief_auto_submit_on_approve: false,
};

let loaded = false;
let current: DoneBotCollabTaskPrefs = { ...DEFAULT_PREFS };

function prefsFilePath(): string | null {
  if (process.env.VITEST || process.env.NODE_ENV === "test") return null;
  const base = process.env.DONEBOT_DATA_DIR?.trim() || path.join(os.homedir(), ".donebot");
  return path.join(base, "collab-task-prefs.json");
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  const file = prefsFilePath();
  if (!file) return;
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<DoneBotCollabTaskPrefs> | null;
    if (parsed && typeof parsed === "object") {
      current = {
        chief_auto_submit_on_approve: parsed.chief_auto_submit_on_approve === true,
      };
    }
  } catch {
    current = { ...DEFAULT_PREFS };
  }
}

function persist() {
  const file = prefsFilePath();
  if (!file) return;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify(current, null, 2));
  } catch {
    // Best-effort local persistence.
  }
}

export function getCollabTaskPrefs(): DoneBotCollabTaskPrefs {
  ensureLoaded();
  return { ...current };
}

export function saveCollabTaskPrefs(patch: Partial<DoneBotCollabTaskPrefs>): DoneBotCollabTaskPrefs {
  ensureLoaded();
  if (typeof patch.chief_auto_submit_on_approve === "boolean") {
    current = {
      ...current,
      chief_auto_submit_on_approve: patch.chief_auto_submit_on_approve,
    };
  }
  persist();
  return { ...current };
}

/** Tests only. */
export function resetCollabTaskPrefsForTests(): void {
  loaded = true;
  current = { ...DEFAULT_PREFS };
}
