import { randomUUID } from "node:crypto";
import type { ProviderRegistry } from "../harness/registry.ts";
import type { BotRecord, Store } from "../store.ts";

interface ExternalContextDeps {
  store: Pick<Store, "taskByThread" | "patchTask">;
  botForThread(botId: string, threadId: string): BotRecord | null;
  registry: Pick<ProviderRegistry, "get">;
}

// Provider sessions only know their own turns' messages, so a harness-appended result marks the task for one replay; the unique suffix keeps a newer marker through a racing replay.
const EXTERNAL_CONTEXT_MARKER_PREFIX = "__openmaus_external_context__:";

export function createExternalContext({ store, botForThread, registry }: ExternalContextDeps) {
  function isExternalContextMarker(value: string | undefined): boolean {
    return Boolean(value?.startsWith(EXTERNAL_CONTEXT_MARKER_PREFIX));
  }

  function markTaskContextExternallyUpdated(bot: BotRecord, threadId: string): void {
    const task = store.taskByThread(bot.id, threadId);
    if (!task) return;
    const owner = task.lastInstanceId;
    const record = owner ? task.handedMessages?.[owner] : undefined;
    if (owner && record?.session !== undefined && record.session === task.resumeCursors[owner] &&
      (botForThread(bot.id, threadId) ?? bot).modelSelection.instanceId === owner &&
      registry.get(owner)?.adapter.capabilities.strictResume) return;
    store.patchTask(bot.id, threadId, {
      resumeCursors: {},
      lastInstanceId: `${EXTERNAL_CONTEXT_MARKER_PREFIX}${randomUUID()}`,
    });
  }

  return { isExternalContextMarker, markTaskContextExternallyUpdated };
}
