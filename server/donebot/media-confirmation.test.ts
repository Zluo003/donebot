import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Message, Store } from "../store.ts";
import type { DoneBotGateway } from "./gateway.ts";
import { createDoneBotMediaHost } from "./host.ts";
import { MediaJobStore, type MediaJob } from "./media-store.ts";

it.each(["allow", "deny", "stopped", "account", "revoked", "full-deny"])("restores a video confirmation before its first background poll: %s", async scenario => {
  const root = await mkdtemp(join(tmpdir(), "donebot-confirmation-"));
  const scope = { accountId: "fixture-account", installationId: "fixture-installation" };
  const job: MediaJob = { version: 1, id: "00000000-0000-4000-8000-000000000001", operationKey: "operation", fingerprint: "primary",
    scope, botId: "bot", threadId: "thread", turnId: "turn", kind: "video", model: "muse-video", operation: "generate",
    status: "failed", fallbackEligible: true, fallbackDecision: "pending", artifacts: [], waitingStopped: scenario === "stopped",
    createdAt: 1, updatedAt: 1, nextPollAt: Date.now() + 30_000, attempts: 0,
    fallback: { model: "seedance-2-5", adapter: "seedance.videos.v1", operation: "generate", parameters: {}, referenceFingerprint: {}, fingerprint: "backup" } };
  const disk = new MediaJobStore(join(root, "donebot", "media.sqlite")); disk.put(job); disk.close();
  const messages = [{ id: "card", role: "bot", kind: "options", sendId: `donebot_media_${job.id}_fallback_confirmation`,
    card: { title: "Confirm backup", options: ["Allow", "Deny"], requestId: "confirmation", tool: "donebot_media" } }] as Message[];
  const bot = { id: "bot", toolScope: { allow: [scenario === "revoked" ? "mcp:agents:generate_image" : "mcp:agents:generate_video"] } };
  const store = { bot: () => bot, botByThread: () => bot, groupByThread: () => undefined, messagesFor: (thread: string) => thread === "thread" ? messages : [],
    patchMessage: (_thread: string, id: string, patch: object) => Object.assign(messages.find(message => message.id === id)!, patch),
  } as unknown as Store;
  const gateway = { scope: () => scenario === "account" ? null : scope, bindMediaActivity: () => {} } as unknown as DoneBotGateway;
  const host = createDoneBotMediaHost({ store, gateway, dataDir: root, attachmentsDir: join(root, "attachments"), enabled: false,
    fullAccess: () => scenario === "full-deny", messageFileRootsForThread: () => [], canReadThread: () => true, wrote: () => {} });
  try {
    expect(host.answerCard("another-thread", "confirmation", "allow")).toBeNull();
    const behavior = scenario === "deny" || scenario === "full-deny" ? "deny" : "allow";
    expect(host.answerCard("thread", "confirmation", behavior)).toBe(scenario === "allow" ? "allowed-once" : "rejected");
    if (scenario === "allow" || behavior === "deny") expect(messages[0]!.card!.answered).toBe(behavior);
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});
