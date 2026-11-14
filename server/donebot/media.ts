import { createHash, randomUUID } from "node:crypto";
import { doneBotMediaConcurrency } from "../../shared/donebot.ts";
import { publicArtifactResponse, safeMediaArtifact, saveMediaArtifact } from "./media-download.ts";
import { MediaAssetCache, MediaReferenceChanged, type MediaReferenceFile, type MediaReferencePolicy } from "./media-assets.ts";
import { MediaJobStore, mediaScopeKey, type MediaJob, type MediaKind, type MediaScope } from "./media-store.ts";
import { gatewayMediaDiagnostic, gatewayMediaError, mediaDiagnosticText, mediaFailureDetail } from "./media-errors.ts";
import { MEDIA_ADAPTERS as ADAPTERS } from "./media-adapters.ts";
import { mediaLayer } from "./media-layers.ts";

export type { MediaArtifact, MediaJob, MediaKind, MediaScope } from "./media-store.ts";
export type MediaCapabilityKind = MediaKind | "llm" | "tts";

export interface MediaContext {
  botId: string;
  threadId: string;
  turnId: string;
  active: () => boolean;
}

export interface MediaResolvedModel {
  id: string;
  kind: MediaKind;
  adapter: string;
  capabilities?: unknown;
  fixedParameters?: Record<string, unknown>;
  normalizeParameters?: (parameters: Record<string, unknown>, operation: "generate" | "edit" | "extend") => Record<string, unknown>;
  referencePolicy?: MediaReferencePolicy;
  validate?: (parameters: Record<string, unknown>, operation: "generate" | "edit" | "extend") => void;
}

export interface MediaSubmission {
  kind: MediaKind;
  model: string;
  parameters: Record<string, unknown>;
  operation?: "generate" | "edit" | "extend";
  /** Same operation in this turn is deduplicated; a requested variation needs a different value. */
  variationKey?: string;
}

export interface DoneBotMediaDeps {
  dbPath: string;
  artifactDir: string;
  scope: () => MediaScope | null | Promise<MediaScope | null>;
  concurrency: (expectedScope: MediaScope) => Promise<number>;
  activeModelCount?: (accountId: string) => number;
  /** The transport must bind the credential snapshot to expectedScope before sending. */
  fetchGateway: (path: string, init: RequestInit, expectedScope: MediaScope) => Promise<Response>;
  receipt?: (id: string, expectedScope: MediaScope, signal: AbortSignal) => Promise<unknown>;
  resolveModel: (id: string, kind: MediaKind) => Promise<MediaResolvedModel>;
  conversationExists?: (botId: string, threadId: string) => boolean;
  capabilities: (query: { model?: string; kind?: MediaCapabilityKind }) => Promise<unknown>;
  authorize: (context: MediaContext, input: MediaSubmission) => Promise<void>;
  /** Receipts and pending-result notices must be durable and idempotent by job.id and phase. */
  publish: (job: MediaJob) => Promise<void>;
  fetchArtifact?: (url: string, signal: AbortSignal) => Promise<Response>;
  now?: () => number;
  pollMs?: number;
  maxArtifactBytes?: number;
  resolveReference?: (context: MediaContext, path: string, maxBytes: number) => Promise<MediaReferenceFile>;
  maxReferenceBytes?: number;
}

const object = (input: unknown): Record<string, unknown> | undefined =>
  input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const jobError = (status: number, message: string) => Object.assign(new Error(message), { status });

function canonical(value: unknown, depth = 0): string {
  if (depth > 24) throw jobError(400, "Media parameters are too deeply nested.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(part => canonical(part, depth + 1)).join(",")}]`;
  const record = object(value);
  if (record) return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key], depth + 1)}`).join(",")}}`;
  throw jobError(400, "Media parameters must contain JSON values.");
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > 2 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("Media gateway response exceeded the local limit.");
    }
    chunks.push(part.value);
  }
  try { return object(JSON.parse(Buffer.concat(chunks).toString("utf8"))) ?? {}; }
  catch { throw new Error("Media gateway returned invalid JSON."); }
}

