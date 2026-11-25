import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const driver = createDoneBotLlmDriver({ imageCacheDir: join(cwd, "cache"), toolUse: () => toolUse, request, models: () => ({ default: "fixture", options: [{ id: "fixture", label: "Fixture" }] }), protocol: () => protocol, authenticated: () => authenticated });
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
  it("keeps streamed tagged reasoning out of chat messages while preserving the tool continuation", async () => {
    const fx = await fixture("chat");
    const content = "<thinking>Inspect the synthetic fixture.</thinking>";
    fx.request.mockImplementation(async (_path, init) => {
      const body = JSON.parse(init.body as string); fx.bodies.push(body);
      if (fx.bodies.length === 1) return stream([
        { choices: [{ delta: { content: "<thi" } }] },
        { choices: [{ delta: { content: content.slice(4, -3) } }] },
        { choices: [{ delta: { content: content.slice(-3), tool_calls: [{ index: 0, id: "call-fixture", type: "function", function: {
          name: "workspace_write", arguments: JSON.stringify({ path: "receipt.txt", text: "fixture written" }),
        } }] }, finish_reason: "tool_calls" }] },
      ]);
      return stream([
        { choices: [{ delta: { reasoning_content: "Check the receipt. ", content: "<think>" } }] },
        { choices: [{ delta: { content: "The synthetic receipt is present.</think>Fixture complete." }, finish_reason: "stop" }] },
      ]);
    });
    await fx.instance.adapter.sendTurn({ threadId: "fixture", text: "Write the fixture", cwd: fx.cwd, approvalMode: "full", toolScope: { allow: ["native:workspace_write"] } });
    await fx.completed();
    expect(await readFile(join(fx.cwd, "receipt.txt"), "utf8")).toBe("fixture written");
    expect(fx.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    expect(fx.request).toHaveBeenCalledTimes(2);
    expect(fx.events.filter(event => event.type === "item.completed" && event.itemType === "tool")).toHaveLength(1);
    expect(fx.events.filter(event => event.type === "item.completed" && event.itemType === "assistant_text")).toEqual([
      expect.objectContaining({ text: "Fixture complete." }),
    ]);
    const deltas = fx.events.filter(event => event.type === "content.delta");
    expect(deltas.filter(event => event.streamKind === "assistant_text").map(event => event.delta).join("")).toBe("Fixture complete.");
    expect(deltas.filter(event => event.streamKind === "reasoning_text").map(event => event.delta).join("")).toBe("Inspect the synthetic fixture.Check the receipt. The synthetic receipt is present.");
    const assistant = rows(fx.bodies[1]!.messages).find(message => message.role === "assistant");
    expect(assistant).toMatchObject({ content, tool_calls: [expect.objectContaining({ id: "call-fixture" })] });
    expect(assistant).not.toHaveProperty("reasoning_content");
  });

  it.each([false, true])("does not turn reasoning-only output into a final chat bubble or retry (tagged=%s)", async tagged => {
    const fx = await fixture("chat", false);
    fx.request.mockImplementation(async () => stream([{ choices: [{ delta: tagged
      ? { content: "<thinking>Only a synthetic thought.</thinking>" }
      : { reasoning_content: "Only a synthetic thought." }, finish_reason: "stop" }] }]));
    await fx.instance.adapter.sendTurn({ threadId: "fixture", text: "Answer the fixture", cwd: fx.cwd, approvalMode: "full" });
    await fx.completed();
    expect(fx.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false });
    expect(fx.request).toHaveBeenCalledTimes(1);
    expect(fx.events.filter(event => event.type === "item.completed" && event.itemType === "assistant_text")).toEqual([]);
    expect(fx.events.filter(event => event.type === "content.delta" && event.streamKind === "assistant_text")).toEqual([]);
  });

  it("continues repeated image reads after the aggregate would exceed 32 MiB, without rerunning generation tools", async () => {
    const fx = await fixture("chat");
    const images = [];
    for (let index = 0; index < 4; index++) {
      const bytes = Buffer.alloc(9 * 1024 * 1024, index); Buffer.from("GIF89a").copy(bytes);
      const path = join(fx.cwd, `${index}.gif`); await writeFile(path, bytes);
      images.push({ path, mime: "image/gif" as const, bytes: bytes.length });
    }
    let identifiers: string[] = [];
    fx.request.mockImplementation(async (_path, init) => {
      const body = JSON.parse(init.body as string); fx.bodies.push(body);
      const messages = rows(body.messages), parts = messages.flatMap(message => rows(message.content));
      const encoded = parts.filter(part => part.type === "image_url").reduce((total, part) => total + String((part.image_url as { url: string }).url).length, 0);
      expect(encoded).toBeLessThanOrEqual(32 * 1024 * 1024);
      if (!identifiers.length) identifiers = parts.flatMap(part => part.type === "text" && typeof part.text === "string" && part.text.startsWith("{") ? [JSON.parse(part.text).id] : []).filter(Boolean);
      const round = fx.bodies.length;
      return round <= 4 ? json({ choices: [{ message: { tool_calls: [{ id: `read-${round}`, type: "function", function: {
        name: "attachment_read_image", arguments: JSON.stringify({ id: identifiers[(round - 1) % identifiers.length], original: true }),
      } }] }, finish_reason: "tool_calls" }] }) : json({ choices: [{ message: { content: "Read all reference images." }, finish_reason: "stop" }] });
    });
    await fx.instance.adapter.sendTurn({ threadId: "fixture", text: "Inspect the reference images", images, cwd: fx.cwd, approvalMode: "full" });
    await fx.completed();
    expect(fx.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    expect(fx.events.filter(event => event.type === "item.completed" && event.itemType === "tool")).toHaveLength(4);
    expect(fx.bodies).toHaveLength(5);
    expect(fx.events.filter(event => event.type === "runtime.notice")).toHaveLength(1);
    expect(JSON.stringify(fx.bodies.at(-1))).toContain("unloaded to fit attachment budget");
  }, 30_000);
  it("deduplicates identical 9 MiB reference pairs replayed three times before the original encoded-image budget", async () => {
    const fx = await fixture("responses", false);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
    const images = [];
    for (let batch = 0; batch < 3; batch++) for (let image = 0; image < 2; image++) {
      const bytes = Buffer.alloc(4.5 * 1024 * 1024, image); png.copy(bytes);
      const path = join(fx.cwd, `${batch}-${image}.png`); await writeFile(path, bytes);
      images.push({ path, mime: "image/png" as const, bytes: bytes.length });
    }
    await fx.instance.adapter.sendTurn({ threadId: "fixture", text: "Generate from these two repeated references", cwd: fx.cwd, approvalMode: "full", images });
    await fx.completed();
    const parts = rows(fx.bodies[0].input).flatMap(message => rows(message.content)).filter(part => part.type === "input_image");
    expect(parts).toHaveLength(2);
    expect(fx.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    expect((await readFile(images[0].path)).length).toBe(images[0].bytes);
  });
  it.each(["messages", "gemini", "responses", "chat"] as const)("sends the image bytes through %s without requiring optional gateway modality metadata", async protocol => {
    const fx = await fixture(protocol, false);
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
    const path = join(fx.cwd, "uploaded.png");
    await writeFile(path, bytes);
    await fx.instance.adapter.sendTurn({ threadId: "fixture", text: "Use this uploaded image", cwd: fx.cwd, approvalMode: "full", images: [{ path, mime: "image/png", bytes: bytes.length }] });
    await fx.completed();
    const body = fx.bodies[0]!, data = bytes.toString("base64");
    if (protocol === "responses") {
      expect(rows(body.input).flatMap(message => rows(message.content))).toContainEqual({ type: "input_image", image_url: `data:image/png;base64,${data}`, detail: "auto" });
    } else if (protocol === "messages") {
      expect(rows(body.messages).flatMap(message => rows(message.content))).toContainEqual({ type: "image", source: { type: "base64", media_type: "image/png", data } });
    } else if (protocol === "gemini") {
      expect(rows(body.contents).flatMap(message => rows(message.parts))).toContainEqual({ inlineData: { mimeType: "image/png", data } });
    } else {
      expect(rows(body.messages).flatMap(message => rows(message.content))).toContainEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${data}` } });
    }
    expect(fx.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
  });

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

  it.each(["messages", "gemini", "responses", "chat"] as const)("retries a pre-stream transport fetch failure on the follow-up round after a completed %s tool call without replaying the tool", async (protocol) => {
    const fx = await fixture(protocol);
    let attempt = 0;
    fx.request.mockImplementation(async (_path, init) => {
      fx.bodies.push(JSON.parse(init.body as string));
      attempt += 1;
      if (attempt === 1) return reply(protocol, true);
      if (attempt === 2) throw new TypeError("fetch failed");
      return reply(protocol, false);
    });
    await fx.instance.adapter.sendTurn({ threadId: "fixture", text: "Write the fixture", cwd: fx.cwd, approvalMode: "full", toolScope: { allow: ["native:workspace_write"] } });
    await fx.completed();
    expect(fx.request).toHaveBeenCalledTimes(3);
    expect(fx.events).toContainEqual(expect.objectContaining({ type: "turn.retrying", attempt: 1, reason: "connection_reset" }));
    expect(fx.events.filter((one) => one.type === "item.completed" && one.itemType === "tool")).toHaveLength(1);
    expect(fx.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    expect(await readFile(join(fx.cwd, "receipt.txt"), "utf8")).toBe("fixture written");
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
