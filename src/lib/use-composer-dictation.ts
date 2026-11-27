import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { withOpenSettings } from "@/components/OpenSystemSettings";
import { useStoreSelector } from "@/state/store-select";
import { isCloudSpeechBridge } from "@/donebot/voice/cloud-speech-bridge";
import { t } from "./i18n";
import { fishSpeech } from "./fish-speech";
import { cloudAsrReady, listensHere, speechBridge } from "./speech";

export function useComposerDictation({ draftId, text, onText }: {
  draftId: string;
  text: string;
  onText: (text: string) => void;
}) {
  const { capabilities } = useDesktopCapabilities();
  const config = useStoreSelector((state) => state.config);
  const cloudAsr = cloudAsrReady(config);
  const cloudAsrWsPath = config?.asr?.wsPath ?? config?.tts?.asrWsPath ?? "";
  const configRef = useRef(config);
  configRef.current = config;
  const ready = listensHere(capabilities, config);
  const [recording, setRecording] = useState(false);
  const [speechError, setSpeechError] = useState<ReactNode>(null);
  const draft = useRef({ id: draftId, text });
  draft.current = { id: draftId, text };
  const session = useRef({ draftId: "", base: "" });
  const cancel = useRef<(() => void) | null>(null);
  // Fish Audio and cloud streaming ASR finish the active utterance cleanly when the mic is clicked off.
  const finish = useRef<(() => void) | null>(null);
  const stop = useCallback(() => {
    cancel.current?.();
    setRecording(false);
  }, []);

  useEffect(() => {
    if (!recording) return;
    const bridge = speechBridge(configRef.current);
    if (!bridge || session.current.draftId !== draftId) {
      setRecording(false);
      return;
    }
    setSpeechError(null);
    const base = session.current.base;
    let lastText = base;
    let active = true;
    const cancelSession = () => {
      if (!active) return;
      active = false;
      void bridge.speechStop();
      setRecording(false);
    };
    cancel.current = cancelSession;
    finish.current = (bridge === fishSpeech || isCloudSpeechBridge(bridge))
      ? () => void bridge.speechFinish?.()
      : null;
    const offTranscript = bridge.onSpeechTranscript((line) => {
      if (!active || draft.current.id !== draftId) return;
      if (draft.current.text !== lastText) {
        cancelSession();
        return;
      }
      if (typeof line.text !== "string" || !line.text.trim()) return;
      lastText = base ? `${base}${/\s$/.test(base) ? "" : " "}${line.text}` : line.text;
      draft.current.text = lastText;
      onText(lastText);
    });
    const offEnd = bridge.onSpeechEnd(({ code, reason, message }) => {
      if (!active || draft.current.id !== draftId) return;
      active = false;
      setRecording(false);
      if (code === 2) {
        setSpeechError(t("composer.dictation.macOnly"));
      } else if (code === 1) {
        // A refused permission comes with a way to the pane that grants it.
        setSpeechError(message ?? (reason === "speech-not-authorized" ? withOpenSettings(t("composer.dictation.permission"), "speech")
          : t(reason === "dictation-disabled" ? "composer.dictation.disabled" : "composer.dictation.failed")));
      }
    });
    void bridge.speechStart().catch(() => {
      if (!active) return;
      cancelSession();
      setSpeechError(t("composer.dictation.failed"));
    });
    return () => {
      if (cancel.current === cancelSession) cancel.current = null;
      finish.current = null;
      offTranscript();
      offEnd();
      if (active) {
        active = false;
        void bridge.speechStop();
      }
    };
  }, [recording, draftId, onText, cloudAsr, cloudAsrWsPath]);

  const toggle = () => {
    if (!ready || !speechBridge(configRef.current)) {
      setSpeechError(t("composer.dictation.unavailable"));
    } else if (recording) {
      if (finish.current) finish.current();
      else stop();
    } else {
      session.current = { draftId, base: text };
      setRecording(true);
    }
  };
  return { recording, ready, speechError, toggle, stop };
}
