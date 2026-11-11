import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { allowsTool } from "../../shared/tool-scope.ts";
import { createDoneBotLlmDriver, doneBotMediaToolScope } from "./llm-driver.ts";
import type { DoneBotLlmProtocol } from "./llm-protocol.ts";

const instances: ProviderInstance[] = [], directories: string[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose();
  for (const directory of directories.splice(0)) await rm(directory, { force: true, recursive: true });
});
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const stream = (events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const failedBody = (contentType: string) => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new TypeError("terminated")); } }), { headers: { "content-type": contentType } });
const responses = (output: unknown[]) => new Response(`data: ${JSON.stringify({ type: "response.completed", response: { output } })}\n\n`, { headers: { "content-type": "text/event-stream" } });

it("adds the local media capability read when a scoped bot can generate media", () => {
  const scope = { allow: ["mcp:agents:generate_image"] };
  const expanded = doneBotMediaToolScope(scope)!;
  expect(expanded.allow).toEqual(["mcp:agents:generate_image", "mcp:agents:media_model_capabilities"]);
  expect(allowsTool(expanded, { kind: "mcp", server: "agents", name: "media_model_capabilities" })).toBe(true);
  expect(doneBotMediaToolScope({ allow: ["mcp:agents:list_bots"] })).toEqual({ allow: ["mcp:agents:list_bots"] });
  const denied = doneBotMediaToolScope({ allow: ["mcp:agents:generate_video"], deny: ["mcp:agents:media_model_capabilities"] })!;
  expect(allowsTool(denied, { kind: "mcp", server: "agents", name: "media_model_capabilities" })).toBe(false);
});

const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value)
  ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item))
  : [];
const reply = (protocol: DoneBotLlmProtocol, tool: boolean) => {
  const args = { path: "receipt.txt", text: "fixture written" };
  if (protocol === "messages") return json({ content: tool ? [{ type: "thinking", thinking: "reason", signature: "messages-signature" }, { type: "tool_use", id: "call-fixture", name: "workspace_write", input: args }] : [{ type: "text", text: "Fixture complete." }], stop_reason: tool ? "tool_use" : "end_turn" });
  if (protocol === "gemini") return json({ candidates: [{ content: { parts: tool ? [{ functionCall: { id: "call-fixture", name: "workspace_write", args }, thoughtSignature: "gemini-signature" }] : [{ text: "Fixture complete." }] }, finishReason: "STOP" }] });
  if (protocol === "responses") return responses(tool ? [{ type: "reasoning", id: "r", encrypted_content: "responses-encrypted", summary: [] }, { type: "function_call", id: "fc", call_id: "call-fixture", name: "workspace_write", arguments: JSON.stringify(args) }] : [{ type: "message", id: "m", role: "assistant", content: [{ type: "output_text", text: "Fixture complete." }] }]);
  return json({ choices: [{ message: tool ? { content: null, reasoning_content: "chat-reasoning", tool_calls: [{ id: "call-fixture", type: "function", function: { name: "workspace_write", arguments: JSON.stringify(args) } }] } : { content: "Fixture complete." }, finish_reason: tool ? "tool_calls" : "stop" }] });
};
const fixture = async (protocol: DoneBotLlmProtocol, toolUse = true) => {
  const cwd = await mkdtemp(join(tmpdir(), "donebot-driver-fixture-")); directories.push(cwd);
  const bodies: Record<string, unknown>[] = [];
  let authenticated = true;
  const request = vi.fn(async (_path: string, init: RequestInit) => { bodies.push(JSON.parse(init.body as string)); return reply(protocol, toolUse && bodies.length === 1); });
  const driver = createDoneBotLlmDriver({ toolUse: () => toolUse, request, models: () => ({ default: "fixture", options: [{ id: "fixture", label: "Fixture" }] }), protocol: () => protocol, authenticated: () => authenticated });
  const instance = await driver.create({ instanceId: "donebot-fixture", displayName: "Fixture", environment: {}, enabled: true, config: {} }); instances.push(instance);
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event) => events.push(event));
  const completed = () => vi.waitFor(() => expect(events.some((one) => one.type === "turn.completed")).toBe(true), { timeout: 10_000 });
  return { cwd, instance, request, bodies, events, completed, logout: () => { authenticated = false; } };
};

