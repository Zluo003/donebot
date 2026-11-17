import { afterEach, expect, it, vi } from "vitest";
import { startCodingProxy } from "./coding-proxy.ts";
import { codingModels } from "./coding-models.ts";
import { FAKE_DONEBOT_CATALOG } from "../testing/fake-donebot-gateway.ts";
import type { DoneBotScope } from "./gateway.ts";

const scope: DoneBotScope = { accountId: "synthetic-user", installationId: "synthetic-installation" };
const bridges: Array<Awaited<ReturnType<typeof startCodingProxy>>> = [];
afterEach(async () => { await Promise.all(bridges.splice(0).map(bridge => bridge.close())); });
const setup = async (engine: "codex" | "claude" = "codex") => {
  let current: DoneBotScope | null = scope;
  const request = vi.fn(async (_scope: DoneBotScope, _path: string, _init: RequestInit, _engine?: "codex" | "claude") => new Response("data: synthetic\n\n", { headers: { "content-type": "text/event-stream", "set-cookie": "private" } }));
  const bridge = await startCodingProxy({ scope: () => current, codingCatalog: () => FAKE_DONEBOT_CATALOG, requestForScope: request }, engine, scope);
  bridges.push(bridge);
  const post = (path = engine === "codex" ? "/v1/responses" : "/v1/messages", body: unknown = { model: codingModels(engine, FAKE_DONEBOT_CATALOG).default }, extra: RequestInit = {}) => fetch(bridge.url + path, {
    method: "POST", body: JSON.stringify(body), ...extra, headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json", ...extra.headers },
  });
  return { bridge, request, post, change: (next: DoneBotScope | null) => { current = next; } };
};

it.each(["codex", "claude"] as const)("streams %s native protocol without leaking credentials or upstream headers", async engine => {
  const { post, request } = await setup(engine);
  const response = await post(undefined, { model: codingModels(engine, FAKE_DONEBOT_CATALOG).default, ...(engine === "codex" ? { reasoning: { effort: "xhigh" } } : { output_config: { effort: "high" }, thinking: { type: "adaptive" } }) }, { headers: { cookie: "secret", "x-api-key": "unrelated", "anthropic-version": "2023-06-01", "x-destination-url": "https://invalid.example" } });
  expect(response.status).toBe(200); expect(await response.text()).toBe("data: synthetic\n\n");
  expect(response.headers.get("set-cookie")).toBeNull(); expect(response.headers.get("cache-control")).toBe("no-store");
  const [bound, path, init] = request.mock.calls[0]!;
  expect(request.mock.calls[0]![3]).toBe(engine);
  expect(JSON.parse(init.body as string)).toMatchObject(engine === "codex" ? { reasoning: { effort: "xhigh" } } : { output_config: { effort: "high" }, thinking: { type: "adaptive" } });
  expect(bound).toEqual(scope); expect(path).toBe(engine === "codex" ? "/v1/responses" : "/v1/messages");
  expect([...new Headers(init.headers).keys()]).toEqual(["anthropic-version", "content-type", "user-agent"]);
});

it("rejects forged routes, models, browser requests, auth and changed accounts before dispatch", async () => {
  const { post, request, change, bridge } = await setup();
  for (const path of ["/v1/messages", "/v1/responses?url=evil", "/v1/responses/", "/v1/models", "/api/v1/auth/login"]) expect((await post(path)).status).toBe(404);
  expect((await post(undefined, { model: "claude-opus-4-7" })).status).toBe(403);
  expect((await post(undefined, { model: "gpt-invented" })).status).toBe(403);
  expect((await post(undefined, undefined, { headers: { origin: "http://evil.invalid" } })).status).toBe(401);
  expect((await post(undefined, undefined, { headers: { authorization: "Bearer " + "é".repeat(bridge.token.length) } })).status).toBe(401);
  expect((await post(undefined, undefined, { headers: { authorization: "Bearer invalid" } })).status).toBe(401);
  change({ ...scope, installationId: "another-installation" }); expect((await post()).status).toBe(401);
  change(scope); bridge.revoke(); expect((await post()).status).toBe(401);
  expect(request).not.toHaveBeenCalled();
});

it("aborts upstream streaming when revoked or the client disconnects", async () => {
  for (const disconnect of [false, true]) {
    const { post, request, bridge } = await setup();
    let signal: AbortSignal | undefined;
    request.mockImplementation(async (_scope, _path, init) => {
      signal = init.signal as AbortSignal;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data: first\n\n")); signal!.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true }); } }), { headers: { "content-type": "text/event-stream" } });
    });
    const controller = new AbortController(); const response = await post(undefined, undefined, { signal: controller.signal });
    const reader = response.body!.getReader(); await reader.read();
    if (disconnect) controller.abort(); else bridge.revoke();
    await expect.poll(() => signal?.aborted).toBe(true);
    await reader.cancel().catch(() => {});
  }
});

it("restricts coding models to account-enabled tool-capable native protocols", () => {
  const catalog = structuredClone(FAKE_DONEBOT_CATALOG);
  expect(codingModels("codex", catalog).options.length).toBeGreaterThan(0);
  expect(codingModels("claude", catalog).options.length).toBeGreaterThan(0);
  for (const model of catalog.models) model.capabilities = { tool_calling: false };
  expect(codingModels("codex", catalog).options).toEqual([]);
  expect(codingModels("claude", catalog).options).toEqual([]);
  expect(codingModels("codex", null).default).toBe("");
});
