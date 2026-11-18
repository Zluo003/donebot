import { afterEach, beforeEach } from "vitest";
import { UPSTREAM_SERVICES, UPSTREAM_SETTINGS } from "@/donebot/services";

export function withUpstreamServices() {
  const defaults = { ...UPSTREAM_SERVICES };
  const settings = { ...UPSTREAM_SETTINGS };
  beforeEach(() => {
    for (const key of Object.keys(UPSTREAM_SERVICES) as Array<keyof typeof UPSTREAM_SERVICES>) UPSTREAM_SERVICES[key] = true;
    for (const key of Object.keys(UPSTREAM_SETTINGS) as Array<keyof typeof UPSTREAM_SETTINGS>) UPSTREAM_SETTINGS[key] = true;
  });
  afterEach(() => {
    Object.assign(UPSTREAM_SERVICES, defaults);
    Object.assign(UPSTREAM_SETTINGS, settings);
  });
}
