import type { RailAddChoices } from "../../electron/cloud-rail.mjs";

export const UPSTREAM_SERVICES = {
  promotions: false,
  cloud: false,
  boat: false,
  mobileApps: false,
  updatesEmail: false,
};

export function doneBotKeyVisible(id: string): boolean {
  return (id !== "box" || UPSTREAM_SERVICES.boat) && (id !== "modelgo" || UPSTREAM_SERVICES.promotions);
}

export function doneBotPlaceChoices(choices: RailAddChoices): RailAddChoices {
  return {
    ...choices,
    cloud: choices.cloud && UPSTREAM_SERVICES.cloud,
    organization: choices.organization === true && UPSTREAM_SERVICES.cloud,
    account: choices.account === true && UPSTREAM_SERVICES.cloud,
  };
}
