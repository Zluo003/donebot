import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { FileText, Mic, Volume2 } from "lucide-react";
import type { OpcBossOverview, OpcBossReportItem } from "../../../shared/donebot-opc";
import { MausAvatar } from "@/components/Avatar";
import { resolvePendingBossReports } from "@/donebot/OpcBossReportCard";
import { opcApi } from "@/donebot/opc-api";
import { useFestivalDress, wornBody } from "@/lib/festival-dress";
import { localSystemVoiceActive } from "@/lib/local-voice";
import { api } from "@/state/api";
import {
  buildWakePhrase,
  buildWakeReplyPool,
  compactSpokenReply,
  formatBossReportAnnouncement,
  pickWakeReply,
  resolveChiefCoordinatorBot,
  resolvePetMascotState,
  resolveUserAddressTitle,
  toCoordinatorSnapshot,
  type PetBotCandidate,
  type PetBubbleState,
  type PetCoordinatorSnapshot,
  type PetHostSnapshot,
  type PetPopoverCommand,
  type PetVoiceState,
} from "./pet-protocol";
import { createPetTtsPlayer, type PetTtsPlayer } from "./pet-tts";
import { createPetVoiceController, type PetVoiceController } from "./pet-voice";

const DRAG_THRESHOLD_PX = 5;
const REPORT_POLL_MS = 12_000;
const BUBBLE_AUTO_HIDE_MS = 9_500;

interface ActiveTurnTracker {
  sendId: string;
  threadId: string;
  startedAt: number;
  queued: boolean;
  echoed: boolean;
  turnId: string | null;
  itemId: string | null;
  streamed: string;
  latestText: string;
  latestMessageId: string | null;
  turnCompleted: boolean;
  settled: boolean;
  fromVoice: boolean;
  fallbackTimer: ReturnType<typeof setTimeout> | null;
}

const IDLE_VOICE: PetVoiceState = {
  active: false,
  wakeEnabled: false,
  phase: "idle",
  heard: "",
  error: null,
};

