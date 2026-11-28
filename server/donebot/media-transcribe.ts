import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { DoneBotCatalog } from "../../shared/donebot.ts";
import type { DoneBotScope } from "./gateway.ts";
import type { MediaContext } from "./media.ts";
import { resolveDoneBotAsrModel } from "./media-registry.ts";

const execFileAsync = promisify(execFile);

const TARGET_SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
const CHUNK_SECONDS = 90;
const CHUNK_PCM_BYTES = CHUNK_SECONDS * TARGET_SAMPLE_RATE * BYTES_PER_SAMPLE;
const MAX_TRANSCRIBE_DURATION_SEC = 600;
const MAX_DIRECT_WAV_BYTES = 24 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 120_000;

export interface TranscribeFileHandle {
  path: string;
  name: string;
  mime: string;
  bytes: number;
  readBytes(): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface TranscribeAudioInput {
  local_path: string;
  start_sec?: number;
  duration_sec?: number;
  language_hints?: string[];
  hotwords?: Record<string, number>;
}

export interface TranscribeAudioSegment {
  begin_sec: number;
  end_sec: number;
  text: string;
}

export interface TranscribeAudioResult {
  model: string;
  file: string;
  start_sec: number;
  duration_sec: number;
  chunks: number;
  text: string;
  segments: TranscribeAudioSegment[];
  timeline_text: string;
}

export interface DoneBotMediaTranscriber {
  transcribe(context: MediaContext, input: TranscribeAudioInput): Promise<TranscribeAudioResult>;
}

export interface DoneBotMediaTranscriberDeps {
  scope(): DoneBotScope | null;
  catalog(): DoneBotCatalog | null;
  fetchGateway(scope: DoneBotScope, path: string, init: RequestInit): Promise<Response>;
  openLocalMedia(context: MediaContext, localPath: string): Promise<TranscribeFileHandle>;
  extractPcm?: (filePath: string, startSec: number, durationSec: number) => Promise<Uint8Array>;
}

interface ParsedWavPcm {
  sampleRate: 8_000 | 16_000;
  pcm: Uint8Array;
}

/** Parses standard 16-bit mono PCM RIFF/WAVE headers so compatible WAV files can transcribe without ffmpeg. */
export function parseCompatibleWav(bytes: Uint8Array): ParsedWavPcm | null {
  if (bytes.byteLength < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.byteLength) break;
    if (id === "fmt " && size >= 16) {
      audioFormat = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === "data") {
      dataOffset = body;
      dataSize = size;
      break;
    }
    offset = body + size + (size % 2);
  }
  if (audioFormat !== 1 || channels !== 1 || bitsPerSample !== 16 || (sampleRate !== 8_000 && sampleRate !== 16_000) || dataOffset < 0) {
    return null;
  }
  return { sampleRate: sampleRate as 8_000 | 16_000, pcm: bytes.subarray(dataOffset, dataOffset + dataSize) };
}

function formatHms(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

async function defaultExtractPcmWithFfmpeg(filePath: string, startSec: number, durationSec: number): Promise<Uint8Array> {
  const args = [
    "-v", "error",
    ...(startSec > 0 ? ["-ss", String(startSec)] : []),
    "-t", String(durationSec),
    "-i", filePath,
    "-vn",
    "-ac", "1",
    "-ar", String(TARGET_SAMPLE_RATE),
    "-f", "s16le",
    "pipe:1",
  ];
  try {
    const { stdout } = await execFileAsync("ffmpeg", args, {
      encoding: "buffer",
      maxBuffer: (durationSec + 5) * TARGET_SAMPLE_RATE * BYTES_PER_SAMPLE + 2 * 1024 * 1024,
      timeout: FFMPEG_TIMEOUT_MS,
    });
    return new Uint8Array(stdout.buffer, stdout.byteOffset, stdout.byteLength);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      throw Object.assign(
        new Error("当前运行环境未安装 ffmpeg，无法直接从视频或压缩音频抽取音轨。请先转为 16kHz 单声道 WAV，或在安装 ffmpeg 的环境中运行。"),
        { status: 422 },
      );
    }
    const stderr = (error as { stderr?: Buffer | string })?.stderr?.toString().trim();
    throw Object.assign(
      new Error(`抽取音频失败${stderr ? `：${stderr.slice(0, 240)}` : "（请确认文件包含有效音轨）。"}`),
      { status: 422 },
    );
  }
}

function statusError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

