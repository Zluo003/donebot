import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createDoneBotTeamSharing, installDoneBotTeamSharing } from "./donebot-team-sharing.mjs";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test("team folder sharing validates folders, executes read-only operations, blocks disallowed actions, and stops on revoke", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "donebot-team-sharing-state-"));
  const sharedParent = fs.mkdtempSync(path.join(os.tmpdir(), "donebot-team-sharing-files-"));
  const sharedDir = path.join(sharedParent, "project-docs");
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.writeFileSync(path.join(sharedDir, "notes.txt"), "hello team folder\n");
  fs.writeFileSync(path.join(stateDir, "secret.txt"), "private state\n");
  fs.symlinkSync(path.join(stateDir, "secret.txt"), path.join(sharedDir, "escape.txt"));

  const teamId = randomUUID();
  const instanceId = randomUUID();
  const envId = randomUUID();
  const origin = `https://${instanceId}.cloud.donebot.cn`;
  let signedInAccount = "101";
  let connectedRegistration = null;
  let disconnected = false;
  const results = [];
  const jobs = [];
  let pollCount = 0;

  const controller = createDoneBotTeamSharing({
    file: path.join(stateDir, "donebot-team-sharing.json"),
    activityFile: path.join(stateDir, "donebot-team-sharing-activity.jsonl"),
    home: os.homedir(),
    localRequest: async route => {
      if (route === "/api/donebot/state") {
        return Response.json(signedInAccount ? { authenticated: true, user: { id: signedInAccount } } : { authenticated: false });
      }
      return Response.json({ local_device_id: null, devices: [] });
    },
    ensureTeamCloud: async () => ({ origin, id: instanceId, accountId: "101", team: { id: teamId, role: "owner" } }),
    fetch: async (url, init) => {
      const route = new URL(String(url)).pathname;
      if (route === "/api/auth/session") {
        return Response.json({
          kind: "session",
          id: `donebot-team:${teamId}:101:1`,
          environmentId: envId,
          lending: { sharedComputers: true, fileEdits: true },
        });
      }
      if (route === "/api/shared-computers/connect") {
        connectedRegistration = JSON.parse(String(init.body));
        const folderId = connectedRegistration.folders[0].id;
        jobs.push(
          { id: randomUUID(), operation: { computer_id: connectedRegistration.id, action: "read_file", folder_id: folderId, path: "notes.txt" } },
          { id: randomUUID(), operation: { computer_id: connectedRegistration.id, action: "write_file", folder_id: folderId, path: "notes.txt", content: "blocked" } },
          { id: randomUUID(), operation: { computer_id: connectedRegistration.id, action: "read_file", folder_id: folderId, path: "escape.txt" } },
          { id: randomUUID(), operation: { computer_id: connectedRegistration.id, action: "computer_call", tool_name: "click", arguments: {} } },
        );
        return Response.json({ ok: true });
      }
      if (route.endsWith("/poll")) {
        pollCount += 1;
        const job = jobs.shift() ?? null;
        if (!job) await wait(50);
        return Response.json({ job });
      }
      if (route.endsWith("/lease")) return Response.json({ active: true });
      if (route.endsWith("/result")) {
        results.push(JSON.parse(String(init.body)));
        return Response.json({ ok: true });
      }
      if (route.endsWith("/disconnect")) {
        disconnected = true;
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const handlers = new Map();
  let pickedPath = os.homedir();
  installDoneBotTeamSharing({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    guardLocal: (_name, handler) => handler,
    controller,
    pickFolder: async () => pickedPath,
  });

  try {
    // Rejects sharing the whole home folder.
    await assert.rejects(handlers.get("donebot-team-sharing:choose-folder")({}), /home folder/i);

    pickedPath = sharedDir;
    const folder = await handlers.get("donebot-team-sharing:choose-folder")({});
    assert.equal(folder.write, false);
    assert.equal(folder.name, "project-docs");

    await handlers.get("donebot-team-sharing:save")({}, {
      teamId,
      instanceId,
      accountId: "101",
      teamName: "DoneBot Dev",
      role: "owner",
      folders: [folder],
      terminal: false,
    });

    for (let i = 0; i < 60 && results.length < 4; i += 1) await wait(25);
    assert.ok(pollCount >= 1);
    assert.equal(connectedRegistration.computer, false);
    assert.equal(connectedRegistration.terminal, false);
    assert.equal(results.length, 4);
    assert.equal(results[0].result.isError, undefined);
    assert.match(results[0].result.content[0].text, /hello team folder/);
    assert.equal(results[1].result.isError, true);
    assert.equal(results[2].result.isError, true);
    assert.equal(results[3].result.isError, true);
    assert.match(results[3].result.content[0].text, /not permitted/i);

    const log = await handlers.get("donebot-team-sharing:activity")({}, teamId);
    assert.ok(log.length >= 3);

    // Another account cannot see this member's saved folders.
    signedInAccount = "202";
    const otherAccountState = await handlers.get("donebot-team-sharing:state")({}, teamId);
    assert.equal(otherAccountState.enabled, false);
    assert.deepEqual(otherAccountState.folders, []);

    signedInAccount = "101";
    const revoked = await handlers.get("donebot-team-sharing:revoke")({}, teamId);
    assert.equal(revoked.enabled, false);
    assert.equal(revoked.connected, false);
    await wait(30);
    assert.equal(disconnected, true);
  } finally {
    controller.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(sharedParent, { recursive: true, force: true });
  }
});

test("rejects team Cloud containers that do not advertise team folder sharing support", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "donebot-team-sharing-old-state-"));
  const sharedParent = fs.mkdtempSync(path.join(os.tmpdir(), "donebot-team-sharing-old-files-"));
  const sharedDir = path.join(sharedParent, "docs");
  fs.mkdirSync(sharedDir, { recursive: true });
  const teamId = randomUUID(), instanceId = randomUUID(), envId = randomUUID();
  const origin = `https://${instanceId}.cloud.donebot.cn`;

  const controller = createDoneBotTeamSharing({
    file: path.join(stateDir, "donebot-team-sharing.json"),
    localRequest: async () => Response.json({ authenticated: true, user: { id: "101" } }),
    ensureTeamCloud: async () => ({ origin, id: instanceId, accountId: "101", team: { id: teamId, role: "owner" } }),
    fetch: async () => Response.json({ kind: "session", id: `donebot-team:${teamId}:101:1`, environmentId: envId }),
  });

  try {
    await assert.rejects(
      controller.save({
        teamId,
        instanceId,
        accountId: "101",
        teamName: "Old Cloud",
        role: "owner",
        folders: [{ id: randomUUID(), path: sharedDir, name: "docs", write: false }],
        terminal: false,
      }),
      /最新镜像/,
    );
  } finally {
    controller.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(sharedParent, { recursive: true, force: true });
  }
});
