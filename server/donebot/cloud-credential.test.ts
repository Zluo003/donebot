import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { cloudCredentialStore } from "./cloud-credential.ts";
import { DoneBotGateway } from "./gateway.ts";
import { startFakeDoneBotGateway } from "../testing/fake-donebot-gateway.ts";

it("uses an isolated installation for catalog, account and model calls without a login JWT", async () => {
  const dir = await mkdtemp(join(tmpdir(), "donebot-cloud-credential-"));
  const path = join(dir, "gateway.json"), installationId = randomUUID(), credential = "sk-donebot-" + randomBytes(32).toString("hex");
  const fake = await startFakeDoneBotGateway(undefined, new Map([[credential, installationId]]));
  try {
    await writeFile(path, JSON.stringify({ installationId, credential, user: { id: "101", email: "synthetic@example.test" } }), { mode: 0o600 });
    const store = cloudCredentialStore(path), gateway = new DoneBotGateway(store, { testOrigin: fake.origin });
    await gateway.restore();
    expect(gateway.state()).toMatchObject({ authenticated: true, user: { id: "101" } });
    expect(JSON.stringify(gateway.state())).not.toContain(credential);
    expect(gateway.models()!.models.length).toBeGreaterThan(0);
    expect(await gateway.account()).toMatchObject({ concurrency: 20 });
    const response = await gateway.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "deepseek-flash", messages: [{ role: "user", content: "Synthetic Cloud request" }], stream: true }) });
    expect(response.ok).toBe(true);
    expect(await response.text()).toContain("Synthetic DoneBot fixture complete.");
    expect(fake.requests.some(r => r.path.startsWith("/api/v1/auth/"))).toBe(false);
    expect(fake.requests.every(r => r.authenticated && r.installation === installationId)).toBe(true);
    await expect(store.save(null)).rejects.toThrow("Cloud console");
    await writeFile(path, JSON.stringify({ installationId, credential: "invalid", user: { id: "101", email: "synthetic@example.test" } }));
    await expect(store.load()).rejects.toThrow("invalid");
  } finally { await fake.close(); await rm(dir, { recursive: true, force: true }); }
});
