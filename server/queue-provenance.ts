import type { ResolvedSender } from "../shared/wire.ts";

export interface QueueProvenance {
  capture(threadId: string, queueId: string, sender: ResolvedSender | undefined): void;
  identity(threadId: string, queueId: string): string;
}

let provenance: QueueProvenance | undefined;

export function useQueueProvenance(value: QueueProvenance | undefined): void { provenance = value; }
export function captureQueueProvenance(threadId: string, queueId: string, sender: ResolvedSender | undefined): void {
  provenance?.capture(threadId, queueId, sender);
}
export function queueProvenanceKey(threadId: string | undefined, queueId: string): string {
  return provenance ? threadId ? provenance.identity(threadId, queueId) : `unbound:${queueId}` : "";
}
