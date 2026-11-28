import { useEffect, useMemo, useState } from "react";
import type { DoneBotVoiceCapabilities, DoneBotVoiceDescriptor } from "../../../shared/donebot";
import { Select } from "@/components/Select";
import { Card, SettingRow, Switch } from "@/components/SettingsPrimitives";
import {
  formatDoneBotVoiceLabel,
  genderLabel,
  loadDoneBotVoiceCapabilities,
  resolveVoiceSelection,
} from "@/donebot/voice/voices";
import { speaker } from "@/lib/tts";
import { useSpeech } from "@/lib/tts/useSpeech";
import { api, persistBotUpdate, useStore } from "@/state/store";
import {
  buildWakePhrase,
  MAX_WAKE_WORD_LENGTH,
  MIN_WAKE_WORD_CHARS,
  resolveChiefCoordinatorBot,
  resolveUserAddressTitle,
  sanitizeWakeWord,
  wakeWordCoreChars,
} from "./pet-protocol";

export function DesktopPetSettings({ simple = false }: { simple?: boolean }) {
  const bridge = window.ogb?.desktopPet;
  const { state: storeState, dispatch } = useStore();
  const [state, setState] = useState<DesktopPetState | null>(null);
  const [saving, setSaving] = useState(false);
  const [capabilities, setCapabilities] = useState<DoneBotVoiceCapabilities | null>(null);
  const [savingVoice, setSavingVoice] = useState(false);
  const [wakeWordDraft, setWakeWordDraft] = useState("");
  const [wakeWordStatus, setWakeWordStatus] = useState<{ kind: "saved" | "error"; text: string } | null>(null);
  const speech = useSpeech();

  const chief = useMemo(
    () => resolveChiefCoordinatorBot(storeState.bots),
    [storeState.bots],
  );
  const defaultWakePhrase = buildWakePhrase(chief?.name);
  const savedWakeWord = sanitizeWakeWord(state?.wakeWord);
  const wakePhrase = buildWakePhrase(chief?.name, savedWakeWord);
  const userTitle = resolveUserAddressTitle(chief?.soul, storeState.config?.profile?.name);

  useEffect(() => {
    if (!bridge) return;
    let mounted = true;
    void bridge.state().then((next) => {
      if (mounted) {
        setState(next);
        setWakeWordDraft(sanitizeWakeWord(next.wakeWord));
      }
    }).catch(() => {});
    const off = bridge.onState((next) => {
      if (mounted) {
        setState(next);
        setWakeWordDraft(sanitizeWakeWord(next.wakeWord));
      }
    });
    return () => {
      mounted = false;
      off();
    };
  }, [bridge]);

  useEffect(() => {
    if (!state?.enabled) return;
    let alive = true;
    void loadDoneBotVoiceCapabilities(api, storeState.config?.tts?.model)
      .then((next) => {
        if (alive) setCapabilities(next);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [state?.enabled, storeState.config?.tts?.model, storeState.config?.donebot?.user?.id]);

  const activeModel = useMemo(() => {
    const models = capabilities?.tts.models ?? [];
    return models.find((m) => m.id === storeState.config?.tts?.model)
      ?? models.find((m) => m.id === capabilities?.tts.model)
      ?? models[0];
  }, [capabilities, storeState.config?.tts?.model]);

  const voices: readonly DoneBotVoiceDescriptor[] = activeModel?.voices ?? [];
  const resolvedVoice = useMemo(
    () => resolveVoiceSelection(chief?.voice, voices, activeModel?.defaultVoice),
    [chief?.voice, voices, activeModel?.defaultVoice],
  );
  const cloudAsrEnabled = Boolean(
    capabilities?.asr.available
    || storeState.config?.asr?.ready
    || storeState.config?.tts?.asrAvailable,
  );

  if (!bridge || !state?.available) return null;

  const update = (patch: Partial<DesktopPetConfig>, onDone?: (next: DesktopPetState) => void) => {
    setSaving(true);
    void bridge.set(patch)
      .then((next) => {
        setState(next);
        onDone?.(next);
      })
      .catch(() => {})
      .finally(() => setSaving(false));
  };

  const normalizedDraft = sanitizeWakeWord(wakeWordDraft);
  const wakeWordDirty = normalizedDraft !== savedWakeWord;

  const saveWakeWord = () => {
    if (normalizedDraft && wakeWordCoreChars(normalizedDraft).length < MIN_WAKE_WORD_CHARS) {
      setWakeWordStatus({ kind: "error", text: `唤醒词至少需要 ${MIN_WAKE_WORD_CHARS} 个字，留空可恢复默认。` });
      return;
    }
    setWakeWordStatus(null);
    update({ wakeWord: normalizedDraft }, (next) => {
      const effective = buildWakePhrase(chief?.name, next.wakeWord);
      setWakeWordDraft(sanitizeWakeWord(next.wakeWord));
      setWakeWordStatus({
        kind: "saved",
        text: next.wakeWord ? `已保存，现在直接喊「${effective}」即可唤醒。` : `已恢复默认唤醒词「${effective}」。`,
      });
    });
  };

  const resetWakeWord = () => {
    setWakeWordStatus(null);
    setWakeWordDraft("");
    update({ wakeWord: "" }, (next) => {
      const effective = buildWakePhrase(chief?.name, next.wakeWord);
      setWakeWordDraft("");
      setWakeWordStatus({ kind: "saved", text: `已恢复默认唤醒词「${effective}」。` });
    });
  };

  const updateChiefVoice = async (voice: string) => {
    if (!chief) return;
    setSavingVoice(true);
    try {
      const saved = await persistBotUpdate(chief.id, { voice }, AbortSignal.timeout(10_000));
      dispatch({ type: "botPatched", bot: saved });
    } catch {
      // Keep previous voice on failure.
    } finally {
      setSavingVoice(false);
    }
  };

  const activeVoiceDesc = resolvedVoice.effectiveDescriptor;
  const activeVoiceSubtitle = activeVoiceDesc?.description
    ? `${genderLabel(activeVoiceDesc.gender) ? `${genderLabel(activeVoiceDesc.gender)} · ` : ""}${activeVoiceDesc.description}`
    : "与主协调 Bot 语音设置同步，可随时切换并试听。";

  const rows = (
    <>
      <SettingRow
        title="桌面宠物（macOS）"
        subtitle="关闭或最小化主窗口时保持主协调助手在桌面待命，外观自动同步主协调助手。"
      >
        <Switch
          checked={state.enabled}
          disabled={saving}
          aria-label="启用桌面宠物"
          onClick={() => update({ enabled: !state.enabled })}
        />
      </SettingRow>

      {state.enabled && (
        <>
          <SettingRow
            title="桌宠默认回复方式"
            subtitle="主协调以极简口头风格汇报结果，默认语音播报，可切换为纯文本气泡。"
          >
            <Select
              size="sm"
              variant={simple ? "ghost" : "field"}
              className={simple ? undefined : "w-full max-w-[200px]"}
              aria-label="桌宠默认回复方式"
              value={state.replyMode}
              disabled={saving}
              onChange={(event) => update({ replyMode: event.target.value === "text" ? "text" : "tts" })}
            >
              <option value="tts">语音播报（TTS）</option>
              <option value="text">极简文本气泡</option>
            </Select>
          </SettingRow>

          {chief && voices.length > 0 && (
            <SettingRow
              title="主协调音色"
              subtitle={
                resolvedVoice.isFallback && resolvedVoice.unavailableSavedVoice
                  ? `原音色「${formatDoneBotVoiceLabel(resolvedVoice.unavailableSavedVoice)}」已切换为默认人声「${formatDoneBotVoiceLabel(resolvedVoice.defaultVoiceId, activeVoiceDesc)}」，可随时重选。`
                  : activeVoiceSubtitle
              }
            >
              <div className="flex items-center gap-2">
                <Select
                  size="sm"
                  variant={simple ? "ghost" : "field"}
                  className={simple ? undefined : "w-[200px]"}
                  aria-label="主协调音色"
                  value={resolvedVoice.isFallback ? "" : (chief.voice ?? "")}
                  disabled={savingVoice}
                  onChange={(event) => void updateChiefVoice(event.target.value)}
                >
                  <option value="">
                    {resolvedVoice.defaultVoiceId
                      ? `默认（${formatDoneBotVoiceLabel(resolvedVoice.defaultVoiceId, voices.find((v) => v.id === resolvedVoice.defaultVoiceId))}）`
                      : "默认声音"}
                  </option>
                  {voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {formatDoneBotVoiceLabel(v.id, v)}{v.recommended ? "（推荐）" : ""}
                    </option>
                  ))}
                </Select>
                <button
                  type="button"
                  disabled={speech.status === "preparing"}
                  onClick={() =>
                    void speaker
                      .speak(`${userTitle}，我在。`, {
                        botId: chief.id,
                        voiceId: resolvedVoice.effectiveVoiceId || undefined,
                      })
                      .catch(() => {})
                  }
                  className="ui-button shrink-0"
                >
                  试听
                </button>
              </div>
            </SettingRow>
          )}

          <SettingRow
            title={`语音唤醒（喊「${wakePhrase}」）`}
            subtitle={
              `开启后无需点击桌宠，直接喊「${wakePhrase}」即可唤醒并秒回「${userTitle}，我在。」（忙时回应「${userTitle}，我在忙呢，你有什么事啊？」），点击桌宠仍可弹出输入栏。`
              + (cloudAsrEnabled ? " 已启用云端实时语音，支持播报中随时插话打断，待机静音不耗流量。" : "")
            }
          >
            <Switch
              checked={state.voiceMode}
              disabled={saving}
              aria-label="语音唤醒"
              onClick={() => update({ voiceMode: !state.voiceMode })}
            />
          </SettingRow>

          <SettingRow
            title="自定义唤醒词"
            subtitle={
              wakeWordStatus ? (
                <span className={wakeWordStatus.kind === "error" ? "text-danger" : "text-ink-secondary"}>
                  {wakeWordStatus.text}
                </span>
              ) : (
                `留空默认使用「${defaultWakePhrase}」，保存后说设定好的唤醒词即可唤醒（建议 2–12 个字）。`
              )
            }
          >
            <div className="flex flex-wrap items-center justify-end gap-2">
              <input
                type="text"
                aria-label="自定义唤醒词"
                maxLength={MAX_WAKE_WORD_LENGTH}
                placeholder={defaultWakePhrase}
                value={wakeWordDraft}
                disabled={saving}
                onChange={(event) => {
                  setWakeWordDraft(event.target.value);
                  if (wakeWordStatus) setWakeWordStatus(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (wakeWordDirty && !saving) saveWakeWord();
                  }
                }}
                className="h-8 w-[168px] rounded-full border border-hairline bg-app px-3 text-[13px] text-ink placeholder:text-ink-secondary/60 focus:border-ink/40 focus:outline-none"
              />
              <button
                type="button"
                disabled={saving || !wakeWordDirty}
                onClick={saveWakeWord}
                className="ui-button ui-button-primary shrink-0 disabled:opacity-40"
              >
                保存
              </button>
              {savedWakeWord && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={resetWakeWord}
                  className="ui-button shrink-0"
                >
                  恢复默认
                </button>
              )}
            </div>
          </SettingRow>

          <SettingRow
            title="待审批汇报语音提醒"
            subtitle={`工作完成需要审批时显示文件动画，并自动语音简报「${userTitle}，xxx 已经完成了，需要您审批」。`}
          >
            <Switch
              checked={state.autoAnnounceReports}
              disabled={saving}
              aria-label="待审批汇报语音提醒"
              onClick={() => update({ autoAnnounceReports: !state.autoAnnounceReports })}
            />
          </SettingRow>

          <SettingRow
            title="全屏应用时自动隐藏"
            subtitle="观看视频、演示或进入全屏空间时自动避让，切回桌面后恢复。"
          >
            <Switch
              checked={state.hideInFullscreen}
              disabled={saving}
              aria-label="全屏应用时自动隐藏"
              onClick={() => update({ hideInFullscreen: !state.hideInFullscreen })}
            />
          </SettingRow>
        </>
      )}
    </>
  );

  if (simple) return rows;
  return (
    <Card title="桌面宠物" subtitle="在主窗口关闭或最小化时，以主协调助手形态常驻桌面并同步工作状态。">
      {rows}
    </Card>
  );
}
