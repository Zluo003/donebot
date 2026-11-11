import type { NativeModel } from "./capabilities.ts";
import type { MediaReferencePolicy } from "./media-assets.ts";

const VOLC = "https://docs.volcengine.com/docs/ark/";
export const SEEDANCE_RATIOS = ["16:9", "9:16", "1:1", "21:9", "4:3", "3:4", "adaptive"];
export const SEEDANCE_FIELDS = ["model", "content", "duration", "resolution", "ratio", "generate_audio", "watermark", "return_last_frame", "execution_expires_after", "omni_reference_task_type", "output_format", "priority", "safety_identifier"];

export interface SeedanceReferenceConstraints {
  maxTotalFiles: number;
  requestBodyMaxMegabytes: number;
  image: {
    formats: string[];
    maxMegabytes: number;
    sizeLimitExclusive: boolean;
    edgePixels: { min: number; max: number };
    widthHeightRatio: { min: number; max: number };
    count: { reference: number; firstFrame: number; firstLastFrame: number };
  };
  video: {
    formats: string[];
    resolutions: string[];
    videoCodecs: string[];
    audioCodecsByContainer: Record<string, string[]>;
    maxMegabytes: number;
    edgePixels: { min: number; max: number };
    widthHeightRatio: { min: number; max: number };
    totalPixels: { min: number; max: number };
    fps: { min: number; max: number };
    maxCount: number;
    durationSeconds: { min: number; max: number; totalMax: number; editMin?: number };
  };
  audio: {
    formats: string[];
    maxMegabytes: number;
    maxCount: number;
    durationSeconds: { min: number; max: number; totalMax: number };
    requiresVisualReference: boolean;
  };
  portrait: {
    directHumanFaceReferences: boolean;
    authorizedPortraitAssets: boolean;
    trustedGeneratedVideo: { sameUpstreamAccount: boolean; originalOnly: boolean; withinDays: number; modelFamilies: string[] };
    trustedGeneratedImages: { sameUpstreamAccount: boolean; originalOnly: boolean; withinDays: number; sources: string[] };
    trustedOutputsPlatform: string;
  };
}

