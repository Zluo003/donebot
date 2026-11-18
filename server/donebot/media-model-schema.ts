import { nativeModel, modelCapabilities } from "./capabilities.ts";
import type { DoneBotGatewayModel } from "../../shared/donebot.ts";
import { DONEBOT_MEDIA_PARAMETER_GUIDANCE, DONEBOT_MEDIA_PARAMETER_SCHEMAS } from "./media-parameter-schemas.ts";
import { museParameterSchema, museParameterRules } from "./muse-capabilities.ts";
import { seedream55ParameterRules } from "./seedream-capabilities.ts";

const localFile = { type: "object", additionalProperties: false, properties: { local_path: { type: "string" } }, required: ["local_path"] };
const text = { type: "string" };

export function mediaModelSchema(model: DoneBotGatewayModel): { parameters: Record<string, unknown>; guidance: string; operations: string[] } {
  const native = nativeModel(model.id)!;
  const capabilities = modelCapabilities(model);
  const rules = capabilities.client.parameterRules;
  const operations = native.kind === "image" ? capabilities.client.imageEditEndpoint ? ["generate", "edit"] : ["generate"]
    : capabilities.client.operations.filter(operation => ["generate", "edit", "extend"].includes(operation));
  if (model.id === "muse-video") return { parameters: museParameterSchema, guidance: museParameterRules.rules.join(" "), operations };
  if (model.id === "seedream-5-5") return { parameters: DONEBOT_MEDIA_PARAMETER_SCHEMAS.image!, guidance: `${seedream55ParameterRules.references} ${seedream55ParameterRules.rules.join(" ")}`, operations };
  if (native.kind === "music") return { parameters: DONEBOT_MEDIA_PARAMETER_SCHEMAS.music!, guidance: DONEBOT_MEDIA_PARAMETER_GUIDANCE.music!, operations };
  if (native.kind === "video") {
    const parameters = structuredClone(DONEBOT_MEDIA_PARAMETER_SCHEMAS.video!);
    const properties = parameters.properties as Record<string, unknown>;
    const duration = native.media!.duration!;
    properties.duration = { type: "integer", minimum: duration.min, maximum: duration.max, default: 6 };
    properties.resolution = { type: "string", enum: capabilities.client.outputResolutions };
    properties.output_format = { type: "string", enum: native.media!.formats };
    if (!native.media!.formats?.includes("mov")) delete properties.output_format;
    if (model.id !== "seedance-2-5") delete properties.omni_reference_task_type;
    else properties.omni_reference_task_type = { type: "string", enum: ["auto", "reference", "extend"], description: "Default reference with any reference media; omit for text-only or explicit first/last frames. Extend only when explicitly requested." };
    parameters.required = ["content", "duration", "resolution"];
    const videoRules = rules?.rules.filter(rule => !rule.startsWith("Duration="));
    return { parameters, guidance: `${model.display_name}: ${videoRules?.join(" ") ?? ""} Submit an explicit integer duration from ${duration.min} to ${duration.max} seconds; default 6. The gateway requires positive submitted duration; automatic -1 duration is unavailable.`, operations };
  }
  const gpt = capabilities.client.imageEditEndpoint;
  const properties: Record<string, unknown> = {
    prompt: { ...text, minLength: 1 }, n: { type: "integer", minimum: 1, maximum: gpt ? 10 : 1 },
    size: text, output_format: { type: "string", enum: gpt ? capabilities.client.outputFormats ?? native.media!.formats : ["jpeg", "png"] },
    ...(gpt ? { images: { type: "array", maxItems: 16, items: { type: "object", additionalProperties: false, properties: { image_url: localFile }, required: ["image_url"] } },
      quality: { type: "string", enum: native.media!.qualities }, background: { type: "string", enum: native.media!.backgrounds },
      output_compression: { type: "integer", minimum: 0, maximum: 100 }, moderation: { type: "string", enum: ["auto", "low"] },
      user: text, safety_identifier: { type: "string", maxLength: 128 }, response_format: { type: "string", enum: ["url", "b64_json"] },
      ...(native.media?.complexity ? { complexity: { type: "string", enum: ["high"] }, frame_count: { type: "integer", minimum: 2, maximum: 16 }, frame_duration_ms: { type: "integer", minimum: 20, maximum: 2000 } } : {}) }
      : { image_urls: { type: "array", maxItems: 10, items: localFile }, resolution: { type: "string", enum: ["1K", "1.5K", "2K"] }, watermark: { type: "boolean" },
        layer_decomposition: { type: "boolean" }, background: { type: "string", enum: ["transparent"] },
        optimize_prompt_options: { type: "object", additionalProperties: false, properties: { mode: { type: "string", enum: ["standard"] } }, required: ["mode"] } }),
  };
  return { parameters: { type: "object", additionalProperties: false, properties, required: gpt ? ["prompt"] : [] },
    guidance: `${model.display_name}: ${rules && "references" in rules ? rules.references : ""} ${rules?.rules.join(" ") ?? ""}`, operations };
}
