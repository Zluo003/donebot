// No answer ever carries a password, a 2FA key or the token: a saved secret is only ever replaced.
import { LOGIN_FIELD_MAX, loginPlace, normalizeLoginHost, type BitwardenCredentials, type BitwardenStatus, type LoginBots, type LoginSummary, type OnePasswordStatus } from "../../shared/logins.ts";
import { BitwardenProblem, bitwardenServerUrl } from "../host/bitwarden-vault.ts";
import type { LoginPatch, NewLogin } from "../vault-store.ts";
import { parseTotpKey, type TotpKey } from "../totp.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface LoginRouteDeps {
  list(): LoginSummary[];
  create(input: NewLogin): LoginSummary;
  update(id: string, patch: LoginPatch): LoginSummary | null;
  remove(id: string): boolean;
  botExists(id: string): boolean;
  bitwarden?: {
    status(): BitwardenStatus;
    list(): LoginSummary[];
    connect(credentials: BitwardenCredentials): Promise<BitwardenStatus>;
    refresh(): Promise<BitwardenStatus>;
    disconnect(): Promise<BitwardenStatus>;
  };
  onePassword: {
    status(): OnePasswordStatus;
    list(): LoginSummary[];
    connect(token: string): Promise<OnePasswordStatus>;
    refresh(): Promise<OnePasswordStatus>;
    disconnect(): OnePasswordStatus;
    /** Null for a vault the token does not read. */
    grant(vaultId: string, bots: LoginBots): OnePasswordStatus | null;
  };
}

const ONE_PASSWORD = "/api/logins/1password";
const VAULT = /^\/api\/logins\/1password\/vaults\/([\w-]{1,128})$/u;

const ID = /^[\w-]{1,128}$/u;

export const LOGIN_ERRORS = {
  site: "Enter the address of the login page, such as accounts.example.com.",
  password: "Enter the password.",
  long: `Usernames and passwords can be at most ${LOGIN_FIELD_MAX} characters.`,
  totp: "That 2FA key is not valid. Paste the setup key (letters A–Z and digits 2–7) or the otpauth:// address from the site's QR code.",
  bots: "Choose every bot, or bots that exist.",
  token: "Paste a 1Password service account token. It starts with ops_.",
  notServiceAccount: "That is not a 1Password service account token: those start with ops_. Make one in 1Password under Developer → Service accounts. A Connect token, an account password or a Secret Key does not work here.",
  exactHost: "exactHost must be true or false.",
  readOnly: "This login is in 1Password. Change or remove it there.",
} as const;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Absent leaves it; "" or null clears it. */
export function parseTotpField(value: unknown): Parsed<TotpKey | null | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || (typeof value === "string" && !value.trim())) return { ok: true, value: null };
  const key = parseTotpKey(value);
  return key ? { ok: true, value: key } : { ok: false, error: LOGIN_ERRORS.totp };
}

export function parseLoginFields(body: Record<string, unknown>, options: { passwordRequired: boolean }): Parsed<{ username?: string; password?: string }> {
  const username = body.username;
  const password = body.password;
  if (username !== undefined && typeof username !== "string") return { ok: false, error: "username must be text" };
  if (password !== undefined && typeof password !== "string") return { ok: false, error: LOGIN_ERRORS.password };
  if (options.passwordRequired && !password) return { ok: false, error: LOGIN_ERRORS.password };
  if (password !== undefined && !password) return { ok: false, error: LOGIN_ERRORS.password };
  if ((username?.length ?? 0) > LOGIN_FIELD_MAX || (password?.length ?? 0) > LOGIN_FIELD_MAX) return { ok: false, error: LOGIN_ERRORS.long };
  return { ok: true, value: { ...(username === undefined ? {} : { username: username.trim() }), ...(password === undefined ? {} : { password }) } };
}

export function parseBots(value: unknown, exists: (id: string) => boolean): Parsed<LoginBots | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === "all") return { ok: true, value: "all" };
  if (!Array.isArray(value) || value.length > 500 || !value.every((id) => typeof id === "string" && ID.test(id) && exists(id))) {
    return { ok: false, error: LOGIN_ERRORS.bots };
  }
  return { ok: true, value: [...new Set(value as string[])] };
}

export function isJson(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  return String(req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase() === "application/json";
}

export function parseBitwardenCredentials(raw: unknown): Parsed<BitwardenCredentials> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Enter the Bitwarden API key and master password." };
  const body = raw as Record<string, unknown>;
  const serverUrl = bitwardenServerUrl(body.serverUrl);
  if (!serverUrl) return { ok: false, error: "Enter an HTTPS Bitwarden server address without credentials or a query." };
  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";
  if (!/^user\.[\w-]{1,195}$/u.test(clientId) || !clientSecret || clientSecret.length > 256 || /\s/u.test(clientSecret)) return { ok: false, error: "Enter the personal Bitwarden client_id and client_secret." };
  if (typeof body.password !== "string" || !body.password || body.password.length > 1024) return { ok: false, error: "Enter the Bitwarden master password." };
  return { ok: true, value: { serverUrl, clientId, clientSecret, password: body.password } };
}

