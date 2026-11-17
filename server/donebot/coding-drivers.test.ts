import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AnyProviderDriver, DriverCreateInput, ProviderInstance, SendTurnInput } from "../contracts.ts";
import type { DoneBotGateway, DoneBotScope } from "./gateway.ts";
import { FAKE_DONEBOT_CATALOG } from "../testing/fake-donebot-gateway.ts";

const deps = vi.hoisted(() => ({ install: vi.fn(async () => {}), find: vi.fn(() => ["fixture-cli"]) }));
vi.mock("../engine-install.ts", async original => ({ ...await original<typeof import("../engine-install.ts")>(), installNpmEngine: deps.install }));
vi.mock("../env-path.ts", async original => ({ ...await original<typeof import("../env-path.ts")>(), findCliCandidates: deps.find }));
const { createCodingDrivers } = await import("./coding-drivers.ts");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())); deps.install.mockReset().mockResolvedValue(undefined); deps.find.mockReset().mockReturnValue(["fixture-cli"]); });
async function setup(engine: "codex" | "claude" = "codex", subscription = false) {
  const directory = await mkdtemp(join(tmpdir(), "donebot-coding-test-"));
  const nativeInstances: ProviderInstance[] = [], inputs: DriverCreateInput<unknown>[] = [];
  const events = new Set<(event: unknown) => void>();
  const model = engine === "codex" ? FAKE_DONEBOT_CATALOG.models.find(model => model.id.startsWith("gpt-"))!.id : FAKE_DONEBOT_CATALOG.models.find(model => model.id.startsWith("claude-"))!.id;
  const native: AnyProviderDriver = { driverKind: engine, metadata: { displayName: engine }, models: { default: model, options: [{ id: model, label: model }] },
    install: { npmPackage: "fixture-cli", command: { darwin: "npm install -g fixture-cli" } }, defaultConfig: () => ({}), decodeConfig: raw => raw,
    async create(input) {
      inputs.push(input);
      const instance = { instanceId: input.instanceId, driverKind: engine, enabled: true, displayName: input.displayName, models: native.models,
        snapshot: vi.fn(async () => ({ state: "available" as const, authenticated: true })), dispose: vi.fn(async () => {}),
        startAuthentication: vi.fn(async () => ({ method: "device-code" as const, flowId: "synthetic-flow", verificationUrl: "https://example.invalid" })),
        generateText: vi.fn(async () => "background"),
        adapter: { provider: engine, capabilities: { sessionModelSwitch: "unsupported" as const }, sendTurn: vi.fn(async () => ({ turnId: "synthetic-turn" })),
          onEvent: (listener: (event: unknown) => void) => { events.add(listener); return () => { events.delete(listener); }; },
          interruptTurn: vi.fn(async () => {}), stopAll: vi.fn(async () => {}), hasSession: () => false, respondToRequest: vi.fn(async () => "rejected" as const) },
      } as unknown as ProviderInstance;
      nativeInstances.push(instance); return instance;
    } };
  let scope: DoneBotScope | null = { accountId: "synthetic-owner", installationId: "synthetic-installation" };
  const changes = new Set<() => void>();
  const gateway = { authenticated: () => scope !== null, scope: () => scope, models: () => FAKE_DONEBOT_CATALOG,
    onChange: (listener: () => void) => { changes.add(listener); return () => changes.delete(listener); }, requestForScope: vi.fn(async () => new Response("{}")) } as unknown as DoneBotGateway;
  const factory = createCodingDrivers(gateway, directory, { codex: native, claude: native });
  const driver = factory.drivers[engine === "codex" ? 0 : 1]!;
  const instance = await driver.create({ instanceId: `donebot-${engine}${subscription ? "-subscription" : ""}`, displayName: "fixture", enabled: true, environment: { OPENAI_API_KEY: "must-not-forward" }, config: {} });
  cleanups.push(async () => { await instance.dispose(); await rm(directory, { recursive: true, force: true }); });
  const turn: SendTurnInput = { threadId: "thread", text: "edit this project", model, cwd: directory, approvalMode: "ask" };
  return { instance, factory, inputs, nativeInstances, turn, driver, events, gateway, change: (next: DoneBotScope | null) => { scope = next; for (const changed of changes) changed(); } };
}

