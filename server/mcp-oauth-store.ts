// Kept apart from config.json so a pasted or exported config never carries a token; a token never follows its entry to another URL.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";

const tokensSchema = z.object({
  access: z.string().min(1),
  refresh: z.string().min(1).optional(),
  expiresAt: z.number().optional(),
  scope: z.string().optional(),
});

const recordSchema = z.object({
  url: z.string(),
  state: z.enum(["needs-sign-in", "signed-in"]),
  issuer: z.string().optional(),
  clientId: z.string().optional(),
  /** The secret stays in config.json; it is never kept here. */
  tokenAuth: z.enum(["client_secret_post", "client_secret_basic"]).optional(),
  redirectUri: z.string().optional(),
  tokenEndpoint: z.string().optional(),
  revocationEndpoint: z.string().optional(),
  tokens: tokensSchema.optional(),
});

const fileSchema = z.object({
  servers: z.record(z.string(), recordSchema).default({}),
  /** Refresh tokens already sent to a token endpoint, per server. Presenting one of them again can be a replay, so the
   * mark is kept here and not in memory: a restart must not present it either. */
  spentRefresh: z.record(z.string(), z.string().min(1)).default({}),
});

export type McpOAuthTokens = z.infer<typeof tokensSchema>;
export type McpOAuthRecord = z.infer<typeof recordSchema>;
interface StoreFile {
  servers: Record<string, McpOAuthRecord>;
  spentRefresh: Record<string, string>;
}

/** One sign-in as this store keeps it, from anywhere else (a sign-in moved from the person's own computer); null if not. */
export function parseMcpOAuthRecord(value: unknown): McpOAuthRecord | null {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export class McpOAuthStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  get(name: string, url: string): McpOAuthRecord | undefined {
    const record = this.read().servers[name];
    return record && record.url === url ? record : undefined;
  }

  put(name: string, record: McpOAuthRecord): void {
    const data = this.read();
    data.servers[name] = recordSchema.parse(record);
    this.write(data);
  }

  delete(name: string): void {
    const data = this.read();
    if (!Object.hasOwn(data.servers, name) && !Object.hasOwn(data.spentRefresh, name)) return;
    delete data.servers[name];
    delete data.spentRefresh[name];
    this.write(data);
  }

  forgetSpentRefresh(name: string): void {
    const data = this.read();
    if (!Object.hasOwn(data.spentRefresh, name)) return;
    delete data.spentRefresh[name];
    this.write(data);
  }

  spentRefreshFor(name: string): string | undefined {
    return this.read().spentRefresh[name];
  }

  markSpentRefresh(name: string, token: string): void {
    const data = this.read();
    data.spentRefresh = { ...data.spentRefresh, [name]: token };
    this.write(data);
  }

  clearSpentRefresh(name: string, token: string): void {
    const data = this.read();
    if (data.spentRefresh[name] !== token) return;
    delete data.spentRefresh[name];
    this.write(data);
  }

  // Read through on every call: another process may have changed the file.
  private read(): StoreFile {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
      if (parsed.success) return parsed.data;
    } catch {
    }
    return { servers: {}, spentRefresh: {} };
  }

  private write(data: StoreFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }
}
