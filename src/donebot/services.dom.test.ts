// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/state/api", () => ({ api: fixture.api }));
vi.mock("@/state/store", async original => {
  const actual = await original<typeof import("@/state/store")>();
  return { ...actual, api: fixture.api, useStore: () => ({ state: { ...actual.initialState,
    config: { donebot: { enabled: true }, box: { configured: true }, modelgo: { configured: true }, features: {} },
  }, dispatch: fixture.dispatch, refreshInstances: vi.fn() }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { BoatOfferCard, BoatOfferPanel } = await import("@/components/BoatOffer");
const { ModelgoOfferCard, ModelgoOption } = await import("@/components/ModelgoOffer");
const { CloudAddDialog } = await import("@/components/CloudAddDialog");
const { CloudAccountSettings } = await import("@/components/CloudAccountSettings");
const { OrganizationSettings } = await import("@/components/OrganizationSettings");
const { ProSettingsCard, CloudPlanRow } = await import("@/components/ProIntroduction");
const { UpdatesConsentRow } = await import("@/components/UpdatesConsent");
const { KeyRow } = await import("@/components/keys/KeyRow");
const { KeysPage } = await import("@/components/keys/KeysPage");
const { PhoneAppDialog } = await import("@/components/PhoneAppDialog");
const { CloudBackendPicker } = await import("@/components/CloudBackendPicker");
const { PlaceAddSheet } = await import("@/components/PlaceAddSheet");
const { DoneBotCloudDialog } = await import("@/donebot/CloudDialog");
const { useCloudOffer } = await import("@/lib/use-cloud-offer");
const { IntroChips } = await import("@/components/HelperSetup");
const { openPlaceAction } = await import("@/lib/place-view");

let host: HTMLDivElement, root: Root;
let calls: ReturnType<typeof vi.fn>;
const render = async (children: ReturnType<typeof createElement>[]) => {
  await act(async () => { root.render(createElement(Fragment, null, ...children)); });
};
beforeEach(() => {
  setLocale("en");
  fixture.api.mockReset().mockResolvedValue({ account_id: "fixture-user", email: "fixture@example.invalid", balance_cents: 5000,
    plan: { enabled: true, monthly_price: "12.500000", retention_days: 7 }, instance: null, operations: [], connection_available: true });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  calls = vi.fn(async () => null);
  Object.assign(window, { ogb: {
    cloudAccount: { state: calls, offer: calls, onState: calls, begin: calls },
    cloudPlan: { state: calls, onState: calls, manage: calls },
    updatesConsent: { state: calls, choose: calls },
    organization: { state: calls, onState: calls },
    openExternal: calls,
  } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); delete window.ogb; vi.unstubAllGlobals();
});

it("hides upstream sponsor cards and key entry points even with previously saved provider keys", async () => {
  const onDone = vi.fn();
  await render([
    createElement(BoatOfferCard, { key: "boat", onDone }), createElement(BoatOfferPanel, { key: "boat-panel" }),
    createElement(ModelgoOfferCard, { key: "modelgo", onDone }), createElement(ModelgoOption, { key: "modelgo-option", open: true, onToggle: onDone }),
    createElement(KeyRow, { key: "boat-key", id: "box" }), createElement(KeyRow, { key: "modelgo-key", id: "modelgo" }),
    createElement(KeysPage, { key: "keys" }),
  ]);
  for (const selector of ["[data-boat-offer]", "[data-modelgo-sponsor]", "[data-modelgo-option]", '[data-key-row="box"]', '[data-key-row="modelgo"]']) expect(host.querySelector(selector)).toBeNull();
  expect(host.textContent).not.toContain("$50");
  expect(calls).not.toHaveBeenCalled();
});

it("does not mount upstream account, checkout, newsletter or mobile download flows or query their bridges", async () => {
  const Offer = () => { useCloudOffer(true); return null; };
  await render([
    createElement(CloudAddDialog, { key: "buy" }), createElement(CloudAccountSettings, { key: "account" }),
    createElement(OrganizationSettings, { key: "organization" }), createElement(ProSettingsCard, { key: "pro" }),
    createElement(CloudPlanRow, { key: "plan", place: "account" }), createElement(UpdatesConsentRow, { key: "newsletter" }),
    createElement(PhoneAppDialog, { key: "phone", open: true, onClose: vi.fn() }), createElement(Offer, { key: "offer" }),
  ]);
  expect(host.innerHTML).toBe("");
  expect(calls).not.toHaveBeenCalled();
});

it("keeps local workspaces and self-hosted server connections available when main still advertises upstream purchases", async () => {
  await render([
    createElement(PlaceAddSheet, { key: "places", choices: { cloud: true, organization: true, account: true, local: true, link: true, address: true }, onClose: vi.fn(), onAccount: vi.fn() }),
    createElement(CloudBackendPicker, { key: "backend", value: "box", onChange: vi.fn() }),
  ]);
  expect(document.querySelector('[data-place-add="choose"]')).toBeTruthy();
  expect(document.querySelector('[data-place-add-sheet]')?.textContent).not.toMatch(/Buy a Cloud|Create an organization|Add another account/);
  expect(host.textContent).not.toContain("Boat");
  expect(host.textContent).toContain("VPS");
  const connect = document.querySelector<HTMLButtonElement>('[data-place-add-choice="server"]');
  expect(connect).toBeTruthy();
  await act(async () => connect!.click());
  expect(document.querySelector('[data-place-add="own-server"]')).toBeTruthy();
  expect(calls).not.toHaveBeenCalled();
});

it.each([true, false])("confirms Cloud inside the add sheet without opening a webpage (local=%s)", async local => {
  await render([createElement(PlaceAddSheet, { choices: { cloud: true, local, link: true, address: true }, onClose: vi.fn() })]);
  const entry = document.querySelector('[data-donebot-cloud-access]')!;
  expect(entry.textContent).toContain("12.500000 / 月");
  const open = [...entry.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "开通 DoneBot Cloud")!;
  await act(async () => open.click());
  expect(entry.querySelector('[aria-label="Cloud 操作确认"]')?.textContent).toContain("余额不足无法开通或续期");
  expect(fixture.api.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  expect(calls).not.toHaveBeenCalled();
});

it("opens the application's own Cloud dialog without mounting upstream checkout", async () => {
  await render([createElement(DoneBotCloudDialog, { onClose: vi.fn() })]);
  expect(document.querySelector('[data-donebot-cloud-access]')?.textContent).toContain("开通 DoneBot Cloud");
  expect(calls).not.toHaveBeenCalled();
});

it("omits cloud onboarding chips and refuses stale upstream service actions", async () => {
  await render([createElement(IntroChips, { key: "chips", chips: ["cloud", "phone"] })]);
  expect(host.querySelector('[data-helper-step="cloud"]')).toBeNull();
  expect(host.querySelector('[data-helper-step="phone"]')).toBeTruthy();
  fixture.dispatch.mockClear();
  for (const action of ["add-boat-key", "see-plan", "open-my-cloud"] as const) {
    expect(openPlaceAction(action, { botId: "fixture" }, fixture.dispatch)).toBe(false);
  }
  expect(fixture.dispatch).not.toHaveBeenCalled();
  expect(calls).not.toHaveBeenCalled();
});
