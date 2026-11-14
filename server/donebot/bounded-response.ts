export async function boundedResponseText(response: Response, limit: number): Promise<string> {
  if (!response.body) throw new Error("Empty Cloud response");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) throw new Error("Cloud response too large");
      chunks.push(item.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => {}); }
}