export function createDoneBotMediaTranscriber(deps: DoneBotMediaTranscriberDeps): DoneBotMediaTranscriber {
  const extractPcm = deps.extractPcm ?? defaultExtractPcmWithFfmpeg;

  return {
    async transcribe(context, input) {
      if (!context.active()) throw statusError(403, "This conversation turn ended before transcription started.");
      const scope = deps.scope();
      if (!scope) throw statusError(401, "Sign in to DoneBot to transcribe audio.");
      const asrModel = resolveDoneBotAsrModel(deps.catalog());
      if (!asrModel) throw statusError(409, "当前账号未启用语音转写模型（qwen-audio-3.1-asr-flash-streaming）。");

      const startSec = Math.max(0, input.start_sec ?? 0);
      const requestedDuration = Math.min(MAX_TRANSCRIBE_DURATION_SEC, Math.max(1, input.duration_sec ?? MAX_TRANSCRIBE_DURATION_SEC));

      const opened = await deps.openLocalMedia(context, input.local_path);
      let sampleRate: 8_000 | 16_000 = TARGET_SAMPLE_RATE;
      let pcm: Uint8Array;
      try {
        if (!/^(?:audio|video)\//.test(opened.mime)) {
          throw statusError(400, `仅支持音频或视频文件转写，当前文件类型为 ${opened.mime || "unknown"}。`);
        }
        let direct: ParsedWavPcm | null = null;
        if (opened.mime === "audio/wav" || opened.mime === "audio/x-wav" || opened.mime === "audio/wave" || opened.name.toLowerCase().endsWith(".wav")) {
          if (opened.bytes <= MAX_DIRECT_WAV_BYTES) {
            direct = parseCompatibleWav(await opened.readBytes());
          }
        }
        if (direct) {
          sampleRate = direct.sampleRate;
          const bytesPerSec = sampleRate * BYTES_PER_SAMPLE;
          const startByte = Math.min(direct.pcm.byteLength, Math.floor(startSec * bytesPerSec) & ~1);
          const endByte = Math.min(direct.pcm.byteLength, startByte + (Math.floor(requestedDuration * bytesPerSec) & ~1));
          pcm = direct.pcm.subarray(startByte, endByte);
        } else {
          pcm = await extractPcm(opened.path, startSec, requestedDuration);
        }
      } finally {
        await opened.close();
      }

      if (pcm.byteLength === 0) {
        throw statusError(422, "指定时间段内未提取到有效音频数据（可能超出视频总时长或文件无音轨）。");
      }

      const bytesPerSec = sampleRate * BYTES_PER_SAMPLE;
      const chunkBytes = Math.min(CHUNK_PCM_BYTES, CHUNK_SECONDS * bytesPerSec);
      const actualDurationSec = Number((pcm.byteLength / bytesPerSec).toFixed(2));
      const chunkTexts: string[] = [];
      const segments: TranscribeAudioSegment[] = [];
      let chunkIndex = 0;

      for (let offset = 0; offset < pcm.byteLength; offset += chunkBytes) {
        if (!context.active()) throw statusError(403, "This conversation turn ended during audio transcription.");
        const currentScope = deps.scope();
        if (!currentScope || currentScope.accountId !== scope.accountId || currentScope.installationId !== scope.installationId) {
          throw statusError(409, "DoneBot account changed during transcription.");
        }
        const slice = pcm.subarray(offset, Math.min(pcm.byteLength, offset + chunkBytes));
        const chunkOffsetSec = startSec + offset / bytesPerSec;
        const body: Record<string, unknown> = {
          model: asrModel.id,
          audio_base64: Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength).toString("base64"),
          format: "pcm",
          sample_rate: sampleRate,
        };
        if (input.language_hints?.length) body.language_hints = input.language_hints;
        if (input.hotwords && Object.keys(input.hotwords).length > 0) body.vocabulary = input.hotwords;

        const response = await deps.fetchGateway(scope, "/v1/audio/transcriptions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `donebot-asr-${randomUUID()}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(100_000),
        });
        const payload = await response.json().catch(() => ({})) as {
          text?: unknown;
          segments?: Array<{ begin_ms?: unknown; end_ms?: unknown; text?: unknown }>;
          error?: { message?: unknown } | string;
        };
        if (!response.ok) {
          const message = typeof payload.error === "string"
            ? payload.error
            : typeof payload.error?.message === "string"
              ? payload.error.message
              : `Gateway transcription failed (HTTP ${response.status}).`;
          throw statusError(response.status, message);
        }
        const chunkText = typeof payload.text === "string" ? payload.text.trim() : "";
        if (chunkText) chunkTexts.push(chunkText);

        if (Array.isArray(payload.segments) && payload.segments.length > 0) {
          for (const seg of payload.segments) {
            const segText = typeof seg.text === "string" ? seg.text.trim() : "";
            if (!segText) continue;
            const beginMs = typeof seg.begin_ms === "number" && Number.isFinite(seg.begin_ms) ? seg.begin_ms : 0;
            const endMs = typeof seg.end_ms === "number" && Number.isFinite(seg.end_ms) ? Math.max(beginMs, seg.end_ms) : beginMs;
            segments.push({
              begin_sec: Number((chunkOffsetSec + beginMs / 1000).toFixed(2)),
              end_sec: Number((chunkOffsetSec + endMs / 1000).toFixed(2)),
              text: segText,
            });
          }
        } else if (chunkText) {
          segments.push({
            begin_sec: Number(chunkOffsetSec.toFixed(2)),
            end_sec: Number((chunkOffsetSec + slice.byteLength / bytesPerSec).toFixed(2)),
            text: chunkText,
          });
        }
        chunkIndex += 1;
      }

      const timelineText = segments
        .map((seg) => `[${formatHms(seg.begin_sec)} - ${formatHms(seg.end_sec)}] ${seg.text}`)
        .join("\n");

      return {
        model: asrModel.id,
        file: opened.name,
        start_sec: Number(startSec.toFixed(2)),
        duration_sec: actualDurationSec,
        chunks: chunkIndex,
        text: chunkTexts.join(""),
        segments,
        timeline_text: timelineText,
      };
    },
  };
}
