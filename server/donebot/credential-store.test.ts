import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDoneBotCredentialStore, type DoneBotPrivatePort } from "./credential-store.ts";
import type { DoneBotCredential } from "./gateway.ts";

const credential: DoneBotCredential = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", credential: "synthetic-installation", expiresAt: 1, installationId: "fixture-installation", user: { id: "fixture", email: "fixture@example.invalid" } };
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function vault() {
  let stored: DoneBotCredential | null = null;
  let unavailable = false;
  const port = (): DoneBotPrivatePort => {
    let listener: (event: { data?: object }) => void;
    return {
      on(_event, callback) { listener = callback; },
      postMessage(raw) {
        const message = raw as { requestId: string; operation: string; value: DoneBotCredential | null };
        queueMicrotask(() => {
          if (!unavailable && message.operation === "save") stored = message.value;
          listener({ data: { type: "donebot:credentials-result", requestId: message.requestId, ok: !unavailable, value: stored } });
        });
      },
    };
  };
  return { port, fail: () => { unavailable = true; }, recover: () => { unavailable = false; } };
}

it("keeps headless credentials only for the current process", async () => {
  const store = createDoneBotCredentialStore();
  await store.save(credential);
  expect(await store.load()).toEqual(credential);
  expect(store.persistent).toBe(false);
  await store.save(null);
  expect(await store.load()).toBeNull();
  expect(await createDoneBotCredentialStore().load()).toBeNull();
});

it("prevents an encrypted session from returning after a failed logout write", async () => {
  const root = await mkdtemp(join(tmpdir(), "donebot-vault-fixture-")); roots.push(root);
  const file = join(root, "session-id"), secure = vault();
  const store = createDoneBotCredentialStore(secure.port(), file);
  await store.save(credential);
  expect((await createDoneBotCredentialStore(secure.port(), file).load())?.accessToken).toBe(credential.accessToken);
  secure.fail();
  await store.save(null);
  expect(store.persistent).toBe(false);
  expect(await store.load()).toBeNull();
  secure.recover();
  expect(await createDoneBotCredentialStore(secure.port(), file).load()).toBeNull();
  expect(await readFile(file, "utf8")).not.toMatch(/synthetic|fixture|token|email/);
});

it("serializes secure writes so logout wins over an overlapping login save", async () => {
  const root = await mkdtemp(join(tmpdir(), "donebot-vault-fixture-")); roots.push(root);
  const file = join(root, "session-id"), secure = vault();
  const store = createDoneBotCredentialStore(secure.port(), file);
  await Promise.all([store.save(credential), store.save(null)]);
  expect(await createDoneBotCredentialStore(secure.port(), file).load()).toBeNull();
});
