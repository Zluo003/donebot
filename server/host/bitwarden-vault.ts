// Bitwarden in the Vault, through its own command line tool (bitwarden-cli.ts). Its logins and secrets join the Vault's
// list by name and site only; every value is read from Bitwarden at the moment a bot uses it and never kept. The
// session key lives in this process's memory alone. Bitwarden has no per-collection bots here: the account's own
// collections are the boundary, so its items are for every bot.
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { BitwardenCredentials, BitwardenStatus, LoginPlace } from "../../shared/logins.ts";
import { loginSite, normalizeLoginHost } from "../../shared/logins.ts";
import type { LinkedSecret } from "../../shared/vault.ts";

import { parseTotpKey, totpCode } from "../totp.ts";
import type { LinkedItem, LinkedValue, VaultProvider } from "../vault/providers.ts";
import { bitwardenRunner, forgetBitwardenAppData, installBitwardenCli, type BwResult, type BwRun } from "./bitwarden-cli.ts";

const ID_PREFIX = "bitwarden:";
const STALE_MS = 10 * 60_000;
/** `bw sync` asks Bitwarden's server for the whole vault, so it runs at most this often. */
const SYNC_EVERY_MS = 60_000;
const MAX_ITEMS = 1_000;
const FIELDS_MAX = 20;
const LOGIN = 1;
const SECURE_NOTE = 2;
const BUILT_IN = ["password", "username", "totp", "notes"] as const;
type BuiltIn = typeof BUILT_IN[number];
const DEFAULT_SERVER = "https://vault.bitwarden.com";

interface BwField { name?: string | null; value?: string | null; type?: number }
interface BwItem {
  id: string; name?: string | null; type: number; notes?: string | null; fields?: BwField[] | null;
  login?: { uris?: Array<{ uri?: string | null }> | null; username?: string | null; password?: string | null; totp?: string | null } | null;
}

interface ItemEntry {
  itemId: string;
  name: string;
  type: number;
  /** Custom fields by name, never one named like a built-in field (a reference reads the built-in). */
  custom: string[];
  main?: string;
  has: Record<BuiltIn, boolean>;
}

interface LoginEntry extends LoginPlace { id: string; itemId: string; username: string; hasTotp: boolean }

export const BITWARDEN_WRONG_PASSWORD = "Bitwarden did not accept the master password. Check it and connect again.";
export const BITWARDEN_BAD_KEY = "Bitwarden did not accept the API key. Copy client_id and client_secret again in Bitwarden's Account settings → Security → Keys → View API key, then connect again.";
const TIMEOUT = "Bitwarden did not answer in time. Try again in a moment.";
const LIMITED = "Bitwarden is limiting requests right now. Try again in a few minutes.";
const LOCKED = "Bitwarden stayed locked. Connect it again with the master password.";
const UNREADABLE = "Bitwarden could not be read. Try again, or connect it again.";
const unreachable = (host: string) => `Could not reach the Bitwarden server at ${host}. Check the address and the internet connection, then try again.`;

/** Words for the person and a fixed class for the Admin's report; never what the tool printed. */
type VaultProviderFailure = "cant-connect" | "unavailable" | "refused" | "unreadable" | "rate-limited";

export class BitwardenProblem extends Error {
  readonly failure: VaultProviderFailure;
  readonly relock: boolean;
  readonly gone: boolean;
  constructor(message: string, failure: VaultProviderFailure, options: { relock?: boolean; gone?: boolean } = {}) {
    super(message);
    this.name = "BitwardenProblem";
    this.failure = failure;
    this.relock = options.relock ?? false;
    this.gone = options.gone ?? false;
  }
}

export function bitwardenProblem(result: Pick<BwResult, "code" | "stdout" | "stderr" | "timedOut">, host: string): BitwardenProblem {
  const text = `${result.stderr}\n${result.stdout}`;
  if (result.timedOut) return new BitwardenProblem(TIMEOUT, "cant-connect");
  if (result.code === 127) return new BitwardenProblem("Bitwarden's command line tool is missing on this computer. Connect again to set it up.", "unavailable");
  if (/invalid master password/iu.test(text)) return new BitwardenProblem(BITWARDEN_WRONG_PASSWORD, "refused");
  if (/client_id or client_secret|invalid_client|invalid client/iu.test(text)) return new BitwardenProblem(BITWARDEN_BAD_KEY, "refused");
  if (/vault is locked|not logged in|unauthenticated/iu.test(text)) return new BitwardenProblem(LOCKED, "unreadable", { relock: true });
  if (/^\s*not found\.?\s*$/imu.test(text)) return new BitwardenProblem("That item is no longer in Bitwarden.", "unreadable", { gone: true });
  if (/too many requests|rate limit|\b429\b/iu.test(text)) return new BitwardenProblem(LIMITED, "rate-limited");
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|fetch failed|ETIMEDOUT|ECONNRESET|socket hang up|network|certificate|UNABLE_TO_VERIFY/iu.test(text)) {
    return new BitwardenProblem(unreachable(host), "cant-connect");
  }
  return new BitwardenProblem(UNREADABLE, "unreadable");
}

