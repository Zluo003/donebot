import { randomUUID } from "node:crypto";
import type { Completion, CompletionTransportInput, OpenAIChatMessage } from "../drivers/openai-chat.ts";
import { ChatProtocolError, ChatReasoningDetails, ChatToolCalls, object } from "../drivers/openai-chat-protocol.ts";
import { readResponsesStream, responsesRequest, type ResponseItem } from "../drivers/openai-responses.ts";

export type DoneBotLlmProtocol = "messages" | "gemini" | "responses" | "chat";
export type DoneBotLlmRequest = (path: string, init: RequestInit) => Promise<Response>;
type Row = Record<string, unknown>;
type NativeOutput = { protocol: DoneBotLlmProtocol; content: Row[] };

const MAX_FRAME = 16 * 1024 * 1024;
const MAX_REPLY = 64 * 1024 * 1024;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(object).filter((row): row is Row => Boolean(row)) : [];
const blank = (): Completion => ({ text: "", reasoning: "", usage: null, toolCalls: [], finishReason: null, protocolReasoning: "", protocolReasoningDetails: [] });

function replay(input: CompletionTransportInput, message: OpenAIChatMessage, protocol: DoneBotLlmProtocol): Row[] | undefined {
  const saved = object(input.replay(message));
  return saved?.protocol === protocol && Array.isArray(saved.content) ? saved.content as Row[] : undefined;
}

function image(url: string): { mime: string; data: string } {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!match) throw new ChatProtocolError("Native model image input must be an admitted inline image");
  return { mime: match[1]!, data: match[2]! };
}

function content(message: OpenAIChatMessage, protocol: "messages" | "gemini"): Row[] {
  const parts = Array.isArray(message.content) ? message.content : typeof message.content === "string" && message.content ? [{ type: "text" as const, text: message.content }] : [];
  return parts.map((part) => {
    if (part.type === "text") return protocol === "messages" ? { type: "text", text: part.text } : { text: part.text };
    const data = image(part.image_url.url);
    return protocol === "messages" ? { type: "image", source: { type: "base64", media_type: data.mime, data: data.data } }
      : { inlineData: { mimeType: data.mime, data: data.data } };
  });
}

function argumentsOf(value: string): Row {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new ChatProtocolError("Tool arguments are not complete JSON"); }
  const result = object(parsed);
  if (!result) throw new ChatProtocolError("Tool arguments must be an object");
  return result;
}

function toolTypeLabel(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.replace(/[^\x20-\x7e]/g, "?").slice(0, 40));
  return value === null ? "null" : typeof value;
}

function interruptedStream(): Error {
  return new Error("DoneBot gateway stream connection reset before completion");
}

function transportReadFailure(signal: AbortSignal, error: unknown): never {
  signal.throwIfAborted();
  if (error instanceof ChatProtocolError || (error instanceof Error && error.name === "AbortError")) throw error;
  throw interruptedStream();
}

function gatewayFailure(protocol: string, value: unknown): Error {
  const root = object(value);
  const failure = object(root?.error) ?? root;
  const statuses = [root?.status, root?.code, failure?.status, failure?.code];
  const status = statuses.find((candidate) => typeof candidate === "number" && candidate >= 400 && candidate <= 599);
  if (typeof status === "number") return new Error(`DoneBot gateway ${protocol} request failed (HTTP ${status}${status === 408 ? " timeout" : ""})`);
  const codes = [failure?.type, failure?.status, failure?.code, root?.type]
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => candidate.toLowerCase());
  if (codes.some((code) => /rate.?limit|too_many_requests/.test(code))) return new Error(`DoneBot gateway ${protocol} request failed (HTTP 429)`);
  if (codes.some((code) => /overloaded/.test(code))) return new Error(`DoneBot gateway ${protocol} request failed (overloaded)`);
  if (codes.some((code) => /service_unavailable|unavailable/.test(code))) return new Error(`DoneBot gateway ${protocol} request failed (HTTP 503)`);
  if (codes.some((code) => /deadline_exceeded|timeout/.test(code))) return new Error(`DoneBot gateway ${protocol} request failed (HTTP 504 timeout)`);
  if (codes.some((code) => /server_error|internal_error|api_error/.test(code))) return new Error(`DoneBot gateway ${protocol} request failed (HTTP 500)`);
  return new ChatProtocolError(`DoneBot gateway ${protocol} request failed`);
}