export function createLoginRoutes(deps: LoginRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (path !== "/api/logins" && !path.startsWith("/api/logins/")) return PASS;
    res.setHeader("cache-control", "no-store");
    if (path === "/api/logins" && method === "GET") {
      return json(res, 200, { logins: [...deps.list(), ...deps.onePassword.list(), ...(deps.bitwarden?.list() ?? [])], onePassword: deps.onePassword.status(), ...(deps.bitwarden ? { bitwarden: deps.bitwarden.status() } : {}) });
    }
    // JSON only, so a form posted from another local page cannot add or change one.
    if (method !== "GET" && method !== "DELETE" && !isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
    if (path === "/api/logins/bitwarden" || path.startsWith("/api/logins/bitwarden/")) {
      if (!deps.bitwarden) return json(res, 404, { error: "Bitwarden is not available in this workspace." });
      try {
        if (path === "/api/logins/bitwarden" && method === "POST") {
          const credentials = parseBitwardenCredentials(await readBody(req, 16_384));
          if (!credentials.ok) return json(res, 400, { error: credentials.error });
          return json(res, 200, { bitwarden: await deps.bitwarden.connect(credentials.value) });
        }
        if (path === "/api/logins/bitwarden" && method === "DELETE") return json(res, 200, { bitwarden: await deps.bitwarden.disconnect() });
        if (path === "/api/logins/bitwarden/refresh" && method === "POST") return json(res, 200, { bitwarden: await deps.bitwarden.refresh() });
        return json(res, 405, { error: "method not allowed" });
      } catch (error) {
        return json(res, 400, { error: error instanceof BitwardenProblem ? error.message : "Bitwarden could not be read. Try again, or connect it again." });
      }
    }
    // 1Password's own paths, ahead of the /api/logins/:id pattern they would match.
    if (path === ONE_PASSWORD && method === "POST") {
      const body = await readBody(req, 16_384);
      const token = body && typeof body === "object" && typeof body.token === "string" ? body.token.trim() : "";
      if (!token || token.length > 8192 || /\s/u.test(token)) return json(res, 400, { error: LOGIN_ERRORS.token });
      if (!token.startsWith("ops_")) return json(res, 400, { error: LOGIN_ERRORS.notServiceAccount });
      try { return json(res, 200, { onePassword: await deps.onePassword.connect(token) }); }
      catch (error) { return json(res, 400, { error: error instanceof Error && error.message ? error.message : LOGIN_ERRORS.token }); }
    }
    if (path === `${ONE_PASSWORD}/refresh` && method === "POST") return json(res, 200, { onePassword: await deps.onePassword.refresh() });
    if (path === ONE_PASSWORD && method === "DELETE") return json(res, 200, { onePassword: deps.onePassword.disconnect() });
    const vault = VAULT.exec(path);
    if (vault && method === "PATCH") {
      const body = await readBody(req, 16_384);
      const bots = parseBots(body && typeof body === "object" ? body.bots : undefined, deps.botExists);
      if (!bots.ok || bots.value === undefined) return json(res, 400, { error: bots.ok ? LOGIN_ERRORS.bots : bots.error });
      const status = deps.onePassword.grant(vault[1]!, bots.value);
      return status ? json(res, 200, { onePassword: status }) : json(res, 404, { error: "no such vault" });
    }
    if (path === ONE_PASSWORD || path.startsWith(`${ONE_PASSWORD}/`)) return json(res, 405, { error: "method not allowed" });
    if (path === "/api/logins" && method === "POST") {
      const body = await readBody(req, 16_384);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "send the login as a JSON object" });
      const host = normalizeLoginHost(body.site);
      if (!host) return json(res, 400, { error: LOGIN_ERRORS.site });
      const fields = parseLoginFields(body, { passwordRequired: true });
      if (!fields.ok) return json(res, 400, { error: fields.error });
      const totp = parseTotpField(body.totp);
      if (!totp.ok) return json(res, 400, { error: totp.error });
      const bots = parseBots(body.bots ?? "all", deps.botExists);
      if (!bots.ok) return json(res, 400, { error: bots.error });
      if (body.exactHost !== undefined && typeof body.exactHost !== "boolean") return json(res, 400, { error: LOGIN_ERRORS.exactHost });
      const login = deps.create({
        ...loginPlace(host, [], body.exactHost === true), username: fields.value.username ?? "", password: fields.value.password!,
        totp: totp.value ?? null, source: "settings", bots: bots.value ?? "all",
      });
      return json(res, 201, { login });
    }
    const id = path.slice("/api/logins/".length);
    if (/^1password(?::|%3a)/iu.test(id)) return json(res, 409, { error: LOGIN_ERRORS.readOnly });
    if (/^bitwarden(?::|%3a)/iu.test(id)) return json(res, 409, { error: "This login is in Bitwarden. Change or remove it there." });
    if (!ID.test(id)) return json(res, 404, { error: "no such login" });
    if (method === "DELETE") {
      return deps.remove(id) ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such login" });
    }
    if (method !== "PATCH") return json(res, 405, { error: "method not allowed" });
    const body = await readBody(req, 16_384);
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "send the change as a JSON object" });
    const fields = parseLoginFields(body, { passwordRequired: false });
    if (!fields.ok) return json(res, 400, { error: fields.error });
    const totp = parseTotpField(body.totp);
    if (!totp.ok) return json(res, 400, { error: totp.error });
    const bots = parseBots(body.bots, deps.botExists);
    if (!bots.ok) return json(res, 400, { error: bots.error });
    if (body.exactHost !== undefined && typeof body.exactHost !== "boolean") return json(res, 400, { error: LOGIN_ERRORS.exactHost });
    const login = deps.update(id, {
      ...fields.value,
      ...(totp.value === undefined ? {} : { totp: totp.value }),
      ...(bots.value === undefined ? {} : { bots: bots.value }),
      ...(body.exactHost === undefined ? {} : { exactHost: body.exactHost }),
    });
    return login ? json(res, 200, { login }) : json(res, 404, { error: "no such login" });
  };
}
