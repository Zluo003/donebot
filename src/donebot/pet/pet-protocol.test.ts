import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildWakePhrase,
  buildWakeReplyPool,
  compactSpokenReply,
  formatBossReportAnnouncement,
  matchWakeWord,
  pickWakeReply,
  resolveChiefCoordinatorBot,
  resolvePetMascotState,
  resolveUserAddressTitle,
  toCoordinatorSnapshot,
} from "./pet-protocol";
import { createPetTtsPlayer } from "./pet-tts";
import { createPetVoiceController } from "./pet-voice";

describe("desktop pet protocol helpers", () => {
  it("resolves system chief coordinator bot over department chiefs and regular bots", () => {
    const bots = [
      { id: "b1", name: "普通助手", color: "blue" },
      { id: "b2", name: "研究部协调", color: "purple", chiefOfStaff: true, section: "研究部" },
      { id: "b3", name: "隐藏主协调", color: "red", chiefOfStaff: true, hidden: true },
      { id: "b4", name: "总协调", color: "green", chiefOfStaff: true, section: "" },
    ];
    expect(resolveChiefCoordinatorBot(bots)?.id).toBe("b4");
    expect(resolveChiefCoordinatorBot([bots[0]!, { id: "d1", name: "默认助手", defaultBot: {} }])?.id).toBe("d1");
  });

  it("resolves user addressing title from ChiefSetup soul, Chinese soul, profile.name, or default", () => {
    const chiefSoul = '<!-- donebot-chief-preferences -->\nAddress the user as "张总".\n<!-- /donebot-chief-preferences -->';
    expect(resolveUserAddressTitle(chiefSoul, "Alice")).toBe("张总");
    expect(resolveUserAddressTitle("平时请称呼我为「大老板」", "Alice")).toBe("大老板");
    expect(resolveUserAddressTitle("普通人设", "陈总")).toBe("陈总");
    expect(resolveUserAddressTitle("", "")).toBe("老板");
  });

  it("matches fixed wake word 你好 <chiefName> and extracts inline command remainder", () => {
    expect(buildWakePhrase("多宝")).toBe("你好多宝");
    expect(matchWakeWord("你好多宝", "多宝")).toEqual({ matched: true, remainder: "" });
    expect(matchWakeWord("您好，多宝！", "多宝")).toEqual({ matched: true, remainder: "" });
    expect(matchWakeWord("前面杂音 你好，多宝，帮我整理今天的周报", "多宝")).toEqual({
      matched: true,
      remainder: "帮我整理今天的周报",
    });
    expect(matchWakeWord("你好 DoneBot check status", "DoneBot")).toEqual({
      matched: true,
      remainder: "check status",
    });
    expect(matchWakeWord("今天天气真不错", "多宝")).toEqual({ matched: false, remainder: "" });
  });

  it("picks idle vs busy wake replies using the user's configured title", () => {
    const pool = buildWakeReplyPool("老板");
    expect(pool.idle).toContain("老板，我在。");
    expect(pool.idle).toContain("老板，有什么吩咐。");
    expect(pool.busy).toContain("老板，我在忙呢，你有什么事啊？");
    expect(pickWakeReply("张总", false, 0)).toBe("张总，我在。");
    expect(pickWakeReply("张总", true, 0)).toBe("张总，我在忙呢，你有什么事啊？");
  });

  it("formats zero-fluff boss report announcements with user title", () => {
    expect(formatBossReportAnnouncement([{ title: "周度竞品分析" }], "张总")).toBe(
      "张总，周度竞品分析已经完成了，需要您审批。",
    );
    expect(
      formatBossReportAnnouncement([
        {
          title: "发布上线",
          workflow: {
            runId: "r1",
            workflowId: "w1",
            workflowName: "内容发布流程",
            stepIndex: 1,
            totalSteps: 3,
            stepName: "终稿审核",
            isLastStep: false,
          },
        },
      ]),
    ).toBe("老板，内容发布流程的终稿审核已经完成了，需要您审批。");
    expect(formatBossReportAnnouncement([{ title: "任务 A" }, { title: "任务 B" }])).toBe(
      "老板，有 2 项工作已经完成了，需要您审批。",
    );
  });

  it("strips markdown and trims overly verbose replies cleanly", () => {
    const md = "## 汇报总结\n- **核心结论**：`donebot-api` 发布已完成。\n```bash\necho ok\n```\n详见 [日志](https://example.com)。";
    expect(compactSpokenReply(md)).toBe("汇报总结 核心结论：donebot-api 发布已完成。 详见 日志。");

    const long = "老板，本次调研已经完成。我们整理了五家竞品的定价和核心差异，并生成了完整的分析报告提交到了工作台，另外还附上了一份可以直接对外演示的网页版对比表格供您随时审阅。";
    const trimmed = compactSpokenReply(long, 60);
    expect(trimmed.length).toBeLessThanOrEqual(61);
    expect(trimmed.endsWith("。") || trimmed.endsWith("…")).toBe(true);
  });

  it("maps coordinator and voice activity to mascot animation states with proper priority", () => {
    const chief = toCoordinatorSnapshot({ id: "c1", name: "主协调", color: "green", busy: true });
    expect(resolvePetMascotState({ coordinator: chief, voicePhase: "waking", speaking: true, sending: true, pendingReportCount: 2 })).toBe("happy");
    expect(resolvePetMascotState({ coordinator: chief, voicePhase: "listening", speaking: true, sending: true, pendingReportCount: 2 })).toBe("listening");
    expect(resolvePetMascotState({ coordinator: chief, voicePhase: "idle", speaking: true, sending: false, pendingReportCount: 2 })).toBe("humming");
    expect(resolvePetMascotState({ coordinator: chief, voicePhase: "wake-standby", speaking: false, sending: false, pendingReportCount: 0 })).toBe("working");
    expect(resolvePetMascotState({ coordinator: { ...chief!, busy: false }, voicePhase: "idle", speaking: false, sending: false, pendingReportCount: 2 })).toBe("notifying");
    expect(resolvePetMascotState({ coordinator: { ...chief!, busy: false, hasError: true }, voicePhase: "idle", speaking: false, sending: false, pendingReportCount: 0 })).toBe("alerting");
    expect(resolvePetMascotState({ coordinator: { ...chief!, busy: false }, voicePhase: "wake-standby", speaking: false, sending: false, pendingReportCount: 0 })).toBe("idle");
  });
});

