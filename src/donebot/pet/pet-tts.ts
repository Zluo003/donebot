/**
 * Low-latency TTS player dedicated to the desktop pet:
 * - Pre-warms short wake acknowledgement phrases into in-memory audio blobs for instant (<50ms) playback.
 * - Prefers `/api/tts/stream` (24kHz 16-bit LE PCM streamed directly into Web Audio API) for lowest
 *   first-audio latency and immediate barge-in cancellation, gracefully falling back to `/api/tts/speak`
 *   (WAV blob via HTMLAudioElement) and finally native speechSynthesis so the pet never fails silently.
 * - Playback stays inside Chromium's audio pipeline so getUserMedia AEC cancels speaker output cleanly.
 */

import { createStreamingPcmPlayer, type StreamingPcmPlayer } from "@/donebot/voice/pcm-player";

const MAX_CACHE_ENTRIES = 16;
const MAX_CHUNK_CHARS = 450;

export interface PetTtsSpeakResult {
  ok: boolean;
  usedFallback?: boolean;
  interrupted?: boolean;
  error?: string;
}

export interface PetTtsPlayer {
  warmPhrases(phrases: readonly string[], voiceId?: string): void;
  speak(text: string, opts?: { voiceId?: string }): Promise<PetTtsSpeakResult>;
  stop(): void;
  isSpeaking(): boolean;
  currentText(): string;
  subscribe(listener: (speaking: boolean) => void): () => void;
}

