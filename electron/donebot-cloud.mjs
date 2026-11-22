import { randomUUID } from "node:crypto";
import environments from "./environments.cjs";
import { createDoneBotCloudKeepalive } from "./donebot-cloud-keepalive.mjs";
import { createDoneBotCloudLoading } from "./donebot-cloud-loading.mjs";

const instanceId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const teamRoles = new Set(["owner", "admin", "member"]);

export const doneBotCloudEntry = environments.doneBotCloudEntry;
export const doneBotPersonalCloudEntry = environments.doneBotPersonalCloudEntry;

export async function hasDoneBotCloud(request, state) {
  if (state.environments.some(doneBotPersonalCloudEntry)) return true;
  try {
    const response = await request("/api/donebot/cloud", { signal: AbortSignal.timeout(3_000) });
    return response.ok && Boolean((await response.json()).instance?.paid_until);
  } catch { return false; }
}

export function createDoneBotCloudConnection({ request, fetch: cookieFetch, saved, remember, activate }) {
  const flights = new Map();
  let turn = 0;
  async function local(path, body) {
    const response = await request(path, { ...(body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
    const value = await response.json();
    if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : "Cloud 连接暂时不可用。");
    return value;
  }
  async function account(expected) {
    const state = await local("/api/donebot/state");
    if (!state.authenticated || !state.user?.id || expected && state.user.id !== expected) throw new Error("请在这台电脑登录对应的 DoneBot 账号后重试。");
    return state.user.id;
  }
  async function connected(origin) {
    try {
      const response = await cookieFetch(origin + "/api/auth/session", { credentials: "include", redirect: "error", signal: AbortSignal.timeout(5_000) });
      await response.body?.cancel();
      return response.ok && response.headers.get("x-donebot-cloud") === "1";
    } catch { return false; }
  }
  function resolveTeam(team, entry) {
    const teamId = team?.id ?? entry?.team?.id ?? entry?.donebotCloud?.teamId;
    if (!teamId) return null;
    if (!instanceId.test(teamId)) throw new Error("无效的团队标识。");
    const role = teamRoles.has(team?.role) ? team.role : teamRoles.has(entry?.team?.role) ? entry.team.role : "member";
    const name = String(team?.name ?? entry?.name ?? "").trim().slice(0, 100) || "团队 Cloud";
    return { id: teamId, role, name };
  }
  async function prepare(id, owner, entry, renew, team) {
    let origin = entry?.origin;
    const resolvedTeam = resolveTeam(team, entry);
    if (!renew && origin && entry?.donebotCloud?.accountId === owner && await connected(origin)) {
      return { origin, id, accountId: owner, ...(resolvedTeam ? { team: resolvedTeam, name: resolvedTeam.name } : {}) };
    }
    const launch = resolvedTeam
      ? await local(`/api/donebot/teams/${resolvedTeam.id}/cloud/connect`, { instance_id: id, account_id: owner })
      : await local("/api/donebot/cloud/connect", { id, account_id: owner });
    const link = new URL(launch.url), target = new URL(link.searchParams.get("address"));
    const token = link.searchParams.get("token");
    if (link.protocol !== "donebot:" || link.hostname !== "pair" || target.protocol !== "https:" ||
        !target.hostname.startsWith(id + ".") || target.href !== target.origin + "/" || !/^omb_pair_[A-Za-z0-9_-]{43}$/.test(token ?? "") ||
        origin && target.origin !== origin) throw new Error("Cloud 连接地址无法验证。");
    origin = target.origin;
    const resolvedName = resolvedTeam ? (String(link.searchParams.get("name") ?? "").trim().slice(0, 100) || resolvedTeam.name) : undefined;
    await account(owner);
    const paired = await cookieFetch(origin + "/api/auth/pair", { method: "POST", redirect: "error", credentials: "include",
      headers: { "content-type": "application/json", origin }, body: JSON.stringify({ code: token }), signal: AbortSignal.timeout(10_000) });
    await paired.body?.cancel();
    if (!paired.ok) throw new Error("Cloud 自动连接未完成，请重试。");
    await account(owner);
    return { origin, id, accountId: owner, ...(resolvedTeam ? { team: { id: resolvedTeam.id, role: resolvedTeam.role }, name: resolvedName } : {}) };
  }
  async function target(id, owner, entry, renew = false, team = null) {
    const resolvedTeam = resolveTeam(team, entry);
    const key = JSON.stringify([id, owner, renew, resolvedTeam?.id ?? null]);
    let flight = flights.get(key);
    if (!flight) {
      flight = prepare(id, owner, entry ?? saved().environments.find(candidate => candidate.donebotCloud?.id === id && candidate.donebotCloud.accountId === owner && (candidate.team?.id ?? candidate.donebotCloud?.teamId ?? null) === (resolvedTeam?.id ?? null)), renew, resolvedTeam);
      flights.set(key, flight);
      void flight.finally(() => { if (flights.get(key) === flight) flights.delete(key); }).catch(() => {});
    }
    return flight;
  }
  return {
    cancel() { turn++; },
    async renew(entry, still = () => true) {
      const id = entry.donebotCloud?.id ?? new URL(entry.origin).hostname.split(".")[0];
      if (!instanceId.test(id)) throw new Error("无效的 Cloud 实例。");
      const owner = await account(entry.donebotCloud?.accountId);
      if (!still()) return;
      const renewed = await target(id, owner, entry, true);
      await account(owner);
      if (still()) remember(renewed);
    },
    async ensure({ id, accountId, entry, team, still = () => true }) {
      id ??= entry?.donebotCloud?.id ?? new URL(entry.origin).hostname.split(".")[0];
      if (!instanceId.test(id ?? "")) throw new Error("无效的 Cloud 实例。");
      const owner = await account(accountId ?? entry?.donebotCloud?.accountId);
      if (!still()) return null;
      const destination = await target(id, owner, entry, false, team);
      await account(owner);
      if (!still()) return null;
      remember(destination);
      return destination;
    },
    async open({ id, accountId, entry, team, still = () => true, progress = () => {} }) {
      const mine = ++turn;
      id ??= entry?.donebotCloud?.id ?? new URL(entry.origin).hostname.split(".")[0];
      if (!instanceId.test(id ?? "")) throw new Error("无效的 Cloud 实例。");
      const owner = await account(accountId ?? entry?.donebotCloud?.accountId);
      if (mine !== turn || !still()) return { outcome: "cancelled" };
      progress("connecting");
      const destination = await target(id, owner, entry, false, team);
      await account(owner);
      if (mine !== turn || !still()) return { outcome: "cancelled" };
      remember(destination);
      progress("loading");
      const result = await activate(destination.origin);
      if (result === false) throw new Error("Cloud 页面暂时无法打开，请稍后重试。");
      return { outcome: "connected" };
    },
  };
}

export function installDoneBotCloud({ ipcMain, guardLocal, guardWorkspace, request, fetch, saved, persist, cancelHome, navigate, local, expires, lifecycle, loading }) {
  const { withEnvironment, withActive, activeEnvironment } = environments;
  const connection = createDoneBotCloudConnection({ request, fetch, saved,
    remember: target => {
      const name = target.team ? (target.name ?? saved().environments.find(entry => entry.origin === target.origin)?.name ?? "团队 Cloud")
        : (saved().environments.find(entry => entry.origin === target.origin)?.name ?? "DoneBot Cloud");
      const next = withEnvironment(saved(), { origin: target.origin, name }, randomUUID);
      persist({ ...next, environments: next.environments.map(entry => entry.origin === target.origin ? {
        ...entry,
        ...(target.team ? { team: { id: target.team.id, role: target.team.role } } : {}),
        donebotCloud: { id: target.id, accountId: target.accountId, ...(target.team ? { teamId: target.team.id } : {}) },
      } : entry) });
    },
    activate: async origin => {
      const state = saved(), entry = state.environments.find(candidate => candidate.origin === origin);
      persist(withActive(state, entry.id));
      cancelHome();
      return navigate(origin);
    },
  });
  const cancel = () => { connection.cancel(); display?.hide(); };
  const returnLocal = () => { cancel(); return local(); };
  const display = loading ? createDoneBotCloudLoading({ ...loading, local: returnLocal }) : null;
  const open = async args => {
    const screen = display?.start(() => open(args));
    try {
      const result = await connection.open({ ...args, progress: stage => screen?.update(stage) });
      if (result.outcome === "connected") await screen?.finish();
      else screen?.close();
      return result;
    } catch (error) { screen?.fail(); throw error; }
  };
  ipcMain.handle("donebot-cloud:open", guardLocal("donebot-cloud:open", (_event, id, accountId) => open({ id, accountId })));
  ipcMain.handle("donebot-cloud:open-team", guardLocal("donebot-cloud:open-team", (_event, teamId, instanceIdArg, accountId, teamName, role) =>
    open({ id: instanceIdArg, accountId, team: { id: teamId, name: teamName, role } })));
  ipcMain.handle("donebot-cloud:reconnect", guardWorkspace(event => {
    const entry = activeEnvironment(saved());
    if (!doneBotCloudEntry(entry) || new URL(event.senderFrame.url).origin !== entry.origin) throw new Error("此页面不能重新连接 Cloud。");
    return open({ entry });
  }));
  ipcMain.handle("donebot-cloud:local", guardWorkspace(returnLocal));
  const renewal = expires ? createDoneBotCloudKeepalive({ entry: () => {
    const entry = activeEnvironment(saved());
    return doneBotCloudEntry(entry) ? entry : null;
  }, expires, renew: connection.renew }) : null;
  lifecycle?.whenReady().then(() => renewal?.start());
  lifecycle?.once("before-quit", () => { renewal?.stop(); cancel(); });
  return { ...connection, open, cancel, refreshTheme: () => display?.refreshTheme(), hidesRail: () => Boolean(display?.visible()) || doneBotCloudEntry(activeEnvironment(saved())), start: () => renewal?.start(), stop: () => { renewal?.stop(); cancel(); }, select(entry, still) {
    connection.cancel();
    if (doneBotCloudEntry(entry)) return open({ entry, still });
    display?.hide();
    return null;
  } };
}
