import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { BlockList, connect, isIP, type Socket } from "node:net";
import { dirname } from "node:path";
import { z } from "zod";
import {
  DEFAULT_DONEBOT_BROWSER_PROXY,
  type DoneBotBrowserProxyConfig,
} from "../../shared/donebot.ts";
import type { LinkOpened } from "../../electron/device-link-protocol.mjs";
import { writeFileAtomic } from "../atomic.ts";
import type { GateTarget, GateUpstream } from "../browser/egress/gate.ts";
import type { EgressRules } from "../browser/egress/policy.ts";
import { ownerOrAdmin } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";

export interface ParsedProxyEndpoint {
  protocol: "socks5" | "http";
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface OsSystemProxySnapshot {
  socks?: ParsedProxyEndpoint;
  https?: ParsedProxyEndpoint;
  http?: ParsedProxyEndpoint;
  pacUrl?: string;
  exceptions: string[];
}

export interface ProxyParentPort {
  on(event: "message", listener: (event: { data?: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const CONNECT_TIMEOUT_MS = 8_000;
const ELECTRON_RESOLVE_TIMEOUT_MS = 1_200;
const OS_PROXY_CACHE_TTL_MS = 3_000;
const MAX_HTTP_CONNECT_HEADER_BYTES = 16 * 1024;
const PROBE_URL = "https://www.google.com/";

/** Parses an explicit proxy URL such as `socks5://127.0.0.1:10808` or `http://127.0.0.1:10809`. */
export function parseProxyUrl(raw: string): ParsedProxyEndpoint | null {
  const trimmed = raw.trim();
  if (!trimmed || /[\r\n\0\s]/.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const proto = parsed.protocol.toLowerCase();
  const protocol = proto === "socks5:" || proto === "socks5h:" || proto === "socks:"
    ? "socks5"
    : proto === "http:"
      ? "http"
      : null;
  if (!protocol) return null;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").trim();
  const port = parsed.port ? Number(parsed.port) : protocol === "http" ? 80 : 1080;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (parsed.pathname && parsed.pathname !== "/") return null;
  let username: string | undefined;
  let password: string | undefined;
  try {
    username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
    password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  } catch {
    return null;
  }
  return {
    protocol,
    host,
    port,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

export function formatProxyEndpoint(endpoint: ParsedProxyEndpoint): string {
  const host = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host;
  return `${endpoint.protocol}://${host}:${endpoint.port}`;
}

function parseHostPort(raw: string, defaultPort: number): { host: string; port: number } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const ipv6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(trimmed);
  if (ipv6) {
    const port = ipv6[2] ? Number(ipv6[2]) : defaultPort;
    return Number.isInteger(port) && port >= 1 && port <= 65_535 ? { host: ipv6[1]!, port } : null;
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon <= 0) {
    return Number.isInteger(defaultPort) ? { host: trimmed, port: defaultPort } : null;
  }
  const host = trimmed.slice(0, colon).trim();
  const port = Number(trimmed.slice(colon + 1).trim());
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host, port };
}

/** Parses Chromium's `session.resolveProxy()` output (e.g. `"SOCKS5 127.0.0.1:10808; PROXY 127.0.0.1:10809; DIRECT"`). */
export function parseChromiumProxyDirective(raw: string): ParsedProxyEndpoint[] {
  const out: ParsedProxyEndpoint[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length < 2) continue;
    const scheme = tokens[0]!.toUpperCase();
    const protocol = scheme === "SOCKS5" || scheme === "SOCKS"
      ? "socks5"
      : scheme === "PROXY" || scheme === "HTTP"
        ? "http"
        : null;
    if (!protocol) continue;
    const hp = parseHostPort(tokens[1]!, protocol === "http" ? 80 : 1080);
    if (!hp) continue;
    const key = `${protocol}://${hp.host}:${hp.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ protocol, host: hp.host, port: hp.port });
  }
  return out;
}

/** Parses `scutil --proxy` output on macOS. */
export function parseScutilProxyOutput(stdout: string): OsSystemProxySnapshot {
  const values = new Map<string, string>();
  const exceptions: string[] = [];
  let inExceptions = false;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (inExceptions) {
      if (line === "}") {
        inExceptions = false;
        continue;
      }
      const itemMatch = /^\d+\s*:\s*(.+)$/.exec(line);
      if (itemMatch?.[1]) exceptions.push(itemMatch[1].trim());
      continue;
    }
    if (/^ExceptionsList\s*:\s*<array>\s*\{$/i.test(line)) {
      inExceptions = true;
      continue;
    }
    const kv = /^([A-Za-z0-9_]+)\s*:\s*(.+)$/.exec(line);
    if (kv?.[1] && kv[2]) values.set(kv[1], kv[2].trim());
  }

  const readEndpoint = (enableKey: string, hostKey: string, portKey: string, protocol: "socks5" | "http"): ParsedProxyEndpoint | undefined => {
    if (values.get(enableKey) !== "1") return undefined;
    const host = values.get(hostKey)?.trim();
    const port = Number(values.get(portKey));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
    return { protocol, host, port };
  };

  const pacUrl = values.get("ProxyAutoConfigEnable") === "1"
    ? values.get("ProxyAutoConfigURLString")?.trim() || undefined
    : undefined;

  return {
    socks: readEndpoint("SOCKSEnable", "SOCKSProxy", "SOCKSPort", "socks5"),
    https: readEndpoint("HTTPSEnable", "HTTPSProxy", "HTTPSPort", "http"),
    http: readEndpoint("HTTPEnable", "HTTPProxy", "HTTPPort", "http"),
    ...(pacUrl ? { pacUrl } : {}),
    exceptions,
  };
}

/** Parses `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"` output on Windows. */
export function parseWindowsRegProxyOutput(stdout: string): OsSystemProxySnapshot {
  let enabled = false;
  let serverRaw = "";
  let overrideRaw = "";
  let pacUrl: string | undefined;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s+REG_[A-Z_]+\s+(.+?)\s*$/i.exec(rawLine);
    if (!match) continue;
    const [, name, val] = match;
    if (name === "ProxyEnable") enabled = val === "0x1" || val === "1";
    else if (name === "ProxyServer") serverRaw = val!.trim();
    else if (name === "ProxyOverride") overrideRaw = val!.trim();
    else if (name === "AutoConfigURL") pacUrl = val!.trim() || undefined;
  }

  const exceptions = overrideRaw
    .split(/[;,\s]+/)
    .map(s => s.trim())
    .filter(Boolean);

  if (!enabled || !serverRaw) {
    return { ...(pacUrl ? { pacUrl } : {}), exceptions };
  }

  const out: OsSystemProxySnapshot = { ...(pacUrl ? { pacUrl } : {}), exceptions };
  if (!serverRaw.includes("=")) {
    const parsed = serverRaw.includes("://") ? parseProxyUrl(serverRaw) : null;
    if (parsed) {
      if (parsed.protocol === "socks5") out.socks = parsed;
      else {
        out.https = parsed;
        out.http = parsed;
      }
      return out;
    }
    const hp = parseHostPort(serverRaw, 80);
    if (hp) {
      out.https = { protocol: "http", ...hp };
      out.http = { protocol: "http", ...hp };
    }
    return out;
  }

  for (const segment of serverRaw.split(";")) {
    const eq = segment.indexOf("=");
    if (eq <= 0) continue;
    const key = segment.slice(0, eq).trim().toLowerCase();
    const val = segment.slice(eq + 1).trim();
    const hp = parseHostPort(val, key.startsWith("socks") ? 1080 : 80);
    if (!hp) continue;
    if (key === "socks" || key === "socks5") out.socks = { protocol: "socks5", ...hp };
    else if (key === "https") out.https = { protocol: "http", ...hp };
    else if (key === "http") out.http = { protocol: "http", ...hp };
  }
  return out;
}

export function splitBypassList(raw: string): string[] {
  return raw
    .split(/[\n,;]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/** Matches a destination host against system proxy `ExceptionsList` / `NO_PROXY` / user bypass entries. */
export function matchesBypassRule(rawHost: string, rules: readonly string[]): boolean {
  const host = rawHost.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host) return false;
  const hostIpFamily = isIP(host);
  for (const rawRule of rules) {
    const rule = rawRule.trim().toLowerCase();
    if (!rule) continue;
    if (rule === "*") return true;
    if (rule === "<local>") {
      if (!host.includes(".")) return true;
      continue;
    }
    if (rule.includes("/") && hostIpFamily !== 0) {
      const [netPart, prefixPart] = rule.split("/");
      const netFamily = netPart ? isIP(netPart) : 0;
      const prefix = Number(prefixPart);
      if (netFamily === hostIpFamily && Number.isInteger(prefix) && prefix >= 0 && prefix <= (netFamily === 6 ? 128 : 32)) {
        try {
          const list = new BlockList();
          list.addSubnet(netPart!, prefix, netFamily === 6 ? "ipv6" : "ipv4");
          if (list.check(host, hostIpFamily === 6 ? "ipv6" : "ipv4")) return true;
        } catch {}
      }
      continue;
    }
    const cleanRule = rule.replace(/^\[|\]$/g, "").replace(/:\d+$/, "");
    if (cleanRule.startsWith("*.")) {
      const suffix = cleanRule.slice(1);
      if (host.endsWith(suffix) || host === cleanRule.slice(2)) return true;
      continue;
    }
    if (cleanRule.startsWith(".")) {
      if (host.endsWith(cleanRule) || host === cleanRule.slice(1)) return true;
      continue;
    }
    if (cleanRule.endsWith(".*")) {
      const prefix = cleanRule.slice(0, -1);
      if (host.startsWith(prefix)) return true;
      continue;
    }
    if (host === cleanRule || (hostIpFamily === 0 && host.endsWith(`.${cleanRule}`))) return true;
  }
  return false;
}

function envSystemProxyCandidates(targetHost: string, env: NodeJS.ProcessEnv = process.env): ParsedProxyEndpoint[] {
  const noProxy = splitBypassList(env.NO_PROXY ?? env.no_proxy ?? "");
  if (noProxy.length > 0 && matchesBypassRule(targetHost, noProxy)) return [];
  const rawCandidates = [
    env.ALL_PROXY,
    env.all_proxy,
    env.HTTPS_PROXY,
    env.https_proxy,
    env.HTTP_PROXY,
    env.http_proxy,
  ];
  const out: ParsedProxyEndpoint[] = [];
  const seen = new Set<string>();
  for (const raw of rawCandidates) {
    if (!raw) continue;
    const parsed = parseProxyUrl(raw);
    if (!parsed) continue;
    const key = formatProxyEndpoint(parsed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }
  return out;
}

function candidatesFromOsSnapshot(snapshot: OsSystemProxySnapshot, target: GateTarget): ParsedProxyEndpoint[] {
  if (snapshot.exceptions.length > 0 && matchesBypassRule(target.host, snapshot.exceptions)) return [];
  const ordered = target.port === 80
    ? [snapshot.socks, snapshot.http, snapshot.https]
    : [snapshot.socks, snapshot.https, snapshot.http];
  const out: ParsedProxyEndpoint[] = [];
  const seen = new Set<string>();
  for (const ep of ordered) {
    if (!ep) continue;
    const key = formatProxyEndpoint(ep);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ep);
  }
  return out;
}

function execText(file: string, args: string[], timeoutMs = 2_000): Promise<string | null> {
  return new Promise(resolve => {
    execFile(file, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 512 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/** Reads the host OS proxy configuration with a short TTL cache so toggling v2rayN takes effect within seconds. */
function createOsProxyReader(platform: NodeJS.Platform = process.platform) {
  let cached: { at: number; value: OsSystemProxySnapshot } | null = null;
  let inFlight: Promise<OsSystemProxySnapshot> | null = null;

  return async function readOsProxy(force = false): Promise<OsSystemProxySnapshot> {
    if (!force && cached && Date.now() - cached.at < OS_PROXY_CACHE_TTL_MS) return cached.value;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let value: OsSystemProxySnapshot = { exceptions: [] };
      if (platform === "darwin") {
        const out = await execText("/usr/sbin/scutil", ["--proxy"]);
        if (out) value = parseScutilProxyOutput(out);
      } else if (platform === "win32") {
        const out = await execText("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"]);
        if (out) value = parseWindowsRegProxyOutput(out);
      }
      cached = { at: Date.now(), value };
      return value;
    })().finally(() => { inFlight = null; });
    return inFlight;
  };
}

/** Requests proxy resolution from Electron's main process (`session.defaultSession.resolveProxy`), supporting PAC scripts natively. */
export function createElectronProxyResolver(parentPort?: ProxyParentPort) {
  if (!parentPort || typeof parentPort.postMessage !== "function" || typeof parentPort.on !== "function") {
    return null;
  }
  const pending = new Map<string, { resolve: (value: string | null) => void; timer: ReturnType<typeof setTimeout> }>();
  parentPort.on("message", ({ data }) => {
    const msg = data as { type?: unknown; id?: unknown; proxy?: unknown } | undefined;
    if (msg?.type !== "donebot:resolve-proxy-result" || typeof msg.id !== "string") return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    entry.resolve(typeof msg.proxy === "string" ? msg.proxy : null);
  });

  return function resolveViaElectron(url: string): Promise<string | null> {
    return new Promise(resolve => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, ELECTRON_RESOLVE_TIMEOUT_MS);
      timer.unref?.();
      pending.set(id, { resolve, timer });
      try {
        parentPort.postMessage({ type: "donebot:resolve-proxy", id, url });
      } catch {
        pending.delete(id);
        clearTimeout(timer);
        resolve(null);
      }
    });
  };
}

interface DialResult {
  socket: Socket;
  extra: Buffer;
}

function dialRawSocket(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      const err = new Error("proxy connect timeout") as NodeJS.ErrnoException;
      err.code = "ETIMEDOUT";
      reject(err);
    }, timeoutMs);
    timer.unref?.();
    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });
}

function encodeSocks5ConnectRequest(target: GateTarget): Buffer {
  const host = target.host.replace(/^\[|\]$/g, "");
  const ipKind = isIP(host);
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(target.port, 0);
  if (ipKind === 4) {
    const octets = host.split(".").map(Number);
    return Buffer.concat([Buffer.from([5, 1, 0, 1, ...octets]), portBuf]);
  }
  const hostBuf = Buffer.from(host, "utf8");
  if (hostBuf.length === 0 || hostBuf.length > 255) throw new Error("invalid proxy target host");
  return Buffer.concat([Buffer.from([5, 1, 0, 3, hostBuf.length]), hostBuf, portBuf]);
}

function socks5ReplyLength(buf: Buffer): number | null {
  if (buf.length < 5) return null;
  const atyp = buf[3];
  if (atyp === 1) return 10;
  if (atyp === 4) return 22;
  if (atyp === 3) return 7 + buf[4]!;
  return -1;
}

/** Connects to `target` through a SOCKS5 proxy using remote DNS (ATYP=3) for domain names. */
export async function connectViaSocks5(
  proxy: ParsedProxyEndpoint,
  target: GateTarget,
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<DialResult> {
  const socket = await dialRawSocket(proxy.host, proxy.port, timeoutMs);
  return new Promise<DialResult>((resolve, reject) => {
    let settled = false;
    let stage: "method" | "auth" | "connect" = "method";
    let buf = Buffer.alloc(0);
    const hasAuth = Boolean(proxy.username || proxy.password);

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.destroy();
      reject(err);
    };

    const succeed = (extra: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.pause();
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      resolve({ socket, extra });
    };

    const timer = setTimeout(() => {
      const err = new Error("SOCKS5 handshake timeout") as NodeJS.ErrnoException;
      err.code = "ETIMEDOUT";
      fail(err);
    }, timeoutMs);
    timer.unref?.();

    const onError = (err: Error) => fail(err);
    const onClose = () => fail(new Error("SOCKS5 proxy closed during handshake"));

    const sendConnect = () => {
      stage = "connect";
      try {
        socket.write(encodeSocks5ConnectRequest(target));
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    };

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (!settled) {
        if (stage === "method") {
          if (buf.length < 2) return;
          const ver = buf[0];
          const method = buf[1];
          buf = buf.subarray(2);
          if (ver !== 5) return fail(new Error("Invalid SOCKS5 greeting reply"));
          if (method === 0) {
            sendConnect();
            continue;
          }
          if (method === 2 && hasAuth) {
            stage = "auth";
            const userBuf = Buffer.from(proxy.username ?? "", "utf8");
            const passBuf = Buffer.from(proxy.password ?? "", "utf8");
            if (userBuf.length > 255 || passBuf.length > 255) return fail(new Error("SOCKS5 credentials too long"));
            socket.write(Buffer.concat([Buffer.from([1, userBuf.length]), userBuf, Buffer.from([passBuf.length]), passBuf]));
            continue;
          }
          return fail(new Error("SOCKS5 proxy rejected authentication method"));
        }
        if (stage === "auth") {
          if (buf.length < 2) return;
          const status = buf[1];
          buf = buf.subarray(2);
          if (status !== 0) return fail(new Error("SOCKS5 authentication failed"));
          sendConnect();
          continue;
        }
        if (stage === "connect") {
          const needed = socks5ReplyLength(buf);
          if (needed === null) return;
          if (needed < 0 || buf[0] !== 5) return fail(new Error("Invalid SOCKS5 connect reply"));
          if (buf.length < needed) return;
          const rep = buf[1];
          const extra = buf.subarray(needed);
          if (rep !== 0) {
            const err = new Error(`SOCKS5 connect failed (code ${rep})`) as NodeJS.ErrnoException;
            err.code = rep === 5 ? "ECONNREFUSED" : "EHOSTUNREACH";
            return fail(err);
          }
          return succeed(extra);
        }
      }
    };

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.write(hasAuth ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]));
  });
}

