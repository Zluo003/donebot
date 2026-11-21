import { describe, expect, it, vi } from "vitest";
import { readTeamFilePreview, TEAM_PICTURE_PREVIEW_MAX, TEAM_TEXT_PREVIEW_MAX } from "./preview";

describe("bounded team file previews", () => {
  it.each(["text", "picture"] as const)("accepts %s up to its byte limit", async kind => {
    const max = kind === "text" ? TEAM_TEXT_PREVIEW_MAX : TEAM_PICTURE_PREVIEW_MAX;
    const response = new Response(new Uint8Array(max), { headers: { "content-length": String(max), "content-type": "image/png" } });
    const result = await readTeamFilePreview(response, kind);
    expect("blob" in result && result.blob.size).toBe(max);
    expect("blob" in result && result.blob.type).toBe(kind === "text" ? "text/plain" : "image/png");
  });

  it("cancels a declared oversized body before reading", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers: { "content-length": String(TEAM_TEXT_PREVIEW_MAX + 1) } });
    expect(await readTeamFilePreview(response, "text")).toEqual({ tooLarge: true });
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it.each([undefined, "10", "invalid"])("limits actual bytes with content-length %s", async length => {
    const cancel = vi.fn();
    let chunks = 0;
    const response = new Response(new ReadableStream({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(512 * 1024)); }, cancel,
    }), { headers: length ? { "content-length": length } : {} });
    expect(await readTeamFilePreview(response, "text")).toEqual({ tooLarge: true });
    expect(chunks).toBeLessThanOrEqual(4);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("rejects a truncated stream", async () => {
    await expect(readTeamFilePreview(new Response("short", { headers: { "content-length": "100" } }), "text")).rejects.toThrow("Incomplete preview");
  });

  it("bounds decoded bytes without comparing compressed content length", async () => {
    const result = await readTeamFilePreview(new Response("decoded", { headers: { "content-length": "2", "content-encoding": "gzip" } }), "text");
    expect("blob" in result && await result.blob.text()).toBe("decoded");
  });

  it("propagates an aborted body and releases the reader", async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.error(new DOMException("Stopped", "AbortError")); } }));
    await expect(readTeamFilePreview(response, "text")).rejects.toMatchObject({ name: "AbortError" });
    expect(response.body?.locked).toBe(false);
  });
});
