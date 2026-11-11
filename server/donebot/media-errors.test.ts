import { describe, expect, it } from "vitest";
import { gatewayMediaDiagnostic, gatewayMediaError, mediaFailureDetail } from "./media-errors.ts";

describe("safe media diagnostics", () => {
  it.each([
    ["No eligible APIMart accounts", "No eligible APIMart account"],
    ["APIMart model has no configured local price for this tier", "no local price configured"],
    ["APIMart settlement queue is unavailable", "settlement queue is unavailable"],
    ["Task storage is unavailable", "task storage is unavailable"],
    ["Accepted task synthetic-task could not be persisted; do not resubmit", "could not persist an accepted task"],
  ])("retains the fixed gateway reason for %s", (message, expected) => {
    const result = gatewayMediaError({ error: { type: "api_error", message } }, 503);
    expect(result).toContain("HTTP 503 (api_error)");
    expect(result).toContain(expected);
    expect(result).not.toContain("synthetic-task");
  });

  it("reads standard gateway envelopes and ignores message metadata", () => {
    expect(gatewayMediaError({ code: 503, reason: "DONEBOT_MEDIA_PREPAID_UNAVAILABLE", metadata: { token: "secret" } }, 503))
      .toBe("Gateway returned HTTP 503 (DONEBOT_MEDIA_PREPAID_UNAVAILABLE). Durable media prepayment is unavailable.");
  });

  it("preserves specific native task errors, status, code and request identity", () => {
    expect(gatewayMediaDiagnostic({ status: "uncertain", http_status: 502,
      error: { code: "dispatch_unknown", type: "upstream_error", request_id: "req-provider-123", message: "Connection closed after dispatch; the provider did not confirm a result." } }, 200))
      .toEqual({ http_status: 502, code: "dispatch_unknown", type: "upstream_error", request_id: "req-provider-123",
        message: "Connection closed after dispatch; the provider did not confirm a result." });
    expect(gatewayMediaDiagnostic({ data: { status: "failed", error: { code: "invalid_size", message: "Image size 4096x4096 is unsupported; choose 1024x1024." } } }))
      .toEqual({ code: "invalid_size", message: "Image size 4096x4096 is unsupported; choose 1024x1024." });
  });

  it("accepts the receipt diagnostic contract and request headers without keeping unrelated fields", () => {
    expect(gatewayMediaDiagnostic({ diagnostic: { http_status: 429, code: "provider_capacity", message: "No image workers are available; retry later.",
      raw: "never retained", url: "https://provider.invalid/private" } }, 200, new Headers({ "x-request-id": "req-gateway-42" })))
      .toEqual({ http_status: 429, code: "provider_capacity", request_id: "req-gateway-42", message: "No image workers are available; retry later." });
  });

  it("redacts credentials, supplier URLs, request contents and unsafe identities while retaining the reason", () => {
    const result = gatewayMediaDiagnostic({ http_status: 502, error: { code: "sk-test-private", type: "api_error", request_id: "https://private.invalid/?token=private",
      message: "The provider returned no image. Contact owner@example.invalid; file /Users/fixture/private/ref.png C:\\Users\\fixture\\ref.png. POST https://user:password@host.invalid/v1?token=private api_key=shortsecret Bearer tinytoken sk-shortkey prompt: private request text" },
      body: "raw response that must not be retained" });
    expect(result).toMatchObject({ http_status: 502, type: "api_error", message: expect.stringContaining("The provider returned no image.") });
    expect(result?.code).toBeUndefined(); expect(result?.request_id).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/owner@|example\.invalid|Users|fixture|host\.invalid|private\.invalid|password@|shortsecret|tinytoken|sk-shortkey|private request text|raw response/);
  });

  it.each(['"api_key":"tiny"', '"token": "abc"', "'password': 'xyz'", "Authorization: Bearer abc"])("redacts short quoted or header credentials in an error excerpt: %s", secret => {
    const result = gatewayMediaDiagnostic({ error: { message: `Provider rejected the image request; ${secret}.` } }, 502);
    expect(result?.message).toContain("Provider rejected the image request");
    expect(result?.message).not.toMatch(/tiny|abc|xyz|Bearer/);
    expect(result?.message).toContain("[redacted credential]");
  });

  it.each(["authorization", "api_key", "api-key", "api key", "key", "access_token", "access-token", "refresh token", "token", "secret", "secret_access_key", "secret-access-key", "password", "passwd", "client_secret", "client-secret"])("redacts the gateway credential label %s with short quoted and unquoted values", label => {
    for (const assignment of [`${label}=tiny`, `"${label}":"tiny"`, `'${label}': 'tiny'`]) {
      const result = gatewayMediaDiagnostic({ error: { message: `Provider rejected the image request; ${assignment}.` } });
      expect(result?.message).toContain("Provider rejected the image request");
      expect(result?.message).not.toContain("tiny");
    }
  });

  it.each(["prompt", "input", "messages", "request_body", "response body", "payload"])("omits echoed %s content from diagnostic messages", label => {
    expect(gatewayMediaDiagnostic({ error: { message: `Provider rejected the image request; "${label}": "private contents"` } })?.message)
      .toBe("Provider rejected the image request; [redacted request content]");
  });

  it.each(["AIzaPrivate", "AKIAPrivate", "eyJPrivate", "data:image/png;base64,private-image"])("redacts the gateway credential or data prefix %s", sensitive => {
    const result = gatewayMediaDiagnostic({ error: { message: `Provider rejected the image request; ${sensitive}` } });
    expect(result?.message).toContain("Provider rejected the image request");
    expect(result?.message).not.toContain(sensitive);
  });

  it("removes complete URLs and paths before credential redaction can split them", () => {
    expect(gatewayMediaDiagnostic({ error: { message: "Provider unavailable at https://vendor.invalid/path?api_key=secret." } })?.message)
      .toBe("Provider unavailable at [redacted URL]");
    expect(gatewayMediaDiagnostic({ error: { message: "Connection failure for owner@example.invalid at /Users/fixture/private/image.png." } })?.message)
      .toBe("Connection failure for [redacted email] at [redacted path]");
  });

  it.each(["<html>credential=private</html>", "x".repeat(8193), ""])("drops unreadable or excessive messages but retains status and code", message => {
    expect(gatewayMediaDiagnostic({ error: { code: "provider_error", message } }, 502)).toEqual({ code: "provider_error", http_status: 502 });
  });

  it("preserves plain error messages without copying whole response objects", () => {
    expect(gatewayMediaError({ error: "The selected image model is temporarily unavailable.", internal: "private" }, 503))
      .toBe("Gateway returned HTTP 503. The selected image model is temporarily unavailable.");
    const result = gatewayMediaDiagnostic({ error: { message: 'Provider rejected request: {"headers":{"authorization":"private"},"body":"private"}' } });
    expect(result?.message).toBe("Provider rejected request: [redacted response details]");
  });

  it("does not retain an invalid status value", () => {
    expect(gatewayMediaError({}, NaN)).toBe("Gateway returned HTTP 502.");
  });

  it.each([
    [new Error("Media artifact host is not public."), "Media artifact host is not public."],
    [new Error("Media artifact host returned HTTP 403."), "Media artifact download returned HTTP 403."],
    [new Error("Media artifact has an unsupported content type."), "Media artifact has an unsupported content type."],
    [new Error("Media artifact download was incomplete."), "Media artifact download was incomplete."],
    [Object.assign(new Error("private host"), { code: "ENOTFOUND" }), "The media host could not be resolved by DNS."],
    [new Error("fetch failed https://private.invalid", { cause: { code: "ECONNRESET", message: "private token" } }), "The media network connection failed."],
    [Object.assign(new Error("private URL"), { name: "TimeoutError" }), "The media network request timed out."],
    [Object.assign(new Error("private certificate"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }), "The media host TLS certificate could not be verified."],
  ])("classifies client failures without host or credential details", (error, expected) => {
    expect(mediaFailureDetail(error)).toBe(expected);
  });

  it.each([new Error("token private"), "private prompt", { code: "private-key", message: "Media artifact host returned HTTP 403. secret" }])("drops arbitrary client exceptions", error => {
    expect(mediaFailureDetail(error)).toBe("Media processing failed without a safe diagnostic detail.");
  });
});