function taskId(body: Record<string, unknown>, adapter: string): string | undefined {
  return ADAPTERS[adapter]?.taskId(body);
}

function taskState(body: Record<string, unknown>): string {
  const state = object(body.data)?.status ?? body.status;
  return typeof state === "string" ? state.toLowerCase() : "";
}

function results(body: Record<string, unknown>, adapter: string): unknown[] {
  return ADAPTERS[adapter]?.results(body) ?? [];
}

function outputUrl(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const row = object(value);
  for (const key of ["url", "audio_url", "image_url"]) if (typeof row?.[key] === "string") return row[key] as string;
  return undefined;
}

function inlineImageMime(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "image/gif";
  throw new Error("Gateway returned unsupported inline image bytes.");
}

export class DoneBotMediaService {
  private readonly deps: DoneBotMediaDeps;
  private readonly store: MediaJobStore;
  private readonly assets: MediaAssetCache;
  private readonly active = new Map<string, Promise<void>>();
  private dispatchFlight: Promise<void> | undefined;
  private tickFlight: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerAt = 0;
  private closed = false;

  constructor(deps: DoneBotMediaDeps) {
    this.deps = deps;
    this.store = new MediaJobStore(deps.dbPath);
    this.assets = new MediaAssetCache(deps);
    for (const job of this.store.pending()) {
      if (job.status === "submitting") this.save(job, { status: "uncertain", error: "Submission was interrupted. Check the receipt before creating another generation." });
    }
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  activeCount(accountId: string): number { return this.store.activeCount(accountId); }

  deliveryJob(id: string): MediaJob | undefined { return this.store.get(id); }

  private save(job: MediaJob, patch: Partial<MediaJob>): MediaJob {
    const next = { ...(this.store.get(job.id) ?? job), ...patch, updatedAt: this.now() };
    this.store.put(next);
    return next;
  }

  private async sameScope(scope: MediaScope): Promise<boolean> {
    const current = await this.deps.scope();
    return current !== null && mediaScopeKey(current) === mediaScopeKey(scope);
  }

  private cancelRemovedConversation(job: MediaJob): boolean {
    if (!this.deps.conversationExists || this.deps.conversationExists(job.botId, job.threadId)) return false;
    this.save(job, { status: "cancelled", waitingStopped: true, parameters: undefined, error: "The conversation was removed before submission. No generation was sent or charged." });
    return true;
  }

  private async scopedJob(context: Pick<MediaContext, "botId" | "threadId">, id: string): Promise<MediaJob> {
    const job = this.store.get(id);
    if (!job || job.botId !== context.botId || job.threadId !== context.threadId || !await this.sameScope(job.scope)) throw jobError(404, "No media job is available in this conversation.");
    return job;
  }

  async submit(context: MediaContext, input: MediaSubmission): Promise<MediaJob> {
    return this.submitPlanned(context, input);
  }

  private async submitPlanned(context: MediaContext, input: MediaSubmission): Promise<MediaJob> {
    if (this.closed || !context.active()) throw jobError(409, "This turn is no longer active.");
    const scope = await this.deps.scope();
    if (!scope) throw jobError(401, "Sign in to DoneBot to generate media.");
    if (input.variationKey && !/^[A-Za-z0-9_-]{1,80}$/.test(input.variationKey)) throw jobError(400, "variation_key must be 1–80 letters, digits, underscores or hyphens.");
    if (input.parameters.model !== undefined && input.parameters.model !== input.model) throw jobError(400, "A media operation does not match its requested model.");
    const requestedTaskType = input.parameters.omni_reference_task_type;
    const operation = input.operation ?? (requestedTaskType === "edit" || requestedTaskType === "extend" ? requestedTaskType : "generate");
    const model = await this.deps.resolveModel(input.model, input.kind);
    const adapter = ADAPTERS[model.adapter];
    if (model.id !== input.model || model.kind !== input.kind || !adapter || adapter.kind !== input.kind) throw jobError(400, "This media model has no supported local adapter.");
    if (operation === "edit" && input.kind === "image" && !adapter.edit) throw jobError(400, "This model adapter does not support image editing.");
    if (operation === "edit" && input.kind !== "image" && input.kind !== "video") throw jobError(400, "This media model does not support editing.");
    if (operation === "extend" && input.kind !== "video") throw jobError(400, "Only video tasks can be extended.");
    if (input.kind === "music" && operation !== "generate") throw jobError(400, "Standalone audio supports generation only.");
    for (const [key, value] of Object.entries(model.fixedParameters ?? {})) {
      if (input.parameters[key] !== undefined && input.parameters[key] !== value) throw jobError(400, `${key} is fixed by DoneBot and cannot be overridden.`);
    }
    const parameters = { ...input.parameters, ...model.fixedParameters };
    const normalized = model.normalizeParameters?.(parameters, operation) ?? parameters;
    if (Buffer.byteLength(canonical(normalized)) > 1_000_000) throw jobError(413, "Media parameters exceed the local limit.");
    const authorizedInput: MediaSubmission = { kind: input.kind, model: input.model, operation, parameters: normalized, variationKey: input.variationKey };
    await this.deps.authorize(context, authorizedInput);
    if (!context.active() || !await this.sameScope(scope)) throw jobError(409, "This turn or DoneBot account changed before submission.");
    const prepared = await this.assets.prepare(context, scope, normalized, undefined, model.referencePolicy);
    model.validate?.(prepared.parameters, operation);
    if (!context.active() || !await this.sameScope(scope)) throw jobError(409, "This turn or DoneBot account changed before submission.");
    const fingerprint = digest(canonical({ kind: input.kind, model: input.model, operation, parameters: prepared.fingerprint }));
    const operationKey = digest(JSON.stringify([context.botId, context.threadId, context.turnId, fingerprint, input.variationKey ?? ""]));
    const duplicate = this.store.operation(scope, operationKey);
    if (duplicate) return duplicate;
    const now = this.now();
    const job: MediaJob = { version: 1, id: randomUUID(), operationKey, fingerprint, scope, botId: context.botId, threadId: context.threadId,
      turnId: context.turnId, kind: input.kind, model: input.model, adapter: model.adapter, operation, status: "queued",
      parameters: structuredClone(normalized), referenceFingerprint: prepared.fingerprint, artifacts: [],
      waitingStopped: false, createdAt: now, updatedAt: now, nextPollAt: now, attempts: 0 };
    this.store.put(job);
    void this.dispatchQueued().catch(() => {});
    this.schedule();
    return this.store.get(job.id) ?? job;
  }

  private dispatchQueued(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.dispatchFlight) return this.dispatchFlight;
    const run = this.dispatchNext();
    this.dispatchFlight = run;
    void run.finally(() => { if (this.dispatchFlight === run) this.dispatchFlight = undefined; this.schedule(); }).catch(() => {});
    return run;
  }

