import { hasTeamAuthority, isSystemCoordinator, peerAllowed } from "../peer-roster.ts"; import { chiefLevel } from "../chief-level.ts";
import type { BotRecord } from "../store.ts";
import { libraryTeamRoles } from "../team-library.ts";
import { PASS, type RouteHandler } from "./table.ts";

interface CatalogInstance {
  instanceId: string;
  driverKind: string;
  displayName: string;
  snapshot: { state: string };
  models: unknown;
  capabilities?: { effortLevels?: readonly string[] };
}

const NOT_CHIEF = "Only an active Chief may plan team setup";

/** Only dispatch inside the internal capability gate. What a Chief of Staff reads before it changes its team. */
export function createInternalChiefTeamRoutes(deps: {
  /** The calling bot as stored now; read again after every wait. */
  bot(): BotRecord | null;
  requireActive(): void;
  teams(): string[];
  bots(): readonly BotRecord[];
  instances(): Promise<readonly CatalogInstance[]>;
  library?: typeof libraryTeamRoles;
}): RouteHandler {
  const chief = () => {
    const bot = deps.bot();
    return chiefLevel(bot) && !bot!.hidden ? bot : null;
  };
  return async ({ res, path, method, json }) => {
    if (method !== "GET" || (path !== "/api/internal/team-setup-catalog" && path !== "/api/internal/team-library")) return PASS;
    if (!chief()) return json(res, 403, { error: NOT_CHIEF });
    if (path === "/api/internal/team-library") {
      let teams: Awaited<ReturnType<typeof libraryTeamRoles>>;
      try {
        teams = await (deps.library ?? libraryTeamRoles)();
      } catch {
        return json(res, 502, { error: "The team library can't be reached right now. Build the team from what the person asked." });
      }
      deps.requireActive();
      return chief() ? json(res, 200, { teams }) : json(res, 403, { error: NOT_CHIEF });
    }
    const instances = await deps.instances();
    deps.requireActive();
    const current = chief();
    if (!current) return json(res, 403, { error: NOT_CHIEF });
    const sysCoordinator = isSystemCoordinator(current);
    return json(res, 200, {
      coordinatorRole: sysCoordinator ? "system_coordinator" : "department_coordinator",
      teams: deps.teams().filter((name) => hasTeamAuthority(current, name)),
      bots: deps.bots().filter((bot) => !bot.hidden && hasTeamAuthority(current, bot.section) && (bot.id === current.id || peerAllowed(current, bot)))
        .map((bot) => ({
          id: bot.id, name: bot.name, title: bot.title, section: bot.section ?? "", modelSelection: bot.modelSelection,
          chiefOfStaff: Boolean(bot.chiefOfStaff),
          coordinatorRole: bot.chiefOfStaff ? (bot.section?.trim() ? "department_coordinator" : "system_coordinator") : "member",
        })),
      instances: instances.map((instance) => ({ instanceId: instance.instanceId, driverKind: instance.driverKind, displayName: instance.displayName,
        state: instance.snapshot.state, models: instance.models, effortLevels: instance.capabilities?.effortLevels ?? [] })),
      scope: sysCoordinator
        ? "You are the unique System Coordinator overseeing all departments and uncategorized bots. You may directly create new departments (in newTeams or via a new section name), create department bots, appoint ONE Department Coordinator (chiefOfStaff: true) per named department (department members report to the Department Coordinator; the Department Coordinator reports to you), and pass departmentInstructions to initialize each department's shared instructions. Creating a new department automatically ensures a Department Coordinator, initializes department shared instructions, syncs the org chart, and creates its department group chat. After creating any bot(s), immediately equip each with skill(s) via user-provided -> skill_find + skill_import + enable -> skill_manage create."
        : "Bot model defaults apply to groups and new threads; existing threads retain their models. Requested team setup applies immediately, and the person can undo it. Existing unauthorized teams remain outside this coordinator's scope.",
    });
  };
}