/** A Bitwarden reference, `bw://<item id or name>[/<field>]`: the field is password, username, totp, notes or a custom
 * field's name. Null for anything else. */
export function parseBitwardenReference(reference: string): { item: string; field?: string } | null {
  const match = /^bw:\/\/([^/?#]+)(?:\/([^/?#]+))?$/u.exec(reference.trim());
  if (!match) return null;
  return { item: match[1]!.trim(), ...(match[2] ? { field: match[2].trim() } : {}) };
}

/** Bitwarden and Vaultwarden may be hosted below a path; credentials, queries and fragments are rejected. */
export function bitwardenServerUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
  } catch {
    return null;
  }
}

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const hostOf = (serverUrl: string) => { try { return new URL(serverUrl).host; } catch { return serverUrl; } };
const credentialKey = (credentials: BitwardenCredentials) => `${credentials.serverUrl}\0${credentials.clientId}`;

function bySite(hosts: Iterable<string>): Map<string, string[]> {
  const sites = new Map<string, string[]>();
  for (const host of hosts) {
    const site = loginSite(host);
    sites.set(site, [...(sites.get(site) ?? []), host]);
  }
  return sites;
}

function entryOf(item: BwItem): ItemEntry {
  const usable = (item.fields ?? []).filter((field) => field.name?.trim() && field.value && (field.type ?? 0) <= 2);
  const custom: string[] = [];
  for (const field of usable) {
    const name = field.name!.trim();
    if (!BUILT_IN.some((one) => sameText(one, name)) && !custom.some((one) => sameText(one, name)) && custom.length < FIELDS_MAX) custom.push(name);
  }
  const hidden = usable.find((field) => field.type === 1 && custom.includes(field.name!.trim()));
  const notes = Boolean(item.notes?.trim());
  const main = item.type === SECURE_NOTE && notes ? undefined : (hidden?.name?.trim() ?? custom[0]);
  return {
    itemId: item.id, name: item.name?.trim() || "Untitled", type: item.type, custom, ...(main ? { main } : {}),
    has: { password: Boolean(item.login?.password), username: Boolean(item.login?.username), totp: Boolean(item.login?.totp), notes },
  };
}

const listedAsSecret = (entry: ItemEntry) => (entry.type === SECURE_NOTE && entry.has.notes) || entry.main !== undefined;

function valueOf(item: BwItem, entry: ItemEntry, field: string | undefined, now: number): string | undefined {
  if (!field) return item.type === SECURE_NOTE && item.notes?.trim() ? item.notes : customValue(item, entry.main);
  const builtIn = BUILT_IN.find((one) => sameText(one, field));
  if (builtIn === "password") return item.login?.password ?? undefined;
  if (builtIn === "username") return item.login?.username ?? undefined;
  if (builtIn === "notes") return item.notes ?? undefined;
  if (builtIn === "totp") {
    const key = parseTotpKey(item.login?.totp);
    return key ? totpCode(key, now) : undefined;
  }
  return customValue(item, field);
}

function customValue(item: BwItem, name: string | undefined): string | undefined {
  if (!name) return undefined;
  return (item.fields ?? []).find((field) => field.name && sameText(field.name, name) && field.value)?.value ?? undefined;
}

export class BitwardenLogins implements VaultProvider {
  readonly id = "bitwarden";
  readonly label = "Bitwarden";
  private readonly credentials: () => BitwardenCredentials | null;
  private readonly run: BwRun;
  private readonly now: () => number;
  private readonly forgetAppData: () => void;
  private revision = 0;
  private scope: string;
  private activeRevision: number | undefined;
  private pending: Promise<void> = Promise.resolve();

  get connectionId(): string { return this.scope; }

  private assertCurrent(revision: number): void {
    if (revision !== this.revision) throw new BitwardenProblem("The Bitwarden connection changed. Try again.", "unavailable");
  }

