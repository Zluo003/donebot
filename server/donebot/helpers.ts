import type { AppConfig } from "../config.ts";
import { createDecider, type Decider } from "../decider/index.ts";
import type { AskOptions } from "../decider/types.ts";
import type { Extractor } from "../extractor/index.ts";
import { EXTRACT_KEY_CHECK, extractRequestProblem, parseExtractValues } from "../extractor/contract.ts";
import { openrouterExtractBody } from "../extractor/remote.ts";
import type { ExtractOptions, ExtractResult, FieldSchema } from "../extractor/types.ts";
import type { OpenAIChatMessage } from "../drivers/openai-chat.ts";
import { createDoneBotCompletion } from "./llm-protocol.ts";
import { DONEBOT_ORIGIN, type DoneBotGateway } from "./gateway.ts";
import { doneBotProtocol, doneBotTextModels } from "./catalog.ts";

export function createDoneBotHelpers(gateway: DoneBotGateway, config: () => AppConfig, dataDir?: string): { decider: Decider; extractor: Extractor } {
  const complete = createDoneBotCompletion((path, init) => gateway.request(path, init), model => doneBotProtocol(model, gateway.models()));
  const decider = createDecider({
    config() {
      const current = config();
      const available = gateway.authenticated();
      return {
        ...current,
        decider: {
          ...current.decider,
          provider: available && current.decider?.provider !== "off" ? "jev" : "off",
          key: available ? "donebot-gateway" : undefined,
          baseUrl: DONEBOT_ORIGIN,
          enabled: current.decider?.enabled !== false,
        },
      };
    },
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.origin !== DONEBOT_ORIGIN || url.pathname !== "/v1/systemone" || url.search || url.hash) {
        throw new TypeError("Unsupported DoneBot decision endpoint.");
      }
      return gateway.request("/v1/systemone", init);
    },
    ...(dataDir ? { dataDir } : {}),
  });
  const enabled = () => config().decider?.provider !== "off" && config().decider?.enabled !== false;
  async function answer(messages: OpenAIChatMessage[], options: AskOptions | ExtractOptions, images = false): Promise<{ text: string; model: string }> {
    const offered = doneBotTextModels(gateway.models()).options.filter(option => {
      const modalities = gateway.models()?.models.find(model => model.id === option.id)?.capabilities?.input_modalities;
      return !images || Array.isArray(modalities) && modalities.includes("image");
    });
    const preferred = ["claude-haiku-5-5", "gemini-3.8-flash", "deepseek-flash"];
    const model = preferred.find(id => offered.some(x => x.id === id)) ?? offered[0]?.id;
    if (!model || !gateway.authenticated()) throw new Error("No DoneBot helper model is available.");
    const timeout = AbortSignal.timeout(Math.min(30_000, Math.max(50, options.timeoutMs ?? 8000)));
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const result = await complete({ messages, model, tools: [], stream: true, signal, replay: () => undefined, onBytes: () => {} });
    return { text: result.text, model };
  }
  const extract: Extractor["extract"] = async (seam, fields, input, options = {}): Promise<ExtractResult> => {
    if (!enabled()) return { ok: false, reason: "disabled" };
    if (!gateway.authenticated()) return { ok: false, reason: "no_key" };
    if (seam === "inboxTriage" && config().decider?.jobs?.inboxTriage === false) return { ok: false, reason: "job_off" };
    if (extractRequestProblem(fields, input)) return { ok: false, reason: "misconfigured" };
    const started = performance.now();
    try {
      const body = openrouterExtractBody({ fields, input, referenceDate: new Date().toISOString().slice(0, 10) });
      const messages = body.messages as OpenAIChatMessage[];
      messages[0] = { role: "system", content: `${messages[0]!.content}\nJSON schema: ${JSON.stringify(body.response_format.json_schema.schema)}` };
      const result = await answer(messages, options, Boolean(input.images?.length));
      const parsed = JSON.parse(result.text) as { values?: unknown };
      const values = parseExtractValues(parsed.values, fields as FieldSchema);
      if (!values) return { ok: false, reason: "malformed" };
      return { ok: true, provider: "donebot", values, model: result.model, latencyMs: Math.round(performance.now() - started) };
    } catch { return { ok: false, reason: options.signal?.aborted ? "cancelled" : "malformed" }; }
  };
  return { decider, extractor: { extract, testKey: options => extract("keyCheck", EXTRACT_KEY_CHECK.fields, EXTRACT_KEY_CHECK.input, options) } };
}
