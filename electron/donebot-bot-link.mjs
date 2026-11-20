import { BACKGROUND_HEADERS } from "./cloud-power.mjs";

const STATE = "/api/bot-link", PAIR = "/api/bot-link/pair";
const RETRY_MS = 6 * 60 * 60_000;
const CLOUD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function createDoneBotBotLink({ request, fetch: cookieFetch, saved, pref, renew, allowed = () => true, now = Date.now, watchMs = 30_000 }) {
  let epoch = 0, closed = false, flight = null, retryAt = 0;
  let shown = { enabled: false, connected: false, available: false, error: "" };
  const preference = () => { try { const value = pref.read(); return value?.v === 1 && value.enabled === true ? value : null; } catch { return null; } };
  async function local(path, init = {}) {
    const response = await request(path, { ...init, signal: AbortSignal.timeout(15_000) });
    const value = await response.json();
    if (!response.ok) throw new Error(typeof value?.error === "string" ? value.error : "本机服务暂时不可用。");
    return value;
  }
  const write = payload => local(STATE, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  async function discover() {
    const state = await local("/api/donebot/state");
    if (!state.authenticated || !state.user?.id) return { accountId: null, id: null, entry: null, running: false };
    const snapshot = await local("/api/donebot/cloud");
    if (snapshot.account_id !== state.user.id) throw new Error("DoneBot 账号已变化，请重试。");
    const instance = snapshot.instance;
    const entry = CLOUD_ID.test(instance?.id ?? "") ? saved().environments.find(candidate => {
      if (candidate.donebotCloud?.id !== instance.id || candidate.donebotCloud.accountId !== state.user.id) return false;
      try { const url = new URL(candidate.origin); return url.protocol === "https:" && url.origin === candidate.origin && url.hostname.startsWith(instance.id + "."); } catch { return false; }
    }) ?? null : null;
    const running = Boolean(instance && instance.actual === "running" && instance.desired === "running" && instance.subscription_state === "active" && !instance.purge_locked && Date.parse(instance.paid_until) > now() && snapshot.connection_available);
    return { accountId: state.user.id, id: instance?.id ?? null, entry, running };
  }
  const same = (target, setting) => Boolean(setting && setting.accountId === target.accountId && setting.instanceId === target.id && target.entry);
  const current = (mine, target) => !closed && epoch === mine && allowed() && same(target, preference());
  async function forget(target, computer) {
    try {
      const response = await cookieFetch(`${target.entry.origin}${PAIR}?${new URLSearchParams({ computer: computer.id })}`, { method: "DELETE", credentials: "include", redirect: "error", signal: AbortSignal.timeout(10_000), headers: { origin: target.entry.origin, ...BACKGROUND_HEADERS } });
      await response.body?.cancel();
    } catch {}
  }
  async function pair(target, mine) {
    const described = await local("/.well-known/donebot/environment");
    if (!current(mine, target)) return;
    if (typeof described.environmentId !== "string" || !described.environmentId) throw new Error("本机设备身份不可用。");
    const computer = { id: described.environmentId, name: String(described.label ?? "").trim().slice(0, 120) || "这台电脑" };
    const send = () => cookieFetch(target.entry.origin + PAIR, { method: "POST", credentials: "include", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { origin: target.entry.origin, "content-type": "application/json", ...BACKGROUND_HEADERS }, body: JSON.stringify({ computer, name: "DoneBot Cloud" }) });
    let response = await send();
    if (response.status === 401 && current(mine, target)) {
      await response.body?.cancel();
      await renew(target.entry, () => current(mine, target));
      if (!current(mine, target)) return;
      response = await send();
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(response.status === 404 ? "Cloud 版本尚不支持协作，请升级云端。" : "Cloud 拒绝连接，请刷新登录后重试。");
    }
    const paired = await response.json();
    try {
      if (typeof paired.token !== "string" || typeof paired.place?.id !== "string") throw new Error("Cloud 协作响应无效。");
      const latest = await discover();
      if (!current(mine, target) || !same(latest, preference()) || !latest.running || latest.entry.origin !== target.entry.origin) throw new Error("DoneBot 账号或 Cloud 已变化。");
      const state = await write({ on: true, origin: target.entry.origin, token: paired.token, name: computer.name, cloud: paired.place, account: target.accountId });
      if (!current(mine, target)) { await write({ on: false }); throw new Error("协作已关闭。"); }
      return state;
    } catch (cause) { await forget(target, computer); throw cause; }
  }
  async function reconcile(force) {
    const mine = epoch;
    const state = await local(STATE);
    if (closed) return shown;
    const setting = preference();
    if (!setting || !allowed()) {
      if (state.on && state.role === "dialer") await write({ on: false });
      return (shown = { enabled: false, connected: false, available: false, error: "" });
    }
    const target = await discover();
    if (!current(mine, target)) {
      if (mine === epoch) {
        pref.write({ v: 1, enabled: false });
        if (state.on && state.role === "dialer") await write({ on: false });
      }
      return (shown = { enabled: false, connected: false, available: Boolean(target.entry), error: "" });
    }
    let next = state;
    if (state.on && (state.origin !== target.entry.origin || state.account !== target.accountId)) next = await write({ on: false });
    if (!target.running) {
      if (next.on && !next.asleep) next = await write({ cloud: "asleep", origin: target.entry.origin });
    } else if (!next.on || next.needsPairing) {
      if (force || now() >= retryAt) {
        retryAt = now() + RETRY_MS;
        next = await pair(target, mine) ?? next;
        retryAt = 0;
      }
    } else if (next.asleep) next = await write({ cloud: "awake", origin: target.entry.origin });
    if (current(mine, target)) shown = { enabled: true, connected: next.online === true, available: true, error: "" };
    return shown;
  }
  function look(force = false) {
    if (closed) return Promise.resolve(shown);
    const mine = epoch;
    flight ??= reconcile(force).catch(cause => {
      if (!closed && mine === epoch) shown = { ...shown, error: cause instanceof Error ? cause.message : "协作连接暂时不可用。" };
      return shown;
    }).finally(() => { flight = null; });
    return flight;
  }
  const timer = setInterval(() => { void look(); }, watchMs);
  timer.unref?.();
  return {
    state: () => look(),
    async set(enabled, accountId, instanceId) {
      if (typeof enabled !== "boolean") throw new Error("无效的协作开关。");
      const mine = ++epoch;
      if (!enabled) {
        pref.write({ v: 1, enabled: false });
        await write({ on: false });
        shown = { enabled: false, connected: false, available: false, error: "" };
        return shown;
      }
      if (!allowed()) throw new Error("只能在本机个人工作空间启用协作。");
      const target = await discover();
      if (mine !== epoch || closed) return shown;
      if (!target.entry || !target.running || target.accountId !== accountId || target.id !== instanceId) throw new Error("请先连接当前账号的个人 Cloud，再启用协作。");
      pref.write({ v: 1, enabled: true, accountId, instanceId });
      retryAt = 0;
      shown = { enabled: true, connected: false, available: true, error: "" };
      await flight;
      if (mine !== epoch || closed) return shown;
      return look(true);
    },
    close() { closed = true; epoch++; clearInterval(timer); },
  };
}

export function installDoneBotBotLink({ ipcMain, guardLocal, lifecycle, ...deps }) {
  const link = createDoneBotBotLink(deps);
  ipcMain.handle("donebot-bot-link:state", guardLocal("donebot-bot-link:state", () => link.state()));
  ipcMain.handle("donebot-bot-link:set", guardLocal("donebot-bot-link:set", (_event, enabled, accountId, instanceId) => link.set(enabled, accountId, instanceId)));
  lifecycle?.once("before-quit", () => link.close());
  return link;
}
