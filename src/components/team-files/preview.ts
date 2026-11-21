export const TEAM_TEXT_PREVIEW_MAX = 1024 ** 2;
export const TEAM_PICTURE_PREVIEW_MAX = 8 * 1024 ** 2;

export async function readTeamFilePreview(response: Response, kind: "text" | "picture"): Promise<{ tooLarge: true } | { blob: Blob }> {
  const max = kind === "text" ? TEAM_TEXT_PREVIEW_MAX : TEAM_PICTURE_PREVIEW_MAX;
  const length = response.headers.get("content-length");
  const declared = length && /^\d+$/.test(length) && !response.headers.has("content-encoding") ? Number(length) : null;
  if (declared !== null && declared > max) { await response.body?.cancel(); return { tooLarge: true }; }
  if (!response.body) return { blob: new Blob([]) };
  const reader = response.body.getReader(), chunks: BlobPart[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        if (declared !== null && declared !== size) throw new Error("Incomplete preview");
        return { blob: new Blob(chunks, { type: kind === "text" ? "text/plain" : response.headers.get("content-type") ?? "application/octet-stream" }) };
      }
      size += value.byteLength;
      if (size > max) { await reader.cancel(); return { tooLarge: true }; }
      chunks.push(new Uint8Array(value).buffer);
    }
  } finally { reader.releaseLock(); }
}
