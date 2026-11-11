export const mediaObject = (input: unknown): Record<string, unknown> | undefined =>
  input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;

export function mediaTaskId(id: unknown): string | undefined {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(id) ? id : undefined;
}
