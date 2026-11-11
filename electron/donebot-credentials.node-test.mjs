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
  for (const operation of ["load", "save"]) assert.deepEqual(await f.request(operation, credential), { type: "donebot:credentials-result", requestId: "synthetic-request", ok: false });
});
test("malformed IPC saves leave the secure document unchanged", async () => {
  const f = fixture();
  for (const value of [{}, { ...credential, accessToken: 4 }, { ...credential, accessToken: "x".repeat(33000) }]) assert.equal((await f.request("save", value)).ok, false);
  assert.deepEqual(f.document(), { otherSecret: "preserved" });
});
