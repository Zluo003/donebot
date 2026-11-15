import { createServer, request, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { json } from "../harness/http.ts";
import { finishStartedResponse } from "./http-failure.ts";

afterEach(() => vi.restoreAllMocks());

it("leaves an unsent error available for its normal JSON response", () => {
  const res = { headersSent: false, writableEnded: false, destroyed: false } as ServerResponse;
  expect(finishStartedResponse(res, "GET", "/api/bots", new Error("unavailable"))).toBe(false);
});

it("contains failures after streaming, completion, and disconnect without killing the HTTP server", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let failed!: () => void;
  const failures: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      if (req.url?.startsWith("/api/file/")) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("partial");
        await new Promise<void>(resolve => { failed = resolve; });
        throw Object.assign(new Error("secret-message"), { code: "ERR_STREAM_PREMATURE_CLOSE" });
      }
      if (req.url === "/complete") { res.end("complete"); throw new Error("after completion"); }
      json(res, 200, { ok: true });
    } catch (error) {
      if (finishStartedResponse(res, req.method!, new URL(req.url!, "http://fixture").pathname, error)) {
        failures.push(req.url!);
      } else json(res, 500, { error: "failure" });
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const cancel of [false, true]) {
      await new Promise<void>((resolve, reject) => {
        const sent = request(origin + "/api/file/private-token-12345678901234567890?token=secret-query", res => {
          res.once("data", () => { if (cancel) res.destroy(); failed(); });
          res.on("error", () => {});
          res.once("close", resolve);
        });
        sent.on("error", reject); sent.end();
      });
    }
    expect(await (await fetch(origin + "/complete")).text()).toBe("complete");
    await vi.waitFor(() => expect(failures).toHaveLength(3));
    expect(await (await fetch(origin + "/health")).json()).toEqual({ ok: true });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret|private-token/);
    expect(warn.mock.calls[0]).toEqual(["HTTP response interrupted", "GET", "/api/file/:id", "ERR_STREAM_PREMATURE_CLOSE"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
