import assert from "node:assert/strict";
import test from "node:test";
import { createDoneBotCloudConnection, doneBotCloudEntry, installDoneBotCloud } from "./donebot-cloud.mjs";
import environments from "./environments.cjs";

const id = "11861a47-7240-4f99-bf19-bd01d411596f", origin = `https://${id}.cloud.donebot.cn`;
function fixture() {
  let owner = "101", signedIn = false, live = true, probeFailed = false;
  let state = { environments: [], activeId: "local" };
  const calls = [], opened = [];
  const connect = createDoneBotCloudConnection({ saved: () => state,
    request: async (path, init) => {
      calls.push(path);
      if (path === "/api/donebot/state") return Response.json({ authenticated: true, user: { id: owner } });
      assert.equal(path, "/api/donebot/cloud/connect");
      assert.deepEqual(JSON.parse(init.body), { id, account_id: owner });
      return live ? Response.json({ url: `donebot://pair?address=${encodeURIComponent(origin)}&token=omb_pair_${"a".repeat(43)}` }) : Response.json({ error: "Cloud stopped" }, { status: 409 });
    },
    fetch: async (url, init) => {
      calls.push(url);
      assert.equal(init.credentials, "include");
      if (url.endsWith("/api/auth/session")) {
        if (probeFailed) throw new TypeError("Failed to fetch");
        return new Response("{}", { status: signedIn ? 200 : 401, headers: { "x-donebot-cloud": "1" } });
      }
      assert.equal(url, origin + "/api/auth/pair"); assert.equal(init.headers.origin, origin);
      signedIn = true; return Response.json({ ok: true });
    },
    remember: target => { state = { ...state, environments: [{ id: "saved-cloud", origin: target.origin, name: "DoneBot Cloud", donebotCloud: { id: target.id, accountId: target.accountId } }] }; },
    activate: async target => { opened.push(target); return true; },
  });
  return { connect, calls, opened, get entry() { return state.environments[0]; }, set owner(value) { owner = value; }, set signedIn(value) { signedIn = value; }, set live(value) { live = value; }, set probeFailed(value) { probeFailed = value; } };
}

test("failed session probes still renew the saved Cloud, and background renewal never navigates", async () => {
  const f = fixture();
  await f.connect.open({ id, accountId: "101" });
  f.probeFailed = true;
  await f.connect.open({ entry: f.entry });
  assert.equal(f.opened.length, 2);
  const pairings = f.calls.filter(url => url.endsWith("/api/auth/pair")).length;
  await Promise.all([f.connect.renew(f.entry), f.connect.renew(f.entry)]);
  assert.equal(f.calls.filter(url => url.endsWith("/api/auth/pair")).length, pairings + 1);
  assert.equal(f.opened.length, 2);
});

test("reuses a live Cloud session and renews an expired one without generic pairing or account mutations", async () => {
  const f = fixture();
  await f.connect.open({ id, accountId: "101" });
  assert.equal(doneBotCloudEntry(f.entry), true);
  f.calls.length = 0;
  await f.connect.open({ entry: f.entry });
  assert.ok(!f.calls.includes("/api/donebot/cloud/connect"));
  assert.equal(f.calls.filter(url => url.endsWith("/api/auth/pair")).length, 0);
  f.signedIn = false;
  await f.connect.open({ entry: f.entry });
  assert.equal(f.calls.filter(url => url.endsWith("/api/auth/pair")).length, 1);
  assert.deepEqual(f.opened, [origin, origin, origin]);
  assert.ok(f.calls.every(path => !/logout|rotate|revoke|installations/.test(path)));
});

test("an old account, stopped instance and superseded selection cannot activate Cloud", async () => {
  const f = fixture();
  await f.connect.open({ id, accountId: "101" });
  f.owner = "202";
  await assert.rejects(f.connect.open({ entry: f.entry }), /账号/);
  f.owner = "101"; f.signedIn = false; f.live = false;
  await assert.rejects(f.connect.open({ entry: f.entry }), /Cloud stopped/);
  f.live = true;
  assert.deepEqual(await f.connect.open({ entry: f.entry, still: () => false }), { outcome: "cancelled" });
  assert.equal(f.opened.length, 1);
});

test("concurrent opens share one launch and only the latest selection navigates", async () => {
  const f = fixture();
  const results = await Promise.all([f.connect.open({ id, accountId: "101" }), f.connect.open({ id, accountId: "101" })]);
  assert.deepEqual(results, [{ outcome: "cancelled" }, { outcome: "connected" }]);
  assert.equal(f.calls.filter(path => path === "/api/donebot/cloud/connect").length, 1);
  assert.equal(f.opened.length, 1);
});

test("legacy DoneBot Cloud entries migrate only to the same gateway-verified origin", async () => {
  const f = fixture();
  const entry = { id: "legacy", name: "DoneBot Cloud", origin };
  assert.equal(doneBotCloudEntry(entry), true);
  await f.connect.open({ entry });
  assert.deepEqual(f.entry.donebotCloud, { id, accountId: "101" });
  await assert.rejects(f.connect.open({ entry: { ...entry, origin: `https://${id}.foreign.invalid` } }), /无法验证/);
  assert.equal(doneBotCloudEntry({ name: "Other server", origin }), false);
});

test("native IPC saves a reusable Cloud entry and refuses renewal from another page", async () => {
  let state = environments.parseEnvironments({ version: 2, activeId: "local", environments: [] }), homeCancellations = 0;
  const handlers = new Map(), navigated = [];
  const connection = installDoneBotCloud({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    guardLocal: (_name, handler) => handler, guardWorkspace: handler => handler,
    saved: () => state, persist: value => { state = value; }, cancelHome: () => { homeCancellations++; }, navigate: async target => { navigated.push(target); return true; },
    local: () => { state = environments.withActive(state, "local"); },
    request: async path => path === "/api/donebot/state" ? Response.json({ authenticated: true, user: { id: "101" } })
      : Response.json({ url: `donebot://pair?address=${encodeURIComponent(origin)}&token=omb_pair_${"a".repeat(43)}` }),
    fetch: async () => new Response("{}", { headers: { "x-donebot-cloud": "1" } }),
  });
  assert.equal(connection.select(undefined), null);
  await handlers.get("donebot-cloud:open")({}, id, "101");
  const restored = environments.parseEnvironments(state);
  assert.deepEqual(restored.environments[0].donebotCloud, { id, accountId: "101" });
  assert.equal(restored.activeId, restored.environments[0].id);
  assert.throws(() => handlers.get("donebot-cloud:reconnect")({ senderFrame: { url: "https://foreign.invalid" } }), /不能重新连接/);
  await handlers.get("donebot-cloud:reconnect")({ senderFrame: { url: origin } });
  assert.equal(homeCancellations, 2);
  assert.deepEqual(navigated, [origin, origin]);
  await handlers.get("donebot-cloud:local")({ senderFrame: { url: origin } });
  assert.equal(state.activeId, "local");
  assert.equal(state.environments.length, 1);
  await connection.select(state.environments[0]);
  assert.equal(state.activeId, state.environments[0].id);
  assert.equal(state.environments.length, 1);
});
