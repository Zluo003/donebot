import { seedream55ParameterSchema } from "./seedream-capabilities.ts";
import { seedance, seedanceReferenceGuidance } from "./seedance-capabilities.ts";
import { sunoParameterRules, sunoParameterSchema } from "./suno-capabilities.ts";

const localFile = { type: "object", additionalProperties: false, properties: { local_path: { type: "string" } }, required: ["local_path"] };
const text = { type: "string" };
const boolean = { type: "boolean" };

export const DONEBOT_MEDIA_PARAMETER_SCHEMAS: Record<string, Record<string, unknown>> = {
  image: seedream55ParameterSchema,
  video: {
    type: "object", additionalProperties: false,
    properties: {
      content: { type: "array", minItems: 1, description: "Text prompt plus at most 50 reference files: 30 images, 10 videos, 10 audios. Native text is optional with references; this client requires a complete prompt.", items: { type: "object", additionalProperties: false, properties: {
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
  video: "Seedance 2.5: submit content containing the complete text prompt and native reference roles. With reference material, default to 全能参考 (multimodal reference): omni_reference_task_type=reference and reference_image/reference_video/reference_audio roles, even for one image. Without reference material, use text-to-video and omit omni_reference_task_type. Default 720p, adaptive ratio, automatic duration and generated audio. Switch to first/last frames, edit or extend only when explicitly requested. Do not combine first/last frames with reference media; last_frame requires first_frame. At most 30 reference images, 10 reference videos and 10 reference audios, 50 files total. Edit requires a reference video, ratio=adaptive, duration=-1; extend requires a reference video and ratio=adaptive. Duration 4..30 or -1. No 4K. No draft or web_search workflow is exposed. The client preserves existing references. " + seedanceReferenceGuidance(seedance("doubao-seedance-2-5-260628", ["480p", "720p", "1080p"], true)),
  music: sunoParameterRules.rules.join(" "),
};
