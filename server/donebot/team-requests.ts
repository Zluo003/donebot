import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Audience } from "../audience.ts";
import { audienceMember, parseAudience } from "../audience.ts";
import { writeFileAtomic } from "../atomic.ts";
import type { ResolvedSender, WireMessage as Message } from "../../shared/wire.ts";
import type { DoneBotTeamRuntime } from "./team-runtime.ts";

const id = z.string().min(1).max(200);
const actorSchema = z.object({ userId: z.string().regex(/^[1-9][0-9]{0,19}$/), memberVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), person: id }).strict();
const sourceSchema = z.object({ threadId: id, sourceId: id, actor: actorSchema }).strict();
const bindingSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), teamId: z.uuid(), instanceId: z.uuid(), generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sourceId: id, botId: id, threadId: id, audience: z.string().refine(value => parseAudience(value) !== null), actor: actorSchema,
}).strict();

export type TeamRequestActor = z.infer<typeof actorSchema>;
export type TeamRequestBinding = z.infer<typeof bindingSchema>;

/** A reference to harness-owned provenance, never a credential or client-selected billing identity. */
export interface TeamModelRequestContext { bindingId: string; botId: string; threadId: string; ordinal: number }

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
    const path = join(this.folder, `binding-${bindingId}.json`);
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
  binding(bindingId: string): TeamRequestBinding {
    if (!/^[a-f0-9]{64}$/.test(bindingId)) invalid();
    const parsed = bindingSchema.safeParse(privateJson(join(this.folder, `binding-${bindingId}.json`)));
    if (!parsed.success || parsed.data.id !== bindingId || parsed.data.teamId !== this.runtime.team.id || parsed.data.instanceId !== this.runtime.instanceId) invalid();
    return parsed.data;
  }
}
