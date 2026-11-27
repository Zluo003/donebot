import { useEffect, useMemo, useState } from "react";
import { Loader2, Square, Volume2 } from "lucide-react";
import type { DoneBotVoiceCapabilities, DoneBotVoiceDescriptor } from "../../shared/donebot";
import { api, useStore, type Bot, type ConfigStatus } from "@/state/store";
import { Select } from "@/components/Select";
import { Switch } from "@/components/SettingsPrimitives";
import { speaker } from "@/lib/tts";
import { useSpeech } from "@/lib/tts/useSpeech";
import { cn } from "@/lib/cn";
import {
  formatDoneBotVoiceLabel,
  genderLabel,
  loadDoneBotVoiceCapabilities,
  resolveVoiceSelection,
} from "@/donebot/voice/voices";

export { formatDoneBotVoiceLabel };

export interface VoiceSettingsProps {
  bot: Bot;
  onPatch(patch: Partial<Pick<Bot, "voice" | "speakReplies" | "voiceNotes" | "voiceNoteEveryReply">>): void;
  workspaceConfigurationLocked?: boolean;
}

export function DoneBotVoiceSettings({ bot, onPatch, workspaceConfigurationLocked }: VoiceSettingsProps) {
  const { state, dispatch } = useStore();
  const [capabilities, setCapabilities] = useState<DoneBotVoiceCapabilities | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);
  const speech = useSpeech();

  useEffect(() => {
    if (speech.status === "idle") setPreviewingVoiceId(null);
  }, [speech.status]);

  useEffect(() => {
    let active = true;
    setError("");
    void loadDoneBotVoiceCapabilities(api, state.config?.tts?.model).then(
      (value) => { if (active) setCapabilities(value); },
      () => { if (active) setError("语音模型加载失败，请重新打开设置。"); },
    );
    return () => { active = false; };
  }, [state.config?.donebot?.user?.id, state.config?.tts?.model]);

  const models = capabilities?.tts.models ?? [];
  const selected = useMemo(
    () => models.find((model) => model.id === state.config?.tts?.model)
      ?? models.find((model) => model.id === capabilities?.tts.model)
      ?? models[0],
    [models, state.config?.tts?.model, capabilities?.tts.model],
  );
  const voices: readonly DoneBotVoiceDescriptor[] = selected?.voices ?? [];
  const resolved = useMemo(
    () => resolveVoiceSelection(bot.voice, voices, selected?.defaultVoice),
    [bot.voice, voices, selected?.defaultVoice],
  );

  const cloudAsrEnabled = Boolean(
    capabilities?.asr.available
    || state.config?.asr?.ready
    || state.config?.tts?.asrAvailable,
  );

  const saveModel = async (modelId: string) => {
    setBusy(true);
    setError("");
    try {
      const config = await api<ConfigStatus>("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ tts: { model: modelId, voice: "" } }),
      });
      dispatch({ type: "configStatus", config });
      const targetModel = models.find((m) => m.id === modelId);
      const stillSupported = Boolean(bot.voice && targetModel?.voices.some((v) => v.id === bot.voice));
      if (!stillSupported) onPatch({ voice: "" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "语音模型保存失败。");
    } finally {
      setBusy(false);
    }
  };

  const previewSample = (voiceId?: string) => {
    const targetId = voiceId || resolved.effectiveVoiceId;
    if (!targetId) return;
    if (speech.status !== "idle" && previewingVoiceId === targetId) {
      speaker.stop();
      setPreviewingVoiceId(null);
      return;
    }
    setError("");
    setPreviewingVoiceId(targetId);
    const botTitle = bot.name?.trim() || "DoneBot";
    const sampleText = `你好，我是${botTitle}，很高兴为你服务。`;
    void speaker.speak(sampleText, { botId: bot.id, voiceId: targetId }).catch((err) => {
      setPreviewingVoiceId(null);
      setError(err instanceof Error ? err.message : "试听失败。");
    });
  };

  const defaultVoiceLabel = resolved.defaultVoiceId
    ? `默认声音（${formatDoneBotVoiceLabel(resolved.defaultVoiceId, voices.find((v) => v.id === resolved.defaultVoiceId))}）`
    : "默认声音";

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[15px] font-medium text-ink">DoneBot 语音</p>
        {cloudAsrEnabled && (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
            实时语音 · 支持随时打断
          </span>
        )}
      </div>
      <p className="mt-1 text-[13px] text-ink-secondary">
        语音由统一网关提供，模型选择适用于当前工作区，每个助手可单独选择人声。
      </p>

      <label className="mt-4 block text-[13px] text-ink-secondary">
        语音模型
        <Select
          aria-label="语音模型"
          className="mt-1 w-full"
          value={selected?.id ?? ""}
          disabled={busy || workspaceConfigurationLocked || !models.length}
          onChange={(event) => void saveModel(event.target.value)}
        >
          {!models.length && <option value="">暂无可用语音模型</option>}
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.displayName || model.id}
            </option>
          ))}
        </Select>
      </label>

      <label className="mt-3 block text-[13px] text-ink-secondary">
        声音
        <Select
          aria-label="声音"
          className="mt-1 w-full"
          value={resolved.isFallback ? (bot.voice ?? "") : resolved.selectedVoiceId}
          disabled={busy || !voices.length}
          onChange={(event) => onPatch({ voice: event.target.value })}
        >
          <option value="">{defaultVoiceLabel}</option>
          {resolved.isFallback && resolved.unavailableSavedVoice && (
            <option value={resolved.unavailableSavedVoice} disabled>
              原声音（{formatDoneBotVoiceLabel(resolved.unavailableSavedVoice)}）不适用于当前模型
            </option>
          )}
          {voices.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {formatDoneBotVoiceLabel(voice.id, voice)}{voice.recommended ? "（推荐）" : ""}
            </option>
          ))}
        </Select>
      </label>

      {resolved.isFallback && resolved.unavailableSavedVoice && resolved.defaultVoiceId && (
        <p className="mt-2 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[12px] leading-relaxed text-amber-700 dark:text-amber-300">
          原音色「{formatDoneBotVoiceLabel(resolved.unavailableSavedVoice)}」不属于当前模型，播报时将自动使用默认人声「
          {formatDoneBotVoiceLabel(resolved.defaultVoiceId, voices.find((v) => v.id === resolved.defaultVoiceId))}
          」，可在下方直接切换新音色。
        </p>
      )}

      {voices.length > 0 && (
        <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2" role="radiogroup" aria-label="人声列表">
          {voices.map((voice) => {
            const isSelected = resolved.selectedVoiceId === voice.id
              || (!resolved.selectedVoiceId && !resolved.isFallback && resolved.effectiveVoiceId === voice.id);
            const isThisPreviewing = previewingVoiceId === voice.id && speech.status !== "idle";
            const isThisPreparing = previewingVoiceId === voice.id && speech.status === "preparing";
            const gLabel = genderLabel(voice.gender);

            return (
              <div
                key={voice.id}
                role="radio"
                aria-checked={isSelected}
                tabIndex={0}
                onClick={() => {
                  if (!busy) onPatch({ voice: voice.id });
                }}
                onKeyDown={(event) => {
                  if (!busy && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    onPatch({ voice: voice.id });
                  }
                }}
                className={cn(
                  "flex cursor-pointer items-center justify-between gap-2 rounded-lg border px-2.5 py-2 transition-colors",
                  isSelected
                    ? "border-accent bg-accent/10 text-ink"
                    : "border-hairline/60 bg-inset/50 text-ink hover:bg-raised/70",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-ink">
                      {voice.name || voice.label || voice.id}
                    </span>
                    {gLabel && (
                      <span className="rounded bg-ink/[0.07] px-1.5 py-0.5 text-[10px] text-ink-secondary">
                        {gLabel}
                      </span>
                    )}
                    {voice.recommended && (
                      <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                        推荐
                      </span>
                    )}
                  </div>
                  {voice.description && (
                    <p className="mt-0.5 line-clamp-1 text-[11px] text-ink-secondary">
                      {voice.description}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  aria-label={`试听 ${voice.name || voice.label || voice.id}`}
                  title={isThisPreviewing ? "停止试听" : `试听 ${voice.name || voice.label || voice.id}`}
                  disabled={speech.status === "preparing" && !isThisPreparing}
                  onClick={(event) => {
                    event.stopPropagation();
                    previewSample(voice.id);
                  }}
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
                    isThisPreviewing
                      ? "bg-accent text-accent-ink"
                      : "bg-control text-ink-secondary hover:bg-raised-hover hover:text-ink",
                  )}
                >
                  {isThisPreparing ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : isThisPreviewing ? (
                    <Square size={11} />
                  ) : (
                    <Volume2 size={13} />
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          className="ui-button inline-flex items-center gap-1.5"
          disabled={!voices.length || speech.status === "preparing"}
          onClick={() => previewSample(resolved.effectiveVoiceId)}
        >
          {speech.status === "preparing" ? (
            <Loader2 size={13} className="animate-spin" />
          ) : speech.status === "speaking" ? (
            <Square size={11} />
          ) : (
            <Volume2 size={13} />
          )}
          {speech.status === "speaking" ? "停止试听" : "试听声音"}
        </button>
        {resolved.effectiveDescriptor?.description && (
          <span className="truncate text-[12px] text-ink-tertiary">
            当前：{formatDoneBotVoiceLabel(resolved.effectiveVoiceId, resolved.effectiveDescriptor)}
          </span>
        )}
      </div>

      {([
        ["朗读回复", "speakReplies", bot.speakReplies === true],
        ["允许语音消息", "voiceNotes", bot.voiceNotes !== false],
        ["每次回复附带语音", "voiceNoteEveryReply", bot.voiceNoteEveryReply ?? state.config?.tts?.everyReply ?? false],
      ] as const).map(([label, key, checked]) => (
        <div key={key} className="mt-4 flex items-center justify-between gap-4 text-[13px] text-ink">
          <span>{label}</span>
          <Switch checked={checked} aria-label={label} onClick={() => onPatch({ [key]: !checked })} />
        </div>
      ))}

      {error && <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>}
    </div>
  );
}
