import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { AppSettingRequest } from "../../shared/app-settings.ts";
import { appendDecision } from "../decision-log.ts";
import { UNDO_STALE } from "../direct-apply.ts";
import { serverLine } from "../server-lines.ts";
import type { BotRecord, GroupRecord, Store } from "../store.ts";
import { findPlaces, placePath, placesList } from "./places.ts";
import { findSettings, personOnly, type SettingEntry, type WritableEntry } from "./registry.ts";

export const TOOL = "app_settings";
export const WRITE_BUDGET = 10;
const FIND_LIMIT = 8;
const NOT_SET = "not set";
const text = (value: string) => value || NOT_SET;
interface Shown {
  before?: string;
  after: string;
}
const said = ({ before, after }: Shown) => (before === undefined ? after : `${text(before)} → ${text(after)}`);

/** The tool sends every value as text so strict-schema providers accept it; numbers, true/false and JSON are read back
 * from it when the text alone does not fit the setting. A JSON object or list is judged as itself. */
function parseValue(entry: WritableEntry, value: unknown) {
  const direct = entry.value.safeParse(value);
  if (direct.success || typeof value !== "string") return direct;
  try {
    const json: unknown = JSON.parse(value);
    const read = entry.value.safeParse(json);
    return read.success || (typeof json === "object" && json !== null) ? read : direct;
  } catch {
    return direct;
  }
}

export interface Turn {
  botId: string;
  threadId: string;
  generation: string;
}

/** `before`: what Undo writes back; `after`: what the setting read as once applied, so Undo can tell it changed since. */
interface Undoable {
  entry: WritableEntry;
  before: unknown;
  after: string;
}

export type UndoResult =
  | { claimed: false }
  | { claimed: true; state: "already_undone" | "undone" }
  | { claimed: true; state: "invalid"; error: string; status: number; stale?: true };

export interface AppSettingsDeps {
  store: Pick<Store, "appendMessage" | "bot" | "messagesFor" | "patchMessage">;
  dataDir: string;
  entries: readonly SettingEntry[];
  /** Non-null when the turn is the owner's own (phones.turnOwner); null on a Team Cloud or hosted workspace. */
  turnOwner(turn: Turn): string | null;
  guestDriven(threadId: string): boolean;
  connectorThread(botId: string, threadId: string): { group?: GroupRecord } | null;
  language(threadId: string): string | undefined;
  active(turn: Turn): boolean;
  personAsked(turn: Turn): boolean;
}

