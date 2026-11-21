import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Audience } from "../audience.ts";
import { audienceMember, parseAudience } from "../audience.ts";
import { writeFileAtomic } from "../atomic.ts";
import type { ResolvedSender, WireMessage as Message } from "../../shared/wire.ts";
import type { DoneBotTeamRuntime } from "./team-runtime.ts";
import type { CheckBackRecord } from "../host/check-backs.ts";

const id = z.string().min(1).max(200);
const actorSchema = z.object({ userId: z.string().regex(/^[1-9][0-9]{0,19}$/), memberVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), person: id }).strict();
const sourceSchema = z.object({ threadId: id, sourceId: id, actor: actorSchema }).strict();
const bindingSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), teamId: z.uuid(), instanceId: z.uuid(), generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sourceId: id, botId: id, threadId: id, audience: z.string().refine(value => parseAudience(value) !== null), actor: actorSchema,
  parentId: z.string().regex(/^[a-f0-9]{64}$/).optional(), rootId: z.string().regex(/^[a-f0-9]{64}$/).optional(), operation: id.optional(),
}).strict();
const runSchema = z.object({ runId: id, bindingId: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

export type TeamRequestActor = z.infer<typeof actorSchema>;
export type TeamRequestBinding = z.infer<typeof bindingSchema>;

/** A reference to harness-owned provenance, never a credential or client-selected billing identity. */
export interface TeamModelRequestContext { bindingId: string; botId: string; threadId: string; ordinal: number }

export interface TeamTurnBindingInput {
  botId: string; threadId: string; audience: Audience; generation: number;
  sourceId?: string; sourceIds?: string[]; operation?: string; cardContinuation?: boolean;
  work?: { id: string; botId: string; threadId: string; executions: number; restarts: number };
  continuation?: { runId: string; operation: string };
  checkBack?: Readonly<CheckBackRecord>;
  goal?: { runId: string; step: number };
}

export function bindTeamTurn(requests: TeamRequestStore, input: TeamTurnBindingInput): TeamRequestBinding {
  const { botId, threadId, audience, generation } = input;
  if (input.work && (input.work.botId !== botId || input.work.threadId !== threadId)) invalid();
  if (input.checkBack) return requests.checkBack({ record: input.checkBack, audience, generation });
  if (input.continuation) return requests.continueRun({ ...input.continuation, botId, threadId, audience, generation });
  if (input.goal && !input.work) return requests.goalStep({ ...input.goal, sourceId: input.sourceId ?? "", botId, threadId, audience, generation });
  if (input.cardContinuation && !input.work) throw new Error("团队续跑缺少原任务和独立步骤，不能重新提交原模型请求。");
  const binding = input.work ? requests.coordinated({ ...input.work, audience, generation })
    : requests.bind({ sourceId: input.sourceId ?? "", sourceIds: input.sourceIds, botId, threadId, audience, generation });
  return input.operation ? requests.derive(binding.id, input.operation) : binding;
}

export function privateJson(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65_536 || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) throw new Error("Private team state is unavailable");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
function invalid(): never { throw new Error("The team request has no verified member and conversation provenance"); }
function checkBackOperation(record: Readonly<CheckBackRecord>): string {
  const origin = record.origin.kind === "user" ? [record.origin.kind, record.origin.request, record.origin.person ?? null, record.origin.lends ?? false] : [record.origin.kind];
  return `check-back:${hash(JSON.stringify([record.id, record.botId, record.threadId, record.note, record.condition ?? null,
    record.dueAt, record.createdAt, record.zone, origin]))}`;
}

export class TeamRequestStore {
  private readonly senders = new WeakMap<ResolvedSender, TeamRequestActor>();
  private readonly folder: string;
  private readonly runtime: DoneBotTeamRuntime;
  constructor(dataDir: string, runtime: DoneBotTeamRuntime) {
    this.runtime = runtime;
    this.folder = join(dataDir, "donebot-team-execution", "requests");
    mkdirSync(this.folder, { recursive: true, mode: 0o700 });
  }
  sender(sender: ResolvedSender, actor: TeamRequestActor): ResolvedSender {
    if (sender.id !== actor.person) invalid();
    this.senders.set(sender, actorSchema.parse(actor));
    return sender;
  }
  private sourcePath(threadId: string, sourceId: string): string {
    return join(this.folder, `source-${hash(JSON.stringify([threadId, sourceId]))}.json`);
  }
  private saveSource(threadId: string, sourceId: string, actor: TeamRequestActor): void {
    const source = sourceSchema.parse({ threadId, sourceId, actor }), path = this.sourcePath(threadId, sourceId);
    try {
      const old = sourceSchema.parse(privateJson(path));
      if (JSON.stringify(old) !== JSON.stringify(source)) invalid();
    } catch (error) {
      if (!missing(error)) throw error;
      writeFileAtomic(path, JSON.stringify(source), { mode: 0o600 });
    }
  }
  captureQueue(threadId: string, queueId: string, sender: ResolvedSender | undefined): void {
    const actor = sender && this.senders.get(sender);
    if (actor && sender?.id !== actor.person) invalid();
    if (actor) this.saveSource(threadId, queueId, actor);
  }
  captureAction(threadId: string, sourceId: string, sender: ResolvedSender | undefined): void {
    const actor = sender && this.senders.get(sender);
    if (!actor || sender?.id !== actor.person) invalid();
    this.saveSource(threadId, sourceId, actor);
  }
  queueIdentity(threadId: string, queueId: string): string {
    try {
      const source = sourceSchema.parse(privateJson(this.sourcePath(threadId, queueId)));
      if (source.threadId === threadId && source.sourceId === queueId) return JSON.stringify(source.actor);
    } catch {}
    return `unbound:${queueId}`;
  }
  captureMessage(threadId: string, message: Message): void {
    if (message.role !== "user" || message.kind !== "text") return;
    if (message.queueId) {
      try {
        const source = sourceSchema.parse(privateJson(this.sourcePath(threadId, message.queueId)));
        if (source.threadId !== threadId || source.sourceId !== message.queueId || source.actor.person !== message.sender?.id) invalid();
        this.saveSource(threadId, message.id, source.actor);
      } catch (error) { if (!missing(error)) throw error; }
      return;
    }
    const actor = message.sender && this.senders.get(message.sender);
    if (actor && message.sender?.id !== actor.person) invalid();
    if (actor) this.saveSource(threadId, message.id, actor);
  }
  bind(input: { sourceId: string; sourceIds?: string[]; botId: string; threadId: string; audience: Audience; generation: number }): TeamRequestBinding {
    let actor: TeamRequestActor | undefined;
    for (const sourceId of new Set([input.sourceId, ...input.sourceIds ?? []])) {
      const source = sourceSchema.safeParse(privateJson(this.sourcePath(input.threadId, sourceId)));
      if (!source.success || source.data.threadId !== input.threadId || source.data.sourceId !== sourceId) invalid();
      if (actor && JSON.stringify(actor) !== JSON.stringify(source.data.actor)) invalid();
      actor = source.data.actor;
    }
    if (!actor || audienceMember(input.audience) !== null && audienceMember(input.audience) !== actor.person) invalid();
    const bindingId = hash(JSON.stringify([this.runtime.team.id, input.botId, input.threadId, input.sourceId]));
    const binding = bindingSchema.parse({ id: bindingId, teamId: this.runtime.team.id, instanceId: this.runtime.instanceId,
      generation: input.generation, sourceId: input.sourceId, botId: input.botId, threadId: input.threadId, audience: input.audience, actor });
    return this.saveBinding(binding);
  }
  private saveBinding(binding: TeamRequestBinding): TeamRequestBinding {
    const path = join(this.folder, `binding-${binding.id}.json`);
    try {
      const stored = bindingSchema.parse(privateJson(path));
      if (JSON.stringify(stored) !== JSON.stringify(binding)) invalid();
      return stored;
    } catch (error) {
      if (!missing(error)) throw error;
      writeFileAtomic(path, JSON.stringify(binding), { mode: 0o600 });
      return binding;
    }
  }
  attachRun(runId: string, bindingId: string): void {
    this.binding(bindingId);
    const run = runSchema.parse({ runId, bindingId }), path = join(this.folder, `run-${hash(runId)}.json`);
    try {
      const old = runSchema.parse(privateJson(path));
      if (old.runId !== runId || old.bindingId !== bindingId) invalid();
    } catch (error) {
      if (!missing(error)) throw error;
      writeFileAtomic(path, JSON.stringify(run), { mode: 0o600 });
    }
  }
  forRun(runId: string): TeamRequestBinding {
    id.parse(runId);
    const run = runSchema.parse(privateJson(join(this.folder, `run-${hash(runId)}.json`)));
    if (run.runId !== runId) invalid();
    return this.binding(run.bindingId);
  }
  derive(bindingId: string, operation: string, target?: { botId: string; threadId: string; audience: Audience }): TeamRequestBinding {
    const parent = this.binding(bindingId);
    id.parse(operation);
    const destination = target ?? { botId: parent.botId, threadId: parent.threadId, audience: parent.audience as Audience };
    this.assertAudience(parent, destination.audience);
    const binding = bindingSchema.parse({ ...parent, ...destination, parentId: parent.id, rootId: parent.rootId ?? parent.id, operation,
      id: hash(JSON.stringify([this.runtime.team.id, "derived", parent.id, operation, destination.botId, destination.threadId, destination.audience])) });
    return this.saveBinding(binding);
  }
  private assertAudience(parent: TeamRequestBinding, audience: Audience): void {
    const privateTo = audienceMember(audience);
    if (privateTo !== null && privateTo !== parent.actor.person || parent.audience !== "team" && parent.audience !== audience &&
        (privateTo !== parent.actor.person || audienceMember(parent.audience as Audience) !== null)) invalid();
  }
  checkHandOn(runId: string, audience: Audience): void { this.assertAudience(this.forRun(runId), audience); }
  handOn(runId: string, work: { id: string; botId: string; threadId: string }, audience: Audience, duplicate = false): void {
    const parent = this.forRun(runId);
    this.assertAudience(parent, audience);
    if (duplicate) {
      const existing = this.forRun(work.id);
      if (existing.rootId !== (parent.rootId ?? parent.id) || existing.botId !== work.botId || existing.threadId !== work.threadId ||
          existing.audience !== audience || existing.generation !== parent.generation || JSON.stringify(existing.actor) !== JSON.stringify(parent.actor)) invalid();
      return;
    }
    const binding = this.derive(parent.id, `work:${work.id}`, { botId: work.botId, threadId: work.threadId, audience });
    this.attachRun(work.id, binding.id);
  }
  coordinated(input: { id: string; botId: string; threadId: string; audience: Audience; generation: number; executions: number; restarts: number }): TeamRequestBinding {
    const binding = this.forRun(input.id);
    if (binding.botId !== input.botId || binding.threadId !== input.threadId || binding.audience !== input.audience || binding.generation !== input.generation ||
        !Number.isSafeInteger(input.executions) || !Number.isSafeInteger(input.restarts) || input.restarts < 0 || input.executions <= input.restarts) invalid();
    const step = input.executions - input.restarts;
    return step === 1 ? binding : this.derive(binding.id, `step:${step}`);
  }
  continueRun(input: { runId: string; botId: string; threadId: string; audience: Audience; generation: number; operation: string }): TeamRequestBinding {
    const parent = this.forRun(input.runId);
    if (parent.botId !== input.botId || parent.threadId !== input.threadId || parent.audience !== input.audience || parent.generation !== input.generation) invalid();
    return this.derive(parent.id, `continue:${input.operation}`);
  }
  goalStep(input: { sourceId: string; botId: string; threadId: string; audience: Audience; generation: number; runId: string; step: number }): TeamRequestBinding {
    id.parse(input.runId);
    if (!Number.isSafeInteger(input.step) || input.step < 1) invalid();
    const parent = this.bind(input);
    const goalId = `goal:${hash(input.runId)}`;
    this.attachRun(goalId, parent.id);
    return this.derive(parent.id, `${goalId}:step:${input.step}`);
  }
  scheduleCheckBack(input: { runId: string; record: Readonly<CheckBackRecord>; audience: Audience; generation: number }): void {
    const { record } = input, parent = this.forRun(input.runId);
    if (parent.botId !== record.botId || parent.threadId !== record.threadId || parent.audience !== input.audience || parent.generation !== input.generation ||
        record.origin.kind !== "user" || record.origin.person !== parent.actor.person) invalid();
    const binding = this.derive(parent.id, checkBackOperation(record));
    this.attachRun(`check-back:${record.id}`, binding.id);
  }
  checkBack(input: { record: Readonly<CheckBackRecord>; audience: Audience; generation: number }): TeamRequestBinding {
    const { record } = input, binding = this.forRun(`check-back:${record.id}`);
    if (binding.botId !== record.botId || binding.threadId !== record.threadId || binding.audience !== input.audience || binding.generation !== input.generation ||
        binding.operation !== checkBackOperation(record)) invalid();
    return binding;
  }
  helper(input: { runId: string; botId: string; threadId: string; operation: string }): TeamModelRequestContext {
    const parent = this.forRun(input.runId);
    if (parent.botId !== input.botId || parent.threadId !== input.threadId) invalid();
    const binding = this.derive(parent.id, `helper:${input.operation}`);
    return { bindingId: binding.id, botId: binding.botId, threadId: binding.threadId, ordinal: 0 };
  }
  binding(bindingId: string): TeamRequestBinding {
    if (!/^[a-f0-9]{64}$/.test(bindingId)) invalid();
    const parsed = bindingSchema.safeParse(privateJson(join(this.folder, `binding-${bindingId}.json`)));
    if (!parsed.success || parsed.data.id !== bindingId || parsed.data.teamId !== this.runtime.team.id || parsed.data.instanceId !== this.runtime.instanceId) invalid();
    return parsed.data;
  }
}
