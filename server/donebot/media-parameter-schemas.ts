import { seedream55ParameterSchema } from "./seedream-capabilities.ts";
import { sunoParameterRules, sunoParameterSchema } from "./suno-capabilities.ts";

const localFile = { type: "object", additionalProperties: false, properties: { local_path: { type: "string" } }, required: ["local_path"] };
const text = { type: "string" };
const boolean = { type: "boolean" };

export const DONEBOT_MEDIA_PARAMETER_SCHEMAS: Record<string, Record<string, unknown>> = {
  image: seedream55ParameterSchema,
  video: {
    type: "object", additionalProperties: false,
    properties: {
      content: { type: "array", minItems: 1, description: "A complete text prompt and optional model-specific reference files.", items: { type: "object", additionalProperties: false, properties: {
        type: { type: "string", enum: ["text", "image_url", "video_url", "audio_url"] }, text,
        image_url: { type: "object", additionalProperties: false, properties: { url: localFile }, required: ["url"] },
        video_url: { type: "object", additionalProperties: false, properties: { url: localFile }, required: ["url"] },
        audio_url: { type: "object", additionalProperties: false, properties: { url: localFile }, required: ["url"] },
        role: { type: "string", enum: ["first_frame", "last_frame", "reference_image", "reference_video", "reference_audio"] },
      }, required: ["type"] } },
      duration: { type: "integer", enum: [-1, ...Array.from({ length: 27 }, (_, index) => index + 4)], description: "4..30 seconds or -1 for automatic duration; edit requires -1." },
      resolution: { type: "string", enum: ["480p", "720p", "1080p"] },
      ratio: { type: "string", enum: ["16:9", "9:16", "1:1", "21:9", "4:3", "3:4", "adaptive"] },
      omni_reference_task_type: { type: "string", enum: ["auto", "reference", "edit", "extend"], description: "With reference material, default to reference (全能参考), including one image or audio-only input. Omit without references or in explicit first/last-frame mode. Use edit/extend only when explicitly requested." },
      output_format: { type: "string", enum: ["mp4", "mov"] },
      generate_audio: { type: "boolean", enum: [true] }, watermark: boolean, return_last_frame: boolean,
      execution_expires_after: { type: "integer", minimum: 3600, maximum: 259200 },
      priority: { type: "integer", minimum: 0, maximum: 9 }, safety_identifier: { type: "string", maxLength: 64, pattern: "^[ -~]*$" },
    }, required: ["content"],
  },
  music: sunoParameterSchema,
};

export const DONEBOT_MEDIA_PARAMETER_GUIDANCE: Record<string, string> = {
  music: sunoParameterRules.rules.join(" "),
};