export function createAppSettings(deps: AppSettingsDeps) {
  const { store, entries } = deps;
  const undoable = new Map<string, Undoable>();
  const writes = new Map<string, number>();
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  const reply = (status: number, body: Record<string, unknown>) => ({ status, body });
  const refuse = (status: number, error: string) => reply(status, { error });
  const describe = (entry: SettingEntry) => ({ id: entry.id, label: entry.label, scope: "workspace", tier: entry.tier, value: text(entry.read()), where: placePath(entry.where) });
  const from = (bot: BotRecord, threadId: string) => (deps.connectorThread(bot.id, threadId)?.group ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {});
  const spendWrite = (turn: Turn): string | null => {
    const spent = writes.get(turn.generation) ?? 0;
    if (spent >= WRITE_BUDGET) return `This turn has already attempted ${WRITE_BUDGET} setting changes. Ask the user to send a new message before changing more.`;
    writes.set(turn.generation, spent + 1);
    if (writes.size > 200) writes.delete(writes.keys().next().value!);
    return null;
  };

  async function apply(turn: Turn, bot: BotRecord, entry: WritableEntry, value: unknown, change?: string) {
    const before = entry.current(value);
    const was = entry.read();
    const check = () => {
      if (!mayWrite(turn)) throw new Error("The owning conversation ended or its authorization changed; no setting changed.");
      if (entry.read() !== was) throw new Error(UNDO_STALE);
    };
    check();
    const refusal = await entry.write(value, check);
    if (refusal) return refuse(409, refusal);
    const after = entry.read();
    const shown: Shown = change === undefined ? { before: was, after } : { after: change };
    const requestId = randomUUID();
    const language = deps.language(turn.threadId);
    const notSet = (value: string) => value || serverLine(language, "server.appSettings.notSet");
    const appSettingRequest: AppSettingRequest = { settingId: entry.id, label: entry.label, ...(shown.before === undefined ? {} : { before: shown.before }), after: shown.after, tier: entry.tier };
    store.appendMessage(turn.threadId, {
      role: "bot", kind: "options", ...from(bot, turn.threadId),
      card: { title: serverLine(language, "server.appSettings.changed", { label: entry.label }), subtitle: shown.before === undefined ? shown.after : `${notSet(shown.before)} → ${notSet(shown.after)}`,
        options: [], requestId, tool: TOOL, fixedOptions: true, appSettingRequest, answered: "allow", dismissed: true, autoApplied: true },
    });
    undoable.set(requestId, { entry, before, after });
    appendDecision(deps.dataDir, { threadId: turn.threadId, requestId, botId: turn.botId, botName: bot.name, tool: TOOL, summary: `${entry.id}: ${said(shown)}`, decision: "auto-approved", source: "app-settings" });
    const done = change === undefined ? `Changed ${entry.label} from ${text(was)} to ${text(after)}.` : `Done: ${change}. ${entry.label} now: ${text(after)}.`;
    return reply(200, { text: `${done} The user can undo it from the card in the conversation.` });
  }

  const mayWrite = (turn: Turn) => deps.active(turn) && deps.personAsked(turn) && !deps.guestDriven(turn.threadId) && deps.turnOwner(turn) !== null;

  async function set(turn: Turn, body: Record<string, unknown>) {
    if (!deps.active(turn)) return refuse(401, "This turn has ended; no setting changed.");
    const entry = typeof body.id === "string" ? byId.get(body.id) : undefined;
    if (!entry) return refuse(404, `No setting with id ${JSON.stringify(body.id ?? null)}. Use action find first.`);
    const bot = store.bot(turn.botId);
    if (!bot) return refuse(404, "This bot no longer exists.");
    if (entry.tier === "owner-only") return refuse(403, personOnly(entry.label, entry.where));
    if (!mayWrite(turn)) return refuse(403, "Settings change only in the owner's own conversation. This turn was not started by the owner here, so nothing changed; you may still read settings.");
    const parsed = parseValue(entry, body.value);
    if (!parsed.success) return refuse(400, `${entry.label} takes ${entry.allowed}. ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    const described = entry.describe?.(parsed.data);
    if (described && "refusal" in described) return refuse(409, described.refusal);
    const budget = spendWrite(turn);
    if (budget) return refuse(429, budget);
    try { return await apply(turn, bot, entry, parsed.data, described?.change); }
    catch (error) { return refuse(409, error instanceof Error ? error.message : String(error)); }
  }

  let mutation: Promise<unknown> = Promise.resolve();
  function mutate<T>(work: () => Promise<T>): Promise<T> {
    const next = mutation.then(work);
    mutation = next.catch(() => {});
    return next;
  }

  return {
    async handle(input: unknown, turn: Turn): Promise<{ status: number; body: Record<string, unknown> }> {
      if (!deps.active(turn)) return refuse(401, "This turn has ended.");
      const parsed = requestSchema.safeParse(input);
      if (!parsed.success) return refuse(400, "Use find with query, get with id, set with id and a text value, or places with an optional query; no other fields.");
      const body = parsed.data;
      if (body.action === "find") {
        const query = typeof body.query === "string" ? body.query : "";
        const hits = findSettings(entries, query, FIND_LIMIT).map(describe);
        if (hits.length) return reply(200, { text: JSON.stringify(hits) });
        const places = findPlaces(query);
        return reply(200, { text: `No setting you can change matches ${JSON.stringify(query)}.${places.length ? ` Where the person finds it in the app: ${places.join("; ")}.` : " Try other words, or use action places."}` });
      }
      if (body.action === "places") {
        const query = typeof body.query === "string" ? body.query.trim() : "";
        const places = query ? findPlaces(query) : [];
        return reply(200, { text: query ? (places.length ? places.join("\n") : `No place in the app matches ${JSON.stringify(query)}. Here is every place:\n${placesList()}`) : placesList() });
      }
      if (body.action === "get") {
        const entry = typeof body.id === "string" ? byId.get(body.id) : undefined;
        if (!entry) return refuse(404, `No setting with id ${JSON.stringify(body.id ?? null)}. Use action find first.`);
        return reply(200, { text: JSON.stringify({ ...describe(entry), help: entry.help, ...("allowed" in entry ? { allowed: entry.allowed } : {}),
          change: entry.tier === "owner-only" ? `only the person, in ${placePath(entry.where)}` : "set applies at once, with Undo on the card" }) });
      }
      if (body.action === "set") return mutate(() => set(turn, body));
      return refuse(400, "action must be find, get, set or places.");
    },

    async undo(args: { threadId: string; requestId: string; allowed(): boolean }): Promise<UndoResult> {
      return mutate<UndoResult>(async () => {
        const message = store.messagesFor(args.threadId).find((candidate) => candidate.card?.requestId === args.requestId && candidate.card.appSettingRequest);
        const current = message?.card;
        if (!message || !current) return { claimed: false };
        if (!args.allowed()) return { claimed: true, state: "invalid", error: "Only the owner may undo workspace settings here.", status: 403 };
        if (current.undone) return { claimed: true, state: "already_undone" };
        const change = undoable.get(args.requestId);
        if (!change || current.answered !== "allow") return { claimed: true, state: "invalid", error: "This change can't be undone here. Open Settings to change it.", status: 409 };
        const check = () => {
          if (!args.allowed()) throw new Error("Workspace authorization changed.");
          if (change.entry.read() !== change.after) throw new Error(UNDO_STALE);
        };
        try {
          check();
          const refusal = change.before === undefined ? "The earlier value cannot be restored." : await change.entry.write(change.before, check);
          if (refusal) return { claimed: true, state: "invalid", error: refusal, status: 409 };
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return { claimed: true, state: "invalid", error: detail, status: 409, ...(detail === UNDO_STALE ? { stale: true } : {}) };
        }
        undoable.delete(args.requestId);
        store.patchMessage(args.threadId, message.id, { card: { ...current, undone: true } });
        return { claimed: true, state: "undone" };
      });
    },
  };
}

const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("find"), query: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("get"), id: z.string().min(1).max(80) }).strict(),
  z.object({ action: z.literal("set"), id: z.string().min(1).max(80), value: z.string().max(4000) }).strict(),
  z.object({ action: z.literal("places"), query: z.string().max(200).optional() }).strict(),
]);