describe("createPetTtsPlayer", () => {
  it("serves pre-warmed wake replies from cache instantly, retries stale voiceId, and falls back to native speech", async () => {
    const fakeBlob = new Blob(["RIFFxxxx"], { type: "audio/wav" });
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string; voiceId?: string };
      if (body.voiceId === "stale-voice") {
        return new Response("invalid voice", { status: 400 });
      }
      if (body.text === "触发离线回退") {
        return new Response("service down", { status: 503 });
      }
      return new Response(fakeBlob, { status: 200, headers: { "content-type": "audio/wav" } });
    });
    const playBlobImpl = vi.fn(async () => true);
    const speakSystemImpl = vi.fn(async () => true);

    const player = createPetTtsPlayer({ fetchImpl, playBlobImpl, speakSystemImpl });
    player.warmPhrases(["老板，我在。"], "stale-voice");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    // Speaking warmed phrase uses cache with 0 extra fetch calls.
    const res1 = await player.speak("老板，我在。", { voiceId: "stale-voice" });
    expect(res1.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(playBlobImpl).toHaveBeenCalledTimes(1);

    // When remote TTS is unavailable, gracefully falls back to system speech.
    const res2 = await player.speak("触发离线回退");
    expect(res2.ok).toBe(true);
    expect(res2.usedFallback).toBe(true);
    expect(speakSystemImpl).toHaveBeenCalledTimes(1);
  });
});