function responsesFailure(status: number, body: string): Error {
  try {
    const failure = gatewayFailure("Responses", JSON.parse(body));
    if (!(failure instanceof ChatProtocolError)) return failure;
  } catch {}
  return new Error(`DoneBot gateway Responses request failed (HTTP ${status})`);
}

export function messagesRequest(input: CompletionTransportInput) {
  const messages: Array<{ role: "user" | "assistant"; content: Row[] }> = [];
  const add = (role: "user" | "assistant", parts: Row[]) => {
    if (!parts.length) return;
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...parts);
    else messages.push({ role, content: [...parts] });
  };
  for (const message of input.messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      add("user", [{ type: "tool_result", tool_use_id: message.tool_call_id, content: typeof message.content === "string" ? message.content : JSON.stringify(message.content) }]);
    } else {
      add(message.role, replay(input, message, "messages") ?? [...content(message, "messages"), ...(message.tool_calls ?? []).map((call) => ({ type: "tool_use", id: call.id, name: call.function.name, input: argumentsOf(call.function.arguments) }))]);
    }
  }
  const system = input.messages.filter((message) => message.role === "system" && typeof message.content === "string").map((message) => message.content).join("\n\n");
  return { model: input.model, max_tokens: 8192, stream: input.stream, ...(system ? { system } : {}), messages,
    ...(input.tools.length ? { tools: input.tools.map(({ function: fn }) => ({ name: fn.name, description: fn.description, input_schema: fn.parameters })) } : {}) };
}

export function geminiRequest(input: CompletionTransportInput) {
  const contents: Array<{ role: "user" | "model"; parts: Row[] }> = [];
  const names = new Map<string, { name: string; id?: string }>();
  const add = (role: "user" | "model", parts: Row[]) => {
    if (!parts.length) return;
    const previous = contents.at(-1);
    if (previous?.role === role) previous.parts.push(...parts);
    else contents.push({ role, parts: [...parts] });
  };
  for (const message of input.messages) {
    if (message.role === "system") continue;
    const nativeCalls = replay(input, message, "gemini")?.flatMap((part) => object(part.functionCall) ? [object(part.functionCall)!] : []) ?? [];
    for (const [index, call] of (message.tool_calls ?? []).entries()) names.set(call.id, { name: call.function.name, ...(typeof nativeCalls[index]?.id === "string" ? { id: nativeCalls[index]!.id as string } : {}) });
    if (message.role === "tool") {
      const call = names.get(message.tool_call_id ?? "");
      if (!call) throw new ChatProtocolError("Gemini tool result has no matching function call");
      add("user", [{ functionResponse: { ...call, response: { result: message.content } } }]);
    } else {
      add(message.role === "assistant" ? "model" : "user", replay(input, message, "gemini") ?? [...content(message, "gemini"), ...(message.tool_calls ?? []).map((call) => ({ functionCall: { name: call.function.name, args: argumentsOf(call.function.arguments) } }))]);
    }
  }
  const system = input.messages.filter((message) => message.role === "system" && typeof message.content === "string").map((message) => message.content).join("\n\n");
  return { contents, ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    ...(input.tools.length ? { tools: [{ functionDeclarations: input.tools.map(({ function: fn }) => ({ name: fn.name, description: fn.description, parametersJsonSchema: fn.parameters })) }] } : {}) };
}

