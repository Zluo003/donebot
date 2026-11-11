import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DoneBotGateway, type DoneBotCredential, type DoneBotCredentialStore } from "./gateway.ts";
import { DoneBotInstallationIdentity } from "./installation-identity.ts";
import { DoneBotMediaService, type DoneBotMediaDeps } from "./media.ts";

const roots: string[] = [], services: DoneBotMediaService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory() { const root = await mkdtemp(join(tmpdir(), "donebot-installation-")); roots.push(root); return root; }
function vault(initial: DoneBotCredential | null = null): DoneBotCredentialStore & { current: DoneBotCredential | null } {
  return { persistent: false, current: initial, async load() { return this.current; }, async save(value) { this.current = value; } };
}
const catalog = { gateway_contract_version: 3, catalog_scope_id: "fixture", catalog_version: "v1", defaults: {}, models: [] };
const json = (body: unknown, status = 200) => Response.json(body, { status });

describe("DoneBot non-secret installation identity", () => {
  it("keeps identities across store instances and imports an existing installation without sharing it with another account", async () => {
    const path = join(await directory(), "donebot", "installation-identities.json"), oldId = randomUUID();
    const first = new DoneBotInstallationIdentity(path);
    expect(first.resolve("account-one", oldId)).toBe(oldId);
    const second = new DoneBotInstallationIdentity(path);
    expect(second.resolve("account-one")).toBe(oldId);
    const otherId = second.resolve("account-two");
    expect(otherId).not.toBe(oldId);
    expect(() => second.resolve("account-three", oldId)).toThrow("another DoneBot account");
    expect(() => second.resolve("owner@example.invalid")).toThrow();
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved).toEqual({ version: 1, identities: [{ accountId: "account-one", installationId: oldId }, { accountId: "account-two", installationId: otherId }] });
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
    }
  });

  it("does not overwrite a damaged identity file with a new installation", async () => {
    const path = join(await directory(), "identities.json");
    await writeFile(path, "invalid fixture identity data", { mode: 0o600 });
    expect(() => new DoneBotInstallationIdentity(path).resolve("account-one")).toThrow();
    expect(await readFile(path, "utf8")).toBe("invalid fixture identity data");
  });

  it("migrates a saved secure session's installation before logout and preserves it through two-factor sign-in", async () => {
    const path = join(await directory(), "identities.json"), installationId = randomUUID();
    const saved: DoneBotCredential = { user: { id: "fixture-user", email: "fixture@example.invalid" }, accessToken: "fixture-access-secret", refreshToken: "fixture-refresh-secret",
      expiresAt: Date.now() + 3_600_000, installationId, credential: "fixture-installation-secret" };
    const secure = vault(saved), rotated: string[] = [];
    const identities = new DoneBotInstallationIdentity(path);
    const gateway = new DoneBotGateway(secure, { resolveInstallation: (accountId, previous) => identities.resolve(accountId, previous), fetch: (async (url: string | URL | Request) => {
      const endpoint = new URL(String(url)).pathname;
      if (endpoint.endsWith("/auth/login")) return json({ requires_2fa: true, temp_token: "fixture-two-factor-secret" });
      if (endpoint.endsWith("/auth/login/2fa")) return json({ access_token: "fixture-new-access-secret", expires_in: 3600, user: saved.user });
      if (endpoint.endsWith("/installations/claim")) return json({ installation_id: installationId });
      if (endpoint.endsWith("/rotate")) { rotated.push(endpoint); return json({ credential: "fixture-rotated-secret" }); }
      return endpoint.endsWith("/models") ? json(catalog) : json({});
    }) as typeof fetch });
    await gateway.restore(); expect(gateway.scope()?.installationId).toBe(installationId);
    await gateway.logout(); expect(secure.current).toBeNull();
    expect((await gateway.login(saved.user.email, "fixture-password")).requires2fa).toBe(true);
    expect(gateway.scope()).toBeNull();
    await gateway.verify2fa("123456");
    expect(gateway.scope()?.installationId).toBe(installationId);
    expect(rotated).toEqual([`/api/v1/donebot/installations/${installationId}/rotate`]);
    const source = await readFile(path, "utf8");
    expect(source).not.toContain("secret"); expect(source).not.toContain("@"); expect(source).not.toContain("token");
  });

  it("recovers durable media after logout/login and a fresh process without opening another account's jobs", async () => {
    const root = await directory(), path = join(root, "identities.json");
    let accountId = "account-one", now = 10_000, paid = 0;
    const claimed = new Set<string>(), terminal = new Set<string>(), rotations: string[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      const endpoint = new URL(String(url)).pathname;
      if (endpoint.endsWith("/auth/login")) return json({ access_token: "fixture-access", expires_in: 3600, user: { id: accountId, email: `${accountId}@example.invalid` } });
      if (endpoint.endsWith("/installations/claim")) {
        const id = JSON.parse(String(init?.body)).installation_id as string;
        const existing = claimed.has(id); claimed.add(id);
        return json(existing ? { installation_id: id } : { credential: "fixture-installation" });
      }
      if (endpoint.endsWith("/rotate")) { rotations.push(endpoint); return json({ credential: "fixture-rotated" }); }
      if (endpoint.endsWith("/models")) return json(catalog);
      if (endpoint.endsWith("/donebot/account")) return json({ concurrency: 2 });
      if (endpoint === "/v1/images/generations/async") return json({ id: `task-${++paid}` }, 202);
      if (endpoint.startsWith("/v1/images/tasks/")) return json({ status: terminal.has(endpoint.split("/").at(-1)!) ? "failed" : "running" });
      return json({});
    }) as typeof fetch;
    const openGateway = () => {
      const identities = new DoneBotInstallationIdentity(path);
      return new DoneBotGateway(vault(), { fetch: fetcher, resolveInstallation: (id, previous) => identities.resolve(id, previous) });
    };
    let gateway = openGateway();
    await gateway.login("one@example.invalid", "fixture-password");
    const original = gateway.scope()!;
    const context = { botId: "fixture-bot", threadId: "fixture-thread", turnId: "fixture-turn", active: () => true };
    const deps: DoneBotMediaDeps = { dbPath: join(root, "media.sqlite"), artifactDir: join(root, "artifacts"), now: () => now,
      scope: () => gateway.scope(), concurrency: scope => gateway.concurrency(scope), fetchGateway: (endpoint, init, scope) => gateway.requestForScope(scope, endpoint, init),
      resolveModel: async id => ({ id, kind: "image", adapter: "donebot.images.async.v1" }), authorize: async () => {}, capabilities: async () => [], publish: async () => {} };
    const openMedia = () => { const service = new DoneBotMediaService(deps); services.push(service); return service; };
    let media = openMedia();
    const first = await media.submit(context, { kind: "image", model: "fixture-image", parameters: { prompt: "one" } });
    await vi.waitFor(async () => expect((await media.status(context, first.id)).status).toBe("submitted"));
    const queued = await media.submit(context, { kind: "image", model: "fixture-image", parameters: { prompt: "two" } });
    await gateway.logout(); now = 20_000; await media.tick(); expect(paid).toBe(1);
    await gateway.login("one@example.invalid", "fixture-password"); expect(gateway.scope()).toEqual(original);
    terminal.add("task-1"); await media.tick();
    await vi.waitFor(async () => expect((await media.status(context, queued.id)).status).toBe("submitted"));
    expect((await media.status(context, first.id)).status).toBe("failed"); expect(paid).toBe(2);
    await gateway.logout(); await media.close(); services.splice(services.indexOf(media), 1);
    gateway = openGateway(); await gateway.restore(); expect(gateway.scope()).toBeNull();
    await gateway.login("one@example.invalid", "fixture-password"); expect(gateway.scope()).toEqual(original);
    media = openMedia(); terminal.add("task-2"); now = 30_000; await media.tick();
    expect((await media.status(context, queued.id)).status).toBe("failed"); expect(paid).toBe(2);
    expect(rotations).toHaveLength(2);
    await gateway.logout(); accountId = "account-two"; await gateway.login("two@example.invalid", "fixture-password");
    expect(gateway.scope()?.installationId).not.toBe(original.installationId);
    await expect(media.status(context, first.id)).rejects.toMatchObject({ status: 404 });
  });
});
