import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createDoneBotCredentialResponder } from "./donebot-credentials.mjs";

const credential = { accessToken: "synthetic-access", installationId: "synthetic-installation", user: { id: "one", email: "one@example.test" }, expiresAt: 123 };
function fixture(available = async () => true) {
  let doc = { otherSecret: "preserved" };
  const respond = createDoneBotCredentialResponder({ read: () => doc, available, update: async fn => { doc = fn(doc); } });
  const request = (operation, value, dataDir = "/synthetic/one") => new Promise(resolve => {
    assert.equal(respond({ postMessage: resolve }, { type: "donebot:credentials", requestId: "synthetic-request", operation, value }, dataDir), true);
  });
  return { request, document: () => doc };
}
test("DoneBot credentials stay scoped to the main-owned environment and logout clears only that environment", async () => {
  const f = fixture();
  assert.equal((await f.request("save", credential)).ok, true);
  assert.deepEqual((await f.request("load")).value, credential);
  assert.equal((await f.request("load", undefined, "/synthetic/two")).value, null);
  assert.equal(f.document().otherSecret, "preserved");
  assert.deepEqual(Object.keys(f.document().donebotGateways), [createHash("sha256").update("/synthetic/one").digest("hex")]);
  await f.request("save", null);
  assert.equal((await f.request("load")).value, null);
});
test("unavailable OS encryption rejects both reads and writes without returning stored credentials", async () => {
  let available = true;
  const f = fixture(async () => available);
  await f.request("save", credential);
  available = false;
  for (const operation of ["load", "save", "installation"]) assert.deepEqual(await f.request(operation, credential), { type: "donebot:credentials-result", requestId: "synthetic-request", ok: false });
});

test("installation identity survives logout and stays isolated by account and environment", async () => {
  const f = fixture();
  const first = await f.request("installation", { accountId: "one" });
  assert.equal(first.ok, true);
  assert.match(first.value, /^[0-9a-f-]{36}$/);
  await f.request("save", { ...credential, installationId: first.value });
  await f.request("save", null);
  assert.equal((await f.request("installation", { accountId: "one" })).value, first.value);
  assert.notEqual((await f.request("installation", { accountId: "two" })).value, first.value);
  assert.notEqual((await f.request("installation", { accountId: "one" }, "/synthetic/two")).value, first.value);
});

test("migrates the existing credential identity and records a local identity on first use", async () => {
  const f = fixture();
  const installationId = "11111111-1111-4111-8111-111111111111";
  await f.request("save", { ...credential, installationId });
  assert.equal((await f.request("installation", { accountId: "one" })).value, installationId);
  const previousId = "22222222-2222-4222-8222-222222222222";
  assert.equal((await f.request("installation", { accountId: "two", previousId })).value, previousId);
  await f.request("save", null);
  assert.equal((await f.request("installation", { accountId: "two" })).value, previousId);
});

test("invalid installation identities and cross-account reuse cannot change the vault", async () => {
  const f = fixture();
  const first = (await f.request("installation", { accountId: "one" })).value;
  const before = structuredClone(f.document());
  for (const value of [{}, { accountId: " " }, { accountId: "two", previousId: first }, { accountId: "two", previousId: "-".repeat(36) }]) {
    assert.equal((await f.request("installation", value)).ok, false);
    assert.deepEqual(f.document(), before);
  }
});
test("malformed IPC saves leave the secure document unchanged", async () => {
  const f = fixture();
  for (const value of [{}, { ...credential, accessToken: 4 }, { ...credential, accessToken: "x".repeat(33000) }]) assert.equal((await f.request("save", value)).ok, false);
  assert.deepEqual(f.document(), { otherSecret: "preserved" });
});