  private enqueue<T>(revision: number, work: () => Promise<T>): Promise<T> {
    const result = this.pending.then(async () => {
      this.assertCurrent(revision);
      this.activeRevision = revision;
      try { return await work(); }
      finally { this.activeRevision = undefined; }
    });
    this.pending = result.then(() => {}, () => {});
    return result;
  }

  private async checkedRun(...args: Parameters<BwRun>): ReturnType<BwRun> {
    const revision = this.activeRevision!;
    this.assertCurrent(revision);
    const result = await this.run(...args);
    this.assertCurrent(revision);
    return result;
  }

  private session: { key: string; credentials: string } | null = null;
  private signedInAs: string | null = null;
  private unlocking: Promise<string> | null = null;
  private account: string | undefined;
  private logins: LoginEntry[] = [];
  private entries = new Map<string, ItemEntry>();
  private refreshedAt: number | null = null;
  private syncedAt: number | null = null;
  private error: BitwardenProblem | undefined;
  private refreshing: Promise<BitwardenStatus> | null = null;
  private readonly lastUsed = new Map<string, number>();

  constructor(options: { credentials: () => BitwardenCredentials | null; run: BwRun; now?: () => number; forgetAppData?: () => void; connectionId?: string }) {
    this.scope = options.connectionId ?? randomUUID();
    this.credentials = options.credentials;
    this.run = options.run;
    this.now = options.now ?? Date.now;
    this.forgetAppData = options.forgetAppData ?? (() => {});
  }

  status(): BitwardenStatus {
    const credentials = this.credentials();
    if (!credentials) return { connected: false };
    return {
      connected: true, server: hostOf(credentials.serverUrl), ...(this.account ? { account: this.account } : {}),
      items: this.logins.length + [...this.entries.values()].filter(listedAsSecret).length, ...(this.error ? { error: this.error.message } : {}),
    };
  }

  failure(): VaultProviderFailure | undefined {
    return this.credentials() ? this.error?.failure : undefined;
  }

  connect(credentials: BitwardenCredentials, save: (credentials: BitwardenCredentials, connectionId: string) => void): Promise<BitwardenStatus> {
    this.clear();
    const revision = this.revision;
    return this.enqueue(revision, async () => {
      try {
        await this.load(credentials);
        this.assertCurrent(revision);
        save(credentials, this.scope);
        return this.status();
      } catch (error) {
        if (revision === this.revision) {
          this.reset();
          try { await this.forgetSession(); } catch {}
        }
        throw error instanceof BitwardenProblem ? error : new BitwardenProblem(UNREADABLE, "unavailable");
      }
    });
  }

  refresh(candidate?: BitwardenCredentials): Promise<BitwardenStatus> {
    if (candidate) return this.connect(candidate, () => {});
    if (this.refreshing) return this.refreshing;
    const run = this.enqueue(this.revision, () => this.load()).finally(() => { if (this.refreshing === run) this.refreshing = null; });
    this.refreshing = run;
    return run;
  }

  async fresh(): Promise<void> {
    if (!this.credentials()) return;
    if (this.refreshedAt === null || this.now() - this.refreshedAt > STALE_MS) await this.refresh();
  }

  disconnect(): Promise<void> {
    this.clear();
    const cleanup = this.pending.then(() => this.forgetSession());
    this.pending = cleanup.then(() => {}, () => {});
    return cleanup;
  }

  private async forgetSession(): Promise<void> {
    try { await this.run(["logout"]); }
    catch {}
    finally { this.signedInAs = null; this.forgetAppData(); }
  }

  clear(): void {
    this.revision++;
    this.scope = randomUUID();
    this.refreshing = null;
    this.reset();
  }

  private reset(): void {
    this.session = null;
    this.account = undefined;
    this.logins = [];
    this.entries = new Map();
    this.refreshedAt = null;
    this.syncedAt = null;
    this.error = undefined;
    this.lastUsed.clear();
  }

