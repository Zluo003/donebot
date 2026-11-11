import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";

const accountIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const identitiesSchema = z.object({ version: z.literal(1), identities: z.array(z.object({
  accountId: accountIdSchema, installationId: z.uuid(),
}).strict()).max(10_000) }).strict();

export class DoneBotInstallationIdentity {
  private readonly path: string;

  constructor(path: string) { this.path = path; }

  resolve(accountId: string, previousId?: string): string {
    accountIdSchema.parse(accountId);
    let saved: z.infer<typeof identitiesSchema> = { version: 1, identities: [] };
    try {
      const source = readFileSync(this.path, "utf8");
      if (source.length > 2 * 1024 * 1024) throw new Error("DoneBot installation identity file is too large.");
      saved = identitiesSchema.parse(JSON.parse(source));
      if (new Set(saved.identities.map(identity => identity.accountId)).size !== saved.identities.length ||
          new Set(saved.identities.map(identity => identity.installationId)).size !== saved.identities.length) throw new Error("DoneBot installation identities must be unique.");
      chmodSync(this.path, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const existing = saved.identities.find(identity => identity.accountId === accountId);
    if (existing) return existing.installationId;
    const installationId = previousId === undefined ? randomUUID() : z.uuid().parse(previousId);
    if (saved.identities.some(identity => identity.installationId === installationId)) throw new Error("This installation identity belongs to another DoneBot account.");
    saved.identities.push({ accountId, installationId });
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.path, JSON.stringify(saved) + "\n", { mode: 0o600 });
    return installationId;
  }
}
