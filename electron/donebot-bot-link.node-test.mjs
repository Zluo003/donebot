import assert from "node:assert/strict";
import test from "node:test";
import { createDoneBotBotLink, installDoneBotBotLink } from "./donebot-bot-link.mjs";

const id = "11861a47-7240-4f99-bf19-bd01d411596f", origin = `https://${id}.cloud.donebot.cn`;
function fixture() {
  let owner = "101", enabled = null, linked = { on: false }, running = true, failLocal = false, pairGate = async () => {};
  const entry = { origin, donebotCloud: { id, accountId: "101" } };
  const calls = [], handlers = new Map();
  const deps = {
    saved: () => ({ environments: [entry] }),
    pref: { read: () => enabled, write: value => { enabled = value; } },
    request: async (path, init = {}) => {
      calls.push([path, init]);
      if (path === "/api/donebot/state") return Response.json({ authenticated: !!owner, user: { id: owner } });
      if (path === "/api/donebot/cloud") return Response.json({ account_id: owner, instance: { id, actual: running ? "running" : "stopped", desired: running ? "running" : "stopped", subscription_state: "active", paid_until: "2099-01-01" }, connection_available: true });
      if (path === "/.well-known/donebot/environment") return Response.json({ environmentId: "mac-1", label: "Mac mini" });
      assert.equal(path, "/api/bot-link");
      if (init.method === "PUT") {
        const body = JSON.parse(init.body);
        if (failLocal && body.on) return Response.json({ error: "synthetic local refusal" }, { status: 503 });
        if (body.on === true) linked = { on: true, role: "dialer", account: body.account, origin: body.origin, online: true };
        else if (body.on === false) linked = { on: false };
        else linked = { ...linked, asleep: body.cloud === "asleep" };
      }
      return Response.json(linked);
    },
    fetch: async (url, init) => {
      calls.push([url, init]);
      assert.equal(new URL(url).origin, origin);
      assert.equal(init.credentials, "include"); assert.equal(init.redirect, "error");
      assert.equal(init.headers["x-omb-background"], "1");
      if (init.method === "DELETE") return Response.json({ ok: true });
      assert.equal(url, origin + "/api/bot-link/pair");
      await pairGate();
      return Response.json({ token: "personal-link-token-do-not-expose", place: { id: "cloud-1", name: "DoneBot Cloud" } });
    },
    renew: async () => {},
    watchMs: 2 ** 30,
  };
  const link = createDoneBotBotLink(deps);
  return { link, calls, entry, deps, handlers, get linked() { return linked; }, get preference() { return enabled; }, set owner(value) { owner = value; }, set running(value) { running = value; }, set failLocal(value) { failLocal = value; }, set pairGate(value) { pairGate = value; } };
}

test("off by default; only explicit consent pairs the matching personal Cloud and returns no credentials", async t => {
  const f = fixture(); t.after(() => f.link.close());
  assert.equal((await f.link.state()).enabled, false);
  assert.deepEqual(f.calls.map(([path]) => path), ["/api/bot-link"]);
  await assert.rejects(f.link.set(true, "foreign", id), /当前账号/);
  assert.ok(!f.calls.some(([path]) => path.startsWith("https:")));
  const state = await f.link.set(true, "101", id);
  assert.deepEqual(state, { enabled: true, connected: true, available: true, error: "" });
  assert.ok(!JSON.stringify(state).includes("token"));
  const pair = f.calls.find(([path]) => path === origin + "/api/bot-link/pair");
  assert.deepEqual(JSON.parse(pair[1].body), { computer: { id: "mac-1", name: "Mac mini" }, name: "DoneBot Cloud" });
  assert.equal(f.preference.instanceId, id);
  assert.deepEqual(await f.link.set(false), { enabled: false, connected: false, available: false, error: "" });
  assert.equal(f.linked.on, false);
});

test("account change and sign-out revoke the standing link and its saved consent", async t => {
  for (const next of ["202", null]) {
    const f = fixture(); t.after(() => f.link.close());
    await f.link.set(true, "101", id);
    f.owner = next;
    assert.equal((await f.link.state()).enabled, false);
    assert.equal(f.linked.on, false);
    assert.equal(f.preference.enabled, false);
    f.owner = "101";
    await f.link.state();
    assert.equal(f.calls.filter(([path]) => path === origin + "/api/bot-link/pair").length, 1);
  }
});

test("sleeping Cloud is never woken for background pairing", async t => {
  const f = fixture(); t.after(() => f.link.close());
  await f.link.set(true, "101", id);
  f.running = false;
  await f.link.state();
  assert.equal(f.linked.asleep, true);
  const before = f.calls.filter(([path]) => path.startsWith("https:")).length;
  await f.link.state();
  assert.equal(f.calls.filter(([path]) => path.startsWith("https:")).length, before);
  f.running = true;
  await f.link.state();
  assert.equal(f.linked.asleep, false);
});

test("disabling while pairing is pending cleans up the new Cloud grant and cannot resurrect it", async t => {
  const f = fixture(); t.after(() => f.link.close());
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.pairGate = () => new Promise(resolve => { release = resolve; entered(); });
  const opening = f.link.set(true, "101", id);
  await waiting;
  await f.link.set(false);
  release(); await opening;
  assert.equal((await f.link.state()).error, "");
  assert.equal(f.linked.on, false);
  assert.equal(f.preference.enabled, false);
  assert.equal(f.calls.filter(([, init]) => init.method === "DELETE").length, 1);
});

test("account change during pairing or a local acceptance failure leaves no orphan grant", async t => {
  for (const change of ["account", "local"]) {
    const f = fixture(); t.after(() => f.link.close());
    if (change === "account") f.pairGate = async () => { f.owner = "202"; };
    else f.failLocal = true;
    const state = await f.link.set(true, "101", id);
    assert.ok(state.error);
    assert.equal(f.linked.on, false);
    assert.equal(f.calls.filter(([, init]) => init.method === "DELETE").length, 1);
  }
});

test("unverified saved origins and absent account bindings cannot receive a link request", async t => {
  for (const change of ["origin", "account"]) {
    const f = fixture(); t.after(() => f.link.close());
    if (change === "origin") f.entry.origin = "https://foreign.invalid";
    else delete f.entry.donebotCloud;
    await assert.rejects(f.link.set(true, "101", id), /当前账号/);
    assert.ok(!f.calls.some(([path]) => path.startsWith("https:")));
  }
});

test("native bridge guards both reads and writes with the local workspace guard", async t => {
  const f = fixture(); f.link.close();
  const guarded = [];
  const native = installDoneBotBotLink({ ...f.deps, ipcMain: { handle: (name, handler) => f.handlers.set(name, handler) }, guardLocal: (name, _handler) => { guarded.push(name); return () => { throw new Error("blocked foreign page"); }; } });
  t.after(() => native.close());
  assert.deepEqual(guarded, ["donebot-bot-link:state", "donebot-bot-link:set"]);
  for (const handler of f.handlers.values()) assert.throws(() => handler({}), /foreign page/);
});