const writeThroughRetry = async (fx: Awaited<ReturnType<typeof fixture>>, reason: string) => {
  await fx.instance.adapter.sendTurn({ threadId: "fixture", text: "Write the fixture", cwd: fx.cwd, approvalMode: "full", toolScope: { allow: ["native:workspace_write"] } });
  await fx.completed();
  expect(fx.request).toHaveBeenCalledTimes(3);
  expect(fx.events).toContainEqual(expect.objectContaining({ type: "turn.retrying", attempt: 1, reason }));
  expect(fx.events).toContainEqual(expect.objectContaining({ type: "item.completed", itemType: "tool", itemId: "call-fixture", ok: true }));
  expect(fx.events.filter((one) => one.type === "item.completed" && one.itemType === "tool")).toHaveLength(1);
  expect(fx.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
  expect(await readFile(join(fx.cwd, "receipt.txt"), "utf8")).toBe("fixture written");
};

const interruptedReply = (protocol: DoneBotLlmProtocol) => {
  if (protocol === "messages") return stream([{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "partial", name: "workspace_write", input: {} } }]);
  if (protocol === "gemini") return stream([{ candidates: [{ index: 0, content: { parts: [] } }] }]);
  if (protocol === "responses") return stream([{ type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "partial", name: "workspace_write", arguments: "" } }]);
  return stream([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "partial", type: "function", function: { name: "workspace_write", arguments: "{" } }] } }] }]);
};

const transientReply = (protocol: DoneBotLlmProtocol) => {
  if (protocol === "messages") return stream([{ type: "error", error: { type: "overloaded_error" } }]);
  if (protocol === "gemini") return json({ error: { code: 503, status: "UNAVAILABLE", message: "private fixture detail" } });
  if (protocol === "responses") return stream([{ type: "response.failed", response: { error: { type: "overloaded_error", message: "private fixture detail" } } }]);
  return stream([{ error: { type: "rate_limit_error", message: "private fixture detail" } }]);
};

const partialTextThenError = (protocol: DoneBotLlmProtocol) => {
  if (protocol === "messages") return stream([
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial answer" } },
    { type: "error", error: { type: "server_error" } },
  ]);
  if (protocol === "gemini") return stream([
    { candidates: [{ content: { parts: [{ text: "partial answer" }] } }] },
    { error: { code: 503, status: "UNAVAILABLE" } },
  ]);
  if (protocol === "responses") return stream([
    { type: "response.output_text.delta", item_id: "message-1", delta: "partial answer" },
    { type: "response.failed", response: { error: { type: "server_error" } } },
  ]);
  return stream([
    { choices: [{ index: 0, delta: { content: "partial answer" } }] },
    { error: { type: "server_error" } },
  ]);
};

