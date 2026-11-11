import type { DoneBotCatalog } from "../../shared/donebot.ts";
import type { CompletionTransportInput } from "../drivers/openai-chat.ts";
import { DONEBOT_MODEL_CREDENTIAL_RULE } from "./credential-policy.ts";
import { DONEBOT_LEGACY_MEDIA_TOOL_NAMES } from "./media-tools.ts";
import { doneBotClientMediaCatalog, DONEBOT_MEDIA_MODELS } from "./media-registry.ts";
import { DONEBOT_MEDIA_PARAMETER_GUIDANCE, DONEBOT_MEDIA_PARAMETER_SCHEMAS } from "./media-parameter-schemas.ts";
import { seedream55ParameterRules } from "./seedream-capabilities.ts";

const MEDIA_PROVIDER_GUIDANCE = "For image, video and audio generation, choose the provider in this order: the user's explicit choice for this request, the saved preference for this bot and media kind, then the built-in DoneBot gateway. Third-party media CLIs, MCP servers and skills use existing command, MCP and skill tools with normal permissions; inspect their installed instructions or CLI help as needed, without inventing capabilities. To change this bot's future default, use propose_profile to save the provider and media kind in SOUL.md, preserving other instructions; for an explicitly all-bots preference, use memory_update action prefer. Confirm saving only after success. A one-time choice does not change the default. If the chosen provider is missing, signed out or fails, report the blocker and use existing setup/authentication tools when authorized. Do not silently switch providers or submit another paid generation. Built-in schemas and job rules apply only to gateway tools; external providers follow their own contracts. Older assistant claims that external media tools are forbidden are incorrect.";

export function guideDoneBotMedia(input: CompletionTransportInput, catalog: DoneBotCatalog | null): CompletionTransportInput {
  const local = doneBotClientMediaCatalog(catalog);
  const tools = input.tools.filter(tool => tool.function.name !== "agents_media_model_capabilities" &&
    !DONEBOT_LEGACY_MEDIA_TOOL_NAMES.has(tool.function.name.replace(/^agents_/, ""))).flatMap(tool => {
    const kind = tool.function.name === "agents_generate_image" ? "image"
      : tool.function.name === "agents_generate_video" ? "video" : tool.function.name === "agents_generate_audio" ? "music" : undefined;
    if (!kind) return [tool];
    const model = DONEBOT_MEDIA_MODELS[kind];
    if (!local?.models.some(entry => entry.id === model)) return [];
    const schema = tool.function.parameters;
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const { model: _model, ...remaining } = properties;
    const rules = kind === "image" ? `${seedream55ParameterRules.references} ${seedream55ParameterRules.rules.join(" ")}` : DONEBOT_MEDIA_PARAMETER_GUIDANCE[kind];
    return [{ ...tool, function: { ...tool.function, description: `${tool.function.description} ${rules}`, parameters: {
      ...schema, required: ["parameters"], properties: { ...remaining, parameters: DONEBOT_MEDIA_PARAMETER_SCHEMAS[kind] },
    } } }];
  });
  const gatewayAvailable = tools.some(tool => ["agents_generate_image", "agents_generate_video", "agents_generate_audio"].includes(tool.function.name));
  const gatewayGuidance = gatewayAvailable ? "The built-in gateway uses one client-registered model per kind: Seedream 5.5 for images, Seedance 2.5 for video, Suno v6 for music. For this route, submit directly using the matching DoneBot tool; the client supplies the model ID and native parameter schema. Do not query capabilities or run discovery before gateway generation. Use only documented native parameters; reason is not a native field. The gateway forwards the client's native request and bills it. A saved asynchronous job runs in the background and delivers files in this same conversation. Acknowledge once; do not poll, resubmit or claim completion before the receipt. These schemas supersede older claims about built-in model parameters, while preserving the user's provider preference." : "";
  const guidance = `${MEDIA_PROVIDER_GUIDANCE} ${DONEBOT_MODEL_CREDENTIAL_RULE} Use the existing voice tools for streaming text-to-speech.${gatewayGuidance ? ` ${gatewayGuidance}` : ""}`;
  return { ...input, tools, messages: [{ role: "system", content: guidance }, ...input.messages] };
}
