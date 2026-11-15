import type { AppState } from "../state/store";

const key = "donebot.cloud-workspace.v1";
const maxBytes = 2 * 1024 * 1024;
let identity: string | null = null;
type Cached = Pick<AppState, "bots" | "groups" | "sections" | "selectedId" | "config" | "instances">;

export function bindCloudWorkspaceCache(owner: string | null): void {
  identity = owner;
  if (!owner) { try { sessionStorage.removeItem(key); } catch {} }
}

export function readCloudWorkspaceCache(): Cached | null {
  if (!identity) return null;
  try {
    const text = sessionStorage.getItem(key);
    if (!text || text.length > maxBytes) return null;
    const cached = JSON.parse(text);
    if (cached.identity !== identity || !Number.isFinite(cached.at) || Date.now() - cached.at > 86400_000 || cached.at > Date.now() + 60_000) return null;
    const value = cached.value;
    if (!value || !Array.isArray(value.bots) || !Array.isArray(value.groups) || !Array.isArray(value.sections) || !Array.isArray(value.instances) || !value.config || typeof value.selectedId !== "string") return null;
    return value;
  } catch { return null; }
}

export function saveCloudWorkspaceCache(state: AppState): void {
  if (!identity || !state.config || !state.hydrated) return;
  const value: Cached = {
    bots: state.bots.map(bot => ({ ...bot, messages: bot.messages.slice(-80), busy: false })),
    groups: state.groups.map(group => ({ ...group, messages: group.messages.slice(-80) })),
    sections: state.sections, selectedId: state.selectedId, config: state.config, instances: state.instances,
  };
  try {
    const text = JSON.stringify({ identity, at: Date.now(), value });
    if (text.length <= maxBytes) sessionStorage.setItem(key, text);
    else sessionStorage.removeItem(key);
  } catch {}
}
