import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DoneBotGateway, type DoneBotCredential } from "./gateway.ts";
import { codingModels } from "./coding-models.ts";
import { startCodingProxy } from "./coding-proxy.ts";
import { startFakeDoneBotGateway, FAKE_DONEBOT_CATALOG } from "../testing/fake-donebot-gateway.ts";

it.each([false, true])("loads native groups independently and preserves native reasoning (cloud=%s)", async cloud => {
  const id = randomUUID(), token = "synthetic-native-coding-installation";
  const aggregate = structuredClone(FAKE_DONEBOT_CATALOG);
  aggregate.models = aggregate.models.filter(model => !model.id.startsWith("gpt-") && !model.id.startsWith("claude-"));
  const fixture = await startFakeDoneBotGateway(aggregate, new Map([[token, id]]));
  fixture.setCodingModels("codex", ["gpt-6.1-sol", "custom-codex-alias"]);
  fixture.setCodingModels("claude", ["claude-sonnet-5-5"]);
  let saved: DoneBotCredential | null = cloud ? { mode: "installation", accessToken: "", credential: token, installationId: id,
    user: { id: "fixture-user", email: "synthetic@example.invalid" }, expiresAt: Number.MAX_SAFE_INTEGER } : null;
  const gateway = new DoneBotGateway({ persistent: false, load: async () => saved, save: async next => { saved = next; } }, { testOrigin: fixture.origin });
  const bridges: Awaited<ReturnType<typeof startCodingProxy>>[] = [];
  try {
    if (cloud) await gateway.restore(); else await gateway.login("synthetic@example.invalid", "synthetic-fixture-password");
    expect(gateway.models()?.models.some(model => model.id === "gpt-6.1-sol")).toBe(false);
    expect(codingModels("codex", gateway.codingCatalog("codex")).options.map(model => model.id)).toEqual(["gpt-6.1-sol", "custom-codex-alias"]);
    expect(codingModels("claude", gateway.codingCatalog("claude")).default).toBe("claude-sonnet-5-5");
    for (const engine of ["codex", "claude"] as const) {
      const proxy = await startCodingProxy(gateway, engine, gateway.scope()); bridges.push(proxy);
      const path = engine === "codex" ? "/v1/responses" : "/v1/messages";
      const controls = engine === "codex" ? { reasoning: { effort: "xhigh" } } : { output_config: { effort: "high" }, thinking: { type: "adaptive" } };
      const response = await fetch(proxy.url + path, { method: "POST", headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json",
        "x-donebot-coding-engine": engine === "codex" ? "claude" : "codex" }, body: JSON.stringify({ model: codingModels(engine, gateway.codingCatalog(engine)).default, messages: [], input: "synthetic", ...controls }) });
      expect(response.status).toBe(200); await response.text();
      expect(fixture.requests.at(-1)).toMatchObject({ path, codingEngine: engine, authenticated: true, body: controls });
    }
    await gateway.requestForScope(gateway.scope()!, "/v1/models", { headers: { "x-donebot-coding-engine": "codex" } }).then(response => response.json());
    expect(fixture.requests.at(-1)?.codingEngine).toBeUndefined();
    fixture.setCodingModels("codex", []); await gateway.refreshCodingCatalog("codex");
    expect(codingModels("codex", gateway.codingCatalog("codex")).options).toEqual([]);
    await gateway.logout();
    expect(gateway.codingCatalog("claude")).toBeNull();
    expect(saved).toBeNull();
    const response = await fetch(bridges[0]!.url + "/v1/responses", { method: "POST", headers: { authorization: `Bearer ${bridges[0]!.token}` } });
    expect(response.status).toBe(401);
  } finally {
    for (const proxy of bridges) await proxy.close();
    await fixture.close();
  }
});