export function seedance(officialId: string, resolutions: string[], newer = false): NativeModel {
  const maxDuration = newer ? 30 : 15;
  const visual = { edgePixels: { min: 300, max: 6000 }, widthHeightRatio: { min: 0.4, max: 2.5 } };
  return { officialId, kind: "video", tools: false, input: ["text", "image", "video", "audio"], output: ["video", "audio"], streaming: false,
    verifiedAt: "2026-11-11", sources: [`${VOLC}seedance-${newer ? "2-5" : "2-0"}?lang=zh`, `${VOLC}create-video-generation-task-api?lang=zh`,
      `${VOLC}video-generation-tutorial?lang=zh`, `${VOLC}seedance-${newer ? "2-5" : "2-0"}-prompt-guide?lang=zh`, `${VOLC}seedance-portrait-asset-guide?lang=zh`],
    media: { operations: ["generate", "first_frame", "first_last_frame", "multimodal_reference", "edit", "extend"],
      maxReferences: { image: newer ? 30 : 9, video: newer ? 10 : 3, audio: newer ? 10 : 3 }, resolutions, aspectRatios: SEEDANCE_RATIOS,
      formats: newer ? ["mp4", "mov"] : ["mp4"], builtInTools: ["web_search"],
      ...(newer ? { explicitTaskTypes: ["auto", "reference", "edit", "extend"],
        draft: { previewResolution: "480p", finalResolution: "1080p", taskTtlDays: 14, ttlEffectiveAt: "2026-10-28T10:00:00+08:00", separatelyBilled: true,
          inheritedFields: ["content.text", "content.image_url", "content.video_url", "content.audio_url", "duration", "ratio", "seed", "generate_audio", "omni_reference_task_type"],
          overridableFields: ["return_last_frame", "output_format", "watermark", "service_tier", "execution_expires_after", "priority", "callback_url", "safety_identifier"] } } : {}),
      duration: { min: 4, max: maxDuration, automatic: true }, audioOnlyReference: newer, nativeAssetReferences: true,
      referenceMedia: {
        maxTotalFiles: newer ? 50 : 15, requestBodyMaxMegabytes: 64,
        image: { ...visual, formats: ["jpeg", "png", "webp", "bmp", "tiff", "gif", "heic", "heif"], maxMegabytes: 30, sizeLimitExclusive: true,
          count: { reference: newer ? 30 : 9, firstFrame: 1, firstLastFrame: 2 } },
        video: { ...visual, formats: ["mp4", "mov"], resolutions: ["480p", "720p", "1080p", "4k"], videoCodecs: ["h264", "hevc"],
          audioCodecsByContainer: { mp4: ["aac", "mp3"], mov: newer ? ["aac", "mp3", "pcm"] : ["aac", "mp3"] },
          maxMegabytes: 200, totalPixels: { min: 407_696, max: 8_295_044 }, fps: { min: 24, max: 60 }, maxCount: newer ? 10 : 3,
          durationSeconds: { min: 2, max: maxDuration, totalMax: maxDuration, ...(newer ? { editMin: 4 } : {}) } },
        audio: { formats: ["wav", "mp3"], maxMegabytes: 15, maxCount: newer ? 10 : 3,
          durationSeconds: { min: 2, max: maxDuration, totalMax: maxDuration }, requiresVisualReference: !newer },
        portrait: { directHumanFaceReferences: false, authorizedPortraitAssets: true,
          trustedGeneratedVideo: { sameUpstreamAccount: true, originalOnly: true, withinDays: 30, modelFamilies: ["seedance-2-0", "seedance-2-5"] },
          trustedGeneratedImages: { sameUpstreamAccount: true, originalOnly: true, withinDays: 30,
            sources: ["Seedance 2.0/2.5 generated video last frames", "Seedream 5.0 lite/pro/flash text-to-image outputs"] }, trustedOutputsPlatform: "Volcengine ModelArk only; not transferable across platforms" },
      },
      videoOutput: { fps: 24, audioChannels: 2, defaultResolution: "720p", defaultRatio: "adaptive", defaultFormat: "mp4",
        ...(newer ? { defaultDuration: -1, movEncoding: "H.264 / yuv444p / PCM" } : {}),
        highResolutionHevc10Bit: newer ? ["1080p"] : resolutions.includes("4k") ? ["4k"] : [] },
      prompt: { languages: ["zh", "en", "es", "id", "pt", "ja", ...(newer ? ["ms", "th", "ar", "vi", "ko"] : [])],
        recommendedMax: { chineseCharacters: 500, englishWords: 1000 },
        referenceAddressing: "Use per-modality content order: 图片1/视频1/音频1 (or @图片1/@视频1/@音频1). Specify each reference's subject, motion, style or sound role; filenames and asset IDs are not model reference names." },
      notes: ["First/last frames and multimodal references are mutually exclusive; a last frame requires a first frame. Mismatched last-frame aspect ratio is cropped to the first frame.",
        "All numeric reference ranges are inclusive except the strictly-less-than image byte limit. Sum video durations separately from audio durations. The 64 MB limit applies to the request body, not the total size of URL-referenced files.",
        "Reference video dimensions are validated by edges AND total pixels AND aspect ratio; a resolution label alone is insufficient. Do not confuse input resolution with output resolution tiers.",
        "seed, frames, camera_fixed and flex service tier are not generation controls documented for these models. Use body parameters rather than weak --parameter prompt suffixes.",
        "Native web_search is supported but not exposed by the DoneBot adapter. Seedance 2.5 also documents a two-stage draft workflow, currently unavailable in the client. Do not send tools, draft or draft_task through this client.",
        "Real-person face references require the provider's authorized portrait workflow or trusted original generated videos/images. An ordinary DoneBot upload URL does not establish authorization or same-upstream-account provenance.",
        "Output duration can differ slightly from the requested duration; query duration is truncated from frames/24. Inspect the actual result before claiming exact length, resolution or audio.",
        ...(newer ? ["Audio-only reference is explicitly supported by the ModelArk 2.5 API; an image/video is optional.",
          "First/last-frame mode requires adaptive ratio. Edit requires a reference video, adaptive ratio and duration=-1; each input video in an edit task must be 4..30 seconds.",
          "Extend requires a reference video and adaptive ratio. Duration means the final total output length, not added seconds; -1 selects automatic duration.",
          "MOV uses H.264/yuv444p/PCM and may need a compatible professional player. The 2.5 tutorial permits PCM in MOV references; the common API codec table lists only AAC/MP3."]
          : ["Audio reference requires an image or video reference. Edit/extend use reference_video plus prompt instructions; omni_reference_task_type is unavailable.",
            "MP4 is the documented output. MOV reference input does not establish support for MOV output selection."])],
    } };
}