describe("DoneBot driver using the existing platform tool loop", () => {
  it.each(["messages", "gemini", "responses", "chat"] as const)("executes an explicitly Full workspace turn through %s with native replay", async (protocol) => {
    const fx = await fixture(protocol);
    await fx.instance.adapter.sendTurn({ threadId: "fixture", text: "Write the fixture", cwd: fx.cwd, approvalMode: "full", toolScope: { allow: ["native:workspace_write"] } });
    await fx.completed();
    expect(await readFile(join(fx.cwd, "receipt.txt"), "utf8")).toBe("fixture written");
    expect(fx.events).toContainEqual(expect.objectContaining({ type: "item.completed", itemType: "tool", itemId: "call-fixture", ok: true }));
    expect(fx.events).toContainEqual(expect.objectContaining({ type: "turn.completed", ok: true }));
    expect(fx.events.some((one) => one.type === "request.opened")).toBe(false);
    expect(fx.request).toHaveBeenCalledTimes(2);
    const first = fx.bodies[0]!, followup = fx.bodies[1]!;
    if (protocol === "gemini") expect(fx.request.mock.calls[0]![0]).toContain("/fixture:streamGenerateContent");
    else expect(first).toMatchObject({ model: "fixture" });
    if (protocol === "messages") {
      expect(rows(first.tools)).toEqual(expect.arrayContaining([expect.objectContaining({ name: "workspace_write" })]));
      expect(rows(followup.messages).flatMap((message) => rows(message.content))).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "thinking", signature: "messages-signature" }),
        expect.objectContaining({ type: "tool_use", id: "call-fixture" }),
        expect.objectContaining({ type: "tool_result", tool_use_id: "call-fixture" }),
      ]));
    } else if (protocol === "gemini") {
      expect(rows(rows(first.tools)[0]?.functionDeclarations)).toEqual(expect.arrayContaining([expect.objectContaining({ name: "workspace_write" })]));
      expect(rows(followup.contents).flatMap((content) => rows(content.parts))).toEqual(expect.arrayContaining([
        expect.objectContaining({ functionCall: expect.objectContaining({ id: "call-fixture" }) }),
        expect.objectContaining({ functionResponse: expect.objectContaining({ id: "call-fixture" }) }),
      ]));
      expect(JSON.stringify(followup)).toContain("gemini-signature");
    } else if (protocol === "responses") {
      expect(first.tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: "function", name: "workspace_write", strict: false })]));
      expect(followup.input).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "reasoning", encrypted_content: "responses-encrypted" }),
        expect.objectContaining({ type: "function_call", call_id: "call-fixture" }),
        expect.objectContaining({ type: "function_call_output", call_id: "call-fixture" }),
      ]));
    } else {
      expect(first.stream_options).toEqual({ include_usage: true });
      expect(rows(first.tools)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "function", function: expect.objectContaining({ name: "workspace_write" }) })]));
      expect(followup.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "assistant", tool_calls: expect.arrayContaining([expect.objectContaining({ id: "call-fixture" })]) }),
        expect.objectContaining({ role: "tool", tool_call_id: "call-fixture" }),
      ]));
      expect(JSON.stringify(followup)).toContain("chat-reasoning");
    }
    expect(JSON.stringify(followup)).toContain("sha256");
  });

  it("executes a function-shaped Chat tool call with a nonstandard type marker", async () => {
    const fx = await fixture("chat");
    fx.request.mockImplementation(async (_path, init) => {
      fx.bodies.push(JSON.parse(init.body as string));
      return fx.bodies.length === 1
        ? json({ choices: [{ message: { tool_calls: [{ id: "call-fixture", type: "vendor-extension", function: { name: "workspace_write", arguments: JSON.stringify({ path: "receipt.txt", text: "fixture written" }) } }] }, finish_reason: "tool_calls" }] })
        : json({ choices: [{ message: { content: "Fixture complete." }, finish_reason: "stop" }] });
    });
    await fx.instance.adapter.sendTurn({ threadId: "fixture", text: "Write the fixture", cwd: fx.cwd, approvalMode: "full", toolScope: { allow: ["native:workspace_write"] } });
    await fx.completed();
    expect(fx.request).toHaveBeenCalledTimes(2);
    expect(await readFile(join(fx.cwd, "receipt.txt"), "utf8")).toBe("fixture written");
    expect(fx.events).toContainEqual(expect.objectContaining({ type: "item.completed", itemType: "tool", itemId: "call-fixture", ok: true }));
    expect(fx.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
  });

  it("retries a transient gateway HTTP failure before receiving a reply", async () => {
    const fx = await fixture("chat");
    fx.request.mockImplementationOnce(async () => new Response("temporarily unavailable", { status: 503 }));
    await writeThroughRetry(fx, "server_error");
  });

  it("retries a reset gateway connection before receiving a reply", async () => {
    const fx = await fixture("chat");
    fx.request.mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    await writeThroughRetry(fx, "connection_reset");
  });

  it.each(["messages", "gemini", "responses", "chat"] as const)("retries a pre-output stream interruption through %s", async (protocol) => {
    const fx = await fixture(protocol);
    fx.request.mockImplementationOnce(async () => interruptedReply(protocol));
    await writeThroughRetry(fx, "connection_reset");
  });

  it.each(["messages", "gemini", "responses", "chat"] as const)("retries a rejected stream reader through %s", async (protocol) => {
    const fx = await fixture(protocol);
    fx.request.mockImplementationOnce(async () => failedBody("text/event-stream"));
    await writeThroughRetry(fx, "connection_reset");
  });

  it.each(["messages", "gemini", "chat"] as const)("retries a rejected JSON body reader through %s", async (protocol) => {
    const fx = await fixture(protocol);
    fx.request.mockImplementationOnce(async () => failedBody("application/json"));
    await writeThroughRetry(fx, "connection_reset");
  });

  it.each([
    ["messages", "overloaded"], ["gemini", "server_error"], ["responses", "overloaded"], ["chat", "rate_limited"],
  ] as const)("retries a transient %s protocol error envelope", async (protocol, reason) => {
    const fx = await fixture(protocol);
    fx.request.mockImplementationOnce(async () => transientReply(protocol));
    await writeThroughRetry(fx, reason);
    expect(JSON.stringify(fx.events)).not.toContain("private fixture detail");
  });

  it.each(["messages", "gemini", "responses", "chat"] as const)("does not replay a completed %s tool call when the following model request fails", async (protocol) => {
    const fx = await fixture(protocol);
    let attempt = 0;
    fx.request.mockImplementation(async (_path, init) => {
      fx.bodies.push(JSON.parse(init.body as string));
      return ++attempt === 1 ? reply(protocol, true) : new Response("temporarily unavailable", { status: 503 });
    });
    await fx.instance.adapter.sendTurn({ threadId: "fixture", text: "Write the fixture", cwd: fx.cwd, approvalMode: "full", toolScope: { allow: ["native:workspace_write"] } });
    await fx.completed();
    expect(fx.request).toHaveBeenCalledTimes(2);
    expect(fx.events.filter((one) => one.type === "item.completed" && one.itemType === "tool")).toHaveLength(1);
    expect(fx.events).not.toContainEqual(expect.objectContaining({ type: "turn.retrying", reason: "server_error" }));
    expect(fx.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false });
    expect(await readFile(join(fx.cwd, "receipt.txt"), "utf8")).toBe("fixture written");
  });

  it.each(["messages", "gemini", "responses", "chat"] as const)("does not replay after %s text has reached the conversation", async (protocol) => {
    const fx = await fixture(protocol);
    fx.request.mockImplementationOnce(async () => partialTextThenError(protocol));
    await fx.instance.adapter.sendTurn({ threadId: "fixture", text: "Answer the fixture", cwd: fx.cwd, approvalMode: "full" });
    await fx.completed();
    expect(fx.request).toHaveBeenCalledTimes(1);
    expect(fx.events.some((one) => one.type === "content.delta" && one.delta === "partial answer")).toBe(true);
    expect(fx.events).not.toContainEqual(expect.objectContaining({ type: "turn.retrying", reason: "server_error" }));
    expect(fx.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false });
  });

  it("preserves Ask denial, steer and tool-failure events without writing a file", async () => {
    const fx = await fixture("messages");
    await fx.instance.adapter.sendTurn({ threadId: "fixture", text: "Write the fixture", cwd: fx.cwd, approvalMode: "ask", toolScope: { allow: ["native:workspace_write"] } });
    let requestId: string | undefined;
    await vi.waitFor(() => {
      const opened = fx.events.find((one) => one.type === "request.opened");
      if (opened?.type !== "request.opened") throw new Error("No approval card");
      requestId = opened.requestId;
    });
    expect(await fx.instance.adapter.steer!("fixture", "Retain this additional fixture context")).toBe("steered");
    expect(await fx.instance.adapter.respondToRequest("fixture", requestId!, { behavior: "deny" })).toBe("rejected");
    await fx.completed();
    await expect(readFile(join(fx.cwd, "receipt.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(fx.events).toContainEqual(expect.objectContaining({ type: "turn.completed", ok: false, denials: ["workspace_write"] }));
    expect(JSON.stringify(fx.bodies[1])).toContain("Retain this additional fixture context");
    expect(JSON.stringify(fx.bodies[1])).toContain("Permission denied");
  });

  it("keeps a public text-only model usable without advertising tools", async () => {
    const fx = await fixture("chat", false);
    await fx.instance.adapter.sendTurn({ threadId: "fixture", text: "A plain reply", cwd: fx.cwd, approvalMode: "full" });
    await fx.completed();
    expect(fx.bodies[0]).not.toHaveProperty("tools");
    expect(fx.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
  });

  it("refuses unavailable models and logged-out helper calls before any request", async () => {
    const fx = await fixture("messages");
    await expect(fx.instance.generateText!("fixture", { model: "unknown" })).rejects.toThrow("not available");
    fx.logout();
    await expect(fx.instance.generateText!("fixture")).rejects.toThrow("Sign in");
    expect(fx.request).not.toHaveBeenCalled();
    expect(await fx.instance.snapshot()).toMatchObject({ state: "unavailable" });
  });
});