  private async dispatchNext(): Promise<void> {
    const scope = await this.deps.scope();
    if (!scope || this.closed) return;
    const job = this.store.queued(scope)[0];
    if (!job || job.nextPollAt > this.now()) return;
    try {
      if (this.cancelRemovedConversation(job)) return;
      const total = await this.deps.concurrency(scope);
      const limit = doneBotMediaConcurrency(total);
      if (limit === null) throw new Error("The account concurrency limit could not be verified. Dispatch will resume once it is verified.");
      const previous = this.store.dispatchAt(scope);
      const mediaActive = this.store.activeCount(scope.accountId);
      if (mediaActive >= limit || mediaActive + (this.deps.activeModelCount?.(scope.accountId) ?? 0) >= total || previous !== undefined && this.now() - previous < 1000) return;
      if (!job.parameters) { this.save(job, { status: "failed", error: "Queued media parameters are unavailable; no generation was submitted." }); return; }
      const modelId = job.model, adapterId = job.adapter;
      if (!modelId || !adapterId) { this.save(job, { status: "failed", error: "The queued media model is unavailable; no generation was submitted." }); return; }
      const model = await this.deps.resolveModel(modelId, job.kind);
      if (model.adapter !== adapterId) throw new Error("The media model adapter changed while queued.");
      const context: MediaContext = { botId: job.botId, threadId: job.threadId, turnId: job.turnId, active: () => !this.closed && this.store.get(job.id)?.status === "queued" };
      const prepared = await this.assets.prepare(context, scope, job.parameters, job.referenceFingerprint, model.referencePolicy);
      if (!context.active()) return;
      model.validate?.(prepared.parameters, job.operation);
      if (digest(canonical({ kind: job.kind, model: modelId, operation: job.operation, parameters: prepared.fingerprint })) !== job.fingerprint) {
        this.save(job, { status: "failed", parameters: undefined, error: "A queued reference changed after authorization; no generation was submitted." }); return;
      }
      if (this.closed || !await this.sameScope(scope) || this.closed) return;
      if (this.cancelRemovedConversation(job)) return;
      const claimed = this.store.claim(job, limit, total, this.deps.activeModelCount?.(scope.accountId) ?? 0, this.now());
      if (!claimed) return;
      const adapter = ADAPTERS[adapterId]!;
      const path = job.kind === "image" && job.operation === "edit" ? adapter.edit! : adapter.submit;
      const run = this.submitRequest(claimed, { ...prepared.parameters, model: modelId }, path);
      this.active.set(job.id, run);
      void run.finally(() => { this.active.delete(job.id); this.schedule(); }).catch(() => {});
    } catch (error) {
      if (!this.closed && await this.sameScope(scope) && this.store.get(job.id)?.status === "queued") {
        this.save(job, { ...(error instanceof MediaReferenceChanged ? { status: "failed", parameters: undefined } : {}), error: error instanceof Error ? error.message : "Media remains queued until its account limit can be verified." });
      }
    }
  }

