import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";
import type { DoneBotCatalog } from "../../shared/donebot.ts";
import { DONEBOT_TEAMS_PROTOCOL } from "../../shared/donebot-teams.ts";
import { audienceMember } from "../audience.ts";
import { boundedResponseText } from "./bounded-response.ts";
import { DONEBOT_ORIGIN, parseDoneBotCatalog } from "./gateway.ts";
import { privateJson, TeamRequestStore, type TeamModelRequestContext } from "./team-requests.ts";
import type { DoneBotTeamRuntime } from "./team-runtime.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const operationNamespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
function operationKey(slot: string): string {
  const bytes = createHash("sha1").update(operationNamespace).update(`donebot.team.model.v1:${slot}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const canonicalToken = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`))
  .refine(value => Buffer.from(value.slice(prefix.length), "base64url").toString("base64url") === value.slice(prefix.length));
const coordinatorSchema = z.object({ protocol: z.literal(DONEBOT_TEAMS_PROTOCOL), instance_id: z.uuid(), team_id: z.uuid(),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), credential: canonicalToken("dbtc_") }).strict();
const state = z.enum(["prepared", "accepted", "uncertain", "completed", "failed", "cancelled"]);
const grantSchema = z.object({ id: z.uuid(), state, token: canonicalToken("dbte_"), expires_at: z.iso.datetime({ offset: true }) });
const journalSchema = z.object({ key: z.uuid(), bindingId: z.string().regex(/^[a-f0-9]{64}$/), ordinal: z.number().int().nonnegative(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/), executionId: z.uuid().optional() }).strict();
const statusSchema = z.object({ id: z.uuid(), state, receipt_id: z.uuid(), billing_state: z.enum(["pending", "recorded"]), currency: z.literal("CNY"),
  actual_amount: z.string().regex(/^\d+(?:\.\d+)?$/).nullable() }).strict();
export type TeamModelExecutionStatus = z.infer<typeof statusSchema>;

export class TeamModelRequestHeld extends Error {
  readonly executionId: string;
  readonly executionState: string;
  constructor(executionId: string, executionState: string) {
    super(`团队模型请求 ${executionId} 已记录（${executionState}）。请查询原请求，不能重新提交可能已计费的调用。`);
    this.executionId = executionId;
    this.executionState = executionState;
  }
}

