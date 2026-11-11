import { useEffect, useState } from "react";
import type { DoneBotCatalog } from "../../shared/donebot";
import { api, useStore, type Bot, type ConfigStatus } from "@/state/store";
import { Select } from "@/components/Select";
import { Switch } from "@/components/SettingsPrimitives";
import { speaker } from "@/lib/tts";
import { useSpeech } from "@/lib/tts/useSpeech";

export interface VoiceSettingsProps {
  bot: Bot;
  onPatch(patch: Partial<Pick<Bot, "voice" | "speakReplies" | "voiceNotes" | "voiceNoteEveryReply">>): void;
  workspaceConfigurationLocked?: boolean;
}

export function DoneBotVoiceSettings({ bot, onPatch, workspaceConfigurationLocked }: VoiceSettingsProps) {
  const { state, dispatch } = useStore();
  const [catalog, setCatalog] = useState<DoneBotCatalog | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const speech = useSpeech();
  useEffect(() => {
    let active = true;
    void api<DoneBotCatalog>("/api/donebot/catalog").then(value => { if (active) setCatalog(value); }, () => { if (active) setError("语音模型加载失败，请重新打开设置。 "); });
    return () => { active = false; };
  }, [state.config?.donebot?.user?.id]);
  const models = catalog?.models.filter(model => model.interfaces.includes("openai.audio.speech")) ?? [];
  const selected = models.find(model => model.id === state.config?.tts?.model) ?? models[0];
  const advertised = selected?.media_parameters?.voices;
  const voices = Array.isArray(advertised) ? advertised.filter((voice): voice is string => typeof voice === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(voice)) : [];
  const saveModel = async (model: string) => {
    setBusy(true); setError("");
    try {
      const config = await api<ConfigStatus>("/api/config", { method: "PATCH", body: JSON.stringify({ tts: { model, voice: "" } }) });
      dispatch({ type: "configStatus", config });
      onPatch({ voice: "" });
    } catch (error) { setError(error instanceof Error ? error.message : "语音模型保存失败。"); }
    finally { setBusy(false); }
  };
  return <div className="rounded-xl bg-card p-4">
    <p className="text-[15px] font-medium text-ink">DoneBot 语音</p>
    <p className="mt-1 text-[13px] text-ink-secondary">语音由统一网关提供，模型选择适用于当前工作区。</p>
    <label className="mt-4 block text-[13px] text-ink-secondary">语音模型
      <Select aria-label="语音模型" className="mt-1 w-full" value={selected?.id ?? ""} disabled={busy || workspaceConfigurationLocked || !models.length} onChange={event => void saveModel(event.target.value)}>
        {!models.length && <option value="">暂无可用语音模型</option>}
        {models.map(model => <option key={model.id} value={model.id}>{model.display_name || model.id}</option>)}
      </Select>
    </label>
    <label className="mt-3 block text-[13px] text-ink-secondary">声音
      <Select aria-label="声音" className="mt-1 w-full" value={bot.voice ?? ""} disabled={busy || !voices.length} onChange={event => onPatch({ voice: event.target.value })}>
        <option value="">默认声音</option>{bot.voice && !voices.includes(bot.voice) && <option value={bot.voice} disabled>原声音不可用，请选择</option>}{voices.map(voice => <option key={voice} value={voice}>{voice}</option>)}
      </Select>
    </label>
    <button type="button" className="ui-button mt-3" disabled={!voices.length || speech.status === "preparing"} onClick={() => void speaker.speak("你好，我是 DoneBot。", { botId: bot.id, voiceId: bot.voice }).catch(error => setError(error instanceof Error ? error.message : "试听失败。"))}>试听声音</button>
    {([ ["朗读回复", "speakReplies", bot.speakReplies === true], ["允许语音消息", "voiceNotes", bot.voiceNotes !== false], ["每次回复附带语音", "voiceNoteEveryReply", bot.voiceNoteEveryReply ?? state.config?.tts?.everyReply ?? false] ] as const).map(([label, key, checked]) => <div key={key} className="mt-4 flex items-center justify-between gap-4 text-[13px] text-ink"><span>{label}</span><Switch checked={checked} aria-label={label} onClick={() => onPatch({ [key]: !checked })} /></div>)}
    {error && <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>}
  </div>;
}