/** Connects to `target` through an HTTP CONNECT proxy (sending raw hostname for remote DNS resolution). */
export async function connectViaHttpProxy(
  proxy: ParsedProxyEndpoint,
  target: GateTarget,
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<DialResult> {
  const socket = await dialRawSocket(proxy.host, proxy.port, timeoutMs);
  return new Promise<DialResult>((resolve, reject) => {
    let settled = false;
    let buf = Buffer.alloc(0);

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.destroy();
      reject(err);
    };

    const succeed = (extra: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.pause();
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      resolve({ socket, extra });
    };

    const timer = setTimeout(() => {
      const err = new Error("HTTP proxy CONNECT timeout") as NodeJS.ErrnoException;
      err.code = "ETIMEDOUT";
      fail(err);
    }, timeoutMs);
    timer.unref?.();

    const onError = (err: Error) => fail(err);
    const onClose = () => fail(new Error("HTTP proxy closed during CONNECT"));

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        if (buf.length > MAX_HTTP_CONNECT_HEADER_BYTES) fail(new Error("HTTP proxy response headers too large"));
        return;
      }
      const headerText = buf.subarray(0, headerEnd).toString("latin1");
      const extra = buf.subarray(headerEnd + 4);
      const statusLine = headerText.split("\r\n", 1)[0] ?? "";
      const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})/i.exec(statusLine);
      const statusCode = statusMatch ? Number(statusMatch[1]) : 0;
      if (statusCode < 200 || statusCode >= 300) {
        const err = new Error(`HTTP proxy CONNECT failed (${statusCode || "invalid"})`) as NodeJS.ErrnoException;
        err.code = statusCode === 502 || statusCode === 503 ? "ECONNREFUSED" : "EHOSTUNREACH";
        return fail(err);
      }
      succeed(extra);
    };

    const host = target.host.replace(/^\[|\]$/g, "");
    const authority = host.includes(":") ? `[${host}]:${target.port}` : `${host}:${target.port}`;
    const headers = [
      `CONNECT ${authority} HTTP/1.1`,
      `Host: ${authority}`,
      "Proxy-Connection: keep-alive",
    ];
    if (proxy.username || proxy.password) {
      const token = Buffer.from(`${proxy.username ?? ""}:${proxy.password ?? ""}`, "utf8").toString("base64");
      headers.push(`Proxy-Authorization: Basic ${token}`);
    }
    headers.push("", "");

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.write(headers.join("\r\n"));
  });
}