function invalid(): never { throw new Error("Team model authorization could not be verified"); }
async function responseJson(response: Response, limit = 2 * 1024 * 1024): Promise<unknown> {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Team gateway refused the operation (${response.status})`); }
  const value = JSON.parse(await boundedResponseText(response, limit)) as { code?: number; data?: unknown };
  if (value.code !== undefined && value.code !== 0) invalid();
  return value.code === 0 ? value.data : value;
}
function modelPath(path: string): boolean {
  return ["/v1/messages", "/v1/responses", "/v1/chat/completions"].includes(path) ||
    /^\/v1beta\/models\/[A-Za-z0-9._-]+:(?:generateContent|streamGenerateContent(?:\?alt=sse)?)$/.test(path);
}

export class DoneBotTeamModelGateway {
  readonly requests: TeamRequestStore;
  private readonly folder: string;
  private readonly active = new Set<string>();
  private currentCatalog: DoneBotCatalog | null = null;
  private readonly origin: string;
  private readonly runtime: DoneBotTeamRuntime;
  private readonly options: {
    coordinatorFile: string; executionEnabled: boolean; fixtureOrigin?: string;
  };
  constructor(dataDir: string, runtime: DoneBotTeamRuntime, options: DoneBotTeamModelGateway["options"]) {
    this.runtime = runtime;
    this.options = options;
    if (options.coordinatorFile !== "/run/donebot/team-coordinator.json" && !options.fixtureOrigin) invalid();
    if (options.fixtureOrigin) {
      const origin = new URL(options.fixtureOrigin);
      if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) invalid();
    }
    this.origin = options.fixtureOrigin ?? DONEBOT_ORIGIN;
    this.requests = new TeamRequestStore(dataDir, runtime);
    this.folder = join(dataDir, "donebot-team-execution", "dispatches");
    mkdirSync(this.folder, { recursive: true, mode: 0o700 });
  }
  coordinator() {
    const parsed = coordinatorSchema.safeParse(privateJson(this.options.coordinatorFile));
    if (!parsed.success || parsed.data.team_id !== this.runtime.team.id || parsed.data.instance_id !== this.runtime.instanceId) invalid();
    return parsed.data;
  }
  models(): DoneBotCatalog | null { return this.currentCatalog; }
  authenticated(): boolean { return this.options.executionEnabled && this.currentCatalog !== null; }
  async refreshCatalog(): Promise<DoneBotCatalog> {
    const coordinator = this.coordinator();
    try {
      const response = await fetch(`${this.origin}/api/v1/donebot/cloud/coordinators/${coordinator.instance_id}/models`, {
        headers: { authorization: `Bearer ${coordinator.credential}` }, signal: AbortSignal.timeout(30_000), redirect: "error", credentials: "omit",
      });
      const catalog = parseDoneBotCatalog(await responseJson(response));
      if (this.coordinator().generation !== coordinator.generation) invalid();
      this.currentCatalog = catalog;
      return catalog;
    } catch (error) { this.currentCatalog = null; throw error; }
  }
  async status(executionId: string, signal?: AbortSignal): Promise<TeamModelExecutionStatus> {
    if (!z.uuid().safeParse(executionId).success) invalid();
    const coordinator = this.coordinator();
    const response = await fetch(`${this.origin}/api/v1/donebot/cloud/coordinators/${coordinator.instance_id}/executions/${executionId}`, {
      headers: { authorization: `Bearer ${coordinator.credential}` }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), redirect: "error", credentials: "omit",
    });
    const parsed = statusSchema.safeParse(await responseJson(response, 8192));
    if (!parsed.success || parsed.data.id !== executionId || parsed.data.receipt_id !== executionId) invalid();
    return parsed.data;
  }
  async request(path: string, init: RequestInit, context?: TeamModelRequestContext): Promise<Response> {
    if (!this.options.executionEnabled) throw new Error("Team model execution is not enabled");
    if (!context || !Number.isSafeInteger(context.ordinal) || context.ordinal < 0 || !modelPath(path) || init.method !== "POST" ||
        typeof init.body !== "string" || Buffer.byteLength(init.body) > 64 * 1024 * 1024) invalid();
    JSON.parse(init.body);
    init.signal?.throwIfAborted();
    const binding = this.requests.binding(context.bindingId), coordinator = this.coordinator();
    if (binding.generation !== coordinator.generation || binding.botId !== context.botId || binding.threadId !== context.threadId) invalid();
    const requestHash = hash(`POST\n${path}\n${init.body}`), slot = hash(JSON.stringify([binding.id, context.ordinal]));
    if (this.active.has(slot)) throw new Error("This team model request is already in progress");
    this.active.add(slot);
    try {
      const file = join(this.folder, `${slot}.json`);
      let journal: z.infer<typeof journalSchema>;
      try {
        const parsed = journalSchema.safeParse(privateJson(file));
        if (!parsed.success) invalid();
        journal = parsed.data;
        if (journal.key !== operationKey(slot) || journal.bindingId !== binding.id || journal.ordinal !== context.ordinal || journal.requestHash !== requestHash) invalid();
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
        journal = { key: operationKey(slot), bindingId: binding.id, ordinal: context.ordinal, requestHash };
        writeFileAtomic(file, JSON.stringify(journal), { mode: 0o600 });
      }
      if (journal.executionId) {
        const status = await this.status(journal.executionId, init.signal ?? undefined);
        throw new TeamModelRequestHeld(status.id, status.state);
      }
      const response = await fetch(`${this.origin}/api/v1/donebot/cloud/coordinators/${coordinator.instance_id}/executions`, {
        method: "POST", headers: { authorization: `Bearer ${coordinator.credential}`, "content-type": "application/json", "Idempotency-Key": journal.key },
        body: JSON.stringify({ actor_id: binding.actor.userId, member_version: binding.actor.memberVersion, node_kind: "cloud", node_id: coordinator.instance_id,
          node_version: 1, purpose: "llm", bot_id: binding.botId, thread_id: binding.threadId, private: audienceMember(binding.audience as import("../audience.ts").Audience) !== null, request_hash: requestHash }),
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), redirect: "error", credentials: "omit",
      });
      const parsed = grantSchema.safeParse(await responseJson(response, 8192));
      if (!parsed.success || Date.parse(parsed.data.expires_at) <= Date.now() || Date.parse(parsed.data.expires_at) > Date.now() + 310_000) invalid();
      const grant = parsed.data;
      journal.executionId = grant.id;
      // Persist before dispatch: a crash or lost response can only query this same execution after restart.
      writeFileAtomic(file, JSON.stringify(journal), { mode: 0o600 });
      if (grant.state !== "prepared") throw new TeamModelRequestHeld(grant.id, grant.state);
      if (this.coordinator().generation !== coordinator.generation) invalid();
      const headers: Record<string, string> = { authorization: `Bearer ${grant.token}`, "content-type": "application/json" };
      if (path === "/v1/messages") headers["anthropic-version"] = "2023-06-01";
      return await fetch(this.origin + path, { method: "POST", headers, body: init.body, signal: init.signal, redirect: "error", credentials: "omit" });
    } finally { this.active.delete(slot); }
  }
}