  private async submitRequest(job: MediaJob, parameters: Record<string, unknown>, path: string): Promise<void> {
    try {
      const adapterId = job.adapter;
      if (!adapterId) throw new Error("The queued media adapter is unavailable.");
      const response = await this.deps.fetchGateway(path, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": job.operationKey },
        body: JSON.stringify(parameters), signal: AbortSignal.timeout(120_000) }, job.scope);
      job = this.save(job, { receiptId: response.headers.get("X-DoneBot-Receipt-ID") ?? undefined });
      const body = await responseJson(response);
      if (!response.ok) {
        const diagnostic = gatewayMediaDiagnostic(body, response.status, response.headers);
        if (response.status === 429 && (!job.receiptId || diagnostic?.code === "DONEBOT_MEDIA_CONCURRENCY")) {
          const retry = response.headers.get("retry-after"), seconds = Number(retry);
          const backoff = Math.min(30_000, 1000 * 2 ** Math.min(job.attempts, 5));
          const requestedDelay = retry && !Number.isNaN(seconds) ? seconds * 1000 : retry ? Date.parse(retry) - this.now() : backoff;
          const delay = Number.isFinite(requestedDelay) ? Math.max(backoff, Math.min(300_000, requestedDelay)) : backoff;
          this.save(job, { status: "queued", diagnostic, nextPollAt: this.now() + delay, attempts: job.attempts + 1, error: "The account has no slot available yet. This unaccepted operation remains queued and will retry automatically." });
          return;
        }
        const status = response.status >= 500 || [408, 409, 429, 499].includes(response.status) ? "uncertain" : "failed";
        job = this.save(job, { status, nextPollAt: this.now(),
          diagnostic, error: `${gatewayMediaError(body, response.status)} Check its receipt before submitting again.` });
        if (job.status === "failed") await this.publish(job);
        else await this.publishPendingNotice(job);
        return;
      }
      if (!await this.sameScope(job.scope)) {
        const id = taskId(body, adapterId);
        this.save(job, { taskId: id, status: id ? "submitted" : "uncertain" });
        return;
      }
      if (ADAPTERS[adapterId]?.poll) {
        const id = taskId(body, adapterId);
        if (!id) {
          job = this.save(job, { status: "uncertain", error: "The gateway returned success without a task ID. Submission confirmation is pending. Do not resubmit." });
          await this.publishPendingNotice(job);
          return;
        }
        this.save(job, { status: "submitted", taskId: id, nextPollAt: this.now() });
      } else await this.complete(job, body);
    } catch (error) {
      if (!this.closed) {
        const current = this.store.get(job.id) ?? job;
        if (["downloading", "completed", "failed"].includes(current.status)) await this.retryResult(current, error);
        else {
          const uncertain = this.save(current, { status: "uncertain", error: `The submission result is unknown. ${mediaFailureDetail(error)} Check its receipt; do not automatically generate again.` });
          await this.publishPendingNotice(uncertain);
        }
      }
    }
  }

  async status(context: Pick<MediaContext, "botId" | "threadId">, id: string): Promise<MediaJob> {
    return this.scopedJob(context, id);
  }

  async stopWaiting(context: Pick<MediaContext, "botId" | "threadId">, id: string): Promise<MediaJob> {
    const checked = await this.scopedJob(context, id);
    const job = this.store.get(checked.id) ?? checked;
    if (job.status === "queued") return this.save(job, { status: "cancelled", waitingStopped: true, parameters: undefined, error: "Further local dispatch is cancelled. Automatic follow-up is stopped." });
    return this.save(job, { waitingStopped: true });
  }

  async capabilities(query: { model?: string; kind?: MediaCapabilityKind }): Promise<unknown> {
    if (!await this.deps.scope()) throw jobError(401, "Sign in to DoneBot to view available models.");
    return this.deps.capabilities(query);
  }

  private schedule(): void {
    if (this.closed) return;
    const delay = this.store.pending().some(job => job.status === "queued") ? Math.min(1000, this.deps.pollMs ?? 3000) : this.deps.pollMs ?? 3000;
    const at = this.now() + delay;
    if (this.timer && this.timerAt <= at) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick().finally(() => this.schedule()).catch(() => {});
    }, delay);
    this.timer.unref();
  }

  start(): void { this.schedule(); }

  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.tickFlight) return this.tickFlight;
    const flight = this.pollPending();
    this.tickFlight = flight;
    void flight.finally(() => { if (this.tickFlight === flight) this.tickFlight = undefined; }).catch(() => {});
    return flight;
  }

  private async pollPending(): Promise<void> {
    const work: Promise<void>[] = [];
    for (const job of this.store.pending()) {
      if (this.active.has(job.id) || job.status === "queued" || job.status === "submitting" || job.nextPollAt > this.now() || !await this.sameScope(job.scope)) continue;
      if (this.closed) break;
      const run = this.poll(job);
      this.active.set(job.id, run);
      work.push(run.finally(() => this.active.delete(job.id)));
    }
    await Promise.allSettled(work);
    await this.dispatchQueued();
  }

  private async readReceipt(job: MediaJob): Promise<Record<string, unknown> | undefined> {
    if (!job.receiptId || !this.deps.receipt) return undefined;
    const receipt = object(await this.deps.receipt(job.receiptId, job.scope, AbortSignal.timeout(30_000)));
    if (!await this.sameScope(job.scope)) return undefined;
    if (receipt?.receipt_id !== job.receiptId) throw new Error("Media receipt identity changed.");
    return receipt;
  }

  private async poll(job: MediaJob): Promise<void> {
    try {
      if (job.status === "completed" || job.status === "failed") { await this.publish(job); return; }
      if (job.status === "uncertain") await this.publishPendingNotice(job);
      if (!job.taskId && job.receiptId && this.deps.receipt) {
        const receipt = await this.readReceipt(job);
        if (!receipt) return;
        const diagnostic = gatewayMediaDiagnostic(receipt);
        if (diagnostic) job = this.save(job, { diagnostic });
        if (["failed", "cancelled", "canceled", "refunded"].includes(String(receipt.status))) {
          job = this.save(job, { status: "failed", nextPollAt: this.now(), error: `The gateway confirmed this media task ended without a deliverable result.${diagnostic ? ` ${mediaDiagnosticText(diagnostic)}` : job.error ? ` ${job.error}` : ""}` });
          await this.publish(job); return;
        }
        const id = receipt.task_id;
        if (typeof id === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(id)) job = this.save(job, { taskId: id, status: "submitted", error: undefined });
        else { this.save(job, { nextPollAt: this.now() + 30_000, ...(diagnostic ? { error: `Submission confirmation is pending. ${mediaDiagnosticText(diagnostic)} Do not resubmit automatically.` } : {}) }); return; }
      }
      const adapterId = job.adapter;
      const adapter = adapterId ? ADAPTERS[adapterId] : undefined;
      if (!adapter?.poll || !job.taskId) {
        job = this.save(job, { status: "uncertain", nextPollAt: this.now() + 30_000, error: job.error ?? "This media operation has no recoverable task ID." });
        await this.publishPendingNotice(job);
        return;
      }
      const response = await this.deps.fetchGateway(adapter.poll(job.taskId), { method: "GET", signal: AbortSignal.timeout(60_000) }, job.scope);
      if (!response.ok) {
        const body = await responseJson(response).catch(() => ({}));
        const diagnostic = gatewayMediaDiagnostic(body, response.status, response.headers);
        this.save(job, { nextPollAt: this.now() + Math.min(60_000, 3000 * 2 ** Math.min(job.attempts, 4)), attempts: job.attempts + 1,
          diagnostic: diagnostic ?? job.diagnostic,
          error: `Could not refresh the media task (HTTP ${response.status}). ${mediaDiagnosticText(diagnostic)} Retrying without another generation.` });
        return;
      }
      const body = await responseJson(response);
      if (!await this.sameScope(job.scope)) return;
      const generation = body.generation_status ?? object(body.data)?.generation_status;
      if ((generation === "completed" || generation === "failed") && job.generationEndedAt === undefined) {
        job = this.save(job, { generationEndedAt: this.now() });
      }
      const state = taskState(body);
      if (["completed", "success", "succeeded"].includes(state)) await this.complete(job, body);
      else if (["failed", "cancelled", "canceled", "expired"].includes(state)) {
        const diagnostic = gatewayMediaDiagnostic(body, response.status, response.headers);
        job = this.save(job, { status: "failed", nextPollAt: this.now(), diagnostic: diagnostic ?? job.diagnostic,
          error: `Media task ended with ${state}.${diagnostic ? ` ${mediaDiagnosticText(diagnostic)}` : ""}` });
        await this.publish(job);
      }
      else if (state === "uncertain") {
        const diagnostic = gatewayMediaDiagnostic(body, response.status, response.headers);
        job = this.save(job, { status: "uncertain", nextPollAt: this.now() + 30_000, diagnostic: diagnostic ?? job.diagnostic,
          error: `The gateway cannot establish whether the provider completed this task. Do not resubmit automatically.${diagnostic ? ` ${mediaDiagnosticText(diagnostic)}` : ""}` });
        await this.publishPendingNotice(job);
      }
      else this.save(job, { status: "running", nextPollAt: this.now() + (this.deps.pollMs ??
        (job.model === "seedream-5-5" && this.now() - job.createdAt >= 30_000 ? 7500 : 3000)), attempts: 0, error: undefined, diagnostic: undefined });
    } catch (error) {
      if (!this.closed) await this.retryResult(this.store.get(job.id) ?? job, error);
    }
  }

  private async publishPendingNotice(job: MediaJob): Promise<void> {
    const field = job.status === "uncertain" ? "uncertainNotifiedAt" : "retrievalNotifiedAt";
    if (job.status !== "uncertain" && (job.status !== "downloading" || job.attempts < 3)) return;
    const current = this.store.get(job.id) ?? job;
    if (current.status !== job.status || current[field] || current.waitingStopped || !await this.sameScope(current.scope)) return;
    if (this.deps.conversationExists && !this.deps.conversationExists(current.botId, current.threadId)) return;
    try {
      await this.deps.publish(current);
      this.save(current, { [field]: this.now() });
    } catch {}
  }

  private async retryResult(job: MediaJob, error?: unknown): Promise<void> {
    const message = job.status === "completed" || job.status === "failed"
      ? "The media task ended, but its conversation receipt could not be delivered. Delivery will retry."
      : job.status === "downloading"
        ? "The gateway completed this task, but its artifacts could not be retrieved. Retrieval will retry; do not generate again."
        : "Could not refresh the gateway task status. Retrying without another generation.";
    const next = this.save(job, { nextPollAt: this.now() + 30_000, attempts: job.attempts + 1,
      error: job.status === "failed" || job.status === "uncertain" ? job.error : `${message}${error ? ` ${mediaFailureDetail(error)}` : ""}` });
    await this.publishPendingNotice(next);
  }

  private async complete(job: MediaJob, body: Record<string, unknown>): Promise<void> {
    const current = this.store.get(job.id) ?? job;
    job = this.save(current, { status: "downloading" });
    const artifacts = [...job.artifacts];
    const adapter = job.adapter;
    if (!adapter) throw new Error("The completed media task has no adapter.");
    const outputs = job.kind === "video" ? [null] : results(body, adapter);
    const maxOutputs = job.model === "seedream-5-5" && job.parameters?.layer_decomposition === true ? 100 : 32;
    if (!outputs.length || outputs.length > maxOutputs) throw new Error("Media task returned no usable artifacts.");
    for (let index = artifacts.length; index < outputs.length; index++) {
      if (!await this.sameScope(job.scope)) return;
      let response: Response;
      if (job.kind === "video" && job.taskId) {
        response = await this.deps.fetchGateway(`/v1/videos/${job.taskId}/content`, { method: "GET", signal: AbortSignal.timeout(120_000) }, job.scope);
      } else {
        const output = object(outputs[index]);
        if (typeof output?.b64_json === "string") {
          if (output.b64_json.length > 24 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(output.b64_json)) throw new Error("Invalid image bytes.");
          const bytes = Buffer.from(output.b64_json, "base64");
          response = new Response(bytes, { headers: { "content-type": inlineImageMime(bytes), "content-length": String(bytes.length) } });
        } else {
          const url = outputUrl(outputs[index]);
          if (!url) throw new Error("Media task returned no downloadable artifact.");
          response = await (this.deps.fetchArtifact ?? publicArtifactResponse)(url, AbortSignal.timeout(120_000));
        }
      }
      const artifact = await saveMediaArtifact({ directory: this.deps.artifactDir, jobId: job.id, index, kind: job.kind, response, maxBytes: this.deps.maxArtifactBytes ?? 256 * 1024 * 1024 });
      const layer = job.kind === "image" ? mediaLayer(object(outputs[index])?.layer) : undefined;
      artifacts.push({ ...artifact, ...(layer ? { layer } : {}) });
      job = this.save(this.store.get(job.id) ?? job, { artifacts });
    }
    job = this.save(this.store.get(job.id) ?? job, { status: "completed", nextPollAt: this.now(), error: undefined, diagnostic: undefined, attempts: 0 });
    await this.publish(job);
  }

  private async publish(job: MediaJob): Promise<void> {
    const current = this.store.get(job.id) ?? job;
    if (current.waitingStopped || current.deliveredAt || !await this.sameScope(current.scope)) return;
    if (this.deps.conversationExists && !this.deps.conversationExists(current.botId, current.threadId)) {
      this.save(current, { waitingStopped: true });
      return;
    }
    if ((await Promise.all(current.artifacts.map(artifact => safeMediaArtifact(artifact.path, this.deps.artifactDir)))).some(safe => !safe)) throw new Error("Media artifact escaped its private directory.");
    const ready = this.store.get(job.id) ?? current;
    if (ready.waitingStopped) return;
    await this.deps.publish(ready);
    this.save(this.store.get(job.id) ?? current, { publishedAt: this.now(), deliveredAt: this.now(),
      ...(current.status === "completed" ? { error: undefined } : {}) });
  }

  async artifact(jobId: string, name: string): Promise<{ job: MediaJob; artifact: MediaJob["artifacts"][number] } | null> {
    const job = this.store.get(jobId);
    const artifact = job?.artifacts.find(file => file.path === name || file.path.split(/[\\/]/).at(-1) === name);
    if (!job || !artifact || !await this.sameScope(job.scope) || !await safeMediaArtifact(artifact.path, this.deps.artifactDir)) return null;
    return { job, artifact };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await Promise.allSettled([this.tickFlight, this.dispatchFlight]);
    await Promise.allSettled(this.active.values());
    this.assets.close();
    this.store.close();
  }
}