export function PetAvatarView() {
  const festival = useFestivalDress();
  const [active, setActive] = useState(true);
  const [petState, setPetState] = useState<DesktopPetState | null>(null);
  const [coordinator, setCoordinator] = useState<PetCoordinatorSnapshot | null>(null);
  const [profileName, setProfileName] = useState<string>("");
  const [reports, setReports] = useState<OpcBossReportItem[]>([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [voice, setVoice] = useState<PetVoiceState>(IDLE_VOICE);
  const [speaking, setSpeaking] = useState(false);
  const [sending, setSending] = useState(false);
  const [bubble, setBubble] = useState<PetBubbleState | null>(null);
  const [ttsReady, setTtsReady] = useState(true);
  const [cloudAsr, setCloudAsr] = useState<{ available: boolean; wsPath?: string }>({ available: false });
  const [hovered, setHovered] = useState(false);
  const [filePulse, setFilePulse] = useState(false);

  const petStateRef = useRef<DesktopPetState | null>(null);
  const coordinatorRef = useRef<PetCoordinatorSnapshot | null>(null);
  const profileNameRef = useRef<string>("");
  const userTitleRef = useRef<string>("老板");
  const reportsRef = useRef<OpcBossReportItem[]>([]);
  const reportsLoadingRef = useRef(false);
  const voiceRef = useRef<PetVoiceState>(IDLE_VOICE);
  const speakingRef = useRef(false);
  const sendingRef = useRef(false);
  const bubbleRef = useRef<PetBubbleState | null>(null);
  const ttsReadyRef = useRef(true);
  const cloudAsrRef = useRef<{ available: boolean; wsPath?: string }>({ available: false });
  const activeRef = useRef(true);
  const bubbleIdRef = useRef(0);
  const bubbleHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const knownReportIdsRef = useRef<Set<string> | null>(null);
  const trackerRef = useRef<ActiveTurnTracker | null>(null);
  const spokenMessageIdsRef = useRef<Set<string>>(new Set());
  const voiceCtrlRef = useRef<PetVoiceController | null>(null);
  const ttsPlayerRef = useRef<PetTtsPlayer | null>(null);
  const lastSpokenAtRef = useRef(0);

  const dragRef = useRef<{
    pointerId: number;
    startScreenX: number;
    startScreenY: number;
    lastScreenX: number;
    lastScreenY: number;
    moved: boolean;
  } | null>(null);

  const userTitle = resolveUserAddressTitle(coordinator?.soul, profileName);
  const wakePhrase = buildWakePhrase(coordinator?.name);

  petStateRef.current = petState;
  coordinatorRef.current = coordinator;
  profileNameRef.current = profileName;
  userTitleRef.current = userTitle;
  reportsRef.current = reports;
  reportsLoadingRef.current = reportsLoading;
  voiceRef.current = voice;
  speakingRef.current = speaking;
  sendingRef.current = sending;
  bubbleRef.current = bubble;
  ttsReadyRef.current = ttsReady;
  cloudAsrRef.current = cloudAsr;
  activeRef.current = active;

  if (!ttsPlayerRef.current) {
    ttsPlayerRef.current = createPetTtsPlayer();
  }

  const pushSnapshotToPopover = useCallback(() => {
    if (!petStateRef.current?.popoverMode) return;
    const asrOn = cloudAsrRef.current.available === true;
    const snapshot: PetHostSnapshot = {
      coordinator: coordinatorRef.current,
      petState: petStateRef.current,
      userTitle: userTitleRef.current,
      wakePhrase: buildWakePhrase(coordinatorRef.current?.name),
      voice: voiceRef.current,
      speaking: speakingRef.current,
      sending: sendingRef.current,
      bubble: bubbleRef.current,
      reports: reportsRef.current,
      reportsLoading: reportsLoadingRef.current,
      ttsReady: ttsReadyRef.current,
      speechAvailable: Boolean(asrOn || window.ogb?.desktopPet?.speechStart),
      cloudAsrReady: asrOn,
      bargeInEnabled: asrOn,
    };
    void window.ogb?.desktopPet?.post("popover", { type: "host-sync", snapshot });
  }, []);

  useEffect(() => {
    pushSnapshotToPopover();
  }, [coordinator, profileName, petState, voice, speaking, sending, bubble, reports, reportsLoading, ttsReady, cloudAsr, pushSnapshotToPopover]);

  const showBubble = useCallback((next: Omit<PetBubbleState, "id">, options?: { openPopover?: boolean; autoHideMs?: number }) => {
    if (bubbleHideTimerRef.current) {
      clearTimeout(bubbleHideTimerRef.current);
      bubbleHideTimerRef.current = null;
    }
    const created: PetBubbleState = { ...next, id: ++bubbleIdRef.current };
    bubbleRef.current = created;
    setBubble(created);
    if (options?.openPopover && activeRef.current) {
      void window.ogb?.desktopPet?.openPopover("bubble");
    }
    const hideMs = options?.autoHideMs ?? BUBBLE_AUTO_HIDE_MS;
    if (hideMs > 0) {
      bubbleHideTimerRef.current = setTimeout(() => {
        if (bubbleRef.current?.id !== created.id) return;
        bubbleRef.current = null;
        setBubble(null);
        if (petStateRef.current?.popoverMode === "bubble") {
          void window.ogb?.desktopPet?.closePopover();
        }
      }, hideMs);
    }
  }, []);

  const deliverBriefOutput = useCallback(async (
    rawText: string,
    kind: PetBubbleState["kind"],
    options?: { reportId?: string; fromVoice?: boolean; forceSilent?: boolean; expectCommandAfter?: boolean },
  ) => {
    const brief = compactSpokenReply(rawText);
    if (!brief) return;

    const currentPet = petStateRef.current;
    const chief = coordinatorRef.current;
    const wantVoice = !options?.forceSilent
      && !currentPet?.muted
      && (options?.fromVoice === true || currentPet?.replyMode !== "text");

    const inVoiceSession = voiceRef.current.active || options?.fromVoice === true;
    const shouldOpenBubble = !inVoiceSession
      && currentPet?.popoverMode !== "approval"
      && currentPet?.popoverMode !== "preview"
      && (!wantVoice || currentPet?.popoverMode !== "composer");

    showBubble(
      { text: brief, kind, ...(options?.reportId ? { reportId: options.reportId } : {}) },
      { openPopover: shouldOpenBubble },
    );

    if (wantVoice && activeRef.current && ttsPlayerRef.current) {
      lastSpokenAtRef.current = Date.now();
      // In cloud ASR mode this arms AEC barge-in monitoring; in native mode it pauses mic capture to avoid echo.
      voiceCtrlRef.current?.markSpeaking();
      const result = await ttsPlayerRef.current.speak(brief, { voiceId: chief?.voice });
      const interruptedByBargeIn = result.interrupted === true && voiceRef.current.phase === "listening";
      if (!result.ok && !result.interrupted && !inVoiceSession) {
        showBubble(
          { text: brief, kind, ...(options?.reportId ? { reportId: options.reportId } : {}) },
          { openPopover: true },
        );
      }
      if (activeRef.current && !interruptedByBargeIn) {
        voiceCtrlRef.current?.afterSpeaking({ expectCommand: options?.expectCommandAfter === true });
      }
      return;
    }

    if (activeRef.current && (options?.expectCommandAfter || options?.fromVoice)) {
      voiceCtrlRef.current?.afterSpeaking({ expectCommand: options?.expectCommandAfter === true });
    }
  }, [showBubble]);

  const refreshBotsAndConfig = useCallback(async () => {
    try {
      const [botsRes, cfgRes] = await Promise.all([
        api<{ bots?: PetBotCandidate[] }>("/api/bots?messages=1", { timeoutMs: 8_000 }).catch(() => null),
        api<{
          profile?: { name?: string };
          tts?: { configured?: boolean; ready?: boolean; asrAvailable?: boolean; asrWsPath?: string };
          asr?: { ready?: boolean; wsPath?: string };
        }>("/api/config", { timeoutMs: 8_000 }).catch(() => null),
      ]);
      const nextProfileName = typeof cfgRes?.profile?.name === "string" ? cfgRes.profile.name.trim() : "";
      if (cfgRes) {
        profileNameRef.current = nextProfileName;
        setProfileName(nextProfileName);
        const nextCloudAsr = {
          available: cfgRes.asr?.ready === true || cfgRes.tts?.asrAvailable === true,
          wsPath: cfgRes.asr?.wsPath || cfgRes.tts?.asrWsPath,
        };
        cloudAsrRef.current = nextCloudAsr;
        setCloudAsr((prev) => (prev.available === nextCloudAsr.available && prev.wsPath === nextCloudAsr.wsPath ? prev : nextCloudAsr));
        voiceCtrlRef.current?.setCloudAsr(nextCloudAsr);
      }
      if (Array.isArray(botsRes?.bots)) {
        const chief = resolveChiefCoordinatorBot(botsRes.bots);
        const nextSnap = toCoordinatorSnapshot(chief);
        coordinatorRef.current = nextSnap;
        setCoordinator(nextSnap);
        if (nextSnap?.name) voiceCtrlRef.current?.setBotName(nextSnap.name);
        const voiceReady = Boolean(localSystemVoiceActive() || cfgRes?.tts?.ready || cfgRes?.tts?.configured || nextSnap?.voice);
        ttsReadyRef.current = voiceReady;
        setTtsReady(voiceReady);
      } else if (cfgRes) {
        const voiceReady = Boolean(localSystemVoiceActive() || cfgRes.tts?.ready || cfgRes.tts?.configured);
        ttsReadyRef.current = voiceReady;
        setTtsReady(voiceReady);
      }
    } catch {
      // Keep last known snapshot during brief server restarts.
    }
  }, []);

  const refreshReports = useCallback(async (options?: { announceNew?: boolean }) => {
    setReportsLoading(true);
    try {
      const overview: OpcBossOverview = await opcApi.getOverview(30);
      const pending = resolvePendingBossReports(overview);
      reportsRef.current = pending;
      setReports(pending);
      void window.ogb?.desktopPet?.setReportCount(pending.length);

      const currentIds = new Set(pending.map((item) => item.id));
      const known = knownReportIdsRef.current;
      knownReportIdsRef.current = currentIds;

      if (known && options?.announceNew !== false) {
        const added = pending.filter((item) => !known.has(item.id));
        if (added.length > 0 && activeRef.current) {
          setFilePulse(true);
          setTimeout(() => setFilePulse(false), 2600);
          const announcement = formatBossReportAnnouncement(added, userTitleRef.current);
          const autoVoice = petStateRef.current?.autoAnnounceReports !== false;
          const recentlySpoke = Date.now() - lastSpokenAtRef.current < 1_500;
          void deliverBriefOutput(announcement, "report", {
            reportId: added[0]?.id,
            forceSilent: !autoVoice || recentlySpoke,
          });
        }
      }
    } catch {
      // Workbench overview may be temporarily unavailable while restarting.
    } finally {
      setReportsLoading(false);
    }
  }, [deliverBriefOutput]);

  const clearTracker = useCallback(() => {
    if (trackerRef.current?.fallbackTimer) {
      clearTimeout(trackerRef.current.fallbackTimer);
    }
    trackerRef.current = null;
  }, []);

  const settleTrackerWithText = useCallback((tracker: ActiveTurnTracker, text: string, ok = true) => {
    if (tracker.settled || trackerRef.current !== tracker) return;
    tracker.settled = true;
    clearTracker();
    sendingRef.current = false;
    setSending(false);

    if (tracker.latestMessageId) {
      spokenMessageIdsRef.current.add(tracker.latestMessageId);
      if (spokenMessageIdsRef.current.size > 60) {
        const first = spokenMessageIdsRef.current.values().next().value;
        if (first) spokenMessageIdsRef.current.delete(first);
      }
    }

    const finishedText = text.trim();
    if (finishedText) {
      void deliverBriefOutput(finishedText, "reply", { fromVoice: tracker.fromVoice });
    } else if (!ok) {
      void deliverBriefOutput(`${userTitleRef.current}，刚才处理失败了，请打开主窗口看一下。`, "error", { fromVoice: tracker.fromVoice });
    } else if (tracker.fromVoice) {
      voiceCtrlRef.current?.afterSpeaking({ expectCommand: false });
    }
  }, [clearTracker, deliverBriefOutput]);

  const sendInstruction = useCallback(async (rawText: string, options?: { fromVoice?: boolean }) => {
    const text = rawText.trim();
    if (!text) return;
    let chief = coordinatorRef.current;
    if (!chief) {
      await refreshBotsAndConfig();
      chief = coordinatorRef.current;
    }
    if (!chief) {
      showBubble({ text: "还没找到主协调助手，请先打开主窗口完成初始化。", kind: "error" }, { openPopover: true });
      if (options?.fromVoice) voiceCtrlRef.current?.afterSpeaking({ expectCommand: false });
      return;
    }

    ttsPlayerRef.current?.stop();
    clearTracker();
    const sendId = crypto.randomUUID();
    const tracker: ActiveTurnTracker = {
      sendId,
      threadId: chief.threadId,
      startedAt: Date.now(),
      queued: false,
      echoed: false,
      turnId: null,
      itemId: null,
      streamed: "",
      latestText: "",
      latestMessageId: null,
      turnCompleted: false,
      settled: false,
      fromVoice: options?.fromVoice === true,
      fallbackTimer: null,
    };
    trackerRef.current = tracker;
    sendingRef.current = true;
    setSending(true);
    if (options?.fromVoice && voiceRef.current.active) {
      voiceCtrlRef.current?.markWorking();
    }

    try {
      const receipt = await api<{
        ok?: boolean;
        threadId?: string;
        queued?: boolean;
        message?: { id?: string; turnId?: string };
      }>(`/api/bots/${encodeURIComponent(chief.id)}/messages`, {
        method: "POST",
        body: JSON.stringify({
          text,
          threadId: chief.threadId,
          sendId,
          petBrief: true,
          ...(options?.fromVoice ? { via: "call" } : {}),
        }),
        timeoutMs: 15_000,
      });
      if (trackerRef.current === tracker) {
        if (typeof receipt?.threadId === "string" && receipt.threadId) {
          tracker.threadId = receipt.threadId;
        }
        if (receipt?.queued === true) {
          tracker.queued = true;
        }
        if (typeof receipt?.message?.turnId === "string" && receipt.message.turnId) {
          tracker.turnId = receipt.message.turnId;
          tracker.echoed = true;
        }
      }
    } catch (err) {
      if (trackerRef.current === tracker) clearTracker();
      sendingRef.current = false;
      setSending(false);
      const msg = err instanceof Error ? err.message : "发送指令失败，请稍后重试。";
      showBubble({ text: msg, kind: "error" }, { openPopover: !voiceRef.current.active });
      if (options?.fromVoice) {
        voiceCtrlRef.current?.afterSpeaking({ expectCommand: false });
      }
    }
  }, [clearTracker, refreshBotsAndConfig, showBubble]);

  // Pre-warm primary wake replies sequentially only after coordinator resolves so startup never saturates HTTP/1.1 connections.
  useEffect(() => {
    if (!active || !petState?.voiceMode || petState.muted || !coordinator) return;
    const timer = setTimeout(() => {
      if (!activeRef.current || petStateRef.current?.muted) return;
      const pool = buildWakeReplyPool(userTitle);
      const targets = [pool.idle[0], pool.idle[1], pool.busy[0]].filter((v): v is string => Boolean(v));
      ttsPlayerRef.current?.warmPhrases(targets, coordinator.voice);
    }, 1_200);
    return () => clearTimeout(timer);
  }, [active, petState?.voiceMode, petState?.muted, userTitle, coordinator?.id, coordinator?.voice]);

  // Subscribe to pet TTS player speaking state.
  useEffect(() => {
    const player = ttsPlayerRef.current;
    if (!player) return;
    return player.subscribe((isSpeaking) => {
      speakingRef.current = isSpeaking;
      setSpeaking(isSpeaking);
    });
  }, []);

  // Initialize wake-word & quasi-full-duplex voice controller (cloud streaming ASR with native fallback).
  useEffect(() => {
    const ctrl = createPetVoiceController({
      bridge: () => {
        const pet = window.ogb?.desktopPet;
        if (!pet) return undefined;
        return {
          speechStart: pet.speechStart,
          speechStop: pet.speechStop,
          speechFinish: pet.speechFinish,
          onSpeechTranscript: pet.onSpeechTranscript,
          onSpeechEnd: pet.onSpeechEnd,
          callActive: window.ogb?.callActive,
        };
      },
      initialBotName: coordinatorRef.current?.name || "多宝",
      initialCloudAsr: cloudAsrRef.current,
      currentSpokenText: () => ttsPlayerRef.current?.currentText() ?? "",
      onChange: (next) => {
        const prevActive = voiceRef.current.active;
        voiceRef.current = next;
        setVoice(next);
        if (next.error) {
          showBubble({ text: next.error, kind: "error" }, { openPopover: true });
        } else if (prevActive && !next.active && petStateRef.current?.popoverMode === "voice") {
          void window.ogb?.desktopPet?.closePopover();
        }
      },
      onWakeDetected: ({ immediateCommand }) => {
        const bridge = window.ogb?.desktopPet;
        void bridge?.openPopover("voice");
        if (immediateCommand.trim()) {
          void sendInstruction(immediateCommand, { fromVoice: true });
          return;
        }
        const reply = pickWakeReply(userTitleRef.current, coordinatorRef.current?.busy === true);
        void deliverBriefOutput(reply, "status", {
          fromVoice: true,
          expectCommandAfter: true,
        });
      },
      onBargeIn: () => {
        // Immediately halt current TTS playback and pending chunks on verified user barge-in.
        ttsPlayerRef.current?.stop();
        void window.ogb?.desktopPet?.openPopover("voice");
      },
      onUtterance: (utterance) => {
        void sendInstruction(utterance, { fromVoice: true });
      },
    });
    voiceCtrlRef.current = ctrl;
    return () => {
      ctrl.dispose();
      voiceCtrlRef.current = null;
    };
  }, [deliverBriefOutput, sendInstruction, showBubble]);

  // Sync wake-word standby arming & cloud ASR readiness with pet visibility and `voiceMode` preference.
  useEffect(() => {
    const ctrl = voiceCtrlRef.current;
    if (!ctrl) return;
    ctrl.setCloudAsr(cloudAsr);
    if (!active) {
      ctrl.suspend();
      return;
    }
    ctrl.setBotName(coordinator?.name || "多宝");
    ctrl.setWakeEnabled(petState?.voiceMode === true);
  }, [active, petState?.voiceMode, coordinator?.name, cloudAsr]);

  // Listen to Electron desktop pet state, activation, and popover commands once on mount.
  const actionsRef = useRef({ refreshBotsAndConfig, refreshReports, sendInstruction });
  actionsRef.current = { refreshBotsAndConfig, refreshReports, sendInstruction };

  useEffect(() => {
    const bridge = window.ogb?.desktopPet;
    if (!bridge) return;
    void bridge.state().then((initial) => {
      petStateRef.current = initial;
      setPetState(initial);
      setActive(initial.visible);
    }).catch(() => {});

    const offState = bridge.onState((next) => {
      petStateRef.current = next;
      setPetState(next);
      if (next.muted) ttsPlayerRef.current?.stop();
    });
    const offActive = bridge.onActive((isActive) => {
      activeRef.current = isActive;
      setActive(isActive);
      if (!isActive) {
        ttsPlayerRef.current?.stop();
        voiceCtrlRef.current?.suspend();
      } else {
        void actionsRef.current.refreshBotsAndConfig();
        void actionsRef.current.refreshReports({ announceNew: false });
      }
    });
    const offMessage = bridge.onMessage((raw) => {
      if (!raw || typeof raw !== "object") return;
      const cmd = raw as PetPopoverCommand;
      switch (cmd.type) {
        case "request-sync": {
          const asrOn = cloudAsrRef.current.available === true;
          const snapshot: PetHostSnapshot = {
            coordinator: coordinatorRef.current,
            petState: petStateRef.current,
            userTitle: userTitleRef.current,
            wakePhrase: buildWakePhrase(coordinatorRef.current?.name),
            voice: voiceRef.current,
            speaking: speakingRef.current,
            sending: sendingRef.current,
            bubble: bubbleRef.current,
            reports: reportsRef.current,
            reportsLoading: reportsLoadingRef.current,
            ttsReady: ttsReadyRef.current,
            speechAvailable: Boolean(asrOn || window.ogb?.desktopPet?.speechStart),
            cloudAsrReady: asrOn,
            bargeInEnabled: asrOn,
          };
          void bridge.post("popover", { type: "host-sync", snapshot });
          break;
        }
        case "send":
          void actionsRef.current.sendInstruction(cmd.text, { fromVoice: false });
          break;
        case "stop-speaking":
          ttsPlayerRef.current?.stop();
          voiceCtrlRef.current?.afterSpeaking({ expectCommand: false });
          break;
        case "voice-start":
          ttsPlayerRef.current?.stop();
          voiceCtrlRef.current?.startCommandListening();
          void bridge.openPopover("voice");
          break;
        case "voice-stop":
          ttsPlayerRef.current?.stop();
          voiceCtrlRef.current?.stopConversation();
          void bridge.closePopover();
          break;
        case "voice-interrupt":
          ttsPlayerRef.current?.stop();
          voiceCtrlRef.current?.startCommandListening();
          break;
        case "refresh-reports":
          void actionsRef.current.refreshReports({ announceNew: false });
          break;
        case "report-resolved":
          setReports((prev) => {
            const next = prev.filter((item) => item.id !== cmd.reportId);
            reportsRef.current = next;
            void bridge.setReportCount(next.length);
            return next;
          });
          knownReportIdsRef.current?.delete(cmd.reportId);
          void actionsRef.current.refreshReports({ announceNew: false });
          break;
        case "dismiss-bubble":
          bubbleRef.current = null;
          setBubble(null);
          if (petStateRef.current?.popoverMode === "bubble") {
            void bridge.closePopover();
          }
          break;
        case "toggle-mute":
          void bridge.set({ muted: !petStateRef.current?.muted });
          break;
        case "toggle-voice-mode": {
          const nextVoiceMode = !petStateRef.current?.voiceMode;
          void bridge.set({ voiceMode: nextVoiceMode });
          break;
        }
      }
    });

    return () => {
      offState();
      offActive();
      offMessage();
    };
  }, []);

  const settleRef = useRef(settleTrackerWithText);
  settleRef.current = settleTrackerWithText;
  const deliverRef = useRef(deliverBriefOutput);
  deliverRef.current = deliverBriefOutput;

  // Active-only SSE stream + periodic report sync (only depends on `active` so it never reconnect-loops).
  useEffect(() => {
    if (!active) return;

    void actionsRef.current.refreshBotsAndConfig();
    void actionsRef.current.refreshReports({ announceNew: false });

    let closed = false;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reportDebounce: ReturnType<typeof setTimeout> | null = null;
    let botsDebounce: ReturnType<typeof setTimeout> | null = null;
    let bgSpeakTimer: ReturnType<typeof setTimeout> | null = null;
    let bgTurn: { turnId: string | null; text: string; messageId: string | null } | null = null;
    let retryDelay = 1_500;

    const scheduleBotsRefresh = () => {
      if (botsDebounce) return;
      botsDebounce = setTimeout(() => {
        botsDebounce = null;
        void actionsRef.current.refreshBotsAndConfig();
      }, 300);
    };

    const scheduleReportsRefresh = () => {
      if (reportDebounce) clearTimeout(reportDebounce);
      reportDebounce = setTimeout(() => {
        reportDebounce = null;
        void actionsRef.current.refreshReports({ announceNew: true });
      }, 450);
    };

    const handleFrame = (frame: Record<string, unknown>) => {
      const kind = frame.kind;
      const chief = coordinatorRef.current;

      if (kind === "state" && Array.isArray(frame.bots)) {
        const resolved = resolveChiefCoordinatorBot(frame.bots as PetBotCandidate[]);
        const nextSnap = toCoordinatorSnapshot(resolved);
        coordinatorRef.current = nextSnap;
        setCoordinator(nextSnap);
        return;
      }

      if (kind === "bot" || kind === "bot.updated" || kind === "bot.created" || kind === "bot.deleted") {
        const bot = frame.bot as PetBotCandidate | undefined;
        if (bot && chief && bot.id === chief.id) {
          const wasBusy = chief.busy;
          const updated = toCoordinatorSnapshot({ ...chief, ...bot });
          coordinatorRef.current = updated;
          setCoordinator(updated);
          if (wasBusy && updated && !updated.busy) {
            scheduleReportsRefresh();
            const activeTracker = trackerRef.current;
            if (activeTracker && !activeTracker.settled && (!activeTracker.queued || activeTracker.echoed) && activeTracker.latestText.trim()) {
              if (activeTracker.fallbackTimer) clearTimeout(activeTracker.fallbackTimer);
              activeTracker.fallbackTimer = setTimeout(() => {
                if (!activeTracker.settled && trackerRef.current === activeTracker && activeTracker.latestText.trim()) {
                  settleRef.current(activeTracker, activeTracker.latestText, true);
                }
              }, 350);
            }
          }
        } else {
          scheduleBotsRefresh();
        }
        return;
      }

      if (kind === "config" && frame.config && typeof frame.config === "object") {
        const cfg = frame.config as {
          profile?: { name?: string };
          tts?: { asrAvailable?: boolean; asrWsPath?: string };
          asr?: { ready?: boolean; wsPath?: string };
        };
        if (typeof cfg.profile?.name === "string") {
          profileNameRef.current = cfg.profile.name.trim();
          setProfileName(profileNameRef.current);
        }
        if (cfg.asr !== undefined || cfg.tts?.asrAvailable !== undefined) {
          const nextCloudAsr = {
            available: cfg.asr?.ready === true || cfg.tts?.asrAvailable === true,
            wsPath: cfg.asr?.wsPath || cfg.tts?.asrWsPath,
          };
          cloudAsrRef.current = nextCloudAsr;
          setCloudAsr((prev) => (prev.available === nextCloudAsr.available && prev.wsPath === nextCloudAsr.wsPath ? prev : nextCloudAsr));
          voiceCtrlRef.current?.setCloudAsr(nextCloudAsr);
        }
        return;
      }

      const tracker = trackerRef.current;
      if (kind === "runtime" && frame.event && typeof frame.event === "object") {
        const ev = frame.event as Record<string, unknown>;
        const evThread = typeof ev.threadId === "string" ? ev.threadId : undefined;
        const evBotId = typeof ev.botId === "string" ? ev.botId : undefined;

        if (ev.type === "turn.started" && chief && (evBotId === chief.id || evThread === chief.threadId)) {
          setCoordinator((prev) => (prev ? (coordinatorRef.current = { ...prev, busy: true }) : prev));
        }
        if (ev.type === "turn.completed") {
          if (chief && (evBotId === chief.id || evThread === chief.threadId)) {
            setCoordinator((prev) => (prev ? (coordinatorRef.current = { ...prev, busy: false }) : prev));
          }
          scheduleReportsRefresh();
        }

        if (tracker && !tracker.settled && evThread === tracker.threadId) {
          if (tracker.queued && !tracker.echoed) return;
          const evTurn = typeof ev.turnId === "string" ? ev.turnId : null;
          // Bind turnId from the first runtime event after send even if user-echo arrived slightly out of order.
          if (ev.type === "turn.started" && evTurn && tracker.turnId === null) {
            tracker.turnId = evTurn;
            tracker.echoed = true;
          } else if (evTurn && tracker.echoed && tracker.turnId === null) {
            tracker.turnId = evTurn;
          }
          const matchesTurn = !evTurn || !tracker.turnId || evTurn === tracker.turnId;
          if (matchesTurn && (tracker.echoed || ev.type === "content.delta" || ev.type === "item.completed" || ev.type === "turn.completed")) {
            if (ev.type === "content.delta" && ev.streamKind === "assistant_text" && typeof ev.delta === "string") {
              const nextItemId = typeof ev.itemId === "string" ? ev.itemId : null;
              if (nextItemId !== tracker.itemId) {
                tracker.itemId = nextItemId;
                tracker.streamed = "";
              }
              tracker.streamed += ev.delta;
              tracker.latestText = tracker.streamed;
            } else if (ev.type === "item.completed" && ev.itemType === "assistant_text" && typeof ev.text === "string") {
              tracker.latestText = ev.text;
            } else if (ev.type === "turn.completed") {
              tracker.turnCompleted = true;
              const ok = ev.ok !== false;
              if (tracker.latestText.trim()) {
                settleRef.current(tracker, tracker.latestText, ok);
              } else {
                // Authoritative bot text message may land right after turn.completed; wait briefly then settle.
                if (tracker.fallbackTimer) clearTimeout(tracker.fallbackTimer);
                tracker.fallbackTimer = setTimeout(() => {
                  if (tracker.settled || trackerRef.current !== tracker) return;
                  if (tracker.latestText.trim()) {
                    settleRef.current(tracker, tracker.latestText, ok);
                    return;
                  }
                  void api<{ bots?: Array<PetBotCandidate & { messages?: Array<{ id?: string; role?: string; kind?: string; text?: string; at?: number }> }> }>(
                    "/api/bots?messages=1",
                    { timeoutMs: 5_000 },
                  )
                    .then((res) => {
                      const found = res?.bots?.find((b) => b.id === coordinatorRef.current?.id);
                      const lastBotMsg = [...(found?.messages ?? [])]
                        .reverse()
                        .find((m) => m.role === "bot" && m.kind === "text" && typeof m.text === "string" && (!m.at || m.at >= tracker.startedAt - 2_000));
                      if (lastBotMsg?.id && !spokenMessageIdsRef.current.has(lastBotMsg.id)) {
                        tracker.latestMessageId = lastBotMsg.id;
                        settleRef.current(tracker, lastBotMsg.text ?? "", ok);
                      } else {
                        settleRef.current(tracker, "", ok);
                      }
                    })
                    .catch(() => settleRef.current(tracker, "", ok));
                }, 450);
              }
            }
          }
        } else if (!tracker && chief && evThread === chief.threadId) {
          const evTurn = typeof ev.turnId === "string" ? ev.turnId : null;
          if (ev.type === "turn.started") {
            bgTurn = { turnId: evTurn, text: "", messageId: null };
          } else if (bgTurn && (!evTurn || !bgTurn.turnId || evTurn === bgTurn.turnId)) {
            if (ev.type === "item.completed" && ev.itemType === "assistant_text" && typeof ev.text === "string") {
              bgTurn.text = ev.text;
            } else if (ev.type === "turn.completed") {
              const finished = bgTurn;
              bgTurn = null;
              if (ev.ok !== false && finished.text.trim() && (!finished.messageId || !spokenMessageIdsRef.current.has(finished.messageId))) {
                if (bgSpeakTimer) clearTimeout(bgSpeakTimer);
                bgSpeakTimer = setTimeout(() => {
                  bgSpeakTimer = null;
                  if (closed || !activeRef.current || trackerRef.current) return;
                  if (Date.now() - lastSpokenAtRef.current < 2_500) return;
                  if (finished.messageId) {
                    if (spokenMessageIdsRef.current.has(finished.messageId)) return;
                    spokenMessageIdsRef.current.add(finished.messageId);
                  }
                  void deliverRef.current(finished.text, "reply");
                }, 850);
              }
            }
          }
        }
        return;
      }

      if (kind === "message" && frame.message && typeof frame.message === "object") {
        const msg = frame.message as Record<string, unknown>;
        const msgThread = typeof frame.threadId === "string" ? frame.threadId : undefined;
        if (!tracker && bgTurn && chief && msgThread === chief.threadId && msg.role === "bot" && msg.kind === "text" && typeof msg.text === "string") {
          bgTurn.text = msg.text;
          bgTurn.messageId = typeof msg.id === "string" ? msg.id : bgTurn.messageId;
        }
        if (tracker && !tracker.settled && msgThread === tracker.threadId) {
          if (msg.role === "user" && msg.sendId === tracker.sendId) {
            tracker.echoed = true;
            if (typeof msg.turnId === "string") tracker.turnId = msg.turnId;
          } else if (msg.role === "bot" && msg.kind === "text" && typeof msg.text === "string") {
            const msgId = typeof msg.id === "string" ? msg.id : null;
            const msgAt = typeof msg.at === "number" ? msg.at : Date.now();
            const freshEnough = msgAt >= tracker.startedAt - 2_000;
            if (freshEnough && (!msgId || !spokenMessageIdsRef.current.has(msgId)) && (!tracker.queued || tracker.echoed)) {
              tracker.latestText = msg.text;
              tracker.latestMessageId = msgId;
              if (tracker.turnCompleted) {
                settleRef.current(tracker, msg.text, true);
              } else if (tracker.turnId === null && !coordinatorRef.current?.busy) {
                // Only fall back when no turn lifecycle is active (never interrupt a multi-step tool turn).
                if (tracker.fallbackTimer) clearTimeout(tracker.fallbackTimer);
                tracker.fallbackTimer = setTimeout(() => {
                  if (!tracker.settled && trackerRef.current === tracker && !coordinatorRef.current?.busy && tracker.latestText.trim()) {
                    settleRef.current(tracker, tracker.latestText, true);
                  }
                }, 1_400);
              }
            }
          }
        }
        if (msg.role === "bot" && (msg.kind === "text" || msg.kind === "file" || msg.kind === "artifact")) {
          scheduleReportsRefresh();
        }
      }
    };

    const connect = () => {
      if (closed) return;
      try {
        source = new EventSource("/api/events?screens=off&frames=thread");
      } catch {
        reconnectTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(8_000, retryDelay * 1.5);
        return;
      }
      source.onopen = () => {
        retryDelay = 1_500;
      };
      source.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data) as Record<string, unknown>;
          if (parsed && typeof parsed === "object") handleFrame(parsed);
        } catch {}
      };
      source.onerror = () => {
        source?.close();
        source = null;
        if (!closed) {
          reconnectTimer = setTimeout(connect, retryDelay);
          retryDelay = Math.min(8_000, retryDelay * 1.5);
        }
      };
    };

    connect();
    const poll = setInterval(() => {
      void actionsRef.current.refreshReports({ announceNew: true });
    }, REPORT_POLL_MS);

    return () => {
      closed = true;
      source?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (reportDebounce) clearTimeout(reportDebounce);
      if (botsDebounce) clearTimeout(botsDebounce);
      if (bgSpeakTimer) clearTimeout(bgSpeakTimer);
      clearInterval(poll);
    };
  }, [active]);

  const handleAvatarClick = () => {
    const bridge = window.ogb?.desktopPet;
    if (!bridge) return;

    // Clicking while speaking immediately interrupts TTS.
    if (speakingRef.current) {
      ttsPlayerRef.current?.stop();
      if (voiceRef.current.active) {
        voiceCtrlRef.current?.startCommandListening();
        return;
      }
      voiceCtrlRef.current?.afterSpeaking({ expectCommand: false });
      return;
    }

    // Toggle quick composer (wake-word listening works hands-free in parallel).
    if (petStateRef.current?.popoverMode === "composer") {
      void bridge.closePopover();
    } else {
      void bridge.openPopover("composer");
    }
  };

  const handleFileBadgeClick = () => {
    const bridge = window.ogb?.desktopPet;
    if (!bridge) return;
    if (petStateRef.current?.popoverMode === "approval") {
      void bridge.closePopover();
    } else {
      void refreshReports({ announceNew: false });
      void bridge.openPopover("approval");
    }
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      lastScreenX: event.screenX,
      lastScreenY: event.screenY,
      moved: false,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const totalDx = event.screenX - drag.startScreenX;
    const totalDy = event.screenY - drag.startScreenY;
    if (!drag.moved && Math.hypot(totalDx, totalDy) >= DRAG_THRESHOLD_PX) {
      drag.moved = true;
    }
    if (!drag.moved) return;
    const dx = event.screenX - drag.lastScreenX;
    const dy = event.screenY - drag.lastScreenY;
    drag.lastScreenX = event.screenX;
    drag.lastScreenY = event.screenY;
    if (dx !== 0 || dy !== 0) {
      void window.ogb?.desktopPet?.moveBy(dx, dy);
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.moved) {
      void window.ogb?.desktopPet?.commitPosition();
    } else {
      handleAvatarClick();
    }
  };

  const mascotState = resolvePetMascotState({
    coordinator,
    voicePhase: voice.phase,
    speaking,
    sending,
    pendingReportCount: reports.length,
  });

  const color = coordinator?.color ?? "green";
  const bodyId = wornBody(coordinator?.mascotBody, color, festival);
  const pendingCount = reports.length;
  const isListening = voice.phase === "listening";
  const isWaking = voice.phase === "waking";
  const isWakeStandby = voice.phase === "wake-standby";
  const isBusy = coordinator?.busy || sending || voice.phase === "working" || voice.phase === "sending";

  return (
    <div
      className="relative flex size-[140px] select-none items-center justify-center bg-transparent"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={(event) => {
        event.preventDefault();
        void window.ogb?.desktopPet?.contextMenu();
      }}
    >
      <style>{`
        @keyframes donebotPetFileBob {
          0%, 100% { transform: translateY(0px) rotate(-5deg); }
          45% { transform: translateY(-4px) rotate(4deg); }
          70% { transform: translateY(-1px) rotate(-2deg); }
        }
        @keyframes donebotPetFilePop {
          0% { transform: scale(0.7) translateY(8px) rotate(-10deg); }
          50% { transform: scale(1.16) translateY(-6px) rotate(6deg); }
          100% { transform: scale(1) translateY(0px) rotate(-4deg); }
        }
        @keyframes donebotPetRingPulse {
          0% { transform: scale(0.92); opacity: 0.75; }
          100% { transform: scale(1.26); opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .pet-file-anim, .pet-ring-anim { animation: none !important; }
        }
      `}</style>

      {/* Soft ambient ground shadow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-[20px] h-[14px] w-[62px] rounded-full bg-black/28 blur-[8px] transition-transform duration-200"
        style={{ transform: hovered ? "scale(1.06)" : "scale(1)" }}
      />

      {/* Voice / waking / speaking / working aura ring */}
      {(isListening || isWaking || speaking || isBusy) && (
        <div
          aria-hidden="true"
          className="pet-ring-anim pointer-events-none absolute size-[86px] rounded-full border-2"
          style={{
            borderColor: isListening || isWaking
              ? "rgba(56, 152, 255, 0.9)"
              : speaking
                ? "rgba(16, 185, 129, 0.85)"
                : "rgba(245, 158, 11, 0.65)",
            animation: "donebotPetRingPulse 1.5s ease-out infinite",
          }}
        />
      )}

      {/* Draggable / clickable mascot body */}
      <div
        role="button"
        tabIndex={0}
        aria-label={coordinator ? `${coordinator.name} 桌宠` : "DoneBot 桌宠"}
        title={
          speaking
            ? "点击打断播报"
            : petState?.voiceMode
              ? `喊「${wakePhrase}」即可唤醒对话 · 单击弹出输入栏 · 右键更多`
              : "点击弹出输入栏（拖动移动位置，右键更多选项）"
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            handleAvatarClick();
          }
        }}
        className="relative flex size-[92px] cursor-grab items-center justify-center rounded-full transition-transform duration-150 active:cursor-grabbing"
        style={{ transform: hovered || isWaking ? "scale(1.06)" : "scale(1)" }}
      >
        <MausAvatar
          color={color}
          bodyId={bodyId}
          faceColor={coordinator?.mascotFaceColor}
          state={mascotState}
          size={78}
          label={coordinator?.name ?? "DoneBot"}
          showMouth={speaking || isListening || isWaking}
          trackPointer={active && hovered}
          animated={active}
        />

        {/* Compact status pip: active listening / speaking / quiet wake-standby indicator */}
        {(isListening || speaking || isWakeStandby) && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-1 right-1 flex size-[22px] items-center justify-center rounded-full text-white shadow-md ring-2 ring-white/80"
            style={{
              background: isListening
                ? "#2563eb"
                : speaking
                  ? "#10b981"
                  : "rgba(15, 23, 42, 0.55)",
            }}
          >
            {speaking ? <Volume2 size={11} /> : <Mic size={11} />}
          </span>
        )}
      </div>

      {/* Document / report delivery animation badge when workbench approvals are pending */}
      {pendingCount > 0 && (
        <button
          type="button"
          data-pet-report-badge={pendingCount}
          aria-label={`有 ${pendingCount} 份工作汇报待审批，点击预览和审批`}
          title={`有 ${pendingCount} 份工作汇报待审批，点击预览与审批`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            handleFileBadgeClick();
          }}
          className="pet-file-anim group absolute right-[12px] top-[12px] flex size-[38px] cursor-pointer items-center justify-center rounded-xl border border-black/10 bg-white/95 text-slate-800 shadow-[0_6px_18px_rgba(0,0,0,0.22)] backdrop-blur-md transition-transform duration-150 hover:scale-110 active:scale-95 dark:border-white/15 dark:bg-zinc-900/95 dark:text-zinc-100"
          style={{
            animation: filePulse
              ? "donebotPetFilePop 0.55s ease-out 1, donebotPetFileBob 2.4s ease-in-out 0.55s infinite"
              : "donebotPetFileBob 2.6s ease-in-out infinite",
          }}
        >
          <FileText size={18} className="text-amber-500 transition-transform group-hover:scale-105" aria-hidden="true" />
          <span className="absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold leading-none text-white shadow-sm ring-2 ring-white dark:ring-zinc-900">
            {pendingCount > 9 ? "9+" : pendingCount}
          </span>
        </button>
      )}
    </div>
  );
}
