import { PASS, type RouteHandler } from "../routes/table.ts";
import { DONEBOT_MODEL_CREDENTIAL_RULE } from "./credential-policy.ts";

const PROVIDER_CONFIG = new Set(["instances", "anthropic", "openai", "openrouter", "openaiCompat", "xai", "mistral", "cerebras", "groq", "greenference", "modelgo", "meta", "opencodeGo", "deepseek", "imageGen"]);


export function doneBotConfigRefusal(body: Record<string, unknown>): string | undefined {
  if (Object.keys(body).some(key => PROVIDER_CONFIG.has(key))) return DONEBOT_MODEL_CREDENTIAL_RULE;
  for (const [key, allowed] of [["tts", ["model", "voice", "everyReply"]], ["decider", ["enabled", "jobs", "maxParallel"]]] as const) {
    const value = body[key];
    if (value && typeof value === "object" && Object.keys(value).some(field => !(allowed as readonly string[]).includes(field))) return DONEBOT_MODEL_CREDENTIAL_RULE;
  }
  return undefined;
}

export const doneBotModelRoutes: RouteHandler = async ({ res, path, method, json }) => {
  if ((path.startsWith("/api/instances/") && method !== "GET") || path === "/api/instances/ollama" || path === "/api/images/openrouter-models" || path === "/api/images/test") return json(res, 403, { error: DONEBOT_MODEL_CREDENTIAL_RULE });
  if (path === "/api/tts/transcribe" || path === "/api/live/start") return json(res, 409, { error: "当前网关尚未开放语音识别或实时通话模型。" });
  return PASS;
};
