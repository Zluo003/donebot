import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createDoneBotCollab, installDoneBotCollab } from "./donebot-collab.mjs";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test("gateway-relayed collab executes read/write by per-caller access, blocks escape & terminal, and logs audit", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "donebot-collab-state-"));
  const sharedParent = fs.mkdtempSync(path.join(os.tmpdir(), "donebot-collab-files-"));
  const sharedDir = path.join(sharedParent, "team-docs");
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.writeFileSync(path.join(sharedDir, "spec.md"), "# Spec\nhello collab\n");
  fs.writeFileSync(path.join(stateDir, "private.txt"), "secret\n");
  fs.symlinkSync(path.join(stateDir, "private.txt"), path.join(sharedDir, "escape.txt"));

  const folderId = randomUUID();
  const jobs = [];
  const results = [];
  let signedIn = "101";
  let queued = false;

  const controller = createDoneBotCollab({
    file: path.join(stateDir, "donebot-collab-folders.json"),
    activityFile: path.join(stateDir, "donebot-collab-activity.jsonl"),
    home: os.homedir(),
    localRequest: async (route, init) => {
      if (route === "/api/donebot/state") {
        return Response.json(signedIn ? { authenticated: true, user: { id: signedIn } } : { authenticated: false });
      }
      if (route === "/api/donebot/collab/relay/poll") {
        if (!queued) {
          queued = true;
          jobs.push(
            { id: randomUUID(), folder_id: folderId, caller_user_id: 202, caller_email: "bob@example.invalid", granted_access: "read", operation: { action: "read_file", path: "spec.md" } },
            { id: randomUUID(), folder_id: folderId, caller_user_id: 202, caller_email: "bob@example.invalid", granted_access: "read", operation: { action: "write_file", path: "spec.md", content: "denied" } },
            { id: randomUUID(), folder_id: folderId, caller_user_id: 303, caller_email: "carol@example.invalid", granted_access: "write", operation: { action: "append_file", path: "spec.md", content: "added by carol\n" } },
            { id: randomUUID(), folder_id: folderId, caller_user_id: 303, caller_email: "carol@example.invalid", granted_access: "write", operation: { action: "read_file", path: "escape.txt" } },
            { id: randomUUID(), folder_id: folderId, caller_user_id: 303, caller_email: "carol@example.invalid", granted_access: "write", operation: { action: "run_command", command: "whoami" } },
          );
        }
        const job = jobs.shift() ?? null;
        if (!job) await wait(40);
        return Response.json({ job });
      }
      if (route === "/api/donebot/collab/relay/result") {
        results.push(JSON.parse(String(init.body)));
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const handlers = new Map();
  let pickedPath = os.homedir();
  installDoneBotCollab({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    guardLocal: (_name, handler) => handler,
    controller,
    pickFolder: async () => pickedPath,
  });

  try {
    await assert.rejects(handlers.get("donebot-collab:choose-folder")({}), /home folder/i);

    pickedPath = sharedDir;
    const picked = await handlers.get("donebot-collab:choose-folder")({});
    assert.equal(picked.name, "team-docs");

    await handlers.get("donebot-collab:save-folder")({}, {
      id: folderId,
      path: picked.path,
      name: "产品文档",
      enabled: true,
      allowWrite: true,
    });

    for (let i = 0; i < 60 && results.length < 5; i += 1) await wait(25);
    assert.equal(results.length, 5);
    assert.equal(results[0].result.isError, undefined);
    assert.match(results[0].result.content[0].text, /hello collab/);
    assert.equal(results[1].result.isError, true); // read-only caller blocked from write
    assert.equal(results[2].result.isError, undefined); // write caller allowed to append
    assert.match(fs.readFileSync(path.join(sharedDir, "spec.md"), "utf8"), /added by carol/);
    assert.equal(results[3].result.isError, true); // symlink escape to protected stateDir blocked
    assert.equal(results[4].result.isError, true); // run_command blocked

    const log = await handlers.get("donebot-collab:activity")({}, folderId);
    assert.equal(log.length, 5);
    assert.ok(log.some(entry => entry.callerEmail === "bob@example.invalid" && entry.action === "read_file" && entry.ok));
    assert.ok(log.some(entry => entry.callerEmail === "carol@example.invalid" && entry.action === "append_file" && entry.ok));

    // Another account cannot see saved local folders.
    signedIn = "999";
    assert.deepEqual(await handlers.get("donebot-collab:list-folders")({}), []);

    signedIn = "101";
    await handlers.get("donebot-collab:remove-folder")({}, folderId);
    const st = await handlers.get("donebot-collab:status")({});
    assert.equal(st.activeCount, 0);
    assert.equal(st.connected, false);
  } finally {
    controller.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(sharedParent, { recursive: true, force: true });
  }
});

test("streaming collab handles >2MB download/upload (Chinese filenames), reports file sizes, and blocks >max_bytes", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "donebot-collab-stream-state-"));
  const sharedParent = fs.mkdtempSync(path.join(os.tmpdir(), "donebot-collab-stream-files-"));
  const sharedDir = path.join(sharedParent, "media-docs");
  fs.mkdirSync(sharedDir, { recursive: true });
  const bigReadBytes = Buffer.alloc(3 * 1024 * 1024, 0x5a);
  fs.writeFileSync(path.join(sharedDir, "产品方案.bin"), bigReadBytes);
  fs.writeFileSync(path.join(sharedDir, ".DS_Store"), "hidden-file");
  fs.mkdirSync(path.join(sharedDir, ".hidden-dir"), { recursive: true });
  fs.writeFileSync(path.join(sharedDir, ".hidden-dir", "secret.txt"), "hidden");

  const bigWriteBytes = Buffer.alloc(4 * 1024 * 1024, 0x6b);
  const folderId = randomUUID();
  const readTransferId = randomUUID();
  const oversizedTransferId = randomUUID();
  const writeTransferId = randomUUID();
  const jobs = [];
  const results = [];
  const failedTransfers = [];
  let uploadedStreamBytes = null;
  let uploadedHeaders = null;
  let queued = false;

  const controller = createDoneBotCollab({
    file: path.join(stateDir, "donebot-collab-folders.json"),
    activityFile: path.join(stateDir, "donebot-collab-activity.jsonl"),
    home: os.homedir(),
    localRequest: async (route, init) => {
      if (route === "/api/donebot/state") {
        return Response.json({ authenticated: true, user: { id: "101" } });
      }
      if (route === "/api/donebot/collab/relay/poll") {
        if (!queued) {
          queued = true;
          jobs.push(
            { id: randomUUID(), folder_id: folderId, caller_user_id: 202, caller_email: "bob@example.invalid", granted_access: "read", operation: { action: "list_files", path: "" } },
            { id: randomUUID(), folder_id: folderId, caller_user_id: 202, caller_email: "bob@example.invalid", granted_access: "read", operation: { action: "stream_read_file", path: "产品方案.bin", transfer_id: readTransferId } },
            { id: randomUUID(), folder_id: folderId, caller_user_id: 202, caller_email: "bob@example.invalid", granted_access: "read", operation: { action: "stream_read_file", path: "产品方案.bin", transfer_id: oversizedTransferId, max_bytes: 1024 } },
            { id: randomUUID(), folder_id: folderId, caller_user_id: 303, caller_email: "carol@example.invalid", granted_access: "write", operation: { action: "stream_write_file", path: "交付/视频素材.bin", transfer_id: writeTransferId } },
          );
        }
        const job = jobs.shift() ?? null;
        if (!job) await wait(40);
        return Response.json({ job });
      }
      if (route === `/api/donebot/collab/relay/transfers/${readTransferId}/upload`) {
        uploadedHeaders = init.headers;
        const chunks = [];
        for await (const chunk of init.body) chunks.push(Buffer.from(chunk));
        uploadedStreamBytes = Buffer.concat(chunks);
        return Response.json({ ok: true });
      }
      if (route === `/api/donebot/collab/relay/transfers/${oversizedTransferId}/fail`) {
        failedTransfers.push(JSON.parse(String(init.body)));
        return Response.json({ ok: true });
      }
      if (route === `/api/donebot/collab/relay/transfers/${writeTransferId}/download`) {
        return new Response(bigWriteBytes, { status: 200, headers: { "content-type": "application/octet-stream" } });
      }
      if (route === "/api/donebot/collab/relay/result") {
        results.push(JSON.parse(String(init.body)));
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });

  try {
    await controller.saveLocalFolder({
      id: folderId,
      path: sharedDir,
      name: "素材库",
      enabled: true,
      allowWrite: true,
    });

    for (let i = 0; i < 80 && (!uploadedStreamBytes || failedTransfers.length < 1 || results.length < 2); i += 1) {
      await wait(25);
    }

    assert.equal(uploadedStreamBytes?.length, bigReadBytes.length);
    assert.equal(uploadedHeaders["x-file-name"], undefined); // non-ASCII omitted safely
    assert.equal(failedTransfers.length, 1);
    assert.match(failedTransfers[0].error, /100 MB/);

    const listRes = results.find(r => r.result?.content?.[0]?.text?.includes("产品方案.bin"));
    assert.ok(listRes);
    const listParsed = JSON.parse(listRes.result.content[0].text);
    assert.equal(listParsed.entries.find(e => e.name === "产品方案.bin")?.size, bigReadBytes.length);
    assert.equal(listParsed.entries.some(e => e.name.startsWith(".")), false);

    const writeRes = results.find(r => r.result?.content?.[0]?.text?.includes('"written":true'));
    assert.ok(writeRes);
    const saved = fs.readFileSync(path.join(sharedDir, "交付", "视频素材.bin"));
    assert.equal(saved.length, bigWriteBytes.length);
    assert.ok(saved.equals(bigWriteBytes));
  } finally {
    controller.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(sharedParent, { recursive: true, force: true });
  }
});
