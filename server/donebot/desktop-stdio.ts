import { createInterface } from "node:readline";
import { boundedResponseText } from "./bounded-response.ts";

const url = process.env.DONEBOT_DESKTOP_RPC_URL ?? "", token = process.env.DONEBOT_DESKTOP_RPC_TOKEN ?? "";
if (!/^http:\/\/127\.0\.0\.1:\d+\/rpc$/.test(url) || !/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid Cloud desktop bridge");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw new Error("Cloud desktop request too large");
  const response = await fetch(url, { method: "POST", redirect: "error", credentials: "omit", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: line, signal: AbortSignal.timeout(335000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error("Cloud desktop request interrupted; check the result before retrying"); }
  const result = await boundedResponseText(response, 20 * 1024 * 1024);
  if (result !== "null") process.stdout.write(result + "\n");
}