const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function normalizeSeedanceParameters(native: NativeModel, parameters: Record<string, unknown>, operation: "generate" | "edit" | "extend" = "generate"): Record<string, unknown> {
  const content = Array.isArray(parameters.content) ? parameters.content.map(value => {
    const part = record(value);
    return part?.type === "image_url" && part.role === undefined ? { ...part, role: "reference_image" } : value;
  }) : parameters.content;
  const parts = Array.isArray(content) ? content.map(record) : [];
  const frames = parts.some(part => part?.role === "first_frame" || part?.role === "last_frame");
  const references = parts.some(part => ["image_url", "video_url", "audio_url"].includes(String(part?.type)));
  const p: Record<string, unknown> = { ...parameters, ...(content === undefined ? {} : { content }) };
  if (native.media?.explicitTaskTypes) {
    if (operation !== "generate" && p.omni_reference_task_type !== undefined && p.omni_reference_task_type !== operation) {
      throw new Error("The video operation and omni_reference_task_type must match.");
    }
    if (operation !== "generate") p.omni_reference_task_type = operation;
    if (references && !frames && p.omni_reference_task_type === undefined) p.omni_reference_task_type = "reference";
    if ((frames || p.omni_reference_task_type === "edit" || p.omni_reference_task_type === "extend") && p.ratio === undefined) p.ratio = "adaptive";
    if (p.omni_reference_task_type === "edit" && p.duration === undefined) p.duration = -1;
  }
  return p;
}

export function seedanceReferencePolicy(native: NativeModel): MediaReferencePolicy {
  const limits = native.media!.referenceMedia!;
  const formats: Record<string, string> = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp", "image/bmp": "bmp", "image/tiff": "tiff",
    "image/gif": "gif", "image/heic": "heic", "image/heif": "heif", "video/mp4": "mp4", "video/quicktime": "mov", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3" };
  return { maxFiles: limits.maxTotalFiles, maxBytesPerFile: limits.video.maxMegabytes * 1024 * 1024, validateFile: file => {
    const kind = file.mime.split("/")[0] as "image" | "video" | "audio";
    const constraints = limits[kind];
    if (!constraints || !constraints.formats.includes(formats[file.mime] ?? "")) throw new Error("Seedance reference format is not supported; inspect or convert the local file before uploading.");
    const bytes = constraints.maxMegabytes * 1024 * 1024;
    if (file.bytes.byteLength > bytes || kind === "image" && file.bytes.byteLength === bytes) throw new Error(`Seedance ${kind} reference exceeds its official file-size limit.`);
  } };
}