async function readEvents(response: Response, input: CompletionTransportInput, consume: (data: Row) => boolean | void): Promise<boolean> {
  if (!response.body) throw interruptedStream();
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  input.signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder();
  let buffer = "", total = 0, ended = false;
  const frame = (raw: string, final = false) => {
    if (raw.length > MAX_FRAME) throw new ChatProtocolError("Model stream event exceeded the size limit");
    const data = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (data === "[DONE]") { ended = true; return; }
    let row: Row | undefined;
    try { row = object(JSON.parse(data)); } catch { if (final) throw interruptedStream(); throw new ChatProtocolError("Gateway returned a malformed model stream event"); }
    if (!row) throw new ChatProtocolError("Gateway returned a non-object model stream event");
    ended = consume(row) === true;
  };
  try {
    while (!ended) {
      input.signal.throwIfAborted();
      const next = await reader.read().catch((error: unknown) => transportReadFailure(input.signal, error));
      input.signal.throwIfAborted();
      if (next.done) { buffer += decoder.decode(); if (buffer.trim()) frame(buffer, true); break; }
      total += next.value.byteLength;
      if (total > MAX_REPLY) throw new ChatProtocolError("Model response exceeded the size limit");
      input.onBytes();
      buffer += decoder.decode(next.value, { stream: true });
      let match: RegExpExecArray | null;
      while (!ended && (match = /\r?\n\r?\n/.exec(buffer))) {
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        frame(raw);
      }
      if (buffer.length > MAX_FRAME) throw new ChatProtocolError("Model stream event exceeded the size limit");
    }
    input.signal.throwIfAborted();
    return ended;
  } finally { input.signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); }
}

function monitorResponsesStream(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): ReadableStream<Uint8Array> {
  if (!body) throw interruptedStream();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "", complete = false;
  const inspect = (raw: string) => {
    const data = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    try {
      const event = object(JSON.parse(data));
      if (["response.completed", "response.incomplete", "response.failed", "error"].includes(String(event?.type))) complete = true;
    } catch {}
  };
  const consume = (final = false) => {
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      inspect(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
    }
    if (final && buffer.trim()) {
      inspect(buffer);
      buffer = "";
      return true;
    }
    return false;
  };
  let aborted = false;
  let streamController: ReadableStreamDefaultController<Uint8Array>;
  const abort = () => {
    aborted = true;
    streamController.error(signal.reason ?? new DOMException("Aborted", "AbortError"));
    void reader.cancel().catch(() => {});
  };
  const cleanup = () => signal.removeEventListener("abort", abort);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      try {
        const next = await reader.read().catch((error: unknown) => transportReadFailure(signal, error));
        if (aborted) return;
        if (next.done) {
          buffer += decoder.decode();
          const hasFinalFrame = consume(true);
          if (hasFinalFrame) controller.enqueue(encoder.encode("\n"));
          cleanup();
          if (!complete) controller.error(interruptedStream());
          else controller.close();
          return;
        }
        buffer += decoder.decode(next.value, { stream: true });
        if (buffer.length > MAX_FRAME) throw new ChatProtocolError("Model stream event exceeded the size limit");
        consume();
        controller.enqueue(next.value);
      } catch (error) {
        cleanup();
        if (!aborted) controller.error(error);
        void reader.cancel().catch(() => {});
      }
    },
    cancel(reason) { cleanup(); void reader.cancel(reason).catch(() => {}); },
  });
}

async function jsonBody(response: Response, input: CompletionTransportInput): Promise<Row> {
  if (!response.body) throw new ChatProtocolError("Gateway returned no model response body");
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  input.signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      input.signal.throwIfAborted();
      const next = await reader.read().catch((error: unknown) => transportReadFailure(input.signal, error));
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_FRAME) throw new ChatProtocolError("Model response exceeded the size limit");
      input.onBytes(); chunks.push(next.value);
    }
    input.signal.throwIfAborted();
    let parsed: Row | undefined;
    try { parsed = object(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch {}
    if (!parsed) throw new ChatProtocolError("Gateway returned invalid model JSON");
    return parsed;
  } finally { input.signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); }
}

