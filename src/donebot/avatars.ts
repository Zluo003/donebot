import { MASCOT_BODY_IDS } from "../../shared/mascot-bodies";
import type { BotBodyId } from "../../shared/bot-body";

export const NEW_BOT_BODY = "circle" as const;
export const PICKABLE_BOT_BODIES = MASCOT_BODY_IDS.filter(id => id !== "cursor");
export const newBotBody = (body?: BotBodyId | null): BotBodyId => !body || body === "cursor" ? NEW_BOT_BODY : body;
