import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installDoneBotCloudFrontend } from "./donebot-cloud-frontend.mjs";

const origin = "https://11861a47-7240-4f99-bf19-bd01d411596f.cloud.donebot.cn";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "donebot-cloud-frontend-test-"));
  writeFileSync(join(directory, "index.html"), "<h1>Bundled client</h1>");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let handle;
  const calls = [];
  installDoneBotCloudFrontend({ directory, origins: () => [origin], session: {
    protocol: { handle: (scheme, callback) => { assert.equal(scheme, "https"); handle = callback; } },
    fetch: async (request, init) => { calls.push({ request, init }); return new Response("ok"); },
  } });
  return { handle, calls };
}

test("authenticated writes from the bundled Cloud page retain their same-origin provenance and streamed body", async t => {
  const f = fixture(t);
  for (const method of ["POST", "PATCH", "DELETE"]) {
    const request = new Request(origin + "/api/bots/fixture/tasks", { method, body: "fixture body", referrer: origin + "/", headers: { "content-type": "application/json" } });
    await f.handle(request);
    const call = f.calls.at(-1);
    assert.equal(call.init.headers.get("origin"), origin);
    assert.equal(call.request, request);
    assert.equal(request.bodyUsed, false);
    assert.equal(call.init.bypassCustomProtocolHandlers, true);
    assert.equal(call.init.headers.get("content-type"), "application/json");
  }
  const response = await f.handle(new Request(origin));
  assert.equal(response.headers.get("referrer-policy"), "same-origin");
});

test("other pages, opaque requests and unverified destinations cannot acquire a Cloud origin", async t => {
  const f = fixture(t);
  for (const [target, referrer, explicit] of [
    [origin, "https://foreign.invalid/", undefined],
    [origin, "about:client", undefined],
    [origin, "", undefined],
    ["https://other.cloud.donebot.cn", "https://other.cloud.donebot.cn/", undefined],
    [origin, origin + "/", "https://foreign.invalid"],
    [origin, origin + "/", "null"],
  ]) {
    const request = new Request(target + "/api/fixture/write", { method: "POST", referrer, ...(explicit ? { headers: { origin: explicit } } : {}) });
    await f.handle(request);
    assert.equal(f.calls.at(-1).init.headers.get("origin"), explicit ?? null);
  }
});

test("native pairing keeps its explicit origin without a renderer referrer", async t => {
  const f = fixture(t);
  await f.handle(new Request(origin + "/api/auth/pair", { method: "POST", headers: { origin }, body: "synthetic code" }));
  assert.equal(f.calls.at(-1).init.headers.get("origin"), origin);
});
