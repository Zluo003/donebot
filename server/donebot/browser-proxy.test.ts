import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserEgress, OwnListeners } from "../browser/egress/registry.ts";
import { PASS } from "../routes/table.ts";
import {
  createDesktopBrowserProxyBridge,
  createDoneBotBrowserProxyRoute,
  createElectronProxyResolver,
  DoneBotBrowserProxyStore,
  matchesBypassRule,
  parseChromiumProxyDirective,
  parseProxyUrl,
  parseScutilProxyOutput,
  parseWindowsRegProxyOutput,
} from "./browser-proxy.ts";

const tempDirs: string[] = [];
const servers: Server[] = [];
const egressInstances: BrowserEgress[] = [];

function makeTempFile(name = "browser-proxy.json"): string {
  const dir = mkdtempSync(join(tmpdir(), "donebot-browser-proxy-"));
  tempDirs.push(dir);
  return join(dir, name);
}

function listenServer(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

afterEach(async () => {
  for (const eg of egressInstances.splice(0)) await eg.close();
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Opens a SOCKS5 client connection to `gatePort` requesting domain `targetHost:targetPort`, sends `payload`, reads reply. */
function socks5RoundTrip(gatePort: number, targetHost: string, targetPort: number, payload: string): Promise<{ rep: number; data: string }> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: "127.0.0.1", port: gatePort });
    let stage: "greet" | "connect" | "data" = "greet";
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("socks5 test timeout")); }, 5_000);
    const finish = (res: { rep: number; data: string }) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(res);
    };
    sock.on("error", err => { clearTimeout(timer); reject(err); });
    sock.on("connect", () => {
      sock.write(Buffer.from([5, 1, 0]));
    });
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === "greet") {
        if (buf.length < 2) return;
        buf = buf.subarray(2);
        stage = "connect";
        const hostBuf = Buffer.from(targetHost, "utf8");
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(targetPort, 0);
        sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, hostBuf.length]), hostBuf, portBuf]));
        return;
      }
      if (stage === "connect") {
        if (buf.length < 10) return;
        const rep = buf[1]!;
        const rest = buf.subarray(10);
        if (rep !== 0) return finish({ rep, data: "" });
        stage = "data";
        buf = rest;
        sock.write(payload);
        if (buf.length > 0) return finish({ rep: 0, data: buf.toString("utf8") });
        return;
      }
      if (stage === "data" && buf.length > 0) {
        finish({ rep: 0, data: buf.toString("utf8") });
      }
    });
  });
}

