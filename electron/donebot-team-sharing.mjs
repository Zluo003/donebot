import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { allowedServerOrigin } from "./server-address.mjs";
import { existingFolders, validateSharedFolders, validSharedOperation } from "./computer-sharing.mjs";
import { executeSharedOperation, personalSecretPaths, sharedComputerError } from "./shared-computer-access.mjs";
import { createLendingActivity, describeSharedOperation } from "./lending-activity.mjs";

const uuidV4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const anyUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const accountPattern = /^[1-9][0-9]{0,19}$/;
const teamRoles = new Set(["owner", "admin", "member"]);
const ALLOWED_TEAM_ACTIONS = new Set(["list_files", "read_file", "write_file", "edit_file", "append_file", "delete_file", "run_command"]);
const LENT_PLATFORMS = new Set(["darwin", "win32", "linux"]);

function validTeamSessionId(id, teamId) {
  return typeof id === "string" && id.startsWith(`donebot-team:${teamId}:`) && id.length <= 160;
}

/** Member-owned local folder sharing for DoneBot team Clouds.
 * Authority stays on this desktop; only the sharing member's own turns can reach their folders on the team Cloud. */
export function createDoneBotTeamSharing({
  file,
  activityFile,
  fetch: fetchImpl,
  localRequest,
  ensureTeamCloud,
  protectedPaths = [],
  home = os.homedir(),
  now = Date.now,
}) {
  const protectedRoots = [path.dirname(file), ...protectedPaths.filter(entry => typeof entry === "string" && entry), ...personalSecretPaths(home)];
  const activity = createLendingActivity(activityFile ?? path.join(path.dirname(file), "donebot-team-sharing-activity.jsonl"), { now });
  let records = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed?.version === 1 && parsed.records && typeof parsed.records === "object") records = parsed.records;
  } catch { /* Missing or corrupted file starts empty; user re-saves explicitly. */ }

  const running = new Map();
  const status = new Map();
  const grantVersions = new Map();
  let closed = false;
  let executing = false;

  const bumpVersion = teamId => {
    const next = (grantVersions.get(teamId) ?? 0) + 1;
    grantVersions.set(teamId, next);
    return next;
  };

  const store = next => {
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
    } catch { return null; }
  }

  async function requestTeam(origin, route, body, signal, secret) {
    if (!allowedServerOrigin(origin)) throw new Error("团队 Cloud 地址无效，需要 HTTPS 连接。");
    const response = await fetchImpl(`${origin}${route}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "include",
      redirect: "error",
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(12_000),
      headers: {
        origin,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(secret ? { "x-omb-computer-secret": secret } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.length;
      if (bytes > 4_000_000) throw new Error("团队 Cloud 响应超过大小限制。");
      chunks.push(Buffer.from(chunk));
    }
    let json;
    try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw Object.assign(new Error("团队 Cloud 暂不支持本机文件夹共享，请先更新团队 Cloud 镜像。"), { status: response.status }); }
    if (!response.ok) {
      throw Object.assign(
        new Error(response.status === 401 || response.status === 403 ? "团队身份已失效或成员权限已变更，请重新连接团队。" : `团队共享请求失败（${response.status}）。`),
        { status: response.status },
      );
    }
    return json;
  }

  async function inspectTeamSession(origin, teamId, signal) {
    const auth = await requestTeam(origin, "/api/auth/session", undefined, signal);
    if (auth?.kind !== "session" || !validTeamSessionId(auth.id, teamId) || !anyUuid.test(auth.environmentId ?? "")) {
      throw Object.assign(new Error("团队会话尚未就绪，请重试。"), { status: 401 });
    }
    if (auth.lending?.sharedComputers !== true) {
      throw Object.assign(new Error("团队 Cloud 尚未启用本机文件夹共享，请先将团队 Cloud 更新到最新镜像。"), { code: "UNSUPPORTED" });
    }
    return { sessionId: auth.id, environmentId: auth.environmentId };
  }

  const stop = teamId => {
    const live = running.get(teamId);
    if (live) {
      live.abort.abort();
      running.delete(teamId);
    }
    status.set(teamId, { connected: false });
  };

  const disconnect = (grant, paused = false) => {
    stop(grant.teamId);
    if (!grant?.secret || !grant.origin) return;
    void requestTeam(grant.origin, `/api/shared-computers/${grant.id}/disconnect`, paused ? { paused: true } : {}, undefined, grant.secret).catch(() => {});
  };

  const run = (teamId, initialGrant) => {
    stop(teamId);
    if (closed || !initialGrant?.enabled) return;
    let grant = initialGrant;
    const live = { abort: new AbortController() };
    running.set(teamId, live);
    const { signal } = live.abort;
    const env = { id: `team:${teamId}`, name: grant.teamName, origin: grant.origin };
    const call = (action, body = {}) => requestTeam(grant.origin, `/api/shared-computers/${grant.id}/${action}`, body, signal, grant.secret);

    void (async () => {
      let authRetries = 0;
      while (!signal.aborted && !closed) {
        try {
          const signedIn = await currentAccountId();
          if (signal.aborted || running.get(teamId) !== live) break;
          if (!signedIn || signedIn !== grant.accountId) {
            status.set(teamId, { connected: false, error: "当前账号已退出或切换，已暂停团队文件夹共享。" });
            break;
          }
          let info;
          try {
            info = await inspectTeamSession(grant.origin, teamId, signal);
          } catch (error) {
            if ((error?.status === 401 || error?.status === 403) && authRetries < 2) {
              authRetries += 1;
              const renewed = await ensureTeamCloud({
                id: grant.instanceId,
                accountId: grant.accountId,
                team: { id: teamId, name: grant.teamName, role: grant.role },
              });
              if (!renewed?.origin || signal.aborted || running.get(teamId) !== live) break;
              if (renewed.origin !== grant.origin) {
                grant = { ...grant, origin: renewed.origin };
                if (records[teamId]?.id === grant.id) store({ ...records, [teamId]: grant });
              }
              info = await inspectTeamSession(grant.origin, teamId, signal);
            } else {
              throw error;
            }
          }
          authRetries = 0;
          if (signal.aborted || running.get(teamId) !== live) break;
          if (grant.environmentId && grant.environmentId !== info.environmentId) {
            disconnect(grant);
            store({ ...records, [teamId]: { ...grant, enabled: false } });
            status.set(teamId, { connected: false, error: "团队 Cloud 实例已更换，请重新确认共享文件夹。" });
            break;
          }
          if (grant.environmentId !== info.environmentId || grant.sessionId !== info.sessionId) {
            grant = { ...grant, ...info };
            if (records[teamId]?.id === grant.id) store({ ...records, [teamId]: grant });
          }

          const present = new Set((await existingFolders(grant.folders, validateSharedFolders)).map(folder => folder.id));
          const folders = grant.folders.filter(folder => present.has(folder.id));
          const effectiveGrant = { ...grant, folders, computer: false, protectedPaths: protectedRoots };

          await requestTeam(grant.origin, "/api/shared-computers/connect", {
            id: grant.id,
            name: os.hostname().slice(0, 120) || "DoneBot",
            environmentId: grant.environmentId,
            folders: folders.map(({ id, name, write }) => ({ id, name, write })),
            terminal: grant.terminal === true,
            computer: false,
            ...(LENT_PLATFORMS.has(process.platform) ? { platform: process.platform } : {}),
            commandTimeouts: true,
            longCommands: true,
            fileEdits: true,
          }, signal, grant.secret);
          if (signal.aborted || running.get(teamId) !== live) break;

          status.set(teamId, { connected: true });
          while (!signal.aborted && !closed) {
            const { job } = await call("poll", {});
            if (signal.aborted || running.get(teamId) !== live) break;
            if (!job) continue;
            if (!anyUuid.test(job.id ?? "")) throw new Error("Invalid team computer request");
            if (!validSharedOperation(job.operation, grant.id) || !ALLOWED_TEAM_ACTIONS.has(job.operation.action)) {
              activity.record({ env, action: "invalid", detail: "", ok: false, error: "已拒绝团队未授权的操作类型" });
              await call("result", { jobId: job.id, result: sharedComputerError(new Error("This operation is not permitted for team folder sharing")) });
              continue;
            }
            if (executing) {
              await call("result", { jobId: job.id, result: sharedComputerError(new Error("This computer is busy with another request")) });
              continue;
            }
            executing = true;
            const jobAbort = new AbortController();
            const jobSignal = AbortSignal.any([signal, jobAbort.signal]);
            let leasing = false;
            const lease = async () => {
              if (leasing) return;
              leasing = true;
              try {
                if (!(await call("lease", { jobId: job.id })).active) jobAbort.abort();
              } catch { jobAbort.abort(); }
              finally { leasing = false; }
            };
            const heartbeat = setInterval(() => { void lease(); }, 1000);
            let result;
            try {
              await lease();
              jobSignal.throwIfAborted();
              result = await executeSharedOperation(effectiveGrant, job.operation, jobSignal);
            } catch (error) {
              result = sharedComputerError(error);
            } finally {
              clearInterval(heartbeat);
              executing = false;
            }
            activity.record({
              env,
              action: job.operation.action,
              detail: describeSharedOperation(effectiveGrant, job.operation),
              ok: result?.isError !== true,
              error: result?.isError === true ? result?.content?.[0]?.text : undefined,
            });
            await call("result", { jobId: job.id, result });
          }
        } catch (error) {
          if (signal.aborted || closed) break;
          status.set(teamId, { connected: false, error: error instanceof Error ? error.message : "团队文件夹共享连接中断，正在重试。" });
          if (error?.code === "UNSUPPORTED") break;
        }
        try { await delay(5_000, undefined, { signal }); } catch { break; }
      }
      if (running.get(teamId) === live) running.delete(teamId);
    })().catch(() => {});
  };

  async function state(teamId) {
    if (!uuidV4.test(teamId ?? "")) throw new Error("无效的团队标识。");
    const grant = records[teamId];
    const signedIn = await currentAccountId();
    if (!grant || !signedIn || grant.accountId !== signedIn) {
      return { enabled: false, connected: false, folders: [], terminal: false };
    }
    const live = status.get(teamId);
    return {
      enabled: grant.enabled === true,
      connected: live?.connected === true,
      folders: Array.isArray(grant.folders) ? grant.folders : [],
      terminal: grant.terminal === true,
      ...(live?.error ? { error: live.error } : {}),
    };
  }

  async function save(input) {
    if (closed) throw new Error("应用正在退出，无法保存团队共享设置。");
    const teamId = String(input?.teamId ?? "");
    const instanceId = String(input?.instanceId ?? "");
    const accountId = String(input?.accountId ?? "");
    const role = teamRoles.has(input?.role) ? input.role : "member";
    const teamName = String(input?.teamName ?? "").trim().slice(0, 100) || "团队 Cloud";
    if (!uuidV4.test(teamId) || !uuidV4.test(instanceId) || !accountPattern.test(accountId)) {
      throw new Error("无效的团队共享参数。");
    }
    const signedIn = await currentAccountId();
    if (!signedIn || signedIn !== accountId) throw new Error("DoneBot 账号已切换，请刷新后重试。");

    const terminal = input?.terminal === true;
    const rawFolders = Array.isArray(input?.folders) ? input.folders : [];
    if (rawFolders.length === 0 && !terminal) {
      return revoke(teamId, { clearFolders: true });
    }

    const version = bumpVersion(teamId);
    const folders = await validateSharedFolders(rawFolders, { homeEdits: false });
    const destination = await ensureTeamCloud({ id: instanceId, accountId, team: { id: teamId, name: teamName, role } });
    if (!destination?.origin) throw new Error("无法连接团队 Cloud，请确认团队 Cloud 正在运行。");
    const info = await inspectTeamSession(destination.origin, teamId);
    if (grantVersions.get(teamId) !== version) return state(teamId);

    const existing = records[teamId];
    if (existing) disconnect(existing);
    const grant = {
      id: randomUUID(),
      secret: randomBytes(32).toString("hex"),
      enabled: true,
      teamId,
      instanceId,
      accountId,
      teamName,
      role,
      origin: destination.origin,
      environmentId: info.environmentId,
      sessionId: info.sessionId,
      folders,
      terminal,
      computer: false,
    };
    store({ ...records, [teamId]: grant });
    status.set(teamId, { connected: false });
    run(teamId, grant);
    return state(teamId);
  }

  async function revoke(teamId, { clearFolders = false } = {}) {
    if (!uuidV4.test(teamId ?? "")) throw new Error("无效的团队标识。");
    bumpVersion(teamId);
    const existing = records[teamId];
    if (existing) {
      disconnect(existing);
      store({
        ...records,
        [teamId]: {
          ...existing,
          enabled: false,
          ...(clearFolders ? { folders: [], terminal: false } : {}),
        },
      });
    } else {
      stop(teamId);
    }
    return state(teamId);
  }

  async function listActivity(teamId, limit = 50) {
    if (!uuidV4.test(teamId ?? "")) return [];
    const grant = records[teamId];
    const signedIn = await currentAccountId();
    if (!grant || !signedIn || grant.accountId !== signedIn) return [];
    return activity.list(500).filter(entry => entry.origin === grant.origin).slice(0, limit);
  }

  async function start() {
    if (closed) return;
    const signedIn = await currentAccountId();
    if (!signedIn) return;
    for (const [teamId, grant] of Object.entries(records)) {
      if (!grant?.enabled || grant.accountId !== signedIn || !uuidV4.test(teamId) || !uuidV4.test(grant.instanceId ?? "")) continue;
      if (!Array.isArray(grant.folders) || (!grant.folders.length && !grant.terminal)) continue;
      try {
        const res = await localRequest(`/api/donebot/teams/${teamId}/devices`, { signal: AbortSignal.timeout(5_000) });
        if (!res.ok) continue;
        const snapshot = await res.json();
        const local = snapshot?.devices?.find(device => device.id === snapshot.local_device_id && device.enabled === true);
        if (local) run(teamId, grant);
      } catch { /* Best-effort restore on launch; user can re-enable from Team settings. */ }
    }
  }

  function close() {
    closed = true;
    for (const grant of Object.values(records)) {
      if (grant?.teamId && running.has(grant.teamId)) disconnect(grant, true);
    }
    for (const teamId of running.keys()) stop(teamId);
  }

  return { state, save, revoke, activity: listActivity, start, close };
}

export function installDoneBotTeamSharing({ ipcMain, guardLocal, controller, pickFolder, lifecycle }) {
  ipcMain.handle("donebot-team-sharing:state", guardLocal("donebot-team-sharing:state", (_event, teamId) => controller.state(teamId)));
  ipcMain.handle("donebot-team-sharing:choose-folder", guardLocal("donebot-team-sharing:choose-folder", async () => {
    const chosen = await pickFolder();
    if (!chosen) return null;
    const [folder] = await validateSharedFolders([{ id: randomUUID(), path: chosen, write: false }], { homeEdits: false });
    return folder ?? null;
  }));
  ipcMain.handle("donebot-team-sharing:save", guardLocal("donebot-team-sharing:save", (_event, input) => controller.save(input)));
  ipcMain.handle("donebot-team-sharing:revoke", guardLocal("donebot-team-sharing:revoke", (_event, teamId) => controller.revoke(teamId)));
  ipcMain.handle("donebot-team-sharing:activity", guardLocal("donebot-team-sharing:activity", (_event, teamId) => controller.activity(teamId)));
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
