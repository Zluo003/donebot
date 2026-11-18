import { unifiedAdapter, unifiedMedia } from "./unified-media.ts";
import { createHash } from "node:crypto";
import { MEDIA_ADAPTERS } from "./media-adapters.ts";
import { MediaReferenceUnsupported, type MediaAssetCache } from "./media-assets.ts";
import type { MediaContext, MediaSubmission, MediaResolvedModel } from "./media.ts";
import type { MediaFallback, MediaJob, MediaScope } from "./media-store.ts";

export async function prepareMediaFallback(input: MediaSubmission, context: MediaContext, scope: MediaScope, assets: MediaAssetCache,
  resolve: (id: string, kind: MediaSubmission["kind"]) => Promise<MediaResolvedModel>, fingerprint: (value: unknown) => string,
  primaryFingerprint: Record<string, unknown>, unavailable?: (reason: string) => void): Promise<MediaFallback | undefined> {
  const fallback = input.fallback;
  if (!fallback) return undefined;
  if (input.kind === "music" || fallback.model === input.model) throw new Error("A fallback must be a different image or video model.");
  const model = await resolve(fallback.model, input.kind);
  const adapterId = unifiedAdapter(input.kind, model.adapter, fallback.parameters);
  const adapter = MEDIA_ADAPTERS[adapterId];
  const operation = fallback.operation ?? input.operation ?? "generate";
  if (model.id !== fallback.model || model.kind !== input.kind || adapter?.kind !== input.kind || operation === "edit" && input.kind === "image" && !adapter.edit) throw new Error("The fallback has no compatible media adapter.");
  if (fallback.parameters.model !== undefined && fallback.parameters.model !== fallback.model) throw new Error("Fallback parameters do not match the fallback model.");
  for (const [key, value] of Object.entries(model.fixedParameters ?? {})) {
    if (fallback.parameters[key] !== undefined && fallback.parameters[key] !== value) throw new Error(`${key} is fixed for the fallback model.`);
  }
  const parameters = { ...fallback.parameters, ...model.fixedParameters };
  let normalized: Record<string, unknown>;
  try { normalized = model.normalizeParameters?.(parameters, operation) ?? parameters; }
  catch (error) { if (!unifiedMedia(parameters)) throw error; unavailable?.(`${fallback.model}: ${error instanceof Error ? error.message : String(error)}`); return undefined; }
  if (Buffer.byteLength(JSON.stringify(normalized)) > 1_000_000) throw new Error("Fallback parameters exceed the local limit.");
  let prepared: Awaited<ReturnType<MediaAssetCache["prepare"]>>;
  try { prepared = await assets.prepare(context, scope, normalized, undefined, model.referencePolicy); }
  catch (error) { if (!unifiedMedia(parameters) || !(error instanceof MediaReferenceUnsupported)) throw error; unavailable?.(`${fallback.model}: ${error.message}`); return undefined; }
  try { model.validate?.(prepared.parameters, operation); }
  catch (error) { if (!unifiedMedia(parameters)) throw error; unavailable?.(`${fallback.model}: ${error instanceof Error ? error.message : String(error)}`); return undefined; }
  if (JSON.stringify(referenceFiles(primaryFingerprint)) !== JSON.stringify(referenceFiles(prepared.fingerprint))) throw new Error("Fallback parameters must preserve the primary request's reference files. Use no fallback with an explanation when its model cannot accept those references.");
  return { model: model.id, adapter: adapterId, operation, parameters: normalized, referenceFingerprint: prepared.fingerprint,
    fingerprint: fingerprint({ kind: input.kind, model: model.id, operation, parameters: prepared.fingerprint }) };
}

function referenceFiles(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const data = value as Record<string, unknown>;
  if (typeof data.sha256 === "string" && typeof data.mime === "string") return [`${data.sha256}:${data.mime}`];
  return Object.values(data).flatMap(referenceFiles).sort();
}

export function mediaFallbackPatch(job: MediaJob, now: number): Partial<MediaJob> | undefined {
  const fallback = job.fallback;
  if (job.status !== "failed" || !job.fallbackEligible || !fallback || job.waitingStopped || job.previousAttempts?.length) return undefined;
  return { ...fallback, fallback: undefined, fallbackEligible: false,
    previousAttempts: [{ model: job.model!, taskId: job.taskId, receiptId: job.receiptId, error: job.error }],
    dispatchKey: createHash("sha256").update(`${job.operationKey}:fallback:${fallback.model}`).digest("hex"),
    status: "queued", taskId: undefined, receiptId: undefined, error: undefined, diagnostic: undefined,
    generationEndedAt: undefined, nextPollAt: now, attempts: 0, uncertainNotifiedAt: undefined, retrievalNotifiedAt: undefined,
  };
}
