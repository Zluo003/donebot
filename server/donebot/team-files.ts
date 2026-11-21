import { z } from "zod";
import { createTeamFiles, type TeamFilesActor } from "../host/team-files.ts";
import type { RequestAuth } from "../request-auth.ts";
import { teamRuntimeActor, type DoneBotTeamRuntime } from "./team-runtime.ts";

const bytes = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export function donebotTeamFileLimits(runtime: DoneBotTeamRuntime | null, env: NodeJS.ProcessEnv): { cap: number; uploadMax: number } | null {
  if (!runtime || env.DONEBOT_TEAM_FILES_ENABLED !== "1") return null;
  const cap = bytes.parse(env.DONEBOT_TEAM_SHARED_QUOTA_BYTES), uploadMax = bytes.parse(env.DONEBOT_TEAM_MAX_FILE_BYTES);
  if (uploadMax > cap) throw new Error("Team file limit exceeds the shared quota");
  return { cap, uploadMax };
}

export function createDoneBotTeamFiles(runtime: DoneBotTeamRuntime | null, dataDir: string, env: NodeJS.ProcessEnv) {
  const limits = donebotTeamFileLimits(runtime, env);
  const files = limits ? createTeamFiles({ dataDir, ...limits }) : null;
  const actor = (auth: RequestAuth): TeamFilesActor | null => {
    if (!files || !runtime || auth.kind !== "session") return null;
    const verified = teamRuntimeActor(runtime, auth.session);
    if (!verified) return null;
    return { person: verified.person, admin: auth.session.teamRole === "owner" || auth.session.teamRole === "admin" };
  };
  return { files, actor };
}
