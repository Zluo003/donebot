import { useEffect, useState } from "react";

import { REMOTE_BOT_ID_PREFIX } from "../../shared/bot-coordination";
import { api, type Group } from "@/state/store";

export interface LinkedBot {
  id: string;
  home: { id: string; key: string; kind: "cloud" | "computer"; name: string; online: boolean };
  botId: string;
  name: string;
  title?: string;
  color?: string;
  mascotBody?: string;
  mascotFaceColor?: string;
  chiefOfStaff?: boolean;
  threadId?: string;
}

export type FarMemberState = NonNullable<Group["farMembers"]>[number]["state"] | "offline";

export interface FarMemberOption {
  id: string;
  name: string;
  place: string;
  state: FarMemberState;
  color?: string;
  title?: string;
  mascotBody?: string;
  mascotFaceColor?: string;
}

export const isRemoteBotId = (id: string): boolean => id.startsWith(REMOTE_BOT_ID_PREFIX);

export function linkedBotToFarOption(bot: LinkedBot): FarMemberOption {
  return {
    id: bot.id,
    name: bot.name,
    place: bot.home.name,
    state: bot.home.online ? "ok" : "offline",
    ...(bot.color ? { color: bot.color } : {}),
    ...(bot.title ? { title: bot.title } : {}),
    ...(bot.mascotBody ? { mascotBody: bot.mascotBody } : {}),
    ...(bot.mascotFaceColor ? { mascotFaceColor: bot.mascotFaceColor } : {}),
  };
}

export function mergeFarMembers(existing: readonly FarMemberOption[], linked: readonly LinkedBot[]): FarMemberOption[] {
  const byId = new Map<string, LinkedBot>(linked.map((bot) => [bot.id, bot]));
  const merged: FarMemberOption[] = [];
  const seen = new Set<string>();
  for (const member of existing) {
    seen.add(member.id);
    const live = byId.get(member.id);
    if (live) {
      merged.push({
        ...member,
        name: live.name,
        place: live.home.name,
        state: member.state === "ok" ? (live.home.online ? "ok" : "offline") : member.state,
        ...(live.color ? { color: live.color } : {}),
        ...(live.title ? { title: live.title } : {}),
        ...(live.mascotBody ? { mascotBody: live.mascotBody } : {}),
        ...(live.mascotFaceColor ? { mascotFaceColor: live.mascotFaceColor } : {}),
      });
    } else {
      merged.push(member);
    }
  }
  for (const bot of linked) {
    if (seen.has(bot.id)) continue;
    merged.push(linkedBotToFarOption(bot));
  }
  return merged;
}

/** Loads bots available over the personal local-Cloud bot link; degrades quietly when unavailable. */
export function useLinkedBots(enabled = true): LinkedBot[] {
  const [bots, setBots] = useState<LinkedBot[]>([]);
  useEffect(() => {
    if (!enabled) { setBots([]); return; }
    let cancelled = false;
    try {
      void Promise.resolve(api<{ bots?: LinkedBot[] }>("/api/bot-link/bots"))
        .then((res) => { if (!cancelled) setBots(Array.isArray(res?.bots) ? res.bots : []); })
        .catch(() => { if (!cancelled) setBots([]); });
    } catch {
      if (!cancelled) setBots([]);
    }
    return () => { cancelled = true; };
  }, [enabled]);
  return bots;
}