describe("DoneBot desktop browser proxy", () => {
  it("parses proxy URLs, Chromium resolveProxy directives, macOS scutil, Windows registry, and bypass rules", () => {
    expect(parseProxyUrl("socks5://127.0.0.1:10808")).toEqual({ protocol: "socks5", host: "127.0.0.1", port: 10808 });
    expect(parseProxyUrl("socks5h://127.0.0.1:10808")).toEqual({ protocol: "socks5", host: "127.0.0.1", port: 10808 });
    expect(parseProxyUrl("http://u:p%401@127.0.0.1:10809")).toEqual({ protocol: "http", host: "127.0.0.1", port: 10809, username: "u", password: "p@1" });
    expect(parseProxyUrl("ftp://127.0.0.1:21")).toBeNull();
    expect(parseProxyUrl("http://127.0.0.1:10809/path")).toBeNull();

    expect(parseChromiumProxyDirective("SOCKS5 127.0.0.1:10808; PROXY 127.0.0.1:10809; DIRECT")).toEqual([
      { protocol: "socks5", host: "127.0.0.1", port: 10808 },
      { protocol: "http", host: "127.0.0.1", port: 10809 },
    ]);
    expect(parseChromiumProxyDirective("DIRECT")).toEqual([]);

    const scutil = parseScutilProxyOutput(`
<dictionary> {
  ExceptionsList : <array> {
    0 : localhost
    1 : 127.0.0.0/8
    2 : *.cn
  }
  HTTPEnable : 1
  HTTPPort : 10809
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 10809
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 10808
  SOCKSProxy : 127.0.0.1
}`);
    expect(scutil.socks).toEqual({ protocol: "socks5", host: "127.0.0.1", port: 10808 });
    expect(scutil.https).toEqual({ protocol: "http", host: "127.0.0.1", port: 10809 });
    expect(scutil.exceptions).toEqual(["localhost", "127.0.0.0/8", "*.cn"]);

    const win = parseWindowsRegProxyOutput(`
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=127.0.0.1:10809;https=127.0.0.1:10809;socks=127.0.0.1:10808
    ProxyOverride    REG_SZ    localhost;127.*;<local>
`);
    expect(win.socks).toEqual({ protocol: "socks5", host: "127.0.0.1", port: 10808 });
    expect(win.https).toEqual({ protocol: "http", host: "127.0.0.1", port: 10809 });
    expect(win.exceptions).toEqual(["localhost", "127.*", "<local>"]);

    expect(matchesBypassRule("www.baidu.cn", ["*.cn"])).toBe(true);
    expect(matchesBypassRule("google.com", ["*.cn", "127.0.0.0/8"])).toBe(false);
    expect(matchesBypassRule("127.0.0.5", ["127.0.0.0/8"])).toBe(true);
    expect(matchesBypassRule("intranet", ["<local>"])).toBe(true);
  });

  it("chains desktop BrowserEgress through a local SOCKS5 VPN proxy with remote DNS (ATYP=3) while preserving ownPort & localhost guards", async () => {
    const seenTargets: Array<{ atyp: number; host: string; port: number }> = [];
    const fakeVpn = createServer((client: Socket) => {
      let stage: "greet" | "req" | "pipe" = "greet";
      let buf = Buffer.alloc(0);
      client.on("data", (chunk: Buffer) => {
        if (stage === "pipe") {
          client.write(`VPN-SOCKS5:${chunk.toString("utf8")}`);
          return;
        }
        buf = Buffer.concat([buf, chunk]);
        if (stage === "greet" && buf.length >= 3) {
          buf = buf.subarray(3);
          stage = "req";
          client.write(Buffer.from([5, 0]));
        }
        if (stage === "req" && buf.length >= 7) {
          const atyp = buf[3]!;
          const len = buf[4]!;
          if (buf.length < 7 + len) return;
          const host = buf.subarray(5, 5 + len).toString("utf8");
          const port = buf.readUInt16BE(5 + len);
          seenTargets.push({ atyp, host, port });
          const rest = buf.subarray(7 + len);
          stage = "pipe";
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (rest.length > 0) client.write(`VPN-SOCKS5:${rest.toString("utf8")}`);
        }
      });
    });
    const vpnPort = await listenServer(fakeVpn);

    const store = new DoneBotBrowserProxyStore(makeTempFile());
    const bridge = createDesktopBrowserProxyBridge(store, {
      readOsProxy: async () => ({
        socks: { protocol: "socks5", host: "127.0.0.1", port: vpnPort },
        exceptions: ["localhost", "127.0.0.0/8"],
      }),
    });

    const egress = new BrowserEgress();
    egressInstances.push(egress);
    const fakeOwnPorts = new Set([18899]);
    egress.configure({
      host: "desktop",
      config: () => undefined,
      // Simulate external v2rayN process: only DoneBot's own server/gate ports are in ownPort, not the test VPN port.
      listeners: {
        has: (port: number) => fakeOwnPorts.has(port),
        add: (port: number) => { fakeOwnPorts.add(port); },
      } as unknown as OwnListeners,
      resolve: async () => [], // Local DNS deliberately empty to prove remote DNS via SOCKS5 ATYP=3 works!
    });
    egress.setDesktopUpstream(bridge.desktopUpstream);

    const gatePort = await egress.open("bot-vpn-test");
    const res = await socks5RoundTrip(gatePort, "blocked.example.invalid", 443, "HELLO");
    expect(res).toEqual({ rep: 0, data: "VPN-SOCKS5:HELLO" });
    expect(seenTargets).toEqual([{ atyp: 3, host: "blocked.example.invalid", port: 443 }]);

    // DoneBot's own port (18899) must still be refused before dialing the upstream proxy!
    const ownPortBlocked = await socks5RoundTrip(gatePort, "blocked.example.invalid", 18899, "NOPE");
    expect(ownPortBlocked.rep).toBe(2); // NOT_ALLOWED
    expect(seenTargets).toHaveLength(1);
  });

  it("chains desktop BrowserEgress through a manual HTTP CONNECT proxy with Basic auth, blocks own-port proxy loops, and respects bypass rules", async () => {
    const seenHeaders: string[] = [];
    const fakeHttpProxy = createServer((client: Socket) => {
      let buf = Buffer.alloc(0);
      let established = false;
      client.on("data", (chunk: Buffer) => {
        if (established) {
          client.write(`VPN-HTTP:${chunk.toString("utf8")}`);
          return;
        }
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf("\r\n\r\n");
        if (end === -1) return;
        seenHeaders.push(buf.subarray(0, end).toString("utf8"));
        const rest = buf.subarray(end + 4);
        established = true;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length > 0) client.write(`VPN-HTTP:${rest.toString("utf8")}`);
      });
    });
    const proxyPort = await listenServer(fakeHttpProxy);

    const store = new DoneBotBrowserProxyStore(makeTempFile());
    store.save({
      mode: "manual",
      url: `http://alice:secret@127.0.0.1:${proxyPort}`,
      bypass: "*.cn",
    });
    const bridge = createDesktopBrowserProxyBridge(store, {
      readOsProxy: async () => ({ exceptions: [] }),
    });

    const egress = new BrowserEgress();
    egressInstances.push(egress);
    const fakeOwnPorts = new Set([18899]);
    egress.configure({
      host: "desktop",
      config: () => undefined,
      listeners: {
        has: (port: number) => fakeOwnPorts.has(port),
        add: (port: number) => { fakeOwnPorts.add(port); },
      } as unknown as OwnListeners,
      resolve: async () => [],
    });
    egress.setDesktopUpstream(bridge.desktopUpstream);

    const gatePort = await egress.open("bot-http-proxy-test");
    const res = await socks5RoundTrip(gatePort, "youtube.invalid", 443, "PING");
    expect(res).toEqual({ rep: 0, data: "VPN-HTTP:PING" });
    expect(seenHeaders[0]).toContain("CONNECT youtube.invalid:443 HTTP/1.1");
    expect(seenHeaders[0]).toContain(`Proxy-Authorization: Basic ${Buffer.from("alice:secret").toString("base64")}`);

    // Bypassed *.cn host skips manual proxy and attempts direct (returns HOST_UNREACHABLE since test resolver is empty).
    const bypassed = await socks5RoundTrip(gatePort, "example.cn", 443, "DIRECT");
    expect(bypassed.rep).toBe(4); // HOST_UNREACHABLE from direct path
    expect(seenHeaders).toHaveLength(1);

    // Configuring DoneBot's own port (18899) as the manual proxy is refused to prevent loopback proxy loops.
    store.save({ mode: "manual", url: "http://127.0.0.1:18899", bypass: "" });
    const selfLoopRefused = await socks5RoundTrip(gatePort, "youtube.invalid", 443, "LOOP");
    expect(selfLoopRefused.rep).toBe(2); // NOT_ALLOWED
  });

  it("resolves proxy via Electron parentPort IPC (supporting PAC) and persists route updates with ownerOrAdmin auth", async () => {
    const listeners: Array<(event: { data?: unknown }) => void> = [];
    const fakeParentPort = {
      on(_event: "message", fn: (event: { data?: unknown }) => void) { listeners.push(fn); },
      postMessage(msg: { type?: string; id?: string; url?: string }) {
        if (msg.type === "donebot:resolve-proxy" && msg.id) {
          const proxy = msg.url?.includes("google.com") ? "SOCKS5 127.0.0.1:10808; DIRECT" : "DIRECT";
          for (const fn of listeners) fn({ data: { type: "donebot:resolve-proxy-result", id: msg.id, proxy } });
        }
      },
    };

    const resolveElectron = createElectronProxyResolver(fakeParentPort)!;
    expect(await resolveElectron("https://www.google.com/")).toBe("SOCKS5 127.0.0.1:10808; DIRECT");
    expect(await resolveElectron("https://example.cn/")).toBe("DIRECT");

    const file = makeTempFile();
    const store = new DoneBotBrowserProxyStore(file);
    const bridge = createDesktopBrowserProxyBridge(store, { parentPort: fakeParentPort });
    const route = createDoneBotBrowserProxyRoute(store, bridge.detectSystemProxy);

    const invoke = async (method: string, path: string, auth: unknown, body?: unknown) => {
      let status = 0;
      let payload: unknown;
      const result = await route({
        req: {} as IncomingMessage,
        res: { setHeader() {} } as unknown as ServerResponse,
        path,
        method,
        auth: auth as never,
        url: new URL(`http://127.0.0.1${path}`),
        json: (_r: unknown, code: number, data: unknown) => { status = code; payload = data; },
        readBody: async () => body ?? {},
      } as never);
      return { passed: result === PASS, status, payload };
    };

    const ownerAuth = { kind: "loopback", scopes: ["admin", "client"] };
    expect((await invoke("GET", "/api/donebot/browser-proxy", { kind: "session", scopes: ["client"] })).status).toBe(403);

    const initial = await invoke("GET", "/api/donebot/browser-proxy", ownerAuth);
    expect(initial.status).toBe(200);
    expect(initial.payload).toEqual({
      mode: "system",
      url: "",
      bypass: "",
      detectedSystemProxy: "socks5://127.0.0.1:10808",
    });

    const invalid = await invoke("PUT", "/api/donebot/browser-proxy", ownerAuth, { mode: "manual", url: "bad-url", bypass: "" });
    expect(invalid.status).toBe(400);

    const updated = await invoke("PUT", "/api/donebot/browser-proxy", ownerAuth, {
      mode: "manual",
      url: "socks5://127.0.0.1:10808",
      bypass: "*.cn",
    });
    expect(updated.status).toBe(200);
    expect(new DoneBotBrowserProxyStore(file).get()).toEqual({
      mode: "manual",
      url: "socks5://127.0.0.1:10808",
      bypass: "*.cn",
    });

    writeFileSync(file, "{corrupt", "utf8");
    expect(new DoneBotBrowserProxyStore(file).get()).toEqual({ mode: "system", url: "", bypass: "" });
  });
});
