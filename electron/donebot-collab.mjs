import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { validateSharedFolders } from "./computer-sharing.mjs";
import { executeSharedOperation, personalSecretPaths, sharedComputerError } from "./shared-computer-access.mjs";

const uuidV4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ALLOWED_COLLAB_ACTIONS = new Set(["list_files", "read_file", "write_file", "edit_file", "append_file", "delete_file"]);
const WRITE_ACTIONS = new Set(["write_file", "edit_file", "append_file", "delete_file"]);
const ACTIVITY_LIMIT = 500;

function readActivityFile(activityFile) {
  try {
    const raw = fs.readFileSync(activityFile, "utf8");
    const items = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object") items.push(parsed);
      } catch { /* Ignore malformed line */ }
    }
    return items;
  } catch {
    return [];
  }
}

function appendActivity(activityFile, entry) {
  try {
    fs.mkdirSync(path.dirname(activityFile), { recursive: true, mode: 0o700 });
    const existing = readActivityFile(activityFile);
    existing.push(entry);
    const trimmed = existing.slice(-ACTIVITY_LIMIT);
    const temporary = `${activityFile}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, trimmed.map(item => JSON.stringify(item)).join("\n") + "\n", { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, activityFile);
  } catch { /* Best-effort audit log */ }
}

function operationSummary(operation) {
  const rel = typeof operation?.path === "string" && operation.path ? operation.path : ".";
  return rel.slice(0, 240);
}

/** Local gateway-relayed folder sharing for DoneBot friends and teams.
 * Local absolute paths never leave this desktop; every remote operation is re-checked locally before executing. */
export function createDoneBotCollab({
  file,
  activityFile,
  localRequest,
  protectedPaths = [],
  home = os.homedir(),
  now = Date.now,
}) {
  const protectedRoots = [
    path.dirname(file),
    ...protectedPaths.filter(entry => typeof entry === "string" && entry),
    ...personalSecretPaths(home),
  ];
  const auditFile = activityFile ?? path.join(path.dirname(file), "donebot-collab-activity.jsonl");
  let records = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed?.version === 1 && parsed.records && typeof parsed.records === "object") records = parsed.records;
  } catch { /* Missing or corrupted store starts empty. */ }

  let pollRun = null;
  let connected = false;
  let lastError = "";
  let closed = false;
  let executing = false;

  const persist = next => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, records: next }) + "\n", { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
    records = next;
  };

  async function currentAccountId() {
    try {
      const response = await localRequest("/api/donebot/state", { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return null;
      const value = await response.json();
      return value?.authenticated && typeof value.user?.id === "string" ? value.user.id : null;
    } catch {
      return null;
    }
  }

  function activeForAccount(accountId) {
    return Object.values(records).filter(item => item && item.accountId === accountId && item.enabled === true);
  }

  function stopPoller() {
    if (pollRun) {
      pollRun.abort.abort();
      pollRun = null;
    }
    connected = false;
  }

  function ensurePoller(accountId) {
    if (closed) return;
    const active = activeForAccount(accountId);
    if (active.length === 0) {
      stopPoller();
      lastError = "";
      return;
    }
    if (pollRun && pollRun.accountId === accountId && !pollRun.abort.signal.aborted) return;
    stopPoller();
    const run = { accountId, abort: new AbortController() };
    pollRun = run;
    const { signal } = run.abort;

    void (async () => {
      while (!signal.aborted && !closed && pollRun === run) {
        try {
          const signedIn = await currentAccountId();
          if (signal.aborted || pollRun !== run) break;
          if (!signedIn || signedIn !== accountId) {
            connected = false;
            lastError = "当前 DoneBot 账号已退出或切换，已暂停远程文件夹共享。";
            break;
          }
          if (activeForAccount(accountId).length === 0) {
            connected = false;
            lastError = "";
            break;
          }
          const res = await localRequest("/api/donebot/collab/relay/poll", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
            signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
          });
          if (signal.aborted || pollRun !== run) break;
          if (!res.ok) {
            connected = false;
            let errText = `远程协作中继连接失败（${res.status}）。`;
            try {
              const payload = await res.json();
              if (typeof payload?.error === "string" && payload.error.trim()) errText = payload.error.trim();
            } catch { /* ignore */ }
            lastError = errText;
            if (res.status === 401 || res.status === 403) break;
            await delay(4_000, undefined, { signal });
            continue;
          }
          connected = true;
          lastError = "";
          const payload = await res.json();
          const job = payload?.job ?? null;
          if (!job || typeof job !== "object") continue;
          await handleJob(accountId, job, signal);
        } catch (error) {
          if (signal.aborted || closed || pollRun !== run) break;
          connected = false;
          lastError = error instanceof Error ? error.message : "远程协作连接中断，正在重连。";
          try { await delay(4_000, undefined, { signal }); } catch { break; }
        }
      }
      if (pollRun === run) {
        pollRun = null;
        connected = false;
      }
    })().catch(() => {});
  }

  async function postResult(jobId, result) {
    try {
      await localRequest("/api/donebot/collab/relay/result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ job_id: jobId, result }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch { /* Best-effort reply; caller times out safely on drop. */ }
  }

  async function handleJob(accountId, job, signal) {
    const jobId = typeof job.id === "string" ? job.id : "";
    const folderId = typeof job.folder_id === "string" ? job.folder_id : "";
    const callerEmail = typeof job.caller_email === "string" ? job.caller_email : "unknown";
    const grantedAccess = job.granted_access === "write" ? "write" : "read";
    const op = job.operation && typeof job.operation === "object" ? job.operation : null;
    if (!jobId) return;

    const record = records[folderId];
    if (!record || record.accountId !== accountId || record.enabled !== true) {
      const errResult = sharedComputerError(new Error("该共享文件夹当前未启用或已被主人移除。"));
      appendActivity(auditFile, { at: now(), folderId, folderName: record?.name ?? folderId, callerEmail, action: op?.action ?? "invalid", detail: operationSummary(op), ok: false, error: "文件夹未启用或已移除" });
      await postResult(jobId, errResult);
      return;
    }

    const action = typeof op?.action === "string" ? op.action : "";
    if (!ALLOWED_COLLAB_ACTIONS.has(action)) {
      const errResult = sharedComputerError(new Error("远程共享文件夹仅支持安全文件读写操作。"));
      appendActivity(auditFile, { at: now(), folderId, folderName: record.name, callerEmail, action: action || "invalid", detail: operationSummary(op), ok: false, error: "已拒绝未授权操作类型" });
      await postResult(jobId, errResult);
      return;
    }

    const canWrite = grantedAccess === "write" && record.allowWrite === true;
    if (WRITE_ACTIONS.has(action) && !canWrite) {
      const errResult = sharedComputerError(new Error("你对该共享文件夹仅拥有只读权限。"));
      appendActivity(auditFile, { at: now(), folderId, folderName: record.name, callerEmail, action, detail: operationSummary(op), ok: false, error: "只读权限已拦截写入" });
      await postResult(jobId, errResult);
      return;
    }

    if (executing) {
      await postResult(jobId, sharedComputerError(new Error("对方电脑正在处理另一项文件操作，请稍后重试。")));
      return;
    }

    executing = true;
    let result;
    try {
      const grant = {
        enabled: true,
        folders: [{ id: record.id, name: record.name, path: record.path, write: canWrite }],
        terminal: false,
        computer: false,
        protectedPaths: protectedRoots,
      };
      result = await executeSharedOperation(grant, {
        computer_id: record.id,
        folder_id: record.id,
        ...op,
      }, signal);
    } catch (error) {
      result = sharedComputerError(error);
    } finally {
      executing = false;
    }

    appendActivity(auditFile, {
      at: now(),
      folderId: record.id,
      folderName: record.name,
      callerEmail,
      action,
      detail: operationSummary(op),
      ok: result?.isError !== true,
      ...(result?.isError === true ? { error: result?.content?.[0]?.text ?? "操作失败" } : {}),
    });
    await postResult(jobId, result);
  }

  async function listLocalFolders() {
    const accountId = await currentAccountId();
    if (!accountId) return [];
    return Object.values(records).filter(item => item && item.accountId === accountId);
  }

  async function saveLocalFolder(input) {
    if (closed) throw new Error("应用正在退出，无法保存共享文件夹。");
    const accountId = await currentAccountId();
    if (!accountId) throw new Error("请先登录 DoneBot 账号。");
    const id = typeof input?.id === "string" && uuidV4.test(input.id) ? input.id : randomUUID();
    const rawPath = typeof input?.path === "string" ? input.path : records[id]?.path ?? "";
    const [validated] = await validateSharedFolders([{ id, path: rawPath, name: input?.name, write: input?.allowWrite === true }], { homeEdits: false });
    if (!validated) throw new Error("请选择有效的本机文件夹。");
    const entry = {
      id,
      accountId,
      path: validated.path,
      name: typeof input?.name === "string" && input.name.trim() ? input.name.trim().slice(0, 120) : validated.name,
      enabled: input?.enabled !== false,
      allowWrite: input?.allowWrite === true,
    };
    persist({ ...records, [id]: entry });
    ensurePoller(accountId);
    return entry;
  }

  async function removeLocalFolder(id) {
    if (!uuidV4.test(id ?? "")) throw new Error("无效的文件夹标识。");
    const accountId = await currentAccountId();
    if (!accountId) return { ok: true };
    const existing = records[id];
    if (existing && existing.accountId === accountId) {
      const next = { ...records };
      delete next[id];
      persist(next);
      ensurePoller(accountId);
    }
    return { ok: true };
  }

  async function status() {
    const accountId = await currentAccountId();
    if (!accountId) return { connected: false, activeCount: 0 };
    const activeCount = activeForAccount(accountId).length;
    if (activeCount > 0) ensurePoller(accountId);
    return {
      connected: activeCount > 0 && connected,
      activeCount,
      ...(lastError ? { error: lastError } : {}),
    };
  }

  async function listActivity(folderId) {
    const accountId = await currentAccountId();
    if (!accountId) return [];
    const allowedIds = new Set(Object.values(records).filter(item => item && item.accountId === accountId).map(item => item.id));
    return readActivityFile(auditFile)
      .filter(entry => allowedIds.has(entry.folderId) && (!folderId || entry.folderId === folderId))
      .reverse()
      .slice(0, 100);
  }

  async function start() {
    if (closed) return;
    const accountId = await currentAccountId();
    if (accountId && activeForAccount(accountId).length > 0) ensurePoller(accountId);
  }

  function close() {
    closed = true;
    stopPoller();
  }

  return { listLocalFolders, saveLocalFolder, removeLocalFolder, status, activity: listActivity, start, close };
}

export function installDoneBotCollab({ ipcMain, guardLocal, controller, pickFolder, lifecycle }) {
  ipcMain.handle("donebot-collab:choose-folder", guardLocal("donebot-collab:choose-folder", async () => {
    const chosen = await pickFolder();
    if (!chosen) return null;
    const [folder] = await validateSharedFolders([{ id: randomUUID(), path: chosen, write: false }], { homeEdits: false });
    return folder ? { id: folder.id, path: folder.path, name: folder.name } : null;
  }));
  ipcMain.handle("donebot-collab:list-folders", guardLocal("donebot-collab:list-folders", () => controller.listLocalFolders()));
  ipcMain.handle("donebot-collab:save-folder", guardLocal("donebot-collab:save-folder", (_event, input) => controller.saveLocalFolder(input)));
  ipcMain.handle("donebot-collab:remove-folder", guardLocal("donebot-collab:remove-folder", (_event, id) => controller.removeLocalFolder(id)));
  ipcMain.handle("donebot-collab:status", guardLocal("donebot-collab:status", () => controller.status()));
  ipcMain.handle("donebot-collab:activity", guardLocal("donebot-collab:activity", (_event, folderId) => controller.activity(folderId)));

  let bootTimer = null;
  lifecycle?.whenReady().then(() => {
    bootTimer = setTimeout(() => { bootTimer = null; void controller.start(); }, 4_000);
    bootTimer.unref?.();
  });
  lifecycle?.once("before-quit", () => {
    if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
    controller.close();
  });
  return controller;
}
