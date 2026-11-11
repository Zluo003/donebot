import type { DoneBotCatalog, DoneBotModelKind, DoneBotProtocol } from "../../shared/donebot.ts";
import type { ModelCatalog } from "../contracts.ts";
import { nativeModel, modelCapabilities, validateMediaParameters } from "./capabilities.ts";
import type { MediaKind, MediaResolvedModel } from "./media.ts";
import { MEDIA_ADAPTERS } from "./media-adapters.ts";
import { seedream55ReferencePolicy } from "./seedream-capabilities.ts";
import { normalizeSeedanceParameters, seedanceReferencePolicy } from "./seedance-capabilities.ts";
import { SUNO_FIXED_PARAMETERS } from "./suno-capabilities.ts";

const protocolInterfaces = { messages: "anthropic.messages", gemini: "gemini.generate_content", responses: "openai.responses", chat: "openai.chat_completions" } as const;

export function doneBotProtocol(id: string, catalog?: DoneBotCatalog | null): DoneBotProtocol {
  const model = catalog?.models.find(model => model.id === id);
  const registered = nativeModel(id)?.protocol;
  if (model) {
    if (registered && model.interfaces.includes(protocolInterfaces[registered])) return registered;
    for (const protocol of ["messages", "gemini", "responses", "chat"] as const) {
      if (model.interfaces.includes(protocolInterfaces[protocol])) return protocol;
    }
    throw new Error("The gateway has not advertised a supported text interface for this model.");
  }
  if (registered && catalog === undefined) return registered;
  throw new Error("This model is not available in your DoneBot catalog.");
}

export function doneBotTextModels(catalog: DoneBotCatalog | null): ModelCatalog {
  const options = (catalog?.models ?? []).flatMap(model => {
    if (!model.media_types.includes("text") || !model.interfaces.some(iface => Object.values(protocolInterfaces).includes(iface as never))) return [];
    const window = model.capabilities?.context_window_tokens;
    const contextWindow = typeof window === "number" && Number.isSafeInteger(window) && window > 0 ? window : nativeModel(model.id)?.contextWindow;
    return [{ id: model.id, label: model.display_name || model.id, ...(contextWindow ? { contextWindow } : {}) }];
  });
  return { default: options.find(model => model.id === catalog?.defaults.text)?.id ?? options[0]?.id ?? "", options };
}
export function mediaModelSummary(model: ReturnType<typeof modelCapabilities>) {
  return { model: model.model, kind: model.native?.kind ?? null, input: model.client.input,
    operations: model.client.operations, availability: model.availability };
}

export function doneBotModelCapabilities(catalog: DoneBotCatalog | null, query: { model?: string; kind?: MediaKind | "llm" | "tts" }) {
  const kind: DoneBotModelKind | undefined = query.kind === "llm" ? "text" : query.kind === "tts" ? "audio" : query.kind;
  const models = (catalog?.models ?? []).filter(model => (!query.model || query.model === model.id) && (!kind || model.media_types.includes(kind)))
    .map(model => ({ ...modelCapabilities(model), display_name: model.display_name, ...(model.pricing ? { pricing: model.pricing } : {}) }));
  if (query.model && !models.length) {
    if (kind === "image" || kind === "video" || kind === "music") unavailableMediaModel(catalog, query.model, kind, false);
    throw Object.assign(new Error(`No registered model matches ${JSON.stringify(query.model)}${kind ? ` with kind ${kind}` : ""}. Query media_model_capabilities with kind only to discover exact model IDs, then correct the query in this same conversation. An empty match is not evidence of a missing gateway or a conversation restriction.`), { status: 400 });
  }
  return query.model ? models : models.map(model => ({ ...mediaModelSummary(model), display_name: model.display_name, ...(model.pricing ? { pricing: model.pricing } : {}) }));
}

function unavailableMediaModel(catalog: DoneBotCatalog | null, id: string, kind: MediaKind, generation = true): never {
  const available = (catalog?.models ?? []).filter(model => model.media_types.includes(kind) && modelCapabilities(model).availability.usable).map(model => model.id);
  const native = nativeModel(id);
  throw Object.assign(new Error(`The selected ${kind} model ${JSON.stringify(id)} is unavailable for this operation.${native && native.kind !== kind ? ` It is registered for ${native.kind}, not ${kind} generation.` : ""} ${generation ? "No paid generation was submitted." : "This capability lookup did not submit generation."} ${available.length
    ? `Available verified ${kind} models: ${available.join(", ")}. Use the generation tool's registered parameter schema and correct the request in this same conversation. Do not repeat the mismatched model query. A new conversation, changing the chat model or enabling a gateway channel is not required.`
    : `No verified ${kind} model is currently available in this account; report this specific limitation.`} This gateway error does not establish missing provider credentials. Do not request provider API keys to repair it or substitute a local mockup. A user-selected external media tool uses its own contract and authentication.`), { status: 400 });
}

export function doneBotMediaModel(catalog: DoneBotCatalog | null, id: string, kind: MediaKind): MediaResolvedModel {
  const model = catalog?.models.find(x => x.id === id && x.media_types.includes(kind));
  const native = nativeModel(id);
  const protocol = model?.media_parameters?.protocol as { adapter?: unknown } | undefined;
  const adapter = protocol?.adapter;
  if (!model || typeof adapter !== "string") unavailableMediaModel(catalog, id, kind);
  if (!native && Object.hasOwn(MEDIA_ADAPTERS, adapter) && MEDIA_ADAPTERS[adapter]?.kind === kind && adapter !== "openai.images.v1" && modelCapabilities(model).availability.usable) {
    return { id, kind, adapter, capabilities: modelCapabilities(model) };
  }
  if (!native || native.kind !== kind) unavailableMediaModel(catalog, id, kind);
  if (adapter === "openai.images.v1") throw new Error("Deploy the DoneBot gateway asynchronous image update before using this model.");
  const capabilities = modelCapabilities(model);
  if (!capabilities.availability.usable) unavailableMediaModel(catalog, id, kind);
  return { id, kind, adapter, capabilities, fixedParameters: id === "suno" ? SUNO_FIXED_PARAMETERS : capabilities.client.fixedParameters,
    ...(id === "seedream-5-5" ? { referencePolicy: seedream55ReferencePolicy } : {}),
    ...(id === "suno" ? { normalizeParameters: (parameters: Record<string, unknown>) => ({ ...parameters, audio_format: parameters.audio_format ?? "mp3" }) } : {}),
    ...(native.kind === "video" ? { normalizeParameters: (parameters: Record<string, unknown>, operation: "generate" | "edit" | "extend") => normalizeSeedanceParameters(native,
      id === "seedance-2-5" ? { resolution: "720p", ratio: "adaptive", duration: -1, ...parameters } : parameters, operation), referencePolicy: seedanceReferencePolicy(native) } : {}),
    validate: (parameters, operation: "generate" | "edit" | "extend") => {
      if (id === "suno" && parameters.custom_model_id !== undefined) throw new Error("DoneBot music generation uses Suno v6 only.");
      validateMediaParameters(model, parameters, operation);
    } };
}