  private async load(candidate?: BitwardenCredentials): Promise<BitwardenStatus> {
    const credentials = candidate ?? this.credentials();
    if (!credentials) { this.reset(); return this.status(); }
    try {
      if (candidate) { this.session = null; await this.unlock(candidate, true); }
      await this.sync(credentials, true);
      // Every value in this answer is dropped here and read again when a bot uses it.
      const listed = JSON.parse(await this.call(credentials, ["list", "items"])) as unknown;
      const items = (Array.isArray(listed) ? listed as BwItem[] : []).filter((item) => typeof item?.id === "string" && (item.type === LOGIN || item.type === SECURE_NOTE)).slice(0, MAX_ITEMS);
      const logins: LoginEntry[] = [];
      const entries = new Map<string, ItemEntry>();
      for (const item of items) {
        const entry = entryOf(item);
        entries.set(item.id, entry);
        if (item.type !== LOGIN || !item.login?.password) continue;
        const hosts = new Set((item.login.uris ?? []).flatMap((uri) => normalizeLoginHost(uri.uri) ?? []));
        for (const [site, siteHosts] of bySite(hosts)) {
          logins.push({ id: `${ID_PREFIX}${item.id}:${site}`, itemId: item.id, site, hosts: siteHosts, exactHost: false,
            username: item.login.username ?? "", hasTotp: Boolean(parseTotpKey(item.login.totp)) });
        }
      }
      this.logins = logins.sort((a, b) => a.site.localeCompare(b.site) || a.username.localeCompare(b.username));
      this.entries = entries;
      this.refreshedAt = this.now();
      this.error = undefined;
      return this.status();
    } catch (error) {
      const problem = error instanceof BitwardenProblem ? error : new BitwardenProblem(UNREADABLE, "unavailable");
      if (candidate) throw problem;
      if (this.activeRevision !== this.revision) throw problem;
      this.reset();
      this.error = problem;
      return this.status();
    }
  }

  private unlock(credentials: BitwardenCredentials, again = false): Promise<string> {
    if (!again && this.unlocking) return this.unlocking;
    const running = this.unlockNow(credentials, again).finally(() => { if (this.unlocking === running) this.unlocking = null; });
    this.unlocking = running;
    return running;
  }

