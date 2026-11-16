import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { HandoffView } from "../coordinator.ts";
import type { Store } from "../store.ts";
import type { DoneBotGateway } from "./gateway.ts";
import { createDoneBotMediaHost } from "./host.ts";
import { MediaJobStore, type MediaJob } from "./media-store.ts";

it("binds media continuations to their assignment and account, batches results, and persists their acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "donebot-media-followup-"));
  const scope = { accountId: "owner", installationId: "installation" };
  let current: typeof scope | null = scope;
  const node = { id: "assignment", botId: "artist", threadId: "work" } as HandoffView;
  const base: MediaJob = { version: 1, id: "00000000-0000-4000-8000-000000000001", operationKey: "first", fingerprint: "first", scope,
    botId: node.botId, threadId: node.threadId, turnId: "execution", assignmentId: node.id, kind: "image", operation: "generate",
    status: "running", artifacts: [], waitingStopped: false, createdAt: 1, updatedAt: 1, nextPollAt: Date.now() + 60_000, attempts: 0 };
  const disk = new MediaJobStore(join(root, "donebot", "media.sqlite"));
  const second = { ...base, id: "00000000-0000-4000-8000-000000000002", operationKey: "second", status: "failed" as const, deliveredAt: 10, error: "Synthetic failure" };
  disk.put(base); disk.put(second);
  const gateway = { scope: () => current, bindMediaActivity: () => {} } as unknown as DoneBotGateway;
  const open = () => createDoneBotMediaHost({ store: {} as Store, gateway, dataDir: root, attachmentsDir: join(root, "attachments"), enabled: false,
    fullAccess: () => true, messageFileRootsForThread: () => [], canReadThread: () => true, wrote: () => {} });
  let host = open();
  try {
    const cap = host.continuation(node)!;
    expect(cap.mediaJobIds).toEqual([base.id, second.id]);
    const waiting = { ...node, continuation: { ...cap, count: 1 } } as HandoffView;
    expect(host.waiting(waiting)).toBe(true);
    expect(host.continuation({ ...node, id: "unrelated" })).toBeUndefined();
    expect(host.followup({ ...node, botId: "other" }, [base.id])).toContain('"status":"unavailable"');
    expect(disk.get(base.id)?.followupStartedAt).toBeUndefined();
    current = null;
    expect(host.waiting(waiting)).toBe(true);
    current = { ...scope, accountId: "someone-else" };
    expect(host.waiting(waiting)).toBe(false);
    expect(host.followup(node, [second.id])).not.toContain("Synthetic failure");
    expect(disk.get(second.id)?.followupStartedAt).toBeUndefined();
    current = scope;
    disk.put({ ...base, status: "completed", deliveredAt: 20, artifacts: [{ id: "artifact", path: "/private/synthetic.png", name: "synthetic.png", mime: "image/png", bytes: 1 }] });
    expect(host.waiting(waiting)).toBe(false);
    const note = host.followup(node, cap.mediaJobIds!);
    expect(note).toContain("image/png");
    expect(note).toContain("Synthetic failure");
    await host.close(); host = open();
    expect(host.continuation(node)).toBeUndefined();
    expect(disk.get(base.id)?.followupStartedAt).toBeTypeOf("number");
  } finally { await host.close(); disk.close(); await rm(root, { recursive: true, force: true }); }
});