function recordUsage(input: CompletionTransportInput, completion: Completion, usage: Row, fields: { input: string; output: string; cached?: number }) {
  const usedInput = number(usage[fields.input]), usedOutput = number(usage[fields.output]);
  if (usedInput !== undefined || usedOutput !== undefined) {
    completion.usage = { input: usedInput ?? 0, output: usedOutput ?? 0 };
    input.onUsage?.({ model: input.model, ...(usedInput !== undefined ? { input: usedInput } : {}), ...(usedOutput !== undefined ? { output: usedOutput } : {}), ...(fields.cached !== undefined ? { cachedInput: fields.cached } : {}) });
  }
}

function messagesCompletion(input: CompletionTransportInput, blocks: Row[], stop: unknown, usage: Row): Completion {
  if (!["end_turn", "stop_sequence", "refusal", "tool_use", "max_tokens"].includes(String(stop))) throw new ChatProtocolError("Messages model did not finish its response");
  const result = blank();
  const calls = new ChatToolCalls();
  const toolCalls: Row[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") result.text += block.text;
    if (block.type === "thinking" && typeof block.thinking === "string") result.reasoning += block.thinking;
    if (block.type === "tool_use") toolCalls.push({ type: "function", id: block.id, function: { name: block.name, arguments: JSON.stringify(block.input) } });
  }
  calls.add(toolCalls, false);
  result.finishReason = stop === "tool_use" ? "tool_calls" : stop === "max_tokens" ? "length" : "stop";
  result.toolCalls = calls.finish(result.finishReason, false);
  result.nativeOutput = { protocol: "messages", content: blocks } satisfies NativeOutput;
  const cached = number(usage.cache_read_input_tokens) ?? 0;
  const fresh = number(usage.input_tokens);
  recordUsage(input, result, { ...usage, ...(fresh !== undefined ? { input_tokens: fresh + cached + (number(usage.cache_creation_input_tokens) ?? 0) } : {}) }, { input: "input_tokens", output: "output_tokens", cached });
  return result;
}

async function readMessages(response: Response, input: CompletionTransportInput): Promise<Completion> {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const body = await jsonBody(response, input);
    if (body.error || body.type === "error") throw gatewayFailure("Messages", body.error ?? body);
    const blocks = rows(body.content);
    if (!blocks.length || typeof body.stop_reason !== "string") throw new ChatProtocolError("Gateway returned incomplete Messages output");
    return messagesCompletion(input, blocks, body.stop_reason, object(body.usage) ?? {});
  }
  const blocks = new Map<number, Row>(), fragments = new Map<number, string>();
  let usage: Row = {}, stop: unknown, done = false;
  const ended = await readEvents(response, input, (row) => {
    const index = typeof row.index === "number" ? row.index : -1;
    if (row.type === "error") throw gatewayFailure("Messages", row.error ?? row);
    if (row.type === "message_start") usage = { ...object(object(row.message)?.usage) };
    if (row.type === "content_block_start") {
      const block = object(row.content_block);
      if (!block || index < 0 || index > 255 || blocks.has(index)) throw new ChatProtocolError("Invalid Messages content block");
      blocks.set(index, { ...block });
      if (block.type === "text" && typeof block.text === "string" && block.text) input.onDelta?.(block.text, "assistant_text");
      if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) input.onDelta?.(block.thinking, "reasoning_text");
    }
    if (row.type === "content_block_delta") {
      const block = blocks.get(index), delta = object(row.delta);
      if (!block || !delta) throw new ChatProtocolError("Messages delta has no content block");
      if (delta.type === "text_delta" && typeof delta.text === "string") { block.text = String(block.text ?? "") + delta.text; input.onDelta?.(delta.text, "assistant_text"); }
      else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") { block.thinking = String(block.thinking ?? "") + delta.thinking; input.onDelta?.(delta.thinking, "reasoning_text"); }
      else if (delta.type === "signature_delta" && typeof delta.signature === "string") block.signature = String(block.signature ?? "") + delta.signature;
      else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const text = (fragments.get(index) ?? "") + delta.partial_json;
        if (text.length > 256_000) throw new ChatProtocolError("Tool arguments exceeded the size limit");
        fragments.set(index, text);
      }
    }
    if (row.type === "message_delta") { usage = { ...usage, ...object(row.usage) }; stop = object(row.delta)?.stop_reason; }
    if (row.type === "message_stop") { done = true; return true; }
  });
  if (!done && !ended) throw interruptedStream();
  if (!done || typeof stop !== "string") throw new ChatProtocolError("Messages stream ended before completion");
  for (const [index, text] of fragments) blocks.get(index)!.input = argumentsOf(text);
  return messagesCompletion(input, [...blocks].sort(([a], [b]) => a - b).map(([, block]) => block), stop, usage);
}

