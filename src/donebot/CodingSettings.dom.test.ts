// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(), instances: [] as InstanceInfo[] }));
vi.mock("@/state/api", () => ({ api: fixture.api }));
vi.mock("@/state/store", async original => ({ ...await original<typeof import("@/state/store")>(), api: fixture.api,
  useStore: () => ({ state: { instances: fixture.instances, config: { donebot: { authenticated: true } } }, dispatch: fixture.dispatch, refreshInstances: fixture.refreshInstances, refreshModels: fixture.refreshModels }) }));
const { DoneBotCodingSettings } = await import("./CodingSettings");
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.api.mockReset(); fixture.dispatch.mockReset(); fixture.refreshInstances.mockReset().mockResolvedValue(undefined); fixture.refreshModels.mockReset().mockResolvedValue(undefined);
  fixture.instances = ["codex", "claude"].flatMap(engine => ["", "-subscription", "-existing"].map(suffix => ({
    instanceId: `donebot-${engine}${suffix}`, driverKind: engine === "codex" ? "codex" : "claudeAgent", displayName: `${engine} · ${suffix === "-existing" ? "Existing" : suffix === "-subscription" ? "Subscription" : "DoneBot gateway"}`,
    access: suffix === "-subscription" ? "subscription" : "api", models: { default: "fixture-model", options: [{ id: "fixture-model", label: "fixture-model" }] },
    authentication: suffix === "-subscription" ? { method: engine === "codex" ? "browser-pkce" : "paste-code" } : undefined,
    install: { command: { darwin: "npm install -g fixture-cli" }, server: { package: "fixture-cli" } }, snapshot: { state: "available", authenticated: true },
  } as InstanceInfo)));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const mount = async () => act(async () => root.render(createElement(DoneBotCodingSettings)));

it("distinguishes billing and existing conversation switching, and signs out only the selected subscription", async () => {
  await mount();
  expect(host.querySelectorAll("section")).toHaveLength(6);
  expect(host.textContent).toContain("先停止任务"); expect(host.textContent).toContain("不扣 DoneBot 模型余额");
  expect(host.textContent).toContain("Cloud 暂不支持 Codex 订阅登录");
  const signOut = [...host.querySelectorAll("button")].filter(button => button.textContent === "退出执行器账号");
  expect(signOut).toHaveLength(2);
  fixture.api.mockResolvedValue({ instances: fixture.instances });
  await act(async () => signOut[1]!.click());
  expect(fixture.api).toHaveBeenCalledWith("/api/instances/donebot-claude-subscription/auth/sign-out", { method: "POST", body: "{}" });
  expect(fixture.dispatch).toHaveBeenCalledWith({ type: "instances", instances: fixture.instances });
});

it("offers the original server installer without asking for a model API key", async () => {
  fixture.instances[0]!.snapshot = { state: "unavailable", reason: "CLI not installed" };
  await mount();
  const section = host.querySelector('section[aria-label="codex · DoneBot gateway"]')!;
  const install = section.querySelector<HTMLButtonElement>("button.ui-button-primary")!;
  expect(install, section.outerHTML).toBeTruthy();
  fixture.instances[0]!.snapshot = { state: "available", authenticated: true };
  fixture.api.mockResolvedValue({ instances: fixture.instances });
  await act(async () => install.click());
  expect(fixture.api.mock.calls[0]![0]).toBe("/api/instances/donebot-codex/install");
  expect(fixture.refreshModels).toHaveBeenCalledWith("donebot-codex");
  expect(host.querySelector('input[type="password"]')).toBeNull();
});

it("keeps existing CLI mode free of installation and authentication actions", async () => {
  fixture.instances.find(instance => instance.instanceId === "donebot-codex-existing")!.snapshot = { state: "unavailable", reason: "CLI not installed" };
  await mount();
  for (const engine of ["codex", "claude"]) {
    const section = host.querySelector(`section[aria-label="${engine} · Existing"]`)!;
    expect(section.textContent).toContain("维持不变"); expect(section.textContent).toContain("CC Switch");
    expect(section.querySelectorAll("button")).toHaveLength(0);
  }
  expect(host.textContent).toContain("安装并配置 CLI");
  expect(host.textContent).toContain("本机配置不会自动同步到 Cloud");
});
