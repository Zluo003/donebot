import { createHash } from "node:crypto";

export const placeKey = (placeId) => createHash("sha256").update(String(placeId)).digest("hex").slice(0, 8);

export const linkedAddress = (placeId, botId) => `link-${placeKey(placeId)}-${botId}`;