function connectThroughEndpoint(proxy: ParsedProxyEndpoint, target: GateTarget, timeoutMs = CONNECT_TIMEOUT_MS): Promise<DialResult> {
  return proxy.protocol === "socks5"
    ? connectViaSocks5(proxy, target, timeoutMs)
    : connectViaHttpProxy(proxy, target, timeoutMs);
}

// --- Persistent Settings Store ---

export const doneBotBrowserProxySchema = z.object({
  mode: z.enum(["system", "manual", "direct"]),
  url: z.string().trim().max(512).default(""),
  bypass: z.string().trim().max(2048).default(""),
}).strict().superRefine((val, ctx) => {
  if (val.mode === "manual") {
    if (!val.url) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "手动代理模式下请填写代理地址（如 socks5://127.0.0.1:10808 或 http://127.0.0.1:10809）。" });
      return;
    }
    if (!parseProxyUrl(val.url)) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "代理地址格式无效，仅支持 socks5:// 或 http://（例如 socks5://127.0.0.1:10808）。" });
    }
  }
});

export class DoneBotBrowserProxyStore {
  private readonly filePath: string;
  private loaded = false;
  private value: DoneBotBrowserProxyConfig = { ...DEFAULT_DONEBOT_BROWSER_PROXY };

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = doneBotBrowserProxySchema.safeParse(JSON.parse(readFileSync(this.filePath, "utf8")));
      if (parsed.success) {
        this.value = parsed.data;
        return;
      }
      this.backupInvalidFile();
    } catch {
      this.backupInvalidFile();
    }
  }

  private backupInvalidFile(): void {
    try {
      renameSync(this.filePath, `${this.filePath}.invalid-${Date.now()}`);
    } catch {}
    console.warn("[donebot] Invalid browser proxy config was preserved in a backup; using defaults.");
  }

  get(): DoneBotBrowserProxyConfig {
    this.ensureLoaded();
    return { ...this.value };
  }

  save(input: DoneBotBrowserProxyConfig): DoneBotBrowserProxyConfig {
    const parsed = doneBotBrowserProxySchema.parse(input);
    this.loaded = true;
    this.value = { ...parsed };
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.filePath, JSON.stringify(this.value, null, 2), { mode: 0o600 });
    return { ...this.value };
  }
}

