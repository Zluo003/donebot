import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_DONEBOT_TURN_LIMITS } from "../../shared/donebot.ts";
import { createOpenAIChatRuntime } from "../drivers/openai-chat.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { PASS } from "../routes/table.ts";
import { createDoneBotTurnLimitsRoute, DoneBotTurnLimitsStore } from "./turn-limits.ts";

const dirs: string[] = [];
function tempFile(name = "turn-limits.json"): string {
  const dir = mkdtempSync(join(tmpdir(), "donebot-turn-limits-"));
  dirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function routeInvoke(
  route: ReturnType<typeof createDoneBotTurnLimitsRoute>,
  input: {
    method: string;
    path: string;
    auth:
      | { kind: "loopback"; scopes: string[]; trust?: "service" }
      | { kind: "session"; scopes: string[] };
    body?: unknown;
  },
) {
  let status = 0;
  let payload: unknown;
  const headers: Record<string, string> = {};
  const res = {
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; },
  } as unknown as ServerResponse;
  return route({
    req: {} as IncomingMessage,
    res,
    path: input.path,
    method: input.method,
    auth: input.auth as never,
    url: new URL(`http://127.0.0.1${input.path}`),
    json: (_r: unknown, code: number, data: unknown) => { status = code; payload = data; },
    readBody: async () => input.body ?? {},
  } as never).then((result) => ({ passed: result === PASS, status, payload, headers }));
}

describe("DoneBotTurnLimitsStore & route", () => {
  it("defaults to 256 steps / 800 tool calls, persists updates, and recovers invalid files", () => {
    const file = tempFile();
    const store = new DoneBotTurnLimitsStore(file);
    expect(store.get()).toEqual({ maxSteps: 256, maxToolCalls: 800 });
    expect(DEFAULT_DONEBOT_TURN_LIMITS).toEqual({ maxSteps: 256, maxToolCalls: 800 });

    store.save({ maxSteps: 320, maxToolCalls: 1200 });
    expect(new DoneBotTurnLimitsStore(file).get()).toEqual({ maxSteps: 320, maxToolCalls: 1200 });

    expect(() => store.save({ maxSteps: 200, maxToolCalls: 100 })).toThrow();
    expect(() => store.save({ maxSteps: 10, maxToolCalls: 100 })).toThrow();

    writeFileSync(file, "{broken-json", "utf8");
    const recovered = new DoneBotTurnLimitsStore(file);
    expect(recovered.get()).toEqual({ maxSteps: 256, maxToolCalls: 800 });
  });

  it("serves GET/PUT /api/donebot/turn-limits for owner/admin and refuses service or client-only callers", async () => {
    const store = new DoneBotTurnLimitsStore(tempFile());
    const route = createDoneBotTurnLimitsRoute(store);
    const ownerAuth = { kind: "loopback" as const, scopes: ["admin", "client"] };

    const unrelated = await routeInvoke(route, { method: "GET", path: "/api/donebot/state", auth: ownerAuth });
    expect(unrelated.passed).toBe(true);

    const deniedClient = await routeInvoke(route, {
      method: "GET",
      path: "/api/donebot/turn-limits",
      auth: { kind: "session", scopes: ["client"] },
    });
    expect(deniedClient.status).toBe(403);

    const deniedService = await routeInvoke(route, {
      method: "GET",
      path: "/api/donebot/turn-limits",
      auth: { kind: "loopback", scopes: ["client"], trust: "service" },
    });
    expect(deniedService.status).toBe(403);

    const initial = await routeInvoke(route, { method: "GET", path: "/api/donebot/turn-limits", auth: ownerAuth });
    expect(initial.status).toBe(200);
    expect(initial.payload).toEqual({ maxSteps: 256, maxToolCalls: 800 });

    const invalid = await routeInvoke(route, {
      method: "PUT",
      path: "/api/donebot/turn-limits",
      auth: ownerAuth,
      body: { maxSteps: 300, maxToolCalls: 200 },
    });
    expect(invalid.status).toBe(400);

    const updated = await routeInvoke(route, {
      method: "PUT",
      path: "/api/donebot/turn-limits",
      auth: { kind: "session", scopes: ["admin", "client"] },
      body: { maxSteps: 128, maxToolCalls: 500 },
    });
    expect(updated.status).toBe(200);
    expect(updated.payload).toEqual({ maxSteps: 128, maxToolCalls: 500 });
    expect(store.get()).toEqual({ maxSteps: 128, maxToolCalls: 500 });
  });

  it("enforces dynamic maxChatRounds and maxTurnToolCalls in createOpenAIChatRuntime", async () => {
    let roundsLimit = 2;
    let toolCallsLimit = 10;
    let calls = 0;

    const runtime = createOpenAIChatRuntime({
      input: { instanceId: "donebot", displayName: "DoneBot", environment: {}, enabled: true, config: {} },
      driverKind: "donebot",
      apiKey: "",
      apiUrl: "https://donebot.cn/v1",
      authenticated: () => true,
      models: () => ({ default: "test-model", options: [{ id: "test-model", label: "Test" }] }),
      requestBody: () => ({}),
      httpErrorLabel: "DoneBot gateway",
      missingKeyError: "missing",
      unavailableReason: "unavailable",
      timeoutMs: 10_000,
      maxChatRounds: () => roundsLimit,
      maxTurnToolCalls: () => toolCallsLimit,
      completionTransport: async () => ({
        text: "",
        reasoning: "",
        protocolReasoning: "",
        protocolReasoningDetails: [],
        finishReason: "tool_calls",
        toolCalls: [
          { id: `call_${++calls}`, type: "function", function: { name: "ping_tool", arguments: "{}" } },
          { id: `call_${++calls}`, type: "function", function: { name: "ping_tool", arguments: "{}" } },
        ],
        usage: null,
      }),
      localTools: async () => ({
        definitions: [{ type: "function", function: { name: "ping_tool", description: "ping", parameters: { type: "object", properties: {} } } }],
        validate: () => {},
        view: () => ({ title: "ping", input: {}, ask: false }),
        execute: async () => ({ ok: true, text: "pong" }),
        close: async () => {},
      }),
      nativeLog: { source: "test", outgoing: () => ({}), incoming: () => ({}) },
    });

    const runTurn = async (threadId: string) => {
      const events: RuntimeEvent[] = [];
      let done!: () => void;
      const completed = new Promise<void>((resolve) => { done = resolve; });
      const off = runtime.adapter.onEvent((event) => {
        events.push(event);
        if (event.type === "turn.completed" && event.threadId === threadId) done();
      });
      try {
        await runtime.adapter.sendTurn({
          threadId,
          text: "keep going",
          model: "test-model",
          approvalMode: "full",
        });
        await completed;
      } finally {
        off();
      }
      return events;
    };

    const stepCapEvents = await runTurn("thread-step-cap");
    const stepErr = stepCapEvents.find((e) => e.type === "runtime.error");
    expect(stepErr && "message" in stepErr ? stepErr.message : "").toContain("Stopped after 2 steps without a final answer");

    roundsLimit = 10;
    toolCallsLimit = 3;
    const toolCapEvents = await runTurn("thread-tool-cap");
    const toolErr = toolCapEvents.find((e) => e.type === "runtime.error");
    expect(toolErr && "message" in toolErr ? toolErr.message : "").toContain("Stopped after 3 tool calls without a final answer");
  });
});