function splitForSpeak(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= MAX_CHUNK_CHARS) return [trimmed];
  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > MAX_CHUNK_CHARS) {
    const slice = rest.slice(0, MAX_CHUNK_CHARS);
    const cut = Math.max(
      slice.lastIndexOf("。"),
      slice.lastIndexOf("！"),
      slice.lastIndexOf("？"),
      slice.lastIndexOf("!"),
      slice.lastIndexOf("?"),
      slice.lastIndexOf("；"),
      slice.lastIndexOf("，"),
    );
    const splitAt = cut >= 80 ? cut + 1 : MAX_CHUNK_CHARS;
    chunks.push(rest.slice(0, splitAt).trim());
    rest = rest.slice(splitAt).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function pickLocalChineseVoice(): SpeechSynthesisVoice | null {
  try {
    const voices = window.speechSynthesis?.getVoices?.() ?? [];
    if (!voices.length) return null;
    const zh = voices.filter((v) => /^zh(?:[-_]|$)/i.test(v.lang));
    return zh.find((v) => /tingting|meijia|sinji|yating|enhanced|premium/i.test(v.name))
      ?? zh.find((v) => /zh[-_]cn/i.test(v.lang))
      ?? zh[0]
      ?? voices.find((v) => v.default)
      ?? voices[0]
      ?? null;
  } catch {
    return null;
  }
}

export function createPetTtsPlayer(deps?: {
  fetchImpl?: typeof fetch;
  playBlobImpl?: (blob: Blob, signal: AbortSignal) => Promise<boolean>;
  playPcmStreamImpl?: (response: Response, signal: AbortSignal) => Promise<boolean>;
  speakSystemImpl?: (text: string, signal: AbortSignal) => Promise<boolean>;
  /** Defaults to true when AudioContext is available and no custom playBlobImpl override forces blob mode. */
  preferStream?: boolean;
}): PetTtsPlayer {
  const fetchFn = deps?.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const pcmPlayer: StreamingPcmPlayer = createStreamingPcmPlayer();
  const preferStream = deps?.preferStream ?? (deps?.playPcmStreamImpl !== undefined || (deps?.playBlobImpl === undefined && typeof AudioContext !== "undefined"));
  const cache = new Map<string, Blob>();
  const inflightWarm = new Map<string, Promise<Blob | null>>();
  const listeners = new Set<(speaking: boolean) => void>();

  let speaking = false;
  let spokenText = "";
  let token = 0;
  let activeController: AbortController | null = null;
  let activeAudio: HTMLAudioElement | null = null;
  let activeObjectUrl: string | null = null;
  let settleAudio: ((ok: boolean) => void) | null = null;

  const setSpeaking = (next: boolean) => {
    if (speaking === next) return;
    speaking = next;
    if (!next) spokenText = "";
    for (const listener of Array.from(listeners)) listener(next);
  };

  const cleanupAudio = () => {
    if (activeAudio) {
      activeAudio.onended = null;
      activeAudio.onerror = null;
      try { activeAudio.pause(); } catch {}
      try {
        activeAudio.removeAttribute("src");
        activeAudio.load();
      } catch {}
      activeAudio = null;
    }
    if (activeObjectUrl) {
      try { URL.revokeObjectURL(activeObjectUrl); } catch {}
      activeObjectUrl = null;
    }
  };

  const cacheKey = (text: string, voiceId?: string) => `${voiceId ?? ""}::${text}`;

  const putCache = (key: string, blob: Blob) => {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, blob);
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const requestSpeakBlob = async (text: string, voiceId: string | undefined, signal?: AbortSignal): Promise<Blob | null> => {
    const attempt = async (vid?: string): Promise<Blob | null> => {
      const res = await fetchFn("/api/tts/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(vid ? { text, voiceId: vid } : { text }),
        signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        console.warn(`[pet-tts] /api/tts/speak HTTP ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`);
        return null;
      }
      const blob = await res.blob();
      return blob.size > 0 ? blob : null;
    };
    try {
      const first = await attempt(voiceId);
      if (first) return first;
      if (voiceId && !signal?.aborted) {
        return await attempt(undefined);
      }
      return null;
    } catch {
      return null;
    }
  };

  const requestAndPlayStream = async (text: string, voiceId: string | undefined, signal: AbortSignal): Promise<boolean> => {
    if (!preferStream || signal.aborted) return false;
    const attempt = async (vid?: string): Promise<Response | null> => {
      const res = await fetchFn("/api/tts/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(vid ? { text, voiceId: vid } : { text }),
        signal,
      });
      if (!res.ok) return null;
      const ct = (res.headers?.get?.("content-type") ?? "").toLowerCase();
      if (ct && !ct.includes("audio/pcm") && !ct.includes("application/octet-stream")) {
        return null;
      }
      return res.body ? res : null;
    };
    try {
      let res = await attempt(voiceId);
      if (!res && voiceId && !signal.aborted) {
        res = await attempt(undefined);
      }
      if (!res || signal.aborted) return false;
      const playStream = deps?.playPcmStreamImpl ?? ((r, s) => pcmPlayer.playResponse(r, s));
      return await playStream(res, signal);
    } catch {
      return false;
    }
  };

  const defaultPlayBlob = (blob: Blob, signal: AbortSignal): Promise<boolean> => {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(false);
      cleanupAudio();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      activeAudio = audio;
      activeObjectUrl = url;
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        if (settleAudio === finish) settleAudio = null;
        if (activeAudio === audio) cleanupAudio();
        resolve(ok);
      };
      const onAbort = () => finish(false);
      signal.addEventListener("abort", onAbort, { once: true });
      settleAudio = finish;
      audio.onended = () => finish(true);
      audio.onerror = () => finish(false);
      audio.play().catch(() => finish(false));
    });
  };

  const defaultSpeakSystem = (text: string, signal: AbortSignal): Promise<boolean> => {
    return new Promise((resolve) => {
      if (signal.aborted || typeof window === "undefined" || !window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== "function") {
        resolve(false);
        return;
      }
      let settled = false;
      let safetyTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (safetyTimer) {
          clearTimeout(safetyTimer);
          safetyTimer = null;
        }
        signal.removeEventListener("abort", onAbort);
        resolve(ok);
      };
      const onAbort = () => {
        try { window.speechSynthesis.cancel(); } catch {}
        finish(false);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      safetyTimer = setTimeout(() => {
        try { window.speechSynthesis.cancel(); } catch {}
        finish(false);
      }, Math.max(8_000, text.length * 450));
      try {
        window.speechSynthesis.cancel();
        const utterance = new window.SpeechSynthesisUtterance(text);
        utterance.lang = "zh-CN";
        const voice = pickLocalChineseVoice();
        if (voice) utterance.voice = voice;
        utterance.rate = 1.06;
        utterance.onend = () => finish(true);
        utterance.onerror = () => finish(false);
        window.speechSynthesis.speak(utterance);
      } catch {
        finish(false);
      }
    });
  };

  const playBlob = deps?.playBlobImpl ?? defaultPlayBlob;
  const speakSystem = deps?.speakSystemImpl ?? defaultSpeakSystem;

  const stop = () => {
    token += 1;
    spokenText = "";
    activeController?.abort();
    activeController = null;
    pcmPlayer.stop();
    if (settleAudio) settleAudio(false);
    else cleanupAudio();
    try {
      if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    } catch {}
    setSpeaking(false);
  };

  let warmGeneration = 0;

  const warmOne = async (phrase: string, voiceId?: string): Promise<void> => {
    const clean = phrase.trim();
    if (!clean) return;
    const key = cacheKey(clean, voiceId);
    if (cache.has(key) || inflightWarm.has(key)) return;
    const promise = requestSpeakBlob(clean, voiceId)
      .then((blob) => {
        if (blob) putCache(key, blob);
        return blob;
      })
      .finally(() => {
        inflightWarm.delete(key);
      });
    inflightWarm.set(key, promise);
    await promise;
  };

  return {
    warmPhrases(phrases, voiceId) {
      const gen = ++warmGeneration;
      const list = [...phrases];
      void (async () => {
        for (const phrase of list) {
          if (gen !== warmGeneration) return;
          if (speaking) return;
          await warmOne(phrase, voiceId);
        }
      })();
    },

    async speak(rawText, opts = {}) {
      const chunks = splitForSpeak(rawText);
      if (!chunks.length) return { ok: true };

      stop();
      const mine = token;
      const controller = new AbortController();
      activeController = controller;
      spokenText = rawText.trim();
      setSpeaking(true);

      let usedFallback = false;
      try {
        for (const chunk of chunks) {
          if (token !== mine || controller.signal.aborted) {
            return { ok: false, interrupted: true };
          }
          spokenText = chunk;
          const key = cacheKey(chunk, opts.voiceId);
          let blob: Blob | null = cache.get(key) ?? null;
          if (!blob && inflightWarm.has(key)) {
            blob = await inflightWarm.get(key)!;
          }
          if (token !== mine || controller.signal.aborted) {
            return { ok: false, interrupted: true };
          }
          if (blob) {
            const played = await playBlob(blob, controller.signal);
            if (played) continue;
            if (token !== mine || controller.signal.aborted) return { ok: false, interrupted: true };
          }

          // Prefer zero-buffer streaming PCM for uncached replies so first audio starts quickly and barge-in aborts upstream immediately.
          if (preferStream && !(chunks.length === 1 && chunk.length <= 24)) {
            const streamed = await requestAndPlayStream(chunk, opts.voiceId, controller.signal);
            if (streamed) continue;
            if (token !== mine || controller.signal.aborted) return { ok: false, interrupted: true };
          }

          if (!blob && token === mine && !controller.signal.aborted) {
            blob = await requestSpeakBlob(chunk, opts.voiceId, controller.signal);
            if (blob && chunks.length === 1 && chunk.length <= 36) {
              putCache(key, blob);
            }
          }
          if (token !== mine || controller.signal.aborted) {
            return { ok: false, interrupted: true };
          }
          if (blob) {
            const played = await playBlob(blob, controller.signal);
            if (played) continue;
            if (token !== mine || controller.signal.aborted) return { ok: false, interrupted: true };
          }
          // Fallback to native speechSynthesis if remote TTS or playback failed.
          usedFallback = true;
          const spokeNative = await speakSystem(chunk, controller.signal);
          if (token !== mine || controller.signal.aborted) {
            return { ok: false, interrupted: true };
          }
          if (!spokeNative) {
            return { ok: false, usedFallback, error: "语音播放失败" };
          }
        }
        return { ok: true, ...(usedFallback ? { usedFallback } : {}) };
      } finally {
        if (token === mine) {
          if (activeController === controller) activeController = null;
          setSpeaking(false);
        }
      }
    },

    stop,

    isSpeaking() {
      return speaking;
    },

    currentText() {
      return spokenText;
    },

    subscribe(listener) {
      listeners.add(listener);
      listener(speaking);
      return () => listeners.delete(listener);
    },
  };
}
