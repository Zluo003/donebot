import { runMcpBridge } from "../mcp-bridge.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";

const url = process.env.DONEBOT_CONTROL_URL, token = process.env.DONEBOT_CONTROL_TOKEN;
if (!url || !token) throw new Error("Cloud desktop control gate required");
runMcpBridge({ command: process.execPath, args: [SPAWNED_PROXIES.donebotDesktopStdio], label: "DoneBot Cloud desktop", gate: { url, token } });