async function readGemini(response: Response, input: CompletionTransportInput): Promise<Completion> {
  const result = blank(), parts: Row[] = [], calls = new ChatToolCalls();
  let finish: unknown, usage: Row = {}, observed = false, callIndex = 0;
  const consume = (body: Row) => {
    if (body.error) throw gatewayFailure("Gemini", body.error);
    if (object(body.promptFeedback)?.blockReason) throw new ChatProtocolError("Gemini blocked the model request");
    const candidate = rows(body.candidates).find((row) => row.index === undefined || row.index === 0);
    if (candidate) {
      observed = true;
      for (const part of rows(object(candidate.content)?.parts)) {
        parts.push(part);
        if (typeof part.text === "string") {
          if (part.thought === true) { result.reasoning += part.text; input.onDelta?.(part.text, "reasoning_text"); }
          else { result.text += part.text; input.onDelta?.(part.text, "assistant_text"); }
        }
        const call = object(part.functionCall);
        if (call) calls.add([{ index: callIndex++, id: typeof call.id === "string" && call.id ? call.id : `gemini_${randomUUID().replaceAll("-", "")}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } }], true);
      }
      if (candidate.finishReason) finish = candidate.finishReason;
    }
    if (object(body.usageMetadata)) usage = { ...usage, ...object(body.usageMetadata) };
  };
  const streaming = response.headers.get("content-type")?.includes("text/event-stream");
  const ended = streaming ? await readEvents(response, input, consume) : true;
  if (!streaming) consume(await jsonBody(response, input));
  if (!observed || typeof finish !== "string") {
    if (streaming && !ended) throw interruptedStream();
    throw new ChatProtocolError("Gemini response ended before completion");
  }
  if (finish !== "STOP" && finish !== "MAX_TOKENS") throw new ChatProtocolError(`Gemini stopped without a complete result (${finish.slice(0, 80)})`);
  result.finishReason = finish === "MAX_TOKENS" ? "length" : "stop";
  result.toolCalls = calls.finish(result.finishReason, false);
  if (result.toolCalls.length && result.finishReason === "stop") result.finishReason = "tool_calls";
  result.nativeOutput = { protocol: "gemini", content: parts } satisfies NativeOutput;
  const generated = number(usage.candidatesTokenCount);
  recordUsage(input, result, { ...usage, ...(generated !== undefined ? { candidatesTokenCount: generated + (number(usage.thoughtsTokenCount) ?? 0) } : {}) }, { input: "promptTokenCount", output: "candidatesTokenCount", cached: number(usage.cachedContentTokenCount) });
  return result;
}

async function readChat(response: Response, input: CompletionTransportInput): Promise<Completion> {
  const result = blank(), calls = new ChatToolCalls(), details = new ChatReasoningDetails();
  let usage: Row = {}, observed = false;
  const consume = (body: Row, streaming: boolean) => {
    if (body.error) throw gatewayFailure("Chat", body.error);
    const choice = rows(body.choices).find((row) => row.index === undefined || row.index === 0);
    const message = object(streaming ? choice?.delta : choice?.message);
    if (message) {
      observed = true;
      calls.addLegacy(message.function_call);
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.map((raw) => {
        const call = object(raw);
        if (!call || call.type === undefined || (streaming && call.type === null) || call.type === "function") return raw;
        if (!streaming && !object(call.function)) throw new ChatProtocolError(`DoneBot gateway returned unsupported tool-call type ${toolTypeLabel(call.type)}`);
        return { ...call, type: "function" };
      }) : message.tool_calls;
      calls.add(toolCalls, streaming); details.add(message.reasoning_details);
      if (typeof message.content === "string") { result.text += message.content; if (streaming) input.onDelta?.(message.content, "assistant_text"); }
      const reasoning = message.reasoning_content ?? message.reasoning;
      if (typeof reasoning === "string") { result.reasoning += reasoning; if (streaming) input.onDelta?.(reasoning, "reasoning_text"); }
    }
    if (choice?.finish_reason) result.finishReason = String(choice.finish_reason);
    if (object(body.usage)) usage = { ...usage, ...object(body.usage) };
  };
  const streaming = response.headers.get("content-type")?.includes("text/event-stream");
  const ended = streaming ? await readEvents(response, input, (body) => consume(body, true)) : true;
  if (!streaming) consume(await jsonBody(response, input), false);
  if (!observed || !result.finishReason) {
    if (streaming && !ended) throw interruptedStream();
    throw new ChatProtocolError("Chat response ended before completion");
  }
  result.toolCalls = calls.finish(result.finishReason, false);
  result.protocolReasoning = result.reasoning;
  result.protocolReasoningDetails = details.blocks;
  recordUsage(input, result, usage, { input: "prompt_tokens", output: "completion_tokens", cached: number(object(usage.prompt_tokens_details)?.cached_tokens) });
  return result;
}

export function createDoneBotCompletion(request: DoneBotLlmRequest, protocolOf: (model: string) => DoneBotLlmProtocol) {
  return async (input: CompletionTransportInput): Promise<Completion> => {
    input.signal.throwIfAborted();
    const protocol = protocolOf(input.model);
    let path: string, body: Row;
    if (protocol === "messages") { path = "/v1/messages"; body = messagesRequest(input); }
    else if (protocol === "gemini") { path = `/v1beta/models/${encodeURIComponent(input.model)}:${input.stream ? "streamGenerateContent?alt=sse" : "generateContent"}`; body = geminiRequest(input); }
    else if (protocol === "responses") { path = "/v1/responses"; body = { ...responsesRequest({ ...input, summaries: false, replay: (message) => replay(input, message, "responses") as ResponseItem[] | undefined }), include: ["reasoning.encrypted_content"] }; }
    else if (protocol === "chat") { path = "/v1/chat/completions"; body = { model: input.model, messages: input.messages, stream: input.stream, ...(input.stream ? { stream_options: { include_usage: true } } : {}), ...(input.tools.length ? { tools: input.tools } : {}) }; }
    else throw new ChatProtocolError("The selected model has no registered native LLM protocol");
    const response = await request(path, { method: "POST", headers: { "content-type": "application/json", ...(protocol === "messages" ? { "anthropic-version": "2023-06-01" } : {}) }, body: JSON.stringify(body), signal: input.signal, redirect: "error" });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`DoneBot gateway model request failed (HTTP ${response.status})`); }
    let result: Completion;
    if (protocol === "messages") result = await readMessages(response, input);
    else if (protocol === "gemini") result = await readGemini(response, input);
    else if (protocol === "chat") result = await readChat(response, input);
    else {
      result = await readResponsesStream(monitorResponsesStream(response.body, input.signal), { reasoning: true, onBytes: input.onBytes, onDelta: (text, kind) => input.onDelta?.(text, kind), fail: responsesFailure });
      result.nativeOutput = { protocol, content: result.responseOutput ?? [] } satisfies NativeOutput;
      if (result.usage) input.onUsage?.({ model: input.model, input: result.usage.input, output: result.usage.output });
    }
    input.signal.throwIfAborted();
    return result;
  };
}
