import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceNavigation } from "./workspace-navigation.mjs";

test("a navigation retires the launch recovery, except the recovery's own", async () => {
  const calls = [];
  const navigate = createWorkspaceNavigation({
    window: () => ({ isDestroyed: () => false, loadURL: async url => calls.push(`load:${url}`) }),
    local: () => ({ origin: "http://127.0.0.1:48993", id: "local" }),
    saved: () => ({ activeId: "local", environments: [] }),
    restore: () => assert.fail("successful navigation must not restore a workspace"),
    cancel: () => calls.push("cancel"),
  });
  await navigate("https://studio.example.test/");
  assert.deepEqual(calls, ["cancel", "load:https://studio.example.test/"]);
  calls.length = 0;
  await navigate("https://garage.example.test/", true);
  assert.deepEqual(calls, ["load:https://garage.example.test/"]);
});
