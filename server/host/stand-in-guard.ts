import { botMoveRefusal } from "../bot-moves.ts";

type StandIn = { name: string; home?: { place: string; placeName: string; botId: string } };

const READS = new Set(["GET", "HEAD", "OPTIONS"]);
const decoded = (value: string): string => { try { return decodeURIComponent(value); } catch { return value; } };

export function standInNamed(standIns: ReadonlyMap<string, StandIn>, method: string, url: URL): StandIn | null {
  if (standIns.size === 0 || READS.has(method)) return null;
  const path = url.pathname;
  if (!path.startsWith("/api/") || path === "/api/bot-link" || path.startsWith("/api/bot-link/")) return null;
  for (const segment of path.split("/")) {
    const named = segment ? standIns.get(decoded(segment)) : undefined;
    if (named) return named;
  }
  for (const value of url.searchParams.values()) {
    const named = standIns.get(value);
    if (named) return named;
  }
  return null;
}

export function standInWriteRefusal(standIns: ReadonlyMap<string, StandIn>, method: string, url: URL): { error: string; code: "moved" } | null {
  const named = standInNamed(standIns, method, url);
  return named ? { error: botMoveRefusal(named) ?? `${named.name} lives in another place.`, code: "moved" } : null;
}

export function standInAmong(standIns: ReadonlyMap<string, StandIn>, ids: readonly unknown[]): { error: string } | null {
  if (standIns.size === 0) return null;
  for (const id of ids) {
    const named = typeof id === "string" ? standIns.get(id) : undefined;
    if (named) return { error: botMoveRefusal(named) ?? `${named.name} lives in another place.` };
  }
  return null;
}
