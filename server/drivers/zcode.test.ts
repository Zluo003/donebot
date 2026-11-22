import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../contracts.ts";
import {
  resolveZCodeLaunch,
  ZCodeDriver,
  zcodeAuthState,
  zcodePermissionMode,
} from "./zcode.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ZCodeDriver", () => {
  it("maps approval modes to ZCode headless modes", () => {
    expect(zcodePermissionMode(false, "full")).toBe("yolo");
    expect(zcodePermissionMode(true, "ask")).toBe("yolo");
    expect(zcodePermissionMode(false, "edits")).toBe("edit");
    expect(zcodePermissionMode(false, "ask")).toBe("guarded");
    expect(zcodePermissionMode(false, "auto")).toBe("guarded");
  });

  it("detects desktop credentials and API keys without leaking secrets", () => {
    const home = makeTempDir("donebot-zcode-home-");
    expect(zcodeAuthState({ HOME: home }).authenticated).toBe(false);

    const v2Dir = join(home, ".zcode", "v2");
    mkdirSync(v2Dir, { recursive: true });
    writeFileSync(
      join(v2Dir, "credentials.json"),
      JSON.stringify({
        "oauth:bigmodel:access_token": "tok_test_value",
        "oauth:bigmodel:user_info": JSON.stringify({ nickname: "测试开发者" }),
      }),
      "utf8",
    );

    const desktopAuth = zcodeAuthState({ HOME: home });
    expect(desktopAuth.authenticated).toBe(true);
    expect(desktopAuth.account).toEqual({ email: "测试开发者", method: "login" });

    const envAuth = zcodeAuthState({ HOME: makeTempDir("donebot-zcode-empty-"), ZAI_API_KEY: "k_test" });
    expect(envAuth.authenticated).toBe(true);
    expect(envAuth.account?.method).toBe("api-key");
  });

  it("resolves script launches via current Node runtime and streams stream-json turns with resume", async () => {
    const dir = makeTempDir("donebot-zcode-fixture-");
    const home = join(dir, "home");
    mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
    writeFileSync(
      join(home, ".zcode", "v2", "credentials.json"),
      JSON.stringify({ zcodejwttoken: "jwt_ok" }),
      "utf8",
    );

    const fakeScript = join(dir, "fake-zcode.cjs");
    writeFileSync(
      fakeScript,
      `
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("0.16.9");
  process.exit(0);
}
const resumeIdx = args.indexOf("--resume");
const sessionId = resumeIdx >= 0 ? args[resumeIdx + 1] : "sess_zcode_001";
const modeIdx = args.indexOf("--mode");
const mode = modeIdx >= 0 ? args[modeIdx + 1] : "";
console.log(JSON.stringify({ type: "session.created", sessionId }));
console.log(JSON.stringify({ type: "model.streaming", sessionId, payload: { kind: "reasoning_delta", delta: "思考中" } }));
console.log(JSON.stringify({ type: "tool.updated", sessionId, payload: { kind: "started", toolCallId: "tc1", toolName: "Read", path: "README.md" } }));
console.log(JSON.stringify({ type: "tool.updated", sessionId, payload: { kind: "result", toolCallId: "tc1", toolName: "Read", output: "ok" } }));
console.log(JSON.stringify({ type: "model.streaming", sessionId, payload: { kind: "text_delta", delta: "你好，" } }));
console.log(JSON.stringify({ type: "model.streaming", sessionId, payload: { kind: "text_delta", delta: "模式=" + mode } }));
console.log(JSON.stringify({ type: "result", sessionId, response: "你好，模式=" + mode, usage: { inputTokens: 12, outputTokens: 8 } }));
`,
      "utf8",
    );
    chmodSync(fakeScript, 0o755);

    const launch = resolveZCodeLaunch(fakeScript, ["--version"], { HOME: home });
    expect(launch?.command).toBe(process.execPath);
    expect(launch?.extraEnv?.ELECTRON_RUN_AS_NODE).toBe("1");

    const instance = await ZCodeDriver.create({
      instanceId: "coding-zcode",
      displayName: "ZCode",
      environment: { HOME: home },
      enabled: true,
      config: { cli: fakeScript, fullAuto: false },
    });

    try {
      const snap = await instance.snapshot();
      expect(snap.state).toBe("available");
      expect(snap.version).toBe("0.16.9");
      expect(snap.authenticated).toBe(true);

      const events: RuntimeEvent[] = [];
      const done = new Promise<void>((resolve) => {
        instance.adapter.onEvent((event) => {
          events.push(event);
          if (event.type === "turn.completed") resolve();
        });
      });

      await instance.adapter.sendTurn({
        threadId: "thread-z1",
        text: "请帮我看代码",
        cwd: dir,
        approvalMode: "edits",
      });
      await done;

      expect(events.some((e) => e.type === "session.started" && e.sessionId === "sess_zcode_001")).toBe(true);
      expect(events.some((e) => e.type === "content.delta" && e.streamKind === "reasoning_text" && e.delta === "思考中")).toBe(true);
      expect(events.some((e) => e.type === "item.started" && e.itemType === "tool" && e.title === "Read")).toBe(true);
      expect(events.some((e) => e.type === "item.completed" && e.itemType === "tool" && e.ok === true)).toBe(true);
      expect(events.some((e) => e.type === "item.completed" && e.itemType === "assistant_text" && e.text === "你好，模式=edit")).toBe(true);
      expect(events.some((e) => e.type === "turn.completed" && e.ok === true && e.usage?.input === 12 && e.usage?.output === 8)).toBe(true);
    } finally {
      await instance.dispose();
    }
  });
});
