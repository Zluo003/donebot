import assert from "node:assert/strict";
import test from "node:test";
import { createDoneBotCloudKeepalive } from "./donebot-cloud-keepalive.mjs";

function fixture() {
  const cloud = { id: "saved", origin: "https://fixture.invalid", donebotCloud: { id: "fixture", accountId: "101" } };
  let active = cloud, expiry = 1_000_000, clock = 0, attempts = 0, fail = false;
  const renewals = [];
  const keeper = createDoneBotCloudKeepalive({ entry: () => active, now: () => clock,
    expires: async () => expiry, interval: () => 1, clear: () => {},
    renew: async (entry, still) => { attempts++; if (fail) throw new Error("Synthetic outage"); if (still()) renewals.push(entry); },
  });
  return { keeper, renewals, get attempts() { return attempts; }, set clock(value) { clock = value; }, set expiry(value) { expiry = value; }, set active(value) { active = value; }, set fail(value) { fail = value; } };
}

test("renews before each expiry for an active Cloud, retries outages, and stops when local or quitting", async () => {
  const f = fixture();
  f.keeper.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.attempts, 0);
  f.clock = 880_000; await f.keeper.tick();
  assert.equal(f.attempts, 1);
  f.expiry = 2_000_000; f.clock = 1_880_000; f.fail = true;
  await f.keeper.tick(); assert.equal(f.attempts, 2);
  f.fail = false; await f.keeper.tick(); assert.equal(f.attempts, 3);
  f.active = undefined; await f.keeper.tick(); assert.equal(f.attempts, 3);
  f.keeper.stop(); await f.keeper.tick(); assert.equal(f.attempts, 3);
});

test("a pending expiry read cannot renew after the user leaves Cloud", async () => {
  let current = { id: "cloud", donebotCloud: {} }, finish;
  let renewals = 0;
  const keeper = createDoneBotCloudKeepalive({ entry: () => current, expires: () => new Promise(resolve => { finish = resolve; }),
    renew: async () => { renewals++; }, interval: () => 1, clear: () => {},
  });
  keeper.start(); current = undefined; finish(0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(renewals, 0); keeper.stop();
});
