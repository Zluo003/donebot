import { z } from "zod";
import { redactSecretsInText } from "../../shared/redact.ts";

export const mediaDiagnosticSchema = z.object({
  http_status: z.number().int().min(100).max(599).optional(),
  code: z.string().max(96).optional(), type: z.string().max(96).optional(),
  request_id: z.string().max(256).optional(), message: z.string().max(600).optional(),
});
export type MediaDiagnostic = z.infer<typeof mediaDiagnosticSchema>;

const GATEWAY_CODES: Readonly<Record<string, string>> = {
  DONEBOT_GROUP_UNAVAILABLE: "The DoneBot model group is unavailable.",
  DONEBOT_MEDIA_UNAVAILABLE: "Durable media recovery is unavailable.",
  DONEBOT_MEDIA_PREPAID_UNAVAILABLE: "Durable media prepayment is unavailable.",
  DONEBOT_MEDIA_CONCURRENCY: "The account media concurrency limit has been reached.",
  DONEBOT_MEDIA_NOT_FOUND: "This media operation was not found.",
  DONEBOT_MEDIA_IDEMPOTENCY_CONFLICT: "The operation identity belongs to a different media request.",
  DONEBOT_MEDIA_IN_PROGRESS: "This submission may already have reached the provider; check its receipt.",
  DONEBOT_MEDIA_INVALID: "The gateway rejected the media parameters or model interface.",
  DONEBOT_MEDIA_BODY_INVALID: "The gateway could not read the media request.",
  DONEBOT_MEDIA_NATIVE_PATH_REQUIRED: "The gateway requires a native media interface under /v1.",
  DONEBOT_IDEMPOTENCY_KEY_REQUIRED: "The gateway requires a valid operation identity.",
  DONEBOT_CATALOG_CURRENCY: "The gateway catalog currency configuration is invalid.",
  DONEBOT_CATALOG_CAPABILITIES: "The gateway model capability configuration is invalid.",
  DONEBOT_INSTALL_NOT_FOUND: "The DoneBot installation was not found.",
  DONEBOT_INSTALL_INACTIVE: "The DoneBot installation is inactive.",
  DONEBOT_USER_INACTIVE: "The DoneBot user account is inactive.",
};

const GATEWAY_MESSAGES = new Map([
  ["APIMart settlement queue is unavailable", "The APIMart settlement queue is unavailable."],
  ["Task storage is unavailable", "Gateway task storage is unavailable."],
  ["No eligible APIMart accounts", "No eligible APIMart account is available for this model."],
  ["APIMart model has no configured local price for this tier", "The APIMart model has no local price configured for this tier."],
  ["APIMart tariff is unavailable", "The APIMart tariff is unavailable."],
  ["Async generation requires available inflight billing storage", "Gateway inflight billing storage is unavailable."],
  ["Task billing is unavailable", "Gateway task billing is unavailable."],
  ["Task settlement is in progress; retry task lookup", "Gateway task settlement is in progress; retry the existing task lookup."],
  ["Failed to record APIMart usage; retry task lookup", "Gateway usage recording is unavailable; retry the existing task lookup."],
  ["Generated media storage is temporarily unavailable; retry task lookup", "Generated media storage is unavailable; retry the existing task lookup."],
  ["APIMart requires application/json", "The APIMart interface requires application/json."],
  ["Model is not available for this group", "This model is unavailable for the account model group."],
  ["APIMart is not available for this platform", "The account platform does not provide APIMart."],
  ["Invalid API key", "The gateway rejected the installation credential."],
]);

