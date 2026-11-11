import type { DoneBotCatalog } from "../../shared/donebot.ts";
import type { CompletionTransportInput } from "../drivers/openai-chat.ts";
import { DONEBOT_MODEL_CREDENTIAL_RULE } from "./credential-policy.ts";
import { DONEBOT_LEGACY_MEDIA_TOOL_NAMES } from "./media-tools.ts";
import { doneBotClientMediaCatalog, DONEBOT_MEDIA_MODELS } from "./media-registry.ts";
import { DONEBOT_MEDIA_PARAMETER_GUIDANCE, DONEBOT_MEDIA_PARAMETER_SCHEMAS } from "./media-parameter-schemas.ts";
import { seedream55ParameterRules } from "./seedream-capabilities.ts";

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
  if (!tools.some(tool => ["agents_generate_image", "agents_generate_video", "agents_generate_audio"].includes(tool.function.name))) return { ...input, tools };
  const guidance = `${DONEBOT_MODEL_CREDENTIAL_RULE} Media generation uses one client-registered model per kind: Seedream 5.5 for images, Seedance 2.5 for video, Suno v6 for music. The generation tools already contain their parameter rules. Submit directly using the matching tool; the client supplies the model ID. Do not query capabilities or run discovery before generation. Use only documented native parameters; reason is not a native field. The gateway forwards the client's native request and bills it. A saved asynchronous job runs in the background and delivers files in this same conversation. Acknowledge once; do not poll, resubmit or claim completion before the receipt. Use the existing voice tools for streaming text-to-speech. Current tool contracts supersede older assistant claims, skills or memories about media models.`;
  return { ...input, tools, messages: [{ role: "system", content: guidance }, ...input.messages] };
}