export interface DesktopProxyBridgeOptions {
  parentPort?: ProxyParentPort;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  readOsProxy?: (force?: boolean) => Promise<OsSystemProxySnapshot>;
  resolveElectronProxy?: (url: string) => Promise<string | null>;
  connectEndpoint?: (proxy: ParsedProxyEndpoint, target: GateTarget, timeoutMs?: number) => Promise<DialResult>;
}

/** Creates the desktop-only upstream proxy provider and live system proxy detector for DoneBot's browser egress gate. */
export function createDesktopBrowserProxyBridge(
  store: Pick<DoneBotBrowserProxyStore, "get">,
  options: DesktopProxyBridgeOptions = {},
) {
  const resolveElectron = options.resolveElectronProxy ?? createElectronProxyResolver(options.parentPort);
  const readOs = options.readOsProxy ?? createOsProxyReader(options.platform);
  const dial = options.connectEndpoint ?? connectThroughEndpoint;

  const resolveSystemCandidates = async (target: GateTarget, forceOsRefresh = false): Promise<ParsedProxyEndpoint[]> => {
    if (resolveElectron) {
      const scheme = target.port === 80 ? "http" : "https";
      const host = target.host.includes(":") ? `[${target.host}]` : target.host;
      const defaultPort = target.port === 80 || target.port === 443;
      const url = `${scheme}://${host}${defaultPort ? "" : `:${target.port}`}/`;
      const directive = await resolveElectron(url);
      if (directive !== null) {
        return parseChromiumProxyDirective(directive);
      }
    }
    const osSnapshot = await readOs(forceOsRefresh);
    const osCandidates = candidatesFromOsSnapshot(osSnapshot, target);
    if (osCandidates.length > 0) return osCandidates;
    return envSystemProxyCandidates(target.host, options.env);
  };

  const detectSystemProxy = async (): Promise<string | null> => {
    if (resolveElectron) {
      const directive = await resolveElectron(PROBE_URL);
      if (directive !== null) {
        const parsed = parseChromiumProxyDirective(directive);
        if (parsed.length > 0) return formatProxyEndpoint(parsed[0]!);
        return null;
      }
    }
    const osSnapshot = await readOs(true);
    const osCandidates = candidatesFromOsSnapshot(osSnapshot, { host: "www.google.com", port: 443 });
    if (osCandidates.length > 0) return formatProxyEndpoint(osCandidates[0]!);
    if (osSnapshot.pacUrl) return `PAC (${osSnapshot.pacUrl})`;
    const envCandidates = envSystemProxyCandidates("www.google.com", options.env);
    return envCandidates[0] ? formatProxyEndpoint(envCandidates[0]) : null;
  };

  const desktopUpstream = (_target: GateTarget, rules: EgressRules): GateUpstream | null => {
    const cfg = store.get();
    if (cfg.mode === "direct") return null;

    return {
      async open(openTarget): Promise<LinkOpened> {
        // Never allow proxied public hostnames to bounce into DoneBot's own listening ports.
        if (rules.ownPort(openTarget.port)) return { refused: "omb" };

        let candidates: ParsedProxyEndpoint[] = [];
        let fallbackToDirect = true;

        if (cfg.mode === "manual") {
          fallbackToDirect = false;
          const bypassRules = splitBypassList(cfg.bypass);
          if (bypassRules.length > 0 && matchesBypassRule(openTarget.host, bypassRules)) {
            return { gone: true };
          }
          const manual = parseProxyUrl(cfg.url);
          if (!manual) return { failed: "unreachable" };
          candidates = [manual];
        } else {
          candidates = await resolveSystemCandidates(openTarget);
          if (candidates.length === 0) return { gone: true };
        }

        // Never dial one of DoneBot's own ports as an upstream proxy (prevents loops into our own SOCKS gate / API).
        const safeCandidates = candidates.filter(ep => !rules.ownPort(ep.port));
        if (safeCandidates.length === 0) {
          return fallbackToDirect ? { gone: true } : { refused: "omb" };
        }

        let lastCode: string | undefined;
        for (const candidate of safeCandidates) {
          try {
            const { socket, extra } = await dial(candidate, openTarget, CONNECT_TIMEOUT_MS);
            return {
              join(client, early) {
                if (extra.length > 0) client.write(extra);
                for (const chunk of early ?? []) {
                  if (chunk.length > 0) socket.write(chunk);
                }
                socket.pipe(client);
                client.pipe(socket);
                socket.on("close", () => client.destroy());
                client.on("close", () => socket.destroy());
                socket.on("error", () => client.destroy());
              },
              cancel() {
                socket.destroy();
              },
            };
          } catch (err) {
            lastCode = (err as NodeJS.ErrnoException | undefined)?.code;
          }
        }

        if (fallbackToDirect) return { gone: true };
        return { failed: lastCode === "ECONNREFUSED" ? "refused" : "unreachable" };
      },
    };
  };

  return { desktopUpstream, detectSystemProxy };
}

export function createDoneBotBrowserProxyRoute(
  store: DoneBotBrowserProxyStore,
  detectSystemProxy: () => Promise<string | null>,
): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/donebot/browser-proxy") return PASS;
    if (!ownerOrAdmin(auth)) return json(res, 403, { error: "仅工作空间所有者或管理员可调整浏览器代理设置。" });
    res.setHeader("Cache-Control", "no-store");

    if (method === "GET") {
      const detectedSystemProxy = await detectSystemProxy().catch(() => null);
      return json(res, 200, { ...store.get(), detectedSystemProxy });
    }
    if (method === "PUT") {
      const body = await readBody(req, 16 * 1024);
      const parsed = doneBotBrowserProxySchema.safeParse(body);
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message ?? "代理配置无效，请检查代理地址格式。";
        return json(res, 400, { error: detail });
      }
      const saved = store.save(parsed.data);
      const detectedSystemProxy = await detectSystemProxy().catch(() => null);
      return json(res, 200, { ...saved, detectedSystemProxy });
    }
    return PASS;
  };
}
