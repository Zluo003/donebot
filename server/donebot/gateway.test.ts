import { describe, expect, it, vi } from "vitest";
import { DoneBotGateway, doneBotRequestUrl, type DoneBotCredential, type DoneBotCredentialStore } from "./gateway.ts";
const catalog = { gateway_contract_version: 3, catalog_scope_id: "scope", catalog_version: "v1", defaults: { text: "gpt-6.1-sol" }, models: [{ id: "gpt-6.1-sol", display_name: "GPT", interfaces: ["openai.responses"], platforms: ["openai"], media_types: ["text"] }] };
const auth = (id = "1") => ({ code: 0, data: { access_token: `access-${id}`, refresh_token: `refresh-${id}`, expires_in: 3600, user: { id, email: `${id}@example.test` } } });
const json = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
function store(): DoneBotCredentialStore & { current: DoneBotCredential | null } {
  return { persistent: false, current: null, async load() { return this.current; }, async save(value) { this.current = structuredClone(value); } };
}
function fixture(overrides?: (path: string, init?: RequestInit) => Promise<Response> | undefined) {
  const vault = store();
  const requests: { path: string; headers: Headers; body: unknown }[] = [];
  const gateway = new DoneBotGateway(vault, { fetch: (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const custom = overrides?.(path, init);
    if (custom) return custom;
    requests.push({ path, headers: new Headers(init?.headers), body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    if (path.endsWith("/auth/login")) return json(auth());
    if (path.endsWith("/installations/claim")) return json({ credential: "fixture-installation" });
    if (path.endsWith("/donebot/models")) return json(catalog);
    if (path.endsWith("/donebot/account")) return json({ concurrency: 20 });
    if (path.endsWith("/auth/logout")) return json({ code: 0 });
    return json({ result: true });
  }) as typeof fetch });
  return { gateway, vault, requests };
}
describe("DoneBot gateway account boundary", () => {
  it("reports safe DNS, timeout, TLS and connectivity errors for model and account reads", async () => {
    for (const [cause, code, status] of [["ENOTFOUND", "gateway_dns_failed", 502], ["EAI_AGAIN", "gateway_dns_failed", 502],
      ["UND_ERR_CONNECT_TIMEOUT", "gateway_timeout", 504], ["CERT_HAS_EXPIRED", "gateway_tls_failed", 502],
      ["ECONNREFUSED", "gateway_unreachable", 502], ["private-provider-code", "gateway_unreachable", 502]] as const) {
      let failed = false, attempts = 0;
      const { gateway } = fixture(path => failed && (path.endsWith("/donebot/models") || path.endsWith("/donebot/account"))
        ? (attempts++, Promise.reject(new TypeError("private-token-and-url", { cause: { code: cause } }))) : undefined);
      await gateway.login("owner@example.test", "fixture-password");
      failed = true;
      for (const read of [() => gateway.refreshCatalog(), () => gateway.account()]) {
        await expect(read()).rejects.toMatchObject({ code, status });
      }
      expect(attempts).toBe(2);
      expect(gateway.state().authenticated).toBe(true);
      try { await gateway.refreshCatalog(); } catch (error) { expect(String(error)).not.toMatch(/private-token|private-provider-code/); }
    }
  });
  it("distinguishes a proxy HTML response from an empty model catalog", async () => {
    let failed = false;
    const { gateway } = fixture(path => failed && (path.endsWith("/donebot/models") || path.endsWith("/donebot/account"))
      ? Promise.resolve(new Response("<html>private-proxy-response</html>", { headers: { "content-type": "text/html" } })) : undefined);
    await gateway.login("owner@example.test", "fixture-password");
    failed = true;
    await expect(gateway.refreshCatalog()).rejects.toMatchObject({ code: "gateway_response_invalid", status: 502 });
    await expect(gateway.account()).rejects.toMatchObject({ code: "gateway_response_invalid", status: 502 });
    expect(gateway.models()?.models).toHaveLength(1);
  });
  it("uses email-code recovery without accepting or persisting an authenticated session", async () => {
    const { gateway, requests, vault } = fixture();
    await gateway.forgotPassword("owner@example.test", { turnstile_token: "fixture-proof" });
    await gateway.resetPassword("owner@example.test", "123456", "new-fixture-password");
    expect(requests.map(request => [request.path, request.body])).toEqual([
      ["/api/v1/auth/forgot-password", { email: "owner@example.test", delivery: "code", turnstile_token: "fixture-proof" }],
      ["/api/v1/auth/reset-password", { email: "owner@example.test", email_code: "123456", new_password: "new-fixture-password" }],
    ]);
    expect(requests.every(request => !request.headers.has("authorization"))).toBe(true);
    expect(gateway.authenticated()).toBe(false); expect(vault.current).toBeNull();
  });
  it("cancels two-factor login without allowing an old code to establish a session", async () => {
    const { gateway, vault } = fixture(path => path.endsWith("/auth/login") ? Promise.resolve(json({ requires_2fa: true, temp_token: "fixture-temp" })) : undefined);
    expect((await gateway.login("owner@example.test", "fixture-password")).requires2fa).toBe(true);
    expect(gateway.cancelLogin().requires2fa).toBeUndefined();
    await expect(gateway.verify2fa("123456")).rejects.toMatchObject({ code: "login_required" });
    expect(vault.current).toBeNull();
  });
  it("shows safe known recovery errors without reflecting upstream messages", async () => {
    const { gateway } = fixture(path => path.endsWith("/auth/reset-password") ? Promise.resolve(json({ reason: "INVALID_RESET_CODE", message: "private-provider-token" }, 400)) : undefined);
    await expect(gateway.resetPassword("owner@example.test", "123456", "fixture-password")).rejects.toThrow("找回密码验证码无效或已过期");
  });
  it("rejects foreign, normalized traversal and unknown operations", () => {
    for (const path of ["https://evil.test/v1/messages", "//evil.test/v1/messages", "/v1/../v1/messages", "/v1/%2e%2e/messages", "/v1/messages?key=secret", "/api/v1/auth/me"]) expect(() => doneBotRequestUrl(path)).toThrow();
    expect(doneBotRequestUrl("/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse").origin).toBe("https://donebot.cn");
    expect(doneBotRequestUrl("/v1/systemone").pathname).toBe("/v1/systemone");
  });
  it("rejects the removed DoneBot intent-task protocol and permits only native media endpoints", () => {
    for (const path of ["/v1/donebot/media/intent", "/v1/donebot/media/jobs/by-idempotency/key", "/v1/donebot/media/jobs/task/artifacts/file"]) {
      expect(() => doneBotRequestUrl(path)).toThrow();
    }
    for (const path of ["/v1/images/generations/async", "/v1/images/tasks/task-fixture", "/v1/videos", "/v1/videos/task-fixture/content", "/v1/music/generations", "/v1/music/tasks/task-fixture"]) {
      expect(doneBotRequestUrl(path).pathname).toBe(path);
    }
  });
  it("accepts the v4 media catalog while keeping unsupported contract versions closed", async () => {
    const nextCatalog = { ...catalog, gateway_contract_version: 4 };
    const current = fixture(path => path === "/api/v1/donebot/models" ? Promise.resolve(json(nextCatalog)) : undefined);
    await current.gateway.login("owner@example.test", "fixture-password");
    expect(current.gateway.models()?.gateway_contract_version).toBe(4);

    const unsupported = fixture(path => path === "/api/v1/donebot/models"
      ? Promise.resolve(json({ ...catalog, gateway_contract_version: 5 })) : undefined);
    await expect(unsupported.gateway.login("owner@example.test", "fixture-password")).rejects.toMatchObject({ code: "catalog_invalid" });
  });
  it("keeps tokens in vault and strips caller supplied model credentials", async () => {
    const { gateway, requests, vault } = fixture();
    await gateway.login("owner@example.test", "fixture-password");
    expect(gateway.state().authenticated).toBe(true);
    expect(JSON.stringify(gateway.state())).not.toContain("access-");
    expect(vault.current?.credential).toBe("fixture-installation");
    await gateway.request("/v1/responses", { method: "POST", headers: { authorization: "Bearer foreign", cookie: "private", "x-api-key": "foreign" }, body: "{}" });
    const call = requests.at(-1)!;
    expect(call.headers.get("authorization")).toBe("Bearer fixture-installation");
    expect(call.headers.has("cookie")).toBe(false);
    expect(call.headers.has("x-api-key")).toBe(false);
  });
  it("does not resurrect a login that completes after logout", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const { gateway, vault } = fixture(path => path.endsWith("/auth/login") ? pending : undefined);
    const login = gateway.login("owner@example.test", "fixture-password");
    await new Promise(resolve => setTimeout(resolve, 0));
    await gateway.logout();
    release(json(auth()));
    await expect(login).rejects.toMatchObject({ code: "account_changed" });
    expect(gateway.state().authenticated).toBe(false);
    expect(vault.current).toBeNull();
  });
  it("does not dispatch jobs from another account or repeat a failed paid POST", async () => {
    let count = 0;
    const { gateway } = fixture(path => path === "/v1/responses" ? (count++, Promise.resolve(json({}, 503))) : undefined);
    await gateway.login("owner@example.test", "fixture-password");
    await expect(gateway.requestForScope({ accountId: "foreign", installationId: "foreign" }, "/v1/responses", { method: "POST" })).rejects.toMatchObject({ code: "account_changed" });
    expect((await gateway.request("/v1/responses", { method: "POST" })).status).toBe(503);
    expect(count).toBe(1);
  });
  it("does not mark an unsaved installation key authenticated", async () => {
    const { gateway, vault } = fixture();
    vault.save = async value => { if (value?.credential) throw new Error("OS vault unavailable"); vault.current = value; };
    await expect(gateway.login("owner@example.test", "fixture-password")).rejects.toThrow("OS vault");
    expect(gateway.authenticated()).toBe(false);
    expect(vault.current?.credential).toBeUndefined();
  });

  it("caches the actual account concurrency briefly and accepts a refreshed lower limit", async () => {
    let limit: number | undefined = 7, calls = 0, now = 10_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const { gateway } = fixture(path => path.endsWith("/donebot/account") ? (calls++, Promise.resolve(json({ concurrency: limit }))) : undefined);
      await gateway.login("owner@example.test", "fixture-password");
      const scope = gateway.scope()!;
      expect(await Promise.all([gateway.concurrency(scope), gateway.concurrency(scope)])).toEqual([7, 7]);
      expect(calls).toBe(1);
      limit = 2; await gateway.account();
      expect(await gateway.concurrency(scope)).toBe(2); expect(calls).toBe(2);
      limit = 9; now += 10_000;
      expect(await gateway.concurrency(scope)).toBe(9); expect(calls).toBe(3);
      limit = undefined; await gateway.account();
      await expect(gateway.concurrency(scope)).rejects.toMatchObject({ code: "concurrency_unavailable" });
      await expect(gateway.concurrency({ ...scope, accountId: "foreign" })).rejects.toMatchObject({ code: "account_changed" });
    } finally { clock.mockRestore(); }
  });

  it("discards an old account's in-flight limit when a different account signs in", async () => {
    let loginId = "1", accountCalls = 0, release!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const { gateway } = fixture(path => {
      if (path.endsWith("/auth/login")) return Promise.resolve(json(auth(loginId)));
      if (path.endsWith("/donebot/account")) return ++accountCalls === 1 ? pending : Promise.resolve(json({ concurrency: 3 }));
      return undefined;
    });
    await gateway.login("first@example.test", "fixture-password");
    const old = gateway.concurrency(gateway.scope()!);
    const rejection = expect(old).rejects.toMatchObject({ code: "account_changed" });
    await vi.waitFor(() => expect(accountCalls).toBe(1));
    await gateway.logout(); loginId = "2"; await gateway.login("second@example.test", "fixture-password");
    expect(await gateway.concurrency(gateway.scope()!)).toBe(3);
    release(json({ concurrency: 40 })); await rejection;
    expect(await gateway.concurrency(gateway.scope()!)).toBe(3);
  });

  it("shares twenty account slots with ten durable media jobs and releases text/TTS only at EOF or cancellation", async () => {
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [], paths: string[] = [];
    const { gateway } = fixture(path => ["/v1/responses", "/v1/audio/speech"].includes(path) ? (paths.push(path), Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.push(controller); } })))) : undefined);
    gateway.bindMediaActivity(() => 10);
    await gateway.login("owner@example.test", "fixture-password");
    const scope = gateway.scope()!;
    const pending = Array.from({ length: 11 }, (_, index) => gateway.request(index % 2 ? "/v1/audio/speech" : "/v1/responses", { method: "POST" }));
    const responses = await Promise.all(pending.slice(0, 10));
    expect(paths).toHaveLength(10); expect(gateway.activeModelCount(scope.accountId)).toBe(10);
    streams[0]!.close();
    await vi.waitFor(() => expect(paths).toHaveLength(11));
    responses.push(await pending[10]!);
    expect(gateway.activeModelCount(scope.accountId)).toBe(10);
    await responses[1]!.body!.cancel();
    expect(gateway.activeModelCount(scope.accountId)).toBe(9);
    for (const response of responses) await response.body?.cancel();
    expect(gateway.activeModelCount(scope.accountId)).toBe(0);
  });

  it("uses a shared model slot and the installation credential for Jev System One", async () => {
    const { gateway, requests } = fixture();
    await gateway.login("owner@example.test", "fixture-password");
    const response = await gateway.request("/v1/systemone", { method: "POST", body: JSON.stringify({ model: "jev-latest" }) });
    expect(gateway.activeModelCount("1")).toBe(1);
    const call = requests.at(-1)!;
    expect(call.path).toBe("/v1/systemone");
    expect(call.headers.get("authorization")).toBe("Bearer fixture-installation");
    expect(call.body).toEqual({ model: "jev-latest" });
    await response.json();
    expect(gateway.activeModelCount("1")).toBe(0);
  });

  it("never sends a queued model request after its caller aborts or the account signs out", async () => {
    let calls = 0;
    const { gateway } = fixture(path => path === "/v1/responses" ? (calls++, Promise.resolve(json({}))) : undefined);
    gateway.bindMediaActivity(() => 20);
    await gateway.login("owner@example.test", "fixture-password");
    const controller = new AbortController();
    const first = gateway.request("/v1/responses", { method: "POST", signal: controller.signal });
    const aborted = expect(first).rejects.toThrow("fixture aborted");
    controller.abort(new Error("fixture aborted")); await aborted;
    const second = gateway.request("/v1/responses", { method: "POST" });
    const loggedOut = expect(second).rejects.toThrow("DoneBot account changed");
    await gateway.logout(); await loggedOut;
    expect(calls).toBe(0); expect(gateway.activeModelCount("1")).toBe(0);
  });

  it("rejects a pending stream read and cancels its transport when signing out", async () => {
    const cancel = vi.fn();
    const { gateway } = fixture(path => path === "/v1/responses" ? Promise.resolve(new Response(new ReadableStream({ cancel }))) : undefined);
    await gateway.login("owner@example.test", "fixture-password");
    const response = await gateway.request("/v1/responses", { method: "POST" });
    const pending = expect(response.body!.getReader().read()).rejects.toThrow("DoneBot account changed");
    await gateway.logout();
    await pending;
    expect(cancel).toHaveBeenCalledOnce();
    expect(gateway.activeModelCount("1")).toBe(0);
  });

  it("keeps task polling, artifact access and reference uploads outside model generation slots", async () => {
    const { gateway } = fixture(); gateway.bindMediaActivity(() => 20);
    await gateway.login("owner@example.test", "fixture-password");
    for (const [path, method] of [["/v1/images/tasks/task-fixture", "GET"], ["/v1/videos/task-fixture/content", "GET"], ["/v1/assets", "POST"], ["/v1/assets/asset-fixture", "GET"]]) {
      const response = await gateway.request(path!, { method });
      expect(response.ok).toBe(true); await response.body?.cancel();
    }
    expect(gateway.activeModelCount("1")).toBe(0);
  });

  it("releases a model slot when the network fails before response headers", async () => {
    const { gateway } = fixture(path => path === "/v1/responses" ? Promise.reject(new Error("fixture transport failed")) : undefined);
    await gateway.login("owner@example.test", "fixture-password");
    await expect(gateway.request("/v1/responses", { method: "POST" })).rejects.toThrow("fixture transport failed");
    expect(gateway.activeModelCount("1")).toBe(0);
  });
});
