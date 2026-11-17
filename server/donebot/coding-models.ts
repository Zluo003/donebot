import type { DoneBotCatalog } from "../../shared/donebot.ts";
import type { DoneBotCodingEngine } from "../../shared/donebot-coding.ts";
import type { ModelCatalog } from "../contracts.ts";
import { doneBotTextModels } from "./catalog.ts";

export function codingModels(engine: DoneBotCodingEngine, catalog: DoneBotCatalog | null): ModelCatalog {
  const ids = new Set(catalog?.models.filter(model => model.media_types.includes("text") && model.capabilities?.tool_calling === true &&
    (engine === "codex" ? model.interfaces.includes("openai.responses")
      : model.interfaces.includes("anthropic.messages"))).map(model => model.id));
  const options = doneBotTextModels(catalog).options.filter(model => ids.has(model.id));
  return { default: options.find(model => model.id === catalog?.defaults?.text)?.id ?? options[0]?.id ?? "", options };
}
