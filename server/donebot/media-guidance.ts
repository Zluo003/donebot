import type { DoneBotCatalog } from "../../shared/donebot.ts";
import type { CompletionTransportInput } from "../drivers/openai-chat.ts";
import { DONEBOT_MODEL_CREDENTIAL_RULE } from "./credential-policy.ts";
import { DONEBOT_LEGACY_MEDIA_TOOL_NAMES } from "./media-tools.ts";

const MEDIA_TOOL_NAMES = new Set(["agents_media_model_capabilities", "agents_generate_image", "agents_generate_video", "agents_generate_audio"]);

export function guideDoneBotMedia(input: CompletionTransportInput, _catalog: DoneBotCatalog | null): CompletionTransportInput {
  const hasMediaTool = input.tools.some(tool => MEDIA_TOOL_NAMES.has(tool.function.name));
  const tools = input.tools.filter(tool => !DONEBOT_LEGACY_MEDIA_TOOL_NAMES.has(tool.function.name.replace(/^agents_/, "")));
  if (!hasMediaTool) {
    return tools.length === input.tools.length ? input : { ...input, tools };
  }
  const guidance = `${DONEBOT_MODEL_CREDENTIAL_RULE} For a media request, call media_model_capabilities with the matching kind, choose a locally supported public model based on the task, and construct its exact native request fields from the returned registration. Then call generate_image, generate_video or generate_audio with that public model ID and complete parameters. The model choice and request construction happen in this client; the API gateway forwards the request and bills it. A confirmed terminal failure is returned only after gateway account retries finish; use the error code and capability list to decide whether a different supported public model is appropriate, and never resubmit a pending or uncertain job. Audio generation is for standalone audio such as music; use the existing voice tools for streaming text-to-speech. Continue in this same conversation. Successful files return through the original conversation. Current tool results supersede older assistant claims, skills or memories about unavailable media generation.`;
  return { ...input, tools, messages: [{ role: "system", content: guidance }, ...input.messages] };
}
