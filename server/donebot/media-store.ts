import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { mediaDiagnosticSchema } from "./media-errors.ts";
import { mediaLayerSchema } from "./media-layers.ts";

export const mediaKindSchema = z.enum(["image", "video", "music"]);
export type MediaKind = z.infer<typeof mediaKindSchema>;
const scopeSchema = z.object({ accountId: z.string().min(1), installationId: z.string().min(1) });
export type MediaScope = z.infer<typeof scopeSchema>;

const artifactSchema = z.object({
  id: z.string().min(1), path: z.string().min(1), mime: z.string().min(1), name: z.string().min(1), bytes: z.number().int().nonnegative(),
  layer: mediaLayerSchema.optional(),
});
export type MediaArtifact = z.infer<typeof artifactSchema>;

const jobSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), operationKey: z.string(), fingerprint: z.string(), scope: scopeSchema,
  botId: z.string().min(1), threadId: z.string().min(1), turnId: z.string().min(1), kind: mediaKindSchema,
  model: z.string().min(1).optional(), adapter: z.string().min(1).optional(), operation: z.enum(["generate", "edit", "extend"]),
  status: z.enum(["queued", "submitting", "submitted", "running", "downloading", "completed", "failed", "cancelled", "uncertain"]),
  parameters: z.record(z.string(), z.unknown()).optional(),
  referenceFingerprint: z.record(z.string(), z.unknown()).optional(),
  taskId: z.string().optional(), receiptId: z.string().optional(), error: z.string().optional(),
  diagnostic: mediaDiagnosticSchema.optional(),
  generationEndedAt: z.number().optional(),
  artifacts: z.array(artifactSchema), waitingStopped: z.boolean(), createdAt: z.number(), updatedAt: z.number(),
  publishedAt: z.number().optional(), deliveredAt: z.number().optional(), retrievalNotifiedAt: z.number().optional(), uncertainNotifiedAt: z.number().optional(),
  nextPollAt: z.number(), attempts: z.number().int().nonnegative(),
});
export type MediaJob = z.infer<typeof jobSchema>;

export function mediaScopeKey(scope: MediaScope): string {
  return JSON.stringify([scope.accountId, scope.installationId]);
}

export class MediaJobStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS donebot_media_jobs (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        operation_key TEXT NOT NULL,
        json TEXT NOT NULL,
        UNIQUE(scope, operation_key)
      );
      CREATE TABLE IF NOT EXISTS donebot_media_dispatch (
        scope TEXT PRIMARY KEY,
        dispatched_at REAL NOT NULL
      );
    `);
  }

  get(id: string): MediaJob | undefined {
    const row = this.db.prepare("SELECT json FROM donebot_media_jobs WHERE id = ?").get(id);
    return row ? jobSchema.parse(JSON.parse(String(row.json))) : undefined;
  }

  operation(scope: MediaScope, key: string): MediaJob | undefined {
    const row = this.db.prepare("SELECT json FROM donebot_media_jobs WHERE scope = ? AND operation_key = ?").get(mediaScopeKey(scope), key);
    return row ? jobSchema.parse(JSON.parse(String(row.json))) : undefined;
  }

  put(job: MediaJob): void {
    const checked = jobSchema.parse(job);
    this.db.prepare(`INSERT INTO donebot_media_jobs(id, scope, operation_key, json) VALUES(?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET json = excluded.json`).run(checked.id, mediaScopeKey(checked.scope), checked.operationKey, JSON.stringify(checked));
  }

  pending(): MediaJob[] {
    return this.db.prepare("SELECT json FROM donebot_media_jobs ORDER BY rowid").all()
      .map(row => jobSchema.parse(JSON.parse(String(row.json))))
      .filter(job => job.status !== "cancelled" && (job.status !== "uncertain" || Boolean(job.taskId || job.receiptId) || !job.uncertainNotifiedAt && !job.waitingStopped) &&
        (!["completed", "failed"].includes(job.status) || (!job.deliveredAt && !job.waitingStopped)));
  }

  queued(scope: MediaScope): MediaJob[] {
    return this.pending().filter(job => job.status === "queued" && mediaScopeKey(job.scope) === mediaScopeKey(scope));
  }

  activeCount(accountId: string): number {
    return this.db.prepare("SELECT json FROM donebot_media_jobs").all().reduce((count, row) => {
      const job = jobSchema.parse(JSON.parse(String(row.json)));
      return count + Number(job.scope.accountId === accountId && job.generationEndedAt === undefined && ["submitting", "submitted", "running", "uncertain"].includes(job.status));
    }, 0);
  }

  dispatchAt(scope: MediaScope): number | undefined {
    const row = this.db.prepare("SELECT dispatched_at FROM donebot_media_dispatch WHERE scope = ?").get(mediaScopeKey(scope));
    return row ? Number(row.dispatched_at) : undefined;
  }

  claim(job: MediaJob, limit: number, total: number, activeModels: number, now: number): MediaJob | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get(job.id);
      const previous = this.dispatchAt(job.scope);
      const media = this.activeCount(job.scope.accountId);
      if (current?.status !== "queued" || media >= limit || media + activeModels >= total || previous !== undefined && now - previous < 1000) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const next = { ...current, status: "submitting" as const, updatedAt: now, error: undefined, diagnostic: undefined };
      this.put(next);
      this.db.prepare("INSERT INTO donebot_media_dispatch(scope, dispatched_at) VALUES(?, ?) ON CONFLICT(scope) DO UPDATE SET dispatched_at = excluded.dispatched_at").run(mediaScopeKey(job.scope), now);
      this.db.exec("COMMIT");
      return next;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  close(): void { this.db.close(); }
}