it.each(["codex", "claude"] as const)("isolates %s gateway configuration while preserving native turns and permissions", async engine => {
  const { instance, inputs, nativeInstances, turn } = await setup(engine);
  expect(inputs[0]!.environment).not.toHaveProperty("OPENAI_API_KEY");
  expect(JSON.stringify(inputs[0])).not.toContain("must-not-forward");
  expect(instance.startAuthentication).toBeUndefined();
  await instance.adapter.sendTurn(turn);
  expect(nativeInstances[0]!.adapter.sendTurn).toHaveBeenCalledWith({ ...turn, mcpFromUserConfig: false, userSkillsDir: undefined });
  await instance.adapter.respondToRequest("thread", "ask", { behavior: "allow" });
  expect(nativeInstances[0]!.adapter.respondToRequest).toHaveBeenCalledWith("thread", "ask", { behavior: "allow" });
  await expect(instance.adapter.sendTurn({ ...turn, model: "invented" })).rejects.toThrow("available DoneBot");
  await expect(instance.adapter.sendTurn({ ...turn, guestConfined: true })).rejects.toThrow("owner-authorized");
});

it.each(["codex", "claude"] as const)("keeps %s subscription auth separate from the gateway", async engine => {
  const { instance, inputs, factory, turn } = await setup(engine, true);
  expect(instance.startAuthentication).toBeTypeOf("function");
  expect(inputs[0]!.config).toEqual(engine === "codex" ? { authMode: "chatgpt-plan" } : { configDir: expect.stringContaining("donebot-subscription") });
  expect(JSON.stringify(inputs[0]!.environment)).not.toMatch(/OPENMAUSBOT_CODEX_API_KEY|ANTHROPIC_API_KEY/);
  await instance.adapter.sendTurn(turn);
  expect(factory.subscriptions.get(engine)).toBe(instance);
  await instance.dispose(); expect(factory.subscriptions.has(engine)).toBe(false);
});

it("revokes old gateway access and rebuilds even after logout/login to the same account", async () => {
  const { instance, inputs, change, nativeInstances, turn } = await setup();
  const original = inputs[0]!.environment;
  const account = { accountId: "synthetic-owner", installationId: "synthetic-installation" };
  change(null); change(account);
  await instance.adapter.sendTurn(turn);
  expect(nativeInstances).toHaveLength(2); expect(nativeInstances[0]!.dispose).toHaveBeenCalledOnce();
  expect(inputs[1]!.environment.OPENMAUSBOT_CODEX_API_KEY).not.toBe(original.OPENMAUSBOT_CODEX_API_KEY);
  change({ ...account, accountId: "another-account" }); await instance.adapter.sendTurn(turn);
  expect(inputs[2]!.environment.CODEX_HOME).not.toBe(inputs[1]!.environment.CODEX_HOME);
});

it.each(["thread", "all", "account"])("Stop cancels startup during installation (%s)", async kind => {
  const { instance, turn, nativeInstances, change } = await setup();
  deps.find.mockReturnValue([]);
  let finish!: () => void;
  deps.install.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = instance.adapter.sendTurn(turn);
  const rejected = pending.catch(error => error);
  await expect.poll(() => deps.install.mock.calls.length).toBe(1);
  if (kind === "account") change(null);
  else if (kind === "all") await instance.adapter.stopAll();
  else await instance.adapter.interruptTurn(turn.threadId);
  expect((await rejected).message).toContain("stopped"); finish();
  expect(nativeInstances[0]!.adapter.sendTurn).not.toHaveBeenCalled();
});
