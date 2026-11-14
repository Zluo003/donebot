import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { boundedResponseText } from "./bounded-response.ts";
import type { DoneBotAccountState, DoneBotCatalog } from "../../shared/donebot.ts";
import type { DoneBotAuthSettings, DoneBotEmailDelivery } from "../../shared/donebot-auth.ts";
import type { DoneBotCloudInstance, DoneBotCloudMutation, DoneBotCloudMutationResult, DoneBotCloudOperation, DoneBotCloudPlan, DoneBotCloudSnapshot } from "../../shared/donebot-cloud.ts";

export const DONEBOT_ORIGIN = "https://donebot.cn";
export const DONEBOT_INSTANCE_ID = "donebot";

export interface DoneBotCredential {
	mode?: "installation";
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  user: { id: string; email: string };
  installationId: string;
  credential?: string;
}

export interface DoneBotCredentialStore {
  persistent: boolean;
  load(): Promise<DoneBotCredential | null>;
  save(value: DoneBotCredential | null): Promise<void>;
}

export interface DoneBotScope { accountId: string; installationId: string }

export class DoneBotGatewayError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

function readNetworkFailure(error: unknown): DoneBotGatewayError {
  const failure = error as { name?: unknown; cause?: { code?: unknown } } | null;
  const code = failure?.cause?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new DoneBotGatewayError(502, "gateway_dns_failed", "无法解析 DoneBot 网关地址，请检查云节点的 DNS 和受控出网配置。");
  if (failure?.name === "TimeoutError" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return new DoneBotGatewayError(504, "gateway_timeout", "连接 DoneBot 网关超时，请检查云节点的受控出网和防火墙配置。");
  if (["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(String(code))) {
    return new DoneBotGatewayError(502, "gateway_tls_failed", "无法验证 DoneBot 网关的 HTTPS 证书，请检查节点时间、证书和代理配置。");
  }
  return new DoneBotGatewayError(502, "gateway_unreachable", "无法连接 DoneBot 网关，请检查云节点的 CLOUD_EGRESS_MODE、DNS 和防火墙配置。");
}

const nativePath = /^\/v1\/(?:donebot\/runtime\/mobile\/(?:heartbeat|events)|messages(?:\/count_tokens)?|responses|chat\/completions|models|systemone|images\/(?:generations(?:\/async)?|edits(?:\/async)?|tasks\/[A-Za-z0-9_-]+)|tasks\/[A-Za-z0-9_-]+|videos(?:\/(?:edits|extensions|[A-Za-z0-9_-]+(?:\/content)?))?|music\/(?:generations|tasks\/[A-Za-z0-9_-]+)|audio\/speech|assets(?:\/[A-Za-z0-9_-]+)?)$/;
const geminiPath = /^\/v1beta\/models\/[A-Za-z0-9._-]+:(?:generateContent|streamGenerateContent)$/;
const cloudID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const cloudInputText = (value: unknown, pattern: RegExp): value is string => typeof value === "string" && pattern.test(value);
const cloudState = (value: unknown): value is string => cloudInputText(value, /^[a-z_]{1,64}$/);
const cloudProblem = (value: unknown): string => cloudInputText(value, /^[a-z_]{0,100}$/) ? value : "operation_failed";
function cloudInvalid(): never { throw new DoneBotGatewayError(502, "cloud_snapshot_invalid", "Cloud 套餐或实例状态无法验证，请刷新。"); }
function cloudPlan(value: DoneBotCloudPlan): DoneBotCloudPlan {
  if (!value || typeof value.enabled !== "boolean" || !cloudInputText(value.monthly_price, /^\d{1,20}(?:\.\d{1,6})?$/) ||
    !Number.isSafeInteger(value.retention_days) || value.retention_days < 0) return cloudInvalid();
  return { enabled: value.enabled, monthly_price: value.monthly_price, retention_days: value.retention_days };
}
function cloudInstance(value: DoneBotCloudInstance): DoneBotCloudInstance {
  if (!value || !cloudInputText(value.id, cloudID) || !cloudState(value.desired) || !cloudState(value.actual) ||
    !(value.subscription_state === "" || cloudState(value.subscription_state)) || typeof value.purge_locked !== "boolean" ||
    value.paid_until !== null && (typeof value.paid_until !== "string" || !Number.isFinite(Date.parse(value.paid_until)))) return cloudInvalid();
  return { id: value.id, desired: value.desired, actual: value.actual, error: cloudProblem(value.error),
    paid_until: value.paid_until, subscription_state: value.subscription_state, purge_locked: value.purge_locked };
}
function cloudOperation(value: DoneBotCloudOperation): DoneBotCloudOperation {
  if (!value || !cloudInputText(value.id, cloudID) || !cloudState(value.action) || !cloudState(value.state)) return cloudInvalid();
  return { id: value.id, action: value.action, state: value.state, error: cloudProblem(value.error) };
}

export function doneBotRequestUrl(path: string, origin = DONEBOT_ORIGIN): URL {
  const url = new URL(path, origin);
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /(?:^|\/)\.{1,2}(?:\/|[?#]|$)/.test(path) || /%2[ef]|%5c/i.test(path) ||
      url.origin !== origin || url.username || url.password || url.hash ||
      (!nativePath.test(url.pathname) && !geminiPath.test(url.pathname))) {
    throw new DoneBotGatewayError(400, "gateway_path", "Unsupported DoneBot gateway operation.");
  }
  for (const name of url.searchParams.keys()) {
    if (!(name === "alt" && url.searchParams.get(name) === "sse") && name !== "language") {
      throw new DoneBotGatewayError(400, "gateway_query", "Unsupported DoneBot gateway parameter.");
    }
  }
  return url;
}

function credential(value: unknown): DoneBotCredential | null {
  if (!value || typeof value !== "object") return null;
  const x = value as DoneBotCredential;
  return typeof x.accessToken === "string" && typeof x.installationId === "string" &&
    typeof x.expiresAt === "number" && typeof x.user?.id === "string" && typeof x.user.email === "string" ? x : null;
}

function catalog(value: unknown): DoneBotCatalog {
  const x = value as DoneBotCatalog;
  if (!x || ![3, 4].includes(x.gateway_contract_version) || !Array.isArray(x.models) || typeof x.catalog_scope_id !== "string" ||
      typeof x.catalog_version !== "string" || !x.defaults ||
      x.models.some(m => typeof m.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(m.id) ||
        !Array.isArray(m.media_types) || !Array.isArray(m.interfaces) || !Array.isArray(m.platforms))) {
    throw new DoneBotGatewayError(502, "catalog_invalid", "The DoneBot model catalog could not be verified.");
  }
  if (new Set(x.models.map(m => m.id)).size !== x.models.length) {
    throw new DoneBotGatewayError(502, "catalog_invalid", "The DoneBot model catalog contains duplicate models.");
  }
  return x;
}

export class DoneBotGateway {
  private session: DoneBotCredential | null = null;
  private pending2fa: string | null = null;
  private currentCatalog: DoneBotCatalog | null = null;
  private etag: string | null = null;
  private accountSnapshot: { concurrency: number; at: number } | null = null;
  private accountFlight: Promise<number> | null = null;
  private mediaActivity: (accountId: string) => number = () => 0;
  private readonly activeModels = new Map<string, number>();
  private epoch = 0;
  private refreshFlight: Promise<void> | null = null;
  private controllers = new Set<AbortController>();
  private listeners = new Set<() => void>();
  private readonly origin: string;
  private readonly fetcher: typeof fetch;
  private readonly store: DoneBotCredentialStore;
  private readonly installationResolver?: (accountId: string, previousId?: string) => string | Promise<string>;
  private readonly installations = new Map<string, string>();
  private writes: Promise<void> = Promise.resolve();

  constructor(store: DoneBotCredentialStore, options: { fetch?: typeof fetch; testOrigin?: string;
    resolveInstallation?: (accountId: string, previousId?: string) => string | Promise<string> } = {}) {
    this.store = store;
    this.fetcher = options.fetch ?? fetch;
    this.origin = options.testOrigin ?? DONEBOT_ORIGIN;
    this.installationResolver = options.resolveInstallation;
    if (options.testOrigin && !/^http:\/\/127\.0\.0\.1:\d+$/.test(options.testOrigin)) throw new Error("Fixture origin must be IPv4 loopback.");
  }

  private checkEpoch(epoch: number): void {
    if (epoch !== this.epoch) throw new DoneBotGatewayError(409, "account_changed", "DoneBot account changed.");
  }
  private async installationFor(accountId: string, previousId?: string): Promise<string> {
    const known = this.installations.get(accountId) ?? previousId;
    const id = this.installationResolver ? await this.installationResolver(accountId, known) : known ?? randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new DoneBotGatewayError(500, "installation_invalid", "The DoneBot installation identity could not be verified.");
    }
    this.installations.set(accountId, id);
    return id;
  }
  private persist(value: DoneBotCredential | null, epoch: number): Promise<void> {
    const write = this.writes.catch(() => {}).then(async () => {
      this.checkEpoch(epoch);
      await this.store.save(value);
      this.checkEpoch(epoch);
    });
    this.writes = write;
    return write;
  }
  async restore(): Promise<void> {
    const epoch = this.epoch;
    const saved = credential(await this.store.load());
    this.checkEpoch(epoch);
    if (saved) {
      const id = await this.installationFor(saved.user.id, saved.installationId);
      this.checkEpoch(epoch);
      if (id !== saved.installationId) throw new DoneBotGatewayError(409, "installation_changed", "Sign in again to reconnect this DoneBot installation.");
    }
    this.session = saved;
    if (saved) {
      try { await this.refreshCatalog(); }
      catch { this.checkEpoch(epoch); this.currentCatalog = null; }
    }
    this.changed();
  }

  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private changed(): void { for (const fn of this.listeners) fn(); }
  authenticated(): boolean { return Boolean(this.session?.credential); }
  bindMediaActivity(read: (accountId: string) => number): void { this.mediaActivity = read; }
  activeModelCount(accountId: string): number { return this.activeModels.get(accountId) ?? 0; }
  models(): DoneBotCatalog | null { return this.currentCatalog; }
  scope(): DoneBotScope | null {
    return this.session?.credential ? { accountId: this.session.user.id, installationId: this.session.installationId } : null;
  }
  state(): DoneBotAccountState {
    return { enabled: true, authenticated: this.authenticated(), ...(this.session ? { user: this.session.user } : {}),
      ...(this.pending2fa ? { requires2fa: true } : {}), modelCount: this.currentCatalog?.models.length ?? 0, persistent: this.store.persistent };
  }

  private async authCall(path: string, body?: unknown, token?: string): Promise<unknown> {
    const res = await this.fetcher(this.origin + "/api/v1/" + path, {
      method: body === undefined ? "GET" : "POST", redirect: "error", credentials: "omit",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    let result: unknown;
    try { result = await res.json(); } catch { throw new DoneBotGatewayError(502, "gateway_unavailable", "DoneBot is temporarily unavailable. Please retry."); }
    if (!res.ok) {
      const messages: Record<string, string> = {
        EMAIL_EXISTS: "该邮箱已注册，请登录或找回密码。", EMAIL_VERIFY_REQUIRED: "请填写邮箱验证码。",
        INVALID_VERIFY_CODE: "邮箱验证码无效或已过期，请重新获取。", INVALID_RESET_CODE: "找回密码验证码无效或已过期，请重新获取。",
        EMAIL_SUFFIX_NOT_ALLOWED: "该邮箱域名暂不支持注册。", REGISTRATION_DISABLED: "当前未开放注册。",
        INVITATION_CODE_REQUIRED: "请填写邀请码。", INVITATION_CODE_INVALID: "邀请码无效或已使用。",
        PASSWORD_RESET_DISABLED: "当前服务未开放密码找回。", CAPTCHA_REQUIRED: "请先完成安全验证。",
      };
      const reason = result && typeof result === "object" && "reason" in result && typeof result.reason === "string" ? result.reason : "";
      throw new DoneBotGatewayError(res.status, "gateway_rejected", messages[reason] ?? (res.status === 401 ? "邮箱、密码或验证码不正确，或登录状态已失效。" :
        res.status === 429 ? "请求过于频繁，请稍后重试。" : "DoneBot 暂时无法完成请求，请检查验证码或稍后重试。"));
    }
    const wrapped = result as { code?: number; data?: unknown };
    return wrapped.code === 0 && "data" in wrapped ? wrapped.data : result;
  }

  async publicSettings(): Promise<DoneBotAuthSettings> { return await this.authCall("settings/public") as DoneBotAuthSettings; }
  async sendVerification(email: string, proof: Record<string, string> = {}): Promise<DoneBotEmailDelivery> { return await this.authCall("auth/send-verify-code", { ...proof, email }) as DoneBotEmailDelivery; }
  async forgotPassword(email: string, proof: Record<string, string> = {}): Promise<DoneBotEmailDelivery> {
    return await this.authCall("auth/forgot-password", { ...proof, email, delivery: "code" }) as DoneBotEmailDelivery;
  }
  async resetPassword(email: string, emailCode: string, newPassword: string): Promise<void> {
    await this.authCall("auth/reset-password", { email, email_code: emailCode, new_password: newPassword });
  }
  cancelLogin(): DoneBotAccountState {
    if (!this.session) { this.invalidate(); this.pending2fa = null; this.changed(); }
    return this.state();
  }

  private beginLogin(): { epoch: number; previous: DoneBotCredential | null } {
    const previous = this.session;
    this.invalidate();
    this.session = null;
    this.pending2fa = null;
    this.changed();
    return { epoch: this.epoch, previous };
  }
  async register(input: { email: string; password: string; verify_code?: string; invitation_code?: string; [key: string]: string | undefined }): Promise<DoneBotAccountState> {
    const attempt = this.beginLogin();
    await this.persist(null, attempt.epoch);
    return this.acceptLogin(await this.authCall("auth/register", input), attempt);
  }
  async login(email: string, password: string, proof: Record<string, string> = {}): Promise<DoneBotAccountState> {
    const attempt = this.beginLogin();
    await this.persist(null, attempt.epoch);
    const value = await this.authCall("auth/login", { ...proof, email, password }) as { requires_2fa?: boolean; temp_token?: string };
    this.checkEpoch(attempt.epoch);
    if (value.requires_2fa) {
      this.pending2fa = value.temp_token ?? null;
      if (!this.pending2fa) throw new DoneBotGatewayError(502, "invalid_auth", "DoneBot verification could not start.");
      await this.persist(null, attempt.epoch);
      this.changed();
      return this.state();
    }
    return this.acceptLogin(value, attempt);
  }
  async verify2fa(totp_code: string): Promise<DoneBotAccountState> {
    if (!this.pending2fa) throw new DoneBotGatewayError(409, "login_required", "Start sign-in again.");
    const epoch = this.epoch;
    const value = await this.authCall("auth/login/2fa", { temp_token: this.pending2fa, totp_code });
    return this.acceptLogin(value, { epoch, previous: this.session });
  }

  private async acceptLogin(value: unknown, attempt: { epoch: number; previous: DoneBotCredential | null }): Promise<DoneBotAccountState> {
    this.checkEpoch(attempt.epoch);
    const x = value as { access_token?: string; refresh_token?: string; expires_in?: number; user?: { id?: number | string; email?: string } };
    if (!x?.access_token || x.user?.id === undefined || !x.user.email) throw new DoneBotGatewayError(502, "invalid_auth", "DoneBot returned an incomplete account session.");
    const old = attempt.previous;
    const installationId = await this.installationFor(String(x.user.id), old?.user.id === String(x.user.id) ? old.installationId : undefined);
    this.checkEpoch(attempt.epoch);
    let next: DoneBotCredential = { accessToken: x.access_token, refreshToken: x.refresh_token,
      expiresAt: Date.now() + (x.expires_in ?? 900) * 1000, user: { id: String(x.user.id), email: x.user.email },
      installationId,
      ...(old?.user.id === String(x.user.id) && old.installationId === installationId && old.credential ? { credential: old.credential } : {}) };
    await this.persist(next, attempt.epoch);
    if (!next.credential) {
      const claimed = await this.authCall("donebot/installations/claim", { installation_id: next.installationId,
        install_name: "DoneBot", fingerprint: "donebot-desktop" }, next.accessToken) as { credential?: string };
      this.checkEpoch(attempt.epoch);
      let key = claimed.credential;
      if (!key) {
        const rotated = await this.authCall(`donebot/installations/${next.installationId}/rotate`, {}, next.accessToken) as { credential?: string };
        this.checkEpoch(attempt.epoch);
        key = rotated.credential;
      }
      if (!key) throw new DoneBotGatewayError(502, "credential_missing", "Reconnect this DoneBot installation to continue.");
      next = { ...next, credential: key };
      await this.persist(next, attempt.epoch);
    }
    this.checkEpoch(attempt.epoch);
    this.session = next;
    this.pending2fa = null;
    await this.refreshCatalog();
    this.checkEpoch(attempt.epoch);
    this.changed();
    return this.state();
  }

  private invalidate(): void {
    this.epoch++;
    this.refreshFlight = null;
    for (const controller of this.controllers) controller.abort(new Error("DoneBot account changed."));
    this.controllers.clear();
    this.currentCatalog = null;
    this.etag = null;
    this.accountSnapshot = null;
    this.accountFlight = null;
  }
  async logout(): Promise<void> {
    const old = this.session;
    this.invalidate();
    this.session = null;
    this.pending2fa = null;
    await this.persist(null, this.epoch);
    this.changed();
    if (old?.refreshToken) {
      try { await this.authCall("auth/logout", { refresh_token: old.refreshToken }, old.accessToken); } catch { /* Local sign-out is effective even if the remote session service is unavailable. */ }
    }
  }

  private async validSession(): Promise<DoneBotCredential> {
    if (!this.session) throw new DoneBotGatewayError(401, "login_required", "Sign in to DoneBot to use models.");
    if (this.session.mode === "installation") return this.session;
    if (this.session.expiresAt <= Date.now() + 30_000 && this.session.refreshToken) {
      if (!this.refreshFlight) {
        const old = this.session;
        const epoch = this.epoch;
        const flight = (async () => {
          const x = await this.authCall("auth/refresh", { refresh_token: old.refreshToken }) as { access_token?: string; refresh_token?: string; expires_in?: number };
          if (epoch !== this.epoch || this.session !== old) throw new DoneBotGatewayError(409, "account_changed", "DoneBot account changed.");
          if (!x.access_token) throw new DoneBotGatewayError(401, "login_required", "Sign in to DoneBot again.");
          const next = { ...old, accessToken: x.access_token, refreshToken: x.refresh_token ?? old.refreshToken,
            expiresAt: Date.now() + (x.expires_in ?? 900) * 1000 };
          await this.persist(next, epoch);
          this.checkEpoch(epoch);
          this.session = next;
        })();
        this.refreshFlight = flight;
        void flight.finally(() => { if (this.refreshFlight === flight) this.refreshFlight = null; }).catch(() => {});
      }
      await this.refreshFlight;
    }
    if (!this.session) throw new DoneBotGatewayError(401, "login_required", "Sign in to DoneBot again.");
    return this.session;
  }

  private async readGateway(path: string, init: RequestInit): Promise<Response> {
    try { return await this.fetcher(this.origin + path, init); }
    catch (error) {
      if (init.signal?.aborted && init.signal.reason?.name !== "TimeoutError") throw error;
      throw readNetworkFailure(error);
    }
  }

  private async readGatewayJson(res: Response): Promise<unknown> {
    try { return await res.json(); }
    catch (error) {
      if (error instanceof SyntaxError) throw new DoneBotGatewayError(502, "gateway_response_invalid", "DoneBot 网关未返回有效 JSON，请检查运行接口和反向代理配置。");
      throw readNetworkFailure(error);
    }
  }

  async refreshCatalog(): Promise<DoneBotCatalog> {
    const session = await this.validSession();
    const epoch = this.epoch;
    const res = await this.readGateway(session.mode === "installation" ? "/v1/donebot/runtime/models" : "/api/v1/donebot/models", { redirect: "error", credentials: "omit",
      headers: { authorization: `Bearer ${session.mode === "installation" ? session.credential : session.accessToken}`, "X-DoneBot-Installation": session.installationId,
        ...(this.etag ? { "If-None-Match": this.etag } : {}) }, signal: AbortSignal.timeout(30_000) });
    if (epoch !== this.epoch) throw new DoneBotGatewayError(409, "account_changed", "DoneBot account changed.");
    if (res.status === 304 && this.currentCatalog) return this.currentCatalog;
    if (!res.ok) throw new DoneBotGatewayError(res.status, "catalog_unavailable", "DoneBot model list could not be loaded. Refresh or sign in again.");
    const next = catalog(await this.readGatewayJson(res));
    this.checkEpoch(epoch);
    this.currentCatalog = next;
    this.etag = res.headers.get("etag");
    this.changed();
    return next;
  }

  private async accountRequest(path: string, expected?: DoneBotScope, signal?: AbortSignal, maxBytes?: number): Promise<unknown> {
    const epoch = this.epoch;
    const s = await this.validSession();
    this.checkEpoch(epoch);
    if (expected && (expected.accountId !== s.user.id || expected.installationId !== s.installationId)) {
      throw new DoneBotGatewayError(409, "account_changed", "DoneBot account changed.");
    }
    const res = await this.readGateway((s.mode === "installation" ? "/v1/donebot/runtime/" : "/api/v1/donebot/") + path, { redirect: "error", credentials: "omit",
      headers: { authorization: `Bearer ${s.mode === "installation" ? s.credential : s.accessToken}`, "X-DoneBot-Installation": s.installationId }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
    if (!res.ok) throw new DoneBotGatewayError(res.status, "account_unavailable", "DoneBot account information could not be loaded.");
    let result: unknown;
    if (maxBytes && res.body) {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.byteLength;
          if (length > maxBytes) throw new Error("DoneBot template response is too large.");
          chunks.push(next.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } else result = await this.readGatewayJson(res);
    this.checkEpoch(epoch);
    const wrapped = result as { code?: number; data?: unknown };
    return wrapped.code === 0 && "data" in wrapped ? wrapped.data : result;
  }
  templates(scope: DoneBotScope): Promise<unknown> { return this.accountRequest("templates", scope, undefined, 1024 * 1024); }
  template(id: string, release: string, scope: DoneBotScope): Promise<unknown> {
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id) || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(release)) throw new Error("Invalid template identity.");
    return this.accountRequest(`templates/${id}/${release}`, scope, undefined, 8 * 1024 * 1024);
  }
  async account(): Promise<unknown> {
    const epoch = this.epoch;
    const account = await this.accountRequest("account");
    this.checkEpoch(epoch);
    const concurrency = (account as { concurrency?: unknown } | null)?.concurrency;
    this.accountSnapshot = typeof concurrency === "number" && Number.isSafeInteger(concurrency) && concurrency > 0 ? { concurrency, at: Date.now() } : null;
    return account;
  }

  private async cloudRequest(method: "GET" | "POST", path: string, accountId?: string, key?: string): Promise<unknown> {
    const epoch = this.epoch;
    if (!this.session) throw new DoneBotGatewayError(401, "login_required", "请先在应用内登录 DoneBot 账号，再刷新 Cloud。");
    const session = await this.validSession();
    this.checkEpoch(epoch);
    if (session.mode === "installation") throw new DoneBotGatewayError(403, "cloud_login_required", "请在本机登录 DoneBot 账号后管理 Cloud，安装凭据不能操作账户扣款。");
    if (accountId && accountId !== session.user.id) throw new DoneBotGatewayError(409, "account_changed", "DoneBot 账号已切换，请刷新后重新确认。");
    const id = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
    const allowed = method === "GET" ? path === "plan" || path === "instances" || new RegExp(`^instances/${id}/operations$`).test(path)
      : path === "instances" || new RegExp(`^instances/${id}/(?:start|stop|cancel|desktop-launch)$`).test(path);
    if (!allowed) throw new DoneBotGatewayError(400, "cloud_path_invalid", "无效的 Cloud 操作。");
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const response = await this.fetcher(`${this.origin}/api/v1/donebot/cloud/${path}`, {
        method, redirect: "error", credentials: "omit", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
        headers: { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      const value = await response.json() as { code?: number; data?: unknown; reason?: string };
      this.checkEpoch(epoch);
      if (!response.ok) {
        const messages: Record<string, string> = {
          CLOUD_INSUFFICIENT_BALANCE: "账户余额不足，无法开通或续期。", CLOUD_PLAN_DISABLED: "Cloud 暂未开放开通。",
          CLOUD_DELETING: "实例正在永久删除，暂时无法恢复或重新开通。", CLOUD_NOT_FOUND: "未找到当前账号的云实例，请刷新。",
          CLOUD_BROWSER_DISABLED: "云实例连接尚未配置，请联系管理员。",
        };
        const reason = typeof value.reason === "string" && /^CLOUD_[A-Z_]+$/.test(value.reason) ? value.reason : "cloud_unavailable";
        throw new DoneBotGatewayError(response.status, reason, messages[reason] ?? (response.status === 401 ? "登录已失效，请重新登录 DoneBot。" : "Cloud 请求未完成，请刷新状态后重试。"));
      }
      return value.code === 0 && "data" in value ? value.data : value;
    } catch (error) {
      this.checkEpoch(epoch);
      if (error instanceof DoneBotGatewayError) throw error;
      throw new DoneBotGatewayError(502, "cloud_unavailable", "Cloud 请求未完成，请刷新状态或使用原确认重试。");
    } finally { this.controllers.delete(controller); }
  }

  async cloudRelay(id: string, expected: DoneBotScope, body: unknown, signal?: AbortSignal, channel: "desktop" = "desktop"): Promise<unknown> {
    if (!cloudInputText(id, cloudID)) throw new DoneBotGatewayError(400, "cloud_operation_invalid", "无效的 Cloud 实例。");
    const epoch = this.epoch, session = await this.validSession();
    this.checkEpoch(epoch);
    if (session.mode === "installation") throw new DoneBotGatewayError(403, "cloud_login_required", "安装凭据不能连接其它运行服务。");
    if (session.user.id !== expected.accountId || session.installationId !== expected.installationId) throw new DoneBotGatewayError(409, "account_changed", "DoneBot 账号已切换。");
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > 34 * 1024 * 1024) throw new Error("Cloud relay request too large");
    const controller = new AbortController(); this.controllers.add(controller);
    try {
      const response = await this.fetcher(`${this.origin}/api/v1/donebot/cloud/instances/${id}/proxy/api/donebot/relay/v1/${channel}`, {
        method: "POST", redirect: "error", credentials: "omit", body: encoded,
        headers: { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json" },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
      });
      if (!response.ok) { await response.body?.cancel(); throw new DoneBotGatewayError(response.status, "cloud_relay_failed", response.status === 401 ? "登录已失效，请重新登录。" : "Cloud 桌面连接未完成，请检查实例状态和版本。"); }
      const chunks: Uint8Array[] = []; let bytes = 0;
      if (!response.body) throw new Error("Empty Cloud relay response");
      const reader = response.body.getReader();
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          bytes += next.value.byteLength; if (bytes > 34 * 1024 * 1024) throw new Error("Cloud relay response too large");
          chunks.push(next.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      this.checkEpoch(epoch);
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { this.controllers.delete(controller); }
  }

  async cloudSnapshot(): Promise<DoneBotCloudSnapshot> {
    const epoch = this.epoch;
    if (!this.session) throw new DoneBotGatewayError(401, "login_required", "请先在应用内登录 DoneBot 账号，再刷新 Cloud。");
    const session = await this.validSession();
    this.checkEpoch(epoch);
    if (session.mode === "installation") throw new DoneBotGatewayError(403, "cloud_login_required", "请在本机登录 DoneBot 账号后管理 Cloud。");
    const [info, instances, account] = await Promise.all([
      this.cloudRequest("GET", "plan", session.user.id), this.cloudRequest("GET", "instances", session.user.id), this.account(),
    ]) as [{ plan: DoneBotCloudPlan; browser_available: boolean }, DoneBotCloudInstance[], { balance_cents?: number | string }];
    const plan = cloudPlan(info?.plan);
    if (!Array.isArray(instances) || instances.length > 1) return cloudInvalid();
    const instance = instances.length ? cloudInstance(instances[0]!) : null;
    const operations = instance ? await this.cloudRequest("GET", `instances/${instance.id}/operations`, session.user.id) as DoneBotCloudOperation[] : [];
    if (!Array.isArray(operations)) throw new DoneBotGatewayError(502, "cloud_snapshot_invalid", "Cloud 操作状态无法验证，请刷新。");
    this.checkEpoch(epoch);
    const cents = account?.balance_cents;
    const balance = typeof cents === "number" && Number.isFinite(cents) || cloudInputText(cents, /^-?\d+(?:\.\d+)?$/) && Number.isFinite(Number(cents)) ? cents! : null;
    return { account_id: session.user.id, email: session.user.email, balance_cents: balance,
      plan, instance, operations: operations.map(cloudOperation), connection_available: info.browser_available === true };
  }

  async cloudViewerAccess(id: string, expected: DoneBotScope) {
    if (!cloudInputText(id, cloudID)) throw new Error("Invalid Cloud instance");
    const epoch = this.epoch, session = await this.validSession(); this.checkEpoch(epoch);
    if (session.mode === "installation" || session.user.id !== expected.accountId || session.installationId !== expected.installationId) throw new Error("Cloud viewer account changed");
    const controller = new AbortController(); this.controllers.add(controller);
    const url = `${this.origin}/api/v1/donebot/cloud/instances/${id}/proxy/api/desktop-viewer/local/shared`;
    try {
      const response = await this.fetcher(url, { redirect: "error", credentials: "omit", headers: { authorization: `Bearer ${session.accessToken}` }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
      if (!response.ok) { await response.body?.cancel(); throw new Error("Cloud viewer unavailable"); }
      const text = await boundedResponseText(response, 2048);
      const value = JSON.parse(text) as { password?: unknown };
      if (typeof value.password !== "string" || value.password.length > 200) throw new Error("Invalid Cloud viewer credentials");
      this.checkEpoch(epoch);
      return { password: value.password, live: () => this.epoch === epoch,
        open: () => {
          this.checkEpoch(epoch);
          const ws = new WebSocket(url.replace(/^http/, "ws") + "/websockify", { headers: { authorization: `Bearer ${session.accessToken}` }, followRedirects: false, handshakeTimeout: 10000, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false });
          const abort = () => ws.terminate(); controller.signal.addEventListener("abort", abort, { once: true }); this.controllers.add(controller);
          ws.once("close", () => { controller.signal.removeEventListener("abort", abort); this.controllers.delete(controller); });
          return ws;
        } };
    } finally { this.controllers.delete(controller); }
  }

  async cloudMutate(input: DoneBotCloudMutation): Promise<DoneBotCloudMutationResult> {
    if (!input || !["start", "stop", "cancel"].includes(input.action) || !cloudInputText(input.key, /^[A-Za-z0-9_-]{1,100}$/) ||
      !cloudInputText(input.account_id, /^.{1,200}$/) || !cloudInputText(input.monthly_price, /^\d{1,20}(?:\.\d{1,6})?$/) ||
      (input.id !== undefined && !cloudInputText(input.id, cloudID)) ||
      (!input.id && input.action !== "start")) throw new DoneBotGatewayError(400, "cloud_operation_invalid", "无效的 Cloud 操作。");
    const epoch = this.epoch;
    if (input.action === "start") {
      const info = await this.cloudRequest("GET", "plan", input.account_id) as { plan: DoneBotCloudPlan };
      if (cloudPlan(info?.plan).monthly_price !== input.monthly_price) throw new DoneBotGatewayError(409, "cloud_price_changed", "Cloud 月费已变化，请刷新后重新确认。");
    }
    this.checkEpoch(epoch);
    const result = await this.cloudRequest("POST", input.id ? `instances/${input.id}/${input.action}` : "instances", input.account_id, input.key) as DoneBotCloudMutationResult;
    return { instance: cloudInstance(result?.instance), operation: cloudOperation(result?.operation) };
  }

  async cloudConnect(id: string, accountId: string): Promise<{ url: string }> {
    if (!cloudInputText(id, cloudID) || !cloudInputText(accountId, /^.{1,200}$/)) throw new DoneBotGatewayError(400, "cloud_operation_invalid", "无效的 Cloud 操作。");
    const value = await this.cloudRequest("POST", `instances/${id}/desktop-launch`, accountId) as { url: string };
    let valid = false;
    try {
      const url = new URL(value.url), address = new URL(url.searchParams.get("address") ?? "");
      valid = url.protocol === "donebot:" && url.hostname === "pair" && !url.port && !url.pathname && !url.username && !url.password && !url.hash &&
        [...url.searchParams.keys()].every(key => ["address", "token", "name"].includes(key) && url.searchParams.getAll(key).length === 1) &&
        address.protocol === "https:" && address.hostname.startsWith(id + ".") && address.pathname === "/" && !address.username && !address.password && !address.search && !address.hash &&
        /^omb_pair_[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("token") ?? "");
    } catch { /* Malformed pairing replies fail closed. */ }
    if (!valid) throw new DoneBotGatewayError(502, "cloud_connection_invalid", "Cloud 连接地址无法验证，请刷新后重试。");
    return { url: value.url };
  }
  async concurrency(scope: DoneBotScope): Promise<number> {
    const current = this.scope();
    if (!current || current.accountId !== scope.accountId || current.installationId !== scope.installationId) throw new DoneBotGatewayError(409, "account_changed", "DoneBot account changed.");
    if (this.accountSnapshot && Date.now() - this.accountSnapshot.at < 10_000) return this.accountSnapshot.concurrency;
    if (!this.accountFlight) {
      const epoch = this.epoch;
      const flight = (async () => {
        await this.account();
        this.checkEpoch(epoch);
        if (!this.accountSnapshot) throw new DoneBotGatewayError(502, "concurrency_unavailable", "Refresh your DoneBot account concurrency before media can be submitted.");
        return this.accountSnapshot.concurrency;
      })();
      this.accountFlight = flight;
      void flight.finally(() => { if (this.accountFlight === flight) this.accountFlight = null; }).catch(() => {});
    }
    return this.accountFlight;
  }
  receipt(id: string, scope: DoneBotScope, signal?: AbortSignal): Promise<unknown> {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new DoneBotGatewayError(400, "receipt_invalid", "Invalid DoneBot receipt.");
    return this.accountRequest(`receipts/${id}`, scope, signal);
  }

  request(path: string, init: RequestInit = {}): Promise<Response> {
    const scope = this.scope();
    if (!scope) return Promise.reject(new DoneBotGatewayError(401, "login_required", "Sign in to DoneBot to use models."));
    return this.requestForScope(scope, path, init);
  }

  private async acquireModelSlot(scope: DoneBotScope, signal: AbortSignal): Promise<() => void> {
    for (;;) {
      signal.throwIfAborted();
      const total = await this.concurrency(scope);
      signal.throwIfAborted();
      const active = this.activeModelCount(scope.accountId);
      if (active + this.mediaActivity(scope.accountId) < total) {
        this.activeModels.set(scope.accountId, active + 1);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          const remaining = this.activeModelCount(scope.accountId) - 1;
          if (remaining > 0) this.activeModels.set(scope.accountId, remaining);
          else this.activeModels.delete(scope.accountId);
        };
      }
      await new Promise<void>((resolve, reject) => {
        const aborted = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, 100);
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) { signal.removeEventListener("abort", aborted); aborted(); }
      });
    }
  }

  async requestForScope(scope: DoneBotScope, path: string, init: RequestInit = {}): Promise<Response> {
    const url = doneBotRequestUrl(path, this.origin);
    const s = this.session;
    if (!s?.credential || s.user.id !== scope.accountId || s.installationId !== scope.installationId) {
      throw new DoneBotGatewayError(409, "account_changed", "This job belongs to another DoneBot account or installation.");
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    const headers = new Headers(init.headers);
    for (const key of ["authorization", "x-api-key", "x-goog-api-key", "cookie", "proxy-authorization"]) headers.delete(key);
    headers.set("authorization", `Bearer ${s.credential}`);
    headers.set("X-DoneBot-Installation", s.installationId);
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    const modelPost = (init.method ?? "GET").toUpperCase() === "POST" &&
      (["/v1/messages", "/v1/responses", "/v1/chat/completions", "/v1/systemone", "/v1/audio/speech"].includes(url.pathname) || geminiPath.test(url.pathname));
    let release: (() => void) | undefined;
    let cancelBody = () => {};
    const abort = () => { cancelBody(); finish(); };
    const finish = () => { signal.removeEventListener("abort", abort); this.controllers.delete(controller); release?.(); };
    try {
      if (modelPost) release = await this.acquireModelSlot(scope, signal);
      signal.throwIfAborted();
      signal.addEventListener("abort", abort, { once: true });
      const response = await this.fetcher(url, { ...init, headers, signal, redirect: "error", credentials: "omit" });
      if (signal.aborted) { await response.body?.cancel().catch(() => {}); signal.throwIfAborted(); }
      if (!response.body) { finish(); return response; }
      const reader = response.body.getReader();
      let ended = false;
      const body = new ReadableStream<Uint8Array>({
        start(target) {
          cancelBody = () => {
            if (ended) return;
            ended = true;
            target.error(signal.reason);
            void reader.cancel(signal.reason).catch(() => {});
          };
        },
        async pull(target) {
          try {
            const next = await reader.read();
            if (ended) return;
            if (next.done) { ended = true; finish(); target.close(); } else target.enqueue(next.value);
          } catch (error) { if (!ended) { ended = true; finish(); target.error(error); } }
        },
        async cancel(reason) { ended = true; finish(); controller.abort(reason); await reader.cancel(reason); },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { finish(); throw error; }
  }
}
