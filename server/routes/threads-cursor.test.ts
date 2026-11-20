import { rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import { messagePages, pageSize } from "../host/message-pages.ts";
import { closeMessageDb, importThread } from "../message-db.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store, type BotRecord } from "../store.ts";
import { ThreadCache } from "../thread-cache.ts";
import { dispatchRoutes } from "./table.ts";
import { createThreadRoutes, type ThreadRouteDeps } from "./threads.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const servers: Server[] = [];

beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(store: Store, hidden: string): Promise<string> {
  const deps = {
    store, viewerFor: () => ({}),
    visibleTo: () => ({ everything: true, bot: (id: string) => id !== hidden, group: () => true, thread: () => true, sections: () => [] }),
    workspaceAccess: () => null, desktopMutationToken: () => undefined, companionMutationToken: () => undefined, cliOwnerToken: () => undefined,
    groupUsageReader: { refresh: () => {} },
    pageSize, defaultPage: 50, ...messagePages(store),
    wireBot: (bot: BotRecord) => ({ id: bot.id, threadId: bot.threadId, name: bot.name }),
    publicBotQueuedMessages: () => ({}),
    publicGroupState: () => ({}),
    botComputerControlSnapshot: () => ({ held: false, helpReason: null }),
  } as unknown as ThreadRouteDeps;
  const routes = [createThreadRoutes(deps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as RequestAuth;
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("GET /api/threads/:id/messages with before", () => {
  const history = (count: number) => Array.from({ length: count }, (_, index) => ({
    id: `m-${index + 1}`,
    parentId: index === 0 ? null : `m-${index}`,
    at: count - index,
    role: "user" as const,
    kind: "text" as const,
    text: `Message ${index + 1}`,
  }));

  async function getPage(base: string, threadId: string, before: string, limit?: number) {
    const query = new URLSearchParams({ before });
    if (limit !== undefined) query.set("limit", String(limit));
    const response = await fetch(`${base}/api/threads/${threadId}/messages?${query}`);
    return { status: response.status, body: await response.json() };
  }

  it("serves a cold conversation page without loading its transcript into the cache", async () => {
    const store = new Store(() => sonnet);
    const { threadId } = store.createBot({ name: "History" }, { seedMessages: false });
    const other = store.createBot({ name: "Other" }, { seedMessages: false });
    const messages = history(260);
    messages[259].parentId = "m-258";
    importThread(threadId, messages, "m-259");
    importThread(other.threadId, [{ ...history(1)[0], id: "foreign" }], null);
    const base = await serve(store, "");
    const load = vi.spyOn(ThreadCache.prototype, "load");

    const page = await getPage(base, threadId, "m-256", 200);
    expect(page).toEqual({
      status: 200,
      body: { messages: messages.slice(55, 255), hasMore: true, activeLeafId: "m-259" },
    });
    expect(await getPage(base, threadId, "m-56", 200)).toEqual({
      status: 200,
      body: { messages: messages.slice(0, 55), hasMore: false, activeLeafId: "m-259" },
    });
    expect(await getPage(base, threadId, "m-56")).toEqual({
      status: 200,
      body: { messages: messages.slice(5, 55), hasMore: true, activeLeafId: "m-259" },
    });
    expect(await getPage(base, threadId, "m-1")).toEqual({
      status: 200, body: { messages: [], hasMore: false, activeLeafId: "m-259" },
    });
    expect(await getPage(base, threadId, "m-2", 0)).toEqual({
      status: 200, body: { messages: [], hasMore: true, activeLeafId: "m-259" },
    });
    expect(await getPage(base, threadId, "foreign")).toEqual({
      status: 404, body: { error: "no such message" },
    });
    expect(load).not.toHaveBeenCalled();

    store.messagesFor(threadId);
    expect(await getPage(base, threadId, "m-256", 200)).toEqual(page);
  });

  it("reconstructs legacy message links and falls back to the conversation's last message", async () => {
    const store = new Store(() => sonnet);
    const { threadId } = store.createBot({ name: "Legacy" }, { seedMessages: false });
    const messages = history(4);
    const legacy = messages.map(({ parentId: _parentId, ...message }) => message);
    writeFileSync(join(DATA_DIR, `messages-${threadId}.json`), JSON.stringify(legacy));
    const base = await serve(store, "");

    const expected = {
      status: 200,
      body: { messages: messages.slice(1, 3), hasMore: true, activeLeafId: "m-4" },
    };
    expect(await getPage(base, threadId, "m-4", 2)).toEqual(expected);
    const reopened = await serve(new Store(() => sonnet), "");
    expect(await getPage(reopened, threadId, "m-4", 2)).toEqual(expected);
  });
});
