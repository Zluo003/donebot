import type { Relay, RelayPolicy } from "./server.ts";
import type { RelayConfig } from "./config.ts";

export function startRelayManagement(relay: Relay, config: RelayConfig, fetcher: typeof fetch = fetch): () => void {
  if (!config.management) return () => {};
  const { origin, token } = config.management;
  let running = false, stopped = false, last = 0;
  let policy: RelayPolicy = { enabled: false, maxHosts: 1, maxSessions: 1, maxSockets: 4 };
  const abort = new AbortController();
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await fetcher(`${origin}/v1/donebot/relay/nodes/${config.node}/heartbeat`, {
        method: "POST", redirect: "error", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(relay.stats()), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(8_000)]),
      });
      if (!result.ok) throw new Error("Relay policy unavailable");
      const value = await result.json() as { code: number; data: RelayPolicy };
      const next = value.data;
      if (value.code !== 0 || typeof next?.enabled !== "boolean" || ![next.maxHosts, next.maxSessions, next.maxSockets].every(Number.isInteger) || next.maxHosts < 1 || next.maxHosts > 100_000 || next.maxSessions < 1 || next.maxSessions > 100_000 || next.maxSockets < 4 || next.maxSockets > 1_000_000) throw new Error("Invalid relay policy");
      if (stopped) return;
      policy = next; last = Date.now(); relay.setPolicy(policy);
    } catch {
      if (!stopped && Date.now() - last >= 45_000) relay.setPolicy({ ...policy, enabled: false });
    } finally { running = false; }
  };
  const timer = setInterval(() => void tick(), 10_000); timer.unref(); void tick();
  return () => { stopped = true; abort.abort(); clearInterval(timer); };
}
