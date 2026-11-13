import assert from "node:assert/strict";
import test from "node:test";
import environments from "./environments.cjs";
import { createWorkspaceNavigation } from "./workspace-navigation.mjs";

const LOCAL = "http://127.0.0.1:48993";
const CLOUD = "https://cloud.fixture.example";
const OTHER = "https://other.fixture.example";
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture({ shown = LOCAL, activeId = "cloud", localId = "local" } = {}) {
  const state = { activeId, environments: [{ id: "cloud", kind: "remote", origin: CLOUD }, { id: "other", kind: "remote", origin: OTHER }] };
  const requests = [], restores = [], logs = [];
  let destroyed = false, current = shown;
  const win = { isDestroyed: () => destroyed, webContents: { getURL: () => current, mainFrame: {} }, loadURL: url => {
    const request = deferred(); requests.push({ url, ...request }); return request.promise;
  } };
  let window = win;
  const navigate = createWorkspaceNavigation({ window: () => window, local: () => ({ origin: LOCAL, id: localId }), saved: () => state,
    restore: id => { restores.push(id); state.activeId = id; }, log: line => logs.push(line) });
  const event = () => { win.webContents.mainFrame.url = current; return { sender: win.webContents, senderFrame: win.webContents.mainFrame }; };
  return { navigate, state, requests, restores, logs, win, menuAllowed: () => environments.workspaceSenderAllowed(event(), win.webContents, state, LOCAL),
    show: url => { current = url; }, destroy: () => { destroyed = true; }, replaceWindow: () => { window = null; } };
}

test("a rejected Cloud redirect restores the visible computer and its menu without admitting another origin", async () => {
  const f = fixture();
  assert.equal(f.menuAllowed(), false);
  const load = f.navigate(CLOUD);
  f.requests[0].reject(new Error("ERR_ABORTED"));
  assert.equal(await load, false);
  assert.equal(f.state.activeId, "local");
  assert.equal(f.menuAllowed(), true);
  assert.equal(f.requests.length, 1, "the page already on screen is kept");
  assert.equal(environments.workspaceNavigationAllowed("https://unrelated.fixture.example/", f.state, LOCAL), false);
  assert.deepEqual(f.state.environments.map(entry => entry.id), ["cloud", "other"]);
});

test("a failed switch from a saved server restores that server and keeps its menu usable", async () => {
  const f = fixture({ shown: OTHER + "/chat" });
  const load = f.navigate(CLOUD);
  f.requests[0].reject(new Error("ERR_CONNECTION_REFUSED"));
  assert.equal(await load, false);
  assert.equal(f.state.activeId, "other");
  assert.equal(f.menuAllowed(), true);
});

test("a named local environment remains selected when a Cloud cannot open", async () => {
  const f = fixture({ localId: "local-research" });
  const load = f.navigate(CLOUD);
  f.requests[0].reject(new Error("ERR_ABORTED"));
  await load;
  assert.deepEqual(f.restores, ["local-research"]);
});

test("a successful Cloud load keeps its selection and remote workspace controls", async () => {
  const f = fixture();
  const load = f.navigate(CLOUD);
  f.show(CLOUD + "/"); f.requests[0].resolve();
  assert.equal(await load, true);
  assert.equal(f.state.activeId, "cloud");
  assert.equal(f.menuAllowed(), true);
  assert.deepEqual(f.restores, []);
});

test("a failed startup with no visible workspace opens the computer instead of leaving a blank window", async () => {
  const f = fixture({ shown: "" });
  const load = f.navigate(CLOUD);
  f.requests[0].reject(new Error("ERR_ABORTED"));
  await Promise.resolve();
  assert.equal(f.requests[1].url, LOCAL);
  f.show(LOCAL); f.requests[1].resolve();
  assert.equal(await load, false);
  assert.equal(f.menuAllowed(), true);
});

test("an error page or an unknown origin cannot acquire workspace authority and falls back to the computer", async () => {
  for (const shown of ["chrome-error://chromewebdata/", "https://unrelated.fixture.example/"]) {
    const f = fixture({ shown });
    const load = f.navigate(CLOUD);
    f.requests[0].reject(new Error("ERR_FAILED"));
    await Promise.resolve();
    assert.equal(f.state.activeId, "local");
    assert.equal(f.menuAllowed(), false);
    f.requests[1].reject(new Error("ERR_CONNECTION_REFUSED"));
    assert.equal(await load, false);
    assert.equal(f.requests.length, 2, "an unavailable computer is not retried indefinitely");
  }
});

test("an older failed navigation cannot undo a newer choice, even when both chose the same Cloud", async () => {
  for (const next of [CLOUD, OTHER]) {
    const f = fixture();
    const first = f.navigate(CLOUD);
    f.state.activeId = next === CLOUD ? "cloud" : "other";
    const second = f.navigate(next);
    f.requests[0].reject(new Error("ERR_ABORTED"));
    assert.equal(await first, false);
    assert.deepEqual(f.restores, []);
    f.show(next); f.requests[1].resolve();
    assert.equal(await second, true);
    assert.equal(f.menuAllowed(), true);
  }
});

test("a newer selection that has not started navigation yet is preserved", async () => {
  const f = fixture();
  const load = f.navigate(CLOUD);
  f.state.activeId = "other";
  f.requests[0].reject(new Error("ERR_ABORTED"));
  assert.equal(await load, false);
  assert.deepEqual(f.restores, []);
});

test("a closed or replaced window cannot change the selection after its load fails", async () => {
  for (const action of ["destroy", "replaceWindow"]) {
    const f = fixture();
    const load = f.navigate(CLOUD);
    f[action](); f.requests[0].reject(new Error("ERR_ABORTED"));
    assert.equal(await load, false);
    assert.deepEqual(f.restores, []);
  }
});

test("a missing window does not navigate or change saved places", async () => {
  const f = fixture(); f.replaceWindow();
  assert.equal(await f.navigate(CLOUD), false);
  assert.deepEqual(f.requests, []); assert.deepEqual(f.restores, []);
});
