import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { MARKET_INSTALL_HEADER, type MarketInstalledBotInfo } from "../../shared/donebot-market.ts";
import { writeFileAtomic } from "../atomic.ts";

export { MARKET_INSTALL_HEADER };

export interface MarketInstallRecord {
  botId: string;
  installId: string;
  listingId: string;
  releaseId: string;
  version: number;
  installToken: string;
  expiresAt: string;
  installedAt: number;
}

const recordSchema = z.object({
  botId: z.string().min(1).max(128),
  installId: z.string().min(1).max(128),
  listingId: z.string().min(1).max(128),
  releaseId: z.string().min(1).max(128),
  version: z.number().int().positive(),
  installToken: z.string().min(16).max(1024),
  expiresAt: z.string().min(1).max(80),
  installedAt: z.number().finite(),
});

const fileSchema = z.object({
  version: z.literal(1),
  records: z.record(z.string(), recordSchema),
});

const marketBotStorage = new AsyncLocalStorage<string>();

export function runWithMarketBot<T>(botId: string | undefined, fn: () => T): T {
  const clean = botId?.trim();
  if (!clean) return fn();
  return marketBotStorage.run(clean, fn);
}

export function currentMarketBotId(): string | undefined {
  return marketBotStorage.getStore();
}

export function attachMarketInstallHeader(init: RequestInit, token: string | undefined): RequestInit {
  if (!token) return init;
  const headers = new Headers(init.headers);
  if (!headers.has(MARKET_INSTALL_HEADER)) {
    headers.set(MARKET_INSTALL_HEADER, token);
  }
  return { ...init, headers };
}

export class DoneBotMarketInstallStore {
  private readonly filePath: string;
  private records = new Map<string, MarketInstallRecord>();
  private loaded = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(this.filePath)) return;
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
      const parsed = fileSchema.safeParse(raw);
      if (!parsed.success) return;
      for (const [botId, rec] of Object.entries(parsed.data.records)) {
        this.records.set(botId, rec);
      }
    } catch {
      // Corrupt attribution file degrades safely to empty map without breaking startup.
    }
  }

  private persist() {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const payload = {
        version: 1 as const,
        records: Object.fromEntries(this.records.entries()),
      };
      writeFileAtomic(this.filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    } catch {
      // Best-effort persistence.
    }
  }

  get(botId: string | undefined): MarketInstallRecord | undefined {
    const id = botId?.trim();
    if (!id) return undefined;
    this.ensureLoaded();
    return this.records.get(id);
  }

  getActiveToken(botId: string | undefined, nowMs = Date.now()): string | undefined {
    const rec = this.get(botId);
    if (!rec?.installToken) return undefined;
    const exp = Date.parse(rec.expiresAt);
    if (Number.isFinite(exp) && exp <= nowMs) return undefined;
    return rec.installToken;
  }

  set(record: MarketInstallRecord): void {
    this.ensureLoaded();
    this.records.set(record.botId, record);
    this.persist();
  }

  delete(botId: string): void {
    this.ensureLoaded();
    if (this.records.delete(botId)) this.persist();
  }

  findByListingId(listingId: string, existingBotIds?: ReadonlySet<string>): MarketInstallRecord | undefined {
    this.ensureLoaded();
    let best: MarketInstallRecord | undefined;
    for (const rec of this.records.values()) {
      if (rec.listingId !== listingId) continue;
      if (existingBotIds && !existingBotIds.has(rec.botId)) continue;
      if (!best || rec.installedAt > best.installedAt) best = rec;
    }
    return best;
  }

  publicByListing(existingBotIds: ReadonlySet<string>): Record<string, MarketInstalledBotInfo> {
    this.ensureLoaded();
    const out: Record<string, MarketInstalledBotInfo> = {};
    for (const rec of this.records.values()) {
      if (!existingBotIds.has(rec.botId)) continue;
      const prev = out[rec.listingId];
      if (!prev || rec.installedAt > prev.installed_at) {
        out[rec.listingId] = {
          bot_id: rec.botId,
          install_id: rec.installId,
          listing_id: rec.listingId,
          release_id: rec.releaseId,
          version: rec.version,
          expires_at: rec.expiresAt,
          installed_at: rec.installedAt,
        };
      }
    }
    return out;
  }
}
