import { randomBytes } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const mcpNpmCache = join(tmpdir(), `donebot-mcp-npm-${randomBytes(12).toString("hex")}`);

function inheritedNpmCache(env: NodeJS.ProcessEnv): string | undefined {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "npm_config_cache");
  if (key) return env[key] || undefined;
  if (process.platform === "win32") return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "npm-cache") : undefined;
  return env.HOME ? join(env.HOME, ".npm") : undefined;
}

export function writableCache(path: string): boolean {
  for (let at = join(path, "_cacache", "tmp"); ; at = dirname(at)) {
    try {
      accessSync(at, constants.W_OK);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(at) === at) return false;
    }
  }
}

export function mcpCommandEnvironment(base: NodeJS.ProcessEnv, serverEnv: Record<string, string>, canWrite = writableCache): NodeJS.ProcessEnv {
  const explicitCache = Object.keys(serverEnv).some((key) => key.toLowerCase() === "npm_config_cache");
  const inherited = inheritedNpmCache({ ...base, ...serverEnv });
  if (explicitCache || !inherited || canWrite(inherited)) return { ...base, ...serverEnv };
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "npm_config_cache") delete env[key];
  return { ...env, npm_config_cache: mcpNpmCache, ...serverEnv };
}