const CLIENT_MESSAGES = new Set([
  "Media artifact must use public HTTPS.",
  "Media artifact host is not public.",
  "Media artifact has an unsupported content type.",
  "Media artifact exceeds the local size limit.",
  "Media artifact directory is not private.",
  "Media artifact download was incomplete.",
  "Media artifact escaped its private directory.",
  "Media task returned no usable artifacts.",
  "Media task returned no downloadable artifact.",
  "Gateway returned unsupported inline image bytes.",
  "Invalid image bytes.",
  "Media gateway response exceeded the local limit.",
  "Media gateway returned invalid JSON.",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function mediaDiagnosticIdentifier(value: unknown, max = 256): string | undefined {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === "string" && text.length <= max && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(text) &&
    !/^(?:sk-|rk_|xai-|gsk_|csk-|hf_|gh[pousr]_|github_pat_|xox[baprs]-|AIza|AKIA|eyJ)/i.test(text) &&
    redactSecretsInText(text) === text ? text : undefined;
}

function safeMediaMessage(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.length > 8192 || /<!doctype|<html|<body|<script/i.test(value)) return undefined;
  const known = GATEWAY_MESSAGES.get(value);
  if (known) return known;
  if (/^Accepted task [A-Za-z0-9_-]{1,256} could not be (?:bound|queued|persisted); do not resubmit$/.test(value)) {
    return "The gateway could not persist an accepted task; check its receipt and do not resubmit.";
  }
  const message = redactSecretsInText(value.replace(/\\\//g, "/")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+|\bhttps?%3a%2f%2f[^\s<>"'`]+|(?:^|\s)\/\/[^\s<>"'`]+|\bdata:[^\s<>"'`]+/gi, "[redacted URL]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}/gi, "[redacted email]")
    .replace(/\b[A-Z]:\\[^\s<>"'`]+/gi, "[redacted path]")
    .replace(/(^|[\s"'(])(?:~\/|\/)[^\s<>"'`]+/g, "$1[redacted path]")
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,63}(?::\d{1,5})?(?:\/[^\s<>"'`]*)?/gi, "[redacted host]")
    .replace(/\b(?:authorization|api[_ -]?key|key|access[_ -]?token|refresh[_ -]?token|token|secret(?:[_ -]?access[_ -]?key)?|password|passwd|client[_ -]?secret)["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|(?:Bearer|Basic)\s+[^\s,;]+|[^\s,;]+)/gi, "[redacted credential]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[redacted credential]")
    .replace(/\b(?:(?:sk-|rk_|xai-|gsk_|csk-|hf_|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]*|AKIA[A-Za-z0-9_-]*|eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*)/gi, "[redacted credential]")
    .replace(/["']?\b(?:prompt|input|messages|request[_ -]?body|response[_ -]?body|payload)["']?\s*[=:][\s\S]*/gi, "[redacted request content]")
    .replace(/(?:\{|\[)\s*(?:"|'|\{|\[)[\s\S]*$/, "[redacted response details]"))
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ").trim();
  return message ? message.slice(0, 600) : undefined;
}

export function gatewayMediaDiagnostic(body: unknown, status?: number, headers?: Headers): MediaDiagnostic | undefined {
  const root = record(body), data = record(root?.data), diagnostic = record(root?.diagnostic) ?? record(data?.diagnostic);
  const error = record(root?.error) ?? record(data?.error);
  const sources = [diagnostic, error, root, data];
  const identifier = (name: string, max?: number) => sources.map(source => mediaDiagnosticIdentifier(source?.[name], max)).find(Boolean);
  const http = [...sources.map(source => source?.http_status), diagnostic?.status, error?.status, status !== undefined && status >= 400 ? status : undefined]
    .find((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599);
  const code = mediaDiagnosticIdentifier(diagnostic?.code, 96) ?? mediaDiagnosticIdentifier(error?.code, 96) ?? identifier("reason", 96) ?? identifier("code", 96), type = identifier("type", 96);
  const requestID = identifier("request_id") ?? mediaDiagnosticIdentifier(headers?.get("x-request-id") ?? headers?.get("request-id"));
  const message = [...sources.map(source => safeMediaMessage(source?.message)), safeMediaMessage(root?.error), safeMediaMessage(data?.error)].find(Boolean) ?? (code ? GATEWAY_CODES[code] : undefined);
  const result: MediaDiagnostic = {
    ...(typeof http === "number" && Number.isInteger(http) && http >= 100 && http <= 599 ? { http_status: http } : {}),
    ...(code ? { code } : {}), ...(type ? { type } : {}), ...(requestID ? { request_id: requestID } : {}), ...(message ? { message } : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

export function mediaDiagnosticText(diagnostic: MediaDiagnostic | undefined): string {
  if (!diagnostic) return "";
  const fields = [diagnostic.http_status ? `HTTP ${diagnostic.http_status}` : "", diagnostic.code ?? diagnostic.type,
    diagnostic.request_id ? `Request ID: ${diagnostic.request_id}` : ""].filter(Boolean);
  return `${fields.length ? `${fields.join("; ")}.` : ""}${diagnostic.message ? ` ${diagnostic.message}` : ""}`.trim();
}

export function gatewayMediaError(body: unknown, status: number): string {
  const diagnostic = gatewayMediaDiagnostic(body, status);
  const http = diagnostic?.http_status ?? 502, code = diagnostic?.code ?? diagnostic?.type;
  return `Gateway returned HTTP ${http}${code ? ` (${code})` : ""}.${diagnostic?.message ? ` ${diagnostic.message}` : ""}${diagnostic?.request_id ? ` Request ID: ${diagnostic.request_id}.` : ""}`;
}

export function mediaFailureDetail(error: unknown): string {
  let current = record(error);
  for (let depth = 0; current && depth < 5; depth++, current = record(current.cause)) {
    const message = current.message;
    if (typeof message === "string") {
      if (CLIENT_MESSAGES.has(message)) return message;
      const hostStatus = /^Media artifact host returned HTTP ([1-5][0-9]{2})\.$/.exec(message);
      const downloadStatus = /^Media artifact download failed \(HTTP ([1-5][0-9]{2})\)\.$/.exec(message);
      const status = hostStatus?.[1] ?? downloadStatus?.[1];
      if (status) return `Media artifact download returned HTTP ${status}.`;
    }
    const code = current.code;
    if (["ENOTFOUND", "EAI_AGAIN", "ENODATA"].includes(String(code))) return "The media host could not be resolved by DNS.";
    if (["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(String(code)) || current.name === "TimeoutError") return "The media network request timed out.";
    if (["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH", "EPIPE", "UND_ERR_SOCKET"].includes(String(code))) return "The media network connection failed.";
    if (["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(String(code))) return "The media host TLS certificate could not be verified.";
    if (code === "ERR_INVALID_URL") return "The gateway returned an invalid media URL.";
    if (current.name === "AbortError") return "The media network request was interrupted.";
  }
  return "Media processing failed without a safe diagnostic detail.";
}
