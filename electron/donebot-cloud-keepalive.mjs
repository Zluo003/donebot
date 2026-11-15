export function createDoneBotCloudKeepalive({ entry, expires, renew, now = Date.now, interval = setInterval, clear = clearInterval }) {
  let timer = null, busy = false, generation = 0;
  const tick = async () => {
    if (busy || timer === null) return;
    const current = entry(), mine = generation;
    if (!current) return;
    const still = () => generation === mine && timer !== null && entry()?.id === current.id;
    busy = true;
    try {
      const until = await expires(current.origin);
      if (still() && (!Number.isFinite(until) || until - now() <= 120_000)) await renew(current, still);
    } catch {} finally { busy = false; }
  };
  return {
    tick,
    start() {
      if (timer !== null) return;
      timer = interval(() => { void tick(); }, 15_000);
      timer.unref?.();
      void tick();
    },
    stop() { generation++; if (timer !== null) clear(timer); timer = null; },
  };
}
