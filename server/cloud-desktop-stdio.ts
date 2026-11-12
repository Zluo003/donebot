import { request } from "node:http";
import { cloudDesktopSocket } from "./cloud-desktop.ts";

const socketPath = cloudDesktopSocket();
if (!socketPath) throw new Error("Cloud desktop is disabled.");
const req = request({ socketPath, path: "/mcp", agent: false, headers: { connection: "Upgrade", upgrade: "donebot-mcp" }, timeout: 10_000 });
req.on("upgrade", (_res, socket, head) => {
  req.setTimeout(0);
  if (head.length) process.stdout.write(head);
  process.stdin.pipe(socket); socket.pipe(process.stdout);
  socket.on("error", () => { process.exitCode = 1; process.stdin.destroy(); });
  socket.on("close", () => { process.stdin.destroy(); });
  process.stdin.on("end", () => socket.end());
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => socket.destroy());
});
req.on("response", res => { res.resume(); process.stderr.write("Cloud desktop MCP access refused\n"); process.exitCode = 1; });
req.on("error", () => { process.stderr.write("Cloud desktop MCP disconnected\n"); process.exitCode = 1; });
req.on("timeout", () => req.destroy(new Error("Cloud desktop MCP timeout")));
req.end();