export function seedanceReferenceGuidance(native: NativeModel): string {
  const { image, video, audio, maxTotalFiles, requestBodyMaxMegabytes } = native.media!.referenceMedia!;
  return `References: <=${maxTotalFiles} files total. Images: <=${image.count.reference}, ${image.formats.join("/")}, each <${image.maxMegabytes} MiB, edges ${image.edgePixels.min}..${image.edgePixels.max}px, width/height ${image.widthHeightRatio.min}..${image.widthHeightRatio.max}. Videos: <=${video.maxCount}, MP4/MOV H.264/HEVC, MP4 audio AAC/MP3, MOV audio ${video.audioCodecsByContainer.mov!.join("/")}; each <=${video.maxMegabytes} MiB, edges ${video.edgePixels.min}..${video.edgePixels.max}px, width/height ${video.widthHeightRatio.min}..${video.widthHeightRatio.max}, ${video.totalPixels.min}..${video.totalPixels.max} pixels, ${video.fps.min}..${video.fps.max} FPS, ${video.durationSeconds.min}..${video.durationSeconds.max}s${video.durationSeconds.editMin ? ` (edit ${video.durationSeconds.editMin}..${video.durationSeconds.max}s)` : ""}, combined video <=${video.durationSeconds.totalMax}s. Audio: <=${audio.maxCount} WAV/MP3, each <=${audio.maxMegabytes} MiB and ${audio.durationSeconds.min}..${audio.durationSeconds.max}s, combined audio <=${audio.durationSeconds.totalMax}s. URL-reference JSON body <=${requestBodyMaxMegabytes} MiB, not a combined file-byte limit. Use local_path files; type/size/count/roles checked locally, dimensions/codecs/FPS/durations and portrait authorization checked upstream. No ordinary upload proves face authorization; real faces need the provider's authorized or trusted original asset workflow. Prompt length recommendation: <=500 Chinese characters or <=1000 English words, not a hard limit.`;
}

export function seedanceParameterRules(native: NativeModel) {
  return { fields: SEEDANCE_FIELDS.filter(x => x !== "model" && (!["omni_reference_task_type", "output_format"].includes(x) || native.media?.explicitTaskTypes)), required: ["content", "resolution"],
    references: "content:[{type:'text',text:'Animate 图片1'},{type:'image_url',image_url:{url:{local_path:'/allowed/reference.png'}},role:'reference_image'}]. Video/audio use video_url/audio_url and reference_video/reference_audio roles.",
    rules: ["Default to 全能参考 (multimodal reference). Use reference_image/reference_video/reference_audio, even for one image. Switch to first_frame, first/last frames, edit or extend only when explicitly requested by the person. Do not infer first_frame from a single image or edit from a reference video.",
      "DoneBot normalizes omitted image roles to reference_image. A text prompt and an explicitly available resolution are required. Without any reference, use text-to-video; never invent a reference file.",
      "DoneBot always sends generate_audio=true; audio cannot be disabled. Quote dialogue in the prompt when relevant. Do not use weak --parameter suffixes; send supported controls in the JSON body.",
      `Duration=-1 or ${native.media!.duration!.min}..${native.media!.duration!.max} integer seconds. Output format=${native.media!.formats!.join("/")} (default mp4); ratios=${SEEDANCE_RATIOS.join("/")}. Resolutions=${native.media!.resolutions!.join("/")}. Use the client's registered contract directly.`,
      "First/last frames cannot mix with multimodal references; last requires first.",
      seedanceReferenceGuidance(native),
      "Inspect reference metadata before submission. File-size/type and count/role checks are local; dimensions, codec, frame rate and individual/total durations remain provider-validated in this version. A gateway upload alone is not proof of conformance or portrait authorization.",
      "Use per-type content order in prompt: 图片1、视频1、音频1; explain what each should contribute. Native prompt-length recommendations are guidance, not hard input limits.",
      ...(native.media?.explicitTaskTypes ? ["With references, default omni_reference_task_type=reference, not auto. Explicitly requested edit/extend use generate plus the matching task type and a reference video; ratio=adaptive. Edit duration=-1; extend duration is final total length (or -1). First/last frames also require adaptive ratio.",
        "Seedance 2.5 supports audio-only references. Input videos in edit tasks must each be 4..30 seconds; non-edit reference clips may be 2..30 seconds, summed <=30 seconds. Audio clips are separately summed <=30 seconds."]
        : ["Seedance 2.0 does not accept audio-only references: include an image/video reference. Video and audio durations are each 2..15 seconds per file, with separate sums <=15 seconds.",
          "For explicitly requested edit/extend, use reference_video and clear prompt instructions through generate. Seedance 2.0 outputs MP4; never send omni_reference_task_type or output_format, which are documented only for 2.5."])],
  };
}
