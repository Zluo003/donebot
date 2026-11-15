import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function installDoneBotCloudFrontend({ session, directory, origins }) {
  const files = new Map();
  function collect(dir, prefix = "") {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) collect(join(dir, entry.name), name);
      else if (entry.isFile()) files.set(name, pathToFileURL(join(dir, entry.name)).href);
    }
  }
  if (!statSync(join(directory, "index.html"), { throwIfNoEntry: false })?.isFile()) throw new Error("客户端界面文件缺失，请重新安装 DoneBot。");
  collect(directory);
  session.protocol.handle("https", async request => {
    const url = new URL(request.url);
    const cloud = origins().includes(url.origin);
    if (cloud && (request.method === "GET" || request.method === "HEAD")) {
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = files.get(path);
      if (file) {
        const response = await session.fetch(file, { bypassCustomProtocolHandlers: true, signal: request.signal });
        const headers = new Headers(response.headers);
        headers.set("cache-control", "no-store");
        headers.set("x-donebot-frontend", "desktop");
        headers.set("x-content-type-options", "nosniff");
        if (path.endsWith(".html")) {
          headers.set("content-security-policy", "frame-ancestors 'none'");
          headers.set("x-frame-options", "DENY");
          headers.set("referrer-policy", "same-origin");
        }
        return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers });
      }
      if (path.startsWith("/assets/")) return new Response("Client asset unavailable", { status: 404 });
    }
    const headers = new Headers(request.headers);
    if (cloud && !headers.has("origin") && request.referrer) {
      // Electron 43 protocol handlers run before Chromium adds Origin; only a verified same-origin referrer may supply it.
      if (new URL(request.referrer).origin === url.origin) headers.set("origin", url.origin);
    }
    // Electron's native fetch re-enters protocol handlers unless explicitly bypassed.
    return session.fetch(request, { headers, bypassCustomProtocolHandlers: true });
  });
  return () => session.protocol.unhandle("https");
}