describe("createPetVoiceController wake word & half-duplex flow", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("arms wake standby, fires instant wake on 你好 <botName>, then listens for command after greeting", () => {
    vi.useFakeTimers();
    const hooks: {
      onTranscript: ((line: { text?: string; final?: boolean }) => void) | null;
      onEnd: ((info: { code?: number | null; reason?: string }) => void) | null;
    } = { onTranscript: null, onEnd: null };

    const bridge = {
      speechStart: vi.fn(),
      speechStop: vi.fn(),
      speechFinish: vi.fn(() => hooks.onEnd?.({ code: 0 })),
      onSpeechTranscript: vi.fn((cb: (line: { text?: string; final?: boolean }) => void) => {
        hooks.onTranscript = cb;
        return () => { hooks.onTranscript = null; };
      }),
      onSpeechEnd: vi.fn((cb: (info: { code?: number | null; reason?: string }) => void) => {
        hooks.onEnd = cb;
        return () => { hooks.onEnd = null; };
      }),
      callActive: vi.fn(),
    };

    const wakeHits: string[] = [];
    const utterances: string[] = [];
    let latestPhase = "idle";
    const ctrl = createPetVoiceController({
      bridge: () => bridge,
      initialBotName: "多宝",
      onChange: (s) => { latestPhase = s.phase; },
      onWakeDetected: ({ immediateCommand }) => wakeHits.push(immediateCommand),
      onUtterance: (text) => utterances.push(text),
    });

    ctrl.setWakeEnabled(true);
    vi.advanceTimersByTime(400);
    expect(latestPhase).toBe("wake-standby");
    expect(bridge.speechStart).toHaveBeenCalledWith({});

    // User says wake word -> immediate wake hit!
    hooks.onTranscript?.({ text: "你好多宝", final: false });
    expect(wakeHits).toEqual([""]);
    expect(latestPhase).toBe("waking");

    // Fast TTS greeting finishes -> enter command listening with silence endpointing.
    ctrl.afterSpeaking({ expectCommand: true });
    vi.advanceTimersByTime(250);
    expect(latestPhase).toBe("listening");
    expect(bridge.speechStart).toHaveBeenLastCalledWith({ endpointMs: 950 });

    // User speaks command -> endpoint sends utterance.
    hooks.onTranscript?.({ text: "查一下待审批项目", final: false });
    vi.advanceTimersByTime(1_000);
    expect(utterances).toEqual(["查一下待审批项目"]);

    // Bot speaks reply -> mic paused -> afterSpeaking re-arms command listening; 9s silence returns to wake standby.
    ctrl.markWorking();
    ctrl.markSpeaking();
    ctrl.afterSpeaking({ expectCommand: false });
    vi.advanceTimersByTime(300);
    expect(latestPhase).toBe("listening");

    vi.advanceTimersByTime(9_600);
    expect(latestPhase).toBe("wake-standby");

    ctrl.dispose();
  });

  it("circuit-breaks wake standby after 3 rapid helper failures instead of spin-looping", () => {
    vi.useFakeTimers();
    const hooks: { onEnd: ((info: { code?: number | null; reason?: string }) => void) | null } = { onEnd: null };
    const bridge = {
      speechStart: vi.fn(),
      speechStop: vi.fn(),
      speechFinish: vi.fn(),
      onSpeechTranscript: vi.fn(() => () => {}),
      onSpeechEnd: vi.fn((cb: (info: { code?: number | null; reason?: string }) => void) => {
        hooks.onEnd = cb;
        return () => { hooks.onEnd = null; };
      }),
      callActive: vi.fn(),
    };

    let latest = { wakeEnabled: false, phase: "idle", error: null as string | null };
    const ctrl = createPetVoiceController({
      bridge: () => bridge,
      initialBotName: "多宝",
      onChange: (s) => { latest = { wakeEnabled: s.wakeEnabled, phase: s.phase, error: s.error }; },
      onWakeDetected: vi.fn(),
      onUtterance: vi.fn(),
    });

    ctrl.setWakeEnabled(true);
    vi.advanceTimersByTime(400);
    expect(bridge.speechStart).toHaveBeenCalledTimes(1);

    hooks.onEnd?.({ code: 1, reason: "helper-exited" });
    vi.advanceTimersByTime(2_100);
    expect(bridge.speechStart).toHaveBeenCalledTimes(2);

    hooks.onEnd?.({ code: 1, reason: "helper-exited" });
    vi.advanceTimersByTime(5_100);
    expect(bridge.speechStart).toHaveBeenCalledTimes(3);

    hooks.onEnd?.({ code: 1, reason: "helper-exited" });
    vi.advanceTimersByTime(30_000);
    // Must stop retrying after 3 consecutive rapid failures.
    expect(bridge.speechStart).toHaveBeenCalledTimes(3);
    expect(latest.wakeEnabled).toBe(false);
    expect(latest.phase).toBe("idle");
    expect(latest.error).toContain("权限");
    ctrl.dispose();
  });

  it("extracts inline command when user speaks wake word and instruction in one breath", () => {
    vi.useFakeTimers();
    const hooks: {
      onTranscript: ((line: { text?: string; final?: boolean }) => void) | null;
    } = { onTranscript: null };

    const bridge = {
      speechStart: vi.fn(),
      speechStop: vi.fn(),
      speechFinish: vi.fn(),
      onSpeechTranscript: vi.fn((cb: (line: { text?: string; final?: boolean }) => void) => {
        hooks.onTranscript = cb;
        return () => { hooks.onTranscript = null; };
      }),
      onSpeechEnd: vi.fn(() => () => {}),
      callActive: vi.fn(),
    };

    const wakeHits: string[] = [];
    const ctrl = createPetVoiceController({
      bridge: () => bridge,
      initialBotName: "多宝",
      onChange: () => {},
      onWakeDetected: ({ immediateCommand }) => wakeHits.push(immediateCommand),
      onUtterance: vi.fn(),
    });

    ctrl.setWakeEnabled(true);
    vi.advanceTimersByTime(400);
    hooks.onTranscript?.({ text: "你好，多宝，把今天的数据总结一下", final: false });
    vi.advanceTimersByTime(1_000);
    expect(wakeHits).toEqual(["把今天的数据总结一下"]);
    ctrl.dispose();
  });
});
