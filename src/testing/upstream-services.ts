import { afterEach, beforeEach } from "vitest";
import { UPSTREAM_SERVICES } from "@/donebot/services";

export function withUpstreamServices() {
  const defaults = { ...UPSTREAM_SERVICES };
  beforeEach(() => {
    for (const key of Object.keys(UPSTREAM_SERVICES) as Array<keyof typeof UPSTREAM_SERVICES>) UPSTREAM_SERVICES[key] = true;
  });
  afterEach(() => Object.assign(UPSTREAM_SERVICES, defaults));
}
