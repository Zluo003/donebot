import { BACKGROUND_HEADERS } from "./cloud-power.mjs";

const STATE = "/api/bot-link", PAIR = "/api/bot-link/pair";
const RETRY_MS = 30_000;
const STARTUP_MS = 5_000;
const CLOUD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function createDoneBotBotLink({ request, fetch: cookieFetch, saved, pref, renew, ensure, allowed = () => true, now = Date.now, watchMs = 30_000 }) {
  let epoch = 0, closed = false, flight = null, retryAt = 0, lastTarget = null;
  let shown = { enabled: false, connected: false, available: false, error: "" };
  const preference = () => { try { const value = pref.read(); return value?.v === 1 ? value : null; } catch { return null; } };
  const isDisabledFor = (target, setting) => Boolean(setting && setting.enabled === false && target.accountId && target.id && setting.accountId === target.accountId && setting.instanceId === target.id);
  const validCloudOrigin = (origin, id) => {
    try { const url = new URL(origin); return url.protocol === "https:" && url.origin === origin && url.hostname.startsWith(id + "."); } catch { return false; }
  };
  async function local(path, init = {}) {
    const response = await request(path, { ...init, signal: AbortSignal.timeout(15_000) });
    const value = await response.json();
    if (!response.ok) throw new Error(typeof value?.error === "string" ? value.error : "本机服务暂时不可用。");
    return value;
  }
  const write = payload => local(STATE, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  function findSavedEntry(id, owner) {
    if (!CLOUD_ID.test(id ?? "") || !owner) return { entry: null, tampered: false };
    const matched = saved().environments.filter(candidate => candidate.donebotCloud?.id === id && candidate.donebotCloud.accountId === owner && !candidate.team && !candidate.donebotCloud?.teamId);
    const valid = matched.find(candidate => validCloudOrigin(candidate.origin, id)) ?? null;
    return { entry: valid, tampered: !valid && matched.length > 0 };
  }
  async function discover() {
    const state = await local("/api/donebot/state");
    if (!state.authenticated || !state.user?.id) return { accountId: null, id: null, entry: null, tampered: false, running: false };
    const snapshot = await local("/api/donebot/cloud");
    if (snapshot.account_id !== state.user.id) throw new Error("DoneBot 账号已变化，请重试。");
    const instance = snapshot.instance;
    const id = CLOUD_ID.test(instance?.id ?? "") ? instance.id : null;
    const { entry, tampered } = findSavedEntry(id, state.user.id);
    const running = Boolean(id && instance.actual === "running" && instance.desired === "running" && instance.subscription_state === "active" && !instance.purge_locked && Date.parse(instance.paid_until) > now() && snapshot.connection_available);
    const result = { accountId: state.user.id, id, entry, tampered, running };
    if (id) lastTarget = { accountId: state.user.id, id };
    return result;
  }
  const wants = (target, setting) => Boolean(allowed() && target.accountId && target.id && !target.tampered && !isDisabledFor(target, setting));
  const current = (mine, target) => !closed && epoch === mine && wants(target, preference());
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
      if (!current(mine, target) || latest.accountId !== target.accountId || latest.id !== target.id || !latest.running || !latest.entry || latest.entry.origin !== target.entry.origin) throw new Error("DoneBot 账号或 Cloud 已变化。");
      const state = await write({ on: true, origin: target.entry.origin, token: paired.token, name: computer.name, cloud: paired.place, account: target.accountId });
      if (!current(mine, target)) { await write({ on: false }); throw new Error("协作已关闭。"); }
      return state;
    } catch (cause) { await forget(target, computer); throw cause; }
  }
  async function reconcile(force) {
    const mine = epoch;
    let state;
    try { state = await local(STATE); } catch (cause) {
      if (cause instanceof Error && cause.message === "not running") return shown;
      throw cause;
    }
    if (closed) return shown;
    if (!allowed()) {
      if (state.on && state.role === "dialer") await write({ on: false });
      return (shown = { enabled: false, connected: false, available: false, error: "" });
    }
    let target = await discover();
    if (closed || mine !== epoch) return shown;
    if (!wants(target, preference())) {
      if (state.on && state.role === "dialer") await write({ on: false });
      return (shown = { enabled: false, connected: false, available: Boolean(target.id && target.running && !target.tampered), error: "" });
    }
    let next = state;
    if (state.on && (state.account !== target.accountId || (target.entry && state.origin !== target.entry.origin))) next = await write({ on: false });
    if (!target.running) {
      if (next.on && !next.asleep && target.entry) next = await write({ cloud: "asleep", origin: target.entry.origin });
      if (current(mine, target)) shown = { enabled: true, connected: false, available: false, error: "" };
      return shown;
    }
    if (!target.entry) {
      if (!ensure) {
        if (next.on && next.role === "dialer") await write({ on: false });
        return (shown = { enabled: false, connected: false, available: false, error: "" });
      }
      if (force || now() >= retryAt) {
        retryAt = now() + RETRY_MS;
        await ensure({ id: target.id, accountId: target.accountId, still: () => current(mine, target) });
        if (!current(mine, target)) return shown;
        target = await discover();
        if (!current(mine, target) || !target.running || !target.entry) return (shown = { enabled: true, connected: false, available: false, error: "" });
        retryAt = 0;
      } else {
        return (shown = { enabled: true, connected: false, available: false, error: "" });
      }
    }
    if (next.on && next.origin !== target.entry.origin) next = await write({ on: false });
    if (!next.on || next.needsPairing) {
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
  const startup = watchMs < 60_000 ? setTimeout(() => { void look(); }, STARTUP_MS) : null;
  startup?.unref?.();
  const timer = setInterval(() => { void look(); }, watchMs);
  timer.unref?.();
  return {
    state: () => look(),
    async set(enabled, accountId, instanceId) {
      if (typeof enabled !== "boolean") throw new Error("无效的协作开关。");
      const mine = ++epoch;
      if (!enabled) {
        let targetAccount = typeof accountId === "string" && accountId ? accountId : lastTarget?.accountId ?? null;
        let targetInstance = typeof instanceId === "string" && instanceId ? instanceId : lastTarget?.id ?? null;
        let forgetTarget = null;
        let wasOn = false;
        try {
          const prev = await local(STATE);
          wasOn = prev.on === true && prev.role === "dialer";
        } catch {}
        try {
          const live = await discover();
          if (live.accountId && live.id) {
            targetAccount ??= live.accountId;
            targetInstance ??= live.id;
            if (wasOn && live.entry && live.accountId === targetAccount && live.id === targetInstance) forgetTarget = live;
          }
        } catch {}
        pref.write({ v: 1, enabled: false, ...(targetAccount ? { accountId: targetAccount } : {}), ...(targetInstance ? { instanceId: targetInstance } : {}) });
        await write({ on: false });
        if (forgetTarget) {
          try {
            const described = await local("/.well-known/donebot/environment");
            if (typeof described.environmentId === "string" && described.environmentId) await forget(forgetTarget, { id: described.environmentId });
          } catch {}
        }
        shown = { enabled: false, connected: false, available: false, error: "" };
        return shown;
      }
      if (!allowed()) throw new Error("只能在本机个人工作空间启用协作。");
      let target = await discover();
      if (mine !== epoch || closed) return shown;
      if (target.tampered || !target.running || target.accountId !== accountId || target.id !== instanceId) throw new Error("请先连接当前账号的个人 Cloud，再启用协作。");
      if (!target.entry && ensure) {
        await ensure({ id: target.id, accountId: target.accountId, still: () => !closed && epoch === mine && allowed() });
        if (mine !== epoch || closed) return shown;
        target = await discover();
      }
      if (!target.entry || target.tampered || !target.running || target.accountId !== accountId || target.id !== instanceId) throw new Error("请先连接当前账号的个人 Cloud，再启用协作。");
      pref.write({ v: 1, enabled: true, accountId, instanceId });
      retryAt = 0;
      shown = { enabled: true, connected: false, available: true, error: "" };
      await flight;
      if (mine !== epoch || closed) return shown;
      return look(true);
    },
    close() { closed = true; epoch++; if (startup) clearTimeout(startup); clearInterval(timer); },
  };
}

export function installDoneBotBotLink({ ipcMain, guardLocal, lifecycle, ...deps }) {
  const link = createDoneBotBotLink(deps);
  ipcMain.handle("donebot-bot-link:state", guardLocal("donebot-bot-link:state", () => link.state()));
  ipcMain.handle("donebot-bot-link:set", guardLocal("donebot-bot-link:set", (_event, enabled, accountId, instanceId) => link.set(enabled, accountId, instanceId)));
  lifecycle?.once("before-quit", () => link.close());
  return link;
}
