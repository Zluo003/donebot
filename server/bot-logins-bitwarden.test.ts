import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BotLogins } from "./bot-logins.ts";
import { BitwardenLogins } from "./host/bitwarden-vault.ts";
import type { OnePasswordLogins } from "./onepassword.ts";
import { fakeBw } from "./testing/fake-bw.ts";
import { createMcpKeys, vaultPointer } from "./vault/mcp-keys.ts";
import { HeldSecrets, VaultStore } from "./vault-store.ts";

it("keeps redeemed Bitwarden fields working after restart and invalidates cached MCP keys and login candidates on reconnect", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "donebot-bitwarden-refs-"));
  const credentials = { serverUrl: "https://vault.bitwarden.com", clientId: "user.fixture", clientSecret: "fake-client-key", password: "fake-master" };
  const item = { id: "login", name: "GitHub", type: 1 as const, login: { uris: [{ uri: "https://github.com" }], password: "fake-first-key" } };
  const fake = fakeBw({ ...credentials, email: "fixture@example.test", items: [item] });
  const onePassword = { id: "1password", label: "1Password", fresh: async () => {}, items: () => [], read: async () => ({}), markUsed: () => {} } as unknown as OnePasswordLogins;
  const open = () => {
    const store = new VaultStore({ dataDir });
    const held = new HeldSecrets(store);
    const vault = new BitwardenLogins({ credentials: () => store.bitwardenCredentials(), connectionId: store.bitwardenConnectionId(), run: fake.run });
    const logins = new BotLogins(store, onePassword, () => [], (value) => held.remember(value, "password"), vault);
    const keys = createMcpKeys({ store, linked: { fresh: () => logins.fresh(), byId: (id) => logins.linkedById(id) } });
    return { store, held, vault, logins, keys };
  };
  const spec = (id: string) => ({ command: "fixture", args: [], env: { API_KEY: vaultPointer(id) } });
  try {
    const original = open();
    await original.logins.routes(() => true).bitwarden!.connect(credentials);
    const redeemed = await original.logins.linkedSecret("bw://GitHub/password", "bot");
    expect(redeemed?.value).toBe("fake-first-key");
    const id = redeemed!.id;
    original.keys.grant("fixture", [id]);
    await original.keys.warm("fixture", spec(id));
    expect(original.keys.resolve("fixture", spec(id), "bot")).toMatchObject({ ok: true, server: { env: { API_KEY: "fake-first-key" } } });
    expect(original.held.scrub(credentials.password)).not.toContain(credentials.password);
    expect(original.held.scrub(credentials.clientSecret)).not.toContain(credentials.clientSecret);
    expect(original.held.scrub(redeemed!.value)).not.toContain(redeemed!.value);
    const restarted = open();
    await restarted.logins.fresh();
    expect((await restarted.logins.linkedSecret("bw://login/password", "bot"))?.id).toBe(id);
    await restarted.keys.warm("fixture", spec(id));
    expect(restarted.keys.resolve("fixture", spec(id), "bot")).toMatchObject({ ok: true });
    const candidate = (await restarted.logins.candidates("bot", "github.com"))[0]!;
    await restarted.logins.routes(() => true).bitwarden!.disconnect();
    expect(restarted.keys.resolve("fixture", spec(id), "bot")).toMatchObject({ ok: false, reason: "removed" });
    item.login.password = "fake-reconnected-key";
    await restarted.logins.routes(() => true).bitwarden!.connect(credentials);
    await expect(candidate.secrets()).rejects.toThrow("no longer available");
    expect(restarted.logins.linkedById(id)).toBeNull();
    expect(restarted.keys.resolve("fixture", spec(id), "bot")).toMatchObject({ ok: false, reason: "removed" });
    const next = await restarted.logins.linkedSecret("bw://GitHub/password", "bot");
    expect(next?.id).not.toBe(id);
    expect(next?.value).toBe("fake-reconnected-key");
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
