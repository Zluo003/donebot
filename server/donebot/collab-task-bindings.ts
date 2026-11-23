import { mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DoneBotLocalTaskBinding } from "../../shared/donebot-collab.ts";
import { writeFileAtomic } from "../atomic.ts";

const MAX_BINDINGS = 200;

let loaded = false;
const bindingsByTask = new Map<string, DoneBotLocalTaskBinding>();

function bindingsFilePath(): string | null {
  if (process.env.VITEST || process.env.NODE_ENV === "test") return null;
  const base = process.env.DONEBOT_DATA_DIR?.trim() || path.join(os.homedir(), ".donebot");
  return path.join(base, "collab-task-bindings.json");
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  const file = bindingsFilePath();
  if (!file) return;
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return;
    for (const item of parsed) {
      if (
        item
        && typeof item === "object"
        && typeof (item as DoneBotLocalTaskBinding).taskId === "string"
        && typeof (item as DoneBotLocalTaskBinding).teamId === "string"
        && typeof (item as DoneBotLocalTaskBinding).botId === "string"
        && typeof (item as DoneBotLocalTaskBinding).threadId === "string"
      ) {
        const rec = item as DoneBotLocalTaskBinding;
        bindingsByTask.set(rec.taskId, rec);
      }
    }
  } catch {
    // Missing or unreadable cache starts fresh.
  }
}

function persist() {
  const file = bindingsFilePath();
  if (!file) return;
  try {
    const items = [...bindingsByTask.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_BINDINGS);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify(items, null, 2));
  } catch {
    // Best-effort local persistence.
  }
}

export function listTaskBindings(): DoneBotLocalTaskBinding[] {
  ensureLoaded();
  return [...bindingsByTask.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getTaskBinding(taskId: string): DoneBotLocalTaskBinding | undefined {
  ensureLoaded();
  return bindingsByTask.get(taskId);
}

export function getTaskBindingByThread(botId: string, threadId: string): DoneBotLocalTaskBinding | undefined {
  ensureLoaded();
  let match: DoneBotLocalTaskBinding | undefined;
  for (const item of bindingsByTask.values()) {
    const directHit = item.botId === botId && item.threadId === threadId;
    const chiefHit = item.chiefBotId === botId && item.chiefThreadId === threadId;
    const workerHit = item.workerBotId === botId && item.workerThreadId === threadId;
    if (directHit || chiefHit || workerHit) {
      if (!match || item.updatedAt > match.updatedAt) match = item;
    }
  }
  return match;
}

export function saveTaskBinding(input: Omit<DoneBotLocalTaskBinding, "updatedAt">): DoneBotLocalTaskBinding {
  ensureLoaded();
  const prev = bindingsByTask.get(input.taskId);
  const next: DoneBotLocalTaskBinding = {
    ...(prev ? {
      chiefBotId: prev.chiefBotId,
      chiefThreadId: prev.chiefThreadId,
      workerBotId: prev.workerBotId,
      workerThreadId: prev.workerThreadId,
    } : {}),
    ...input,
    teamName: input.teamName || prev?.teamName || "",
    taskTitle: input.taskTitle || prev?.taskTitle || "",
    updatedAt: Date.now(),
  };
  bindingsByTask.set(next.taskId, next);
  if (bindingsByTask.size > MAX_BINDINGS) {
    const oldest = [...bindingsByTask.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (oldest) bindingsByTask.delete(oldest.taskId);
  }
  persist();
  return next;
}

export function removeTaskBinding(taskId: string): void {
  ensureLoaded();
  if (bindingsByTask.delete(taskId)) persist();
}

/** Tests only. */
export function resetTaskBindingsForTests(): void {
  loaded = true;
  bindingsByTask.clear();
}
