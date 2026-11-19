import { afterEach, describe, expect, it, vi } from "vitest";
import { doneBotPurchaseVisible } from "./services";

afterEach(() => vi.unstubAllGlobals());

describe("local credit purchase availability", () => {
  it.each([true, null])("allows the local gateway with owner state %s", ownerOrAdmin => {
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    expect(doneBotPurchaseVisible({ enabled: true, ownerOrAdmin })).toBe(true);
  });

  it.each([
    { enabled: false, ownerOrAdmin: true },
    { enabled: true, ownerOrAdmin: false },
    { enabled: true, ownerOrAdmin: true, cloudHome: true },
    { enabled: true, ownerOrAdmin: true, remote: true },
  ])("hides purchases outside an enabled local owner workspace: %j", input => {
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    expect(doneBotPurchaseVisible(input)).toBe(false);
  });

  it("hides purchases in the Cloud browser even before config loads", () => {
    vi.stubGlobal("sessionStorage", { getItem: (key: string) => key === "donebot.cloud-browser" ? "1" : null });
    expect(doneBotPurchaseVisible({ enabled: true, ownerOrAdmin: true })).toBe(false);
  });
});