  private async unlockNow(credentials: BitwardenCredentials, again: boolean): Promise<string> {
    const host = hostOf(credentials.serverUrl);
    const check = (result: BwResult) => { if (result.code !== 0 || result.timedOut) throw bitwardenProblem(result, host); return result.stdout; };
    const before = this.statusOf(check(await this.checkedRun(["status"])));
    let signedOut = before.status === "unauthenticated";
    const server = bitwardenServerUrl(before.serverUrl ?? DEFAULT_SERVER);
    const elsewhere = server !== bitwardenServerUrl(credentials.serverUrl) || (this.signedInAs !== null && this.signedInAs !== credentials.clientId);
    if (!signedOut && (again || elsewhere)) {
      await this.checkedRun(["logout"]);
      this.signedInAs = null;
      signedOut = true;
    }
    if (signedOut) {
      check(await this.checkedRun(["config", "server", credentials.serverUrl]));
      check(await this.checkedRun(["login", "--apikey"], { BW_CLIENTID: credentials.clientId, BW_CLIENTSECRET: credentials.clientSecret }));
      this.signedInAs = credentials.clientId;
    }
    const key = check(await this.checkedRun(["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], { BW_PASSWORD: credentials.password })).trim();
    if (!key) throw new BitwardenProblem(LOCKED, "unreadable");
    this.session = { key, credentials: credentialKey(credentials) };
    this.signedInAs = credentials.clientId;
    const after = await this.checkedRun(["status"], { BW_SESSION: key });
    if (after.code === 0) this.account = this.statusOf(after.stdout).userEmail ?? undefined;
    return key;
  }

  private statusOf(text: string): { status?: string; serverUrl?: string | null; userEmail?: string | null } {
    try { return JSON.parse(text) as { status?: string; serverUrl?: string | null; userEmail?: string | null }; }
    catch { return {}; }
  }

  private async call(credentials: BitwardenCredentials, args: string[]): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const key = this.session?.credentials === credentialKey(credentials) ? this.session.key : await this.unlock(credentials);
      const result = await this.checkedRun(args, { BW_SESSION: key });
      if (result.code === 0 && !result.timedOut) return result.stdout;
      const problem = bitwardenProblem(result, hostOf(credentials.serverUrl));
      if (!problem.relock || attempt > 0) throw problem;
      this.session = null;
    }
  }

  private async sync(credentials: BitwardenCredentials, force = false): Promise<void> {
    if (!force && this.syncedAt !== null && this.now() - this.syncedAt < SYNC_EVERY_MS) return;
    await this.call(credentials, ["sync"]);
    this.syncedAt = this.now();
  }

  private async item(itemId: string): Promise<BwItem | null> {
    const credentials = this.credentials();
    if (!credentials) return null;
    await this.sync(credentials);
    try { return JSON.parse(await this.call(credentials, ["get", "item", itemId])) as BwItem; }
    catch (error) {
      if (error instanceof BitwardenProblem && !error.gone) throw error;
      return null;
    }
  }

  private secretOf(entry: ItemEntry): LinkedSecret {
    const used = this.lastUsed.get(entry.itemId);
    return { id: `${ID_PREFIX}${entry.itemId}`, name: entry.name, fields: entry.custom.filter((name) => name !== entry.main), source: "linked", provider: this.id,
      bots: "all", readOnly: true, ...(used === undefined ? {} : { lastUsedAt: used }) };
  }

  items(): LinkedItem[] {
    if (!this.credentials()) return [];
    return [
      ...this.logins.map((entry): LinkedItem => {
        const used = this.lastUsed.get(entry.itemId);
        return { kind: "login", id: entry.id, site: entry.site, hosts: [...entry.hosts], exactHost: false, username: entry.username, hasTotp: entry.hasTotp,
          source: "bitwarden", bots: "all", createdAt: 0, ...(used === undefined ? {} : { lastUsedAt: used }) };
      }),
      ...[...this.entries.values()].filter(listedAsSecret).sort((a, b) => a.name.localeCompare(b.name)).map((entry): LinkedItem => ({ kind: "secret", ...this.secretOf(entry) })),
    ];
  }

  resolve(reference: string): { secret: LinkedSecret; field: string } | null {
    const ref = this.credentials() ? parseBitwardenReference(reference) : null;
    if (!ref) return null;
    const all = [...this.entries.values()];
    const byId = all.filter((entry) => entry.itemId === ref.item);
    const found = byId.length ? byId : all.filter((entry) => sameText(entry.name, ref.item));
    if (found.length !== 1) return null;
    const entry = found[0]!;
    const asked = ref.field ?? (entry.type === LOGIN ? "password" : "notes");
    const builtIn = BUILT_IN.find((one) => sameText(one, asked));
    if (builtIn) return entry.has[builtIn] ? { secret: this.secretOf(entry), field: builtIn } : null;
    const custom = entry.custom.find((name) => sameText(name, asked));
    return custom ? { secret: this.secretOf(entry), field: custom } : null;
  }

  referenceItems(): Array<{ secret: LinkedSecret; field: string }> {
    if (!this.credentials()) return [];
    return [...this.entries.values()].flatMap((entry) => [...BUILT_IN.filter((field) => entry.has[field]), ...entry.custom]
      .map((field) => ({ secret: this.secretOf(entry), field })));
  }

  read(itemId: string, field?: string): Promise<LinkedValue> {
    return this.enqueue(this.revision, () => this.readNow(itemId, field));
  }

  private async readNow(itemId: string, field?: string): Promise<LinkedValue> {
    const login = this.logins.find((entry) => entry.id === itemId);
    if (login) {
      const item = await this.item(login.itemId);
      if (!item?.login?.password) return {};
      return { password: item.login.password, totp: parseTotpKey(item.login.totp) };
    }
    const id = itemId.startsWith(ID_PREFIX) ? itemId.slice(ID_PREFIX.length) : "";
    const entry = this.entries.get(id);
    if (!entry) return {};
    const item = await this.item(id);
    const value = item ? valueOf(item, entry, field, this.now()) : undefined;
    return value ? { value } : {};
  }

  markUsed(id: string): void {
    const itemId = this.logins.find((entry) => entry.id === id)?.itemId ?? (id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : "");
    if (this.entries.has(itemId)) this.lastUsed.set(itemId, this.now());
  }
}

export function isBitwardenLoginId(id: string): boolean {
  return id.startsWith(ID_PREFIX);
}

/** Bitwarden for this server: the tool is fetched into `<data>/tools/bitwarden` the first time it is needed, and keeps
 * its own settings and the account's encrypted copy of the vault beside it, which no backup or move carries. */
export function createBitwardenVault(options: { dataDir: string; credentials: () => BitwardenCredentials | null; connectionId?: string }): BitwardenLogins {
  const appDataDir = join(options.dataDir, "tools", "bitwarden", "account");
  const vault = new BitwardenLogins({
    credentials: options.credentials, connectionId: options.connectionId,
    run: bitwardenRunner({ executable: () => installBitwardenCli({ dataDir: options.dataDir }), appDataDir }),
    forgetAppData: () => forgetBitwardenAppData(appDataDir),
  });
  if (options.credentials()) void vault.refresh().catch(() => {});
  return vault;
}
