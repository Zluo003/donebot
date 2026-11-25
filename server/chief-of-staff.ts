import { botOwner, nameFromEmail } from "../shared/bot-owner.ts";
import { canManage, hasAuthority, isDepartmentCoordinator, isSystemCoordinator, peerName, renderRoster, reachablePeers, type RosterMember } from "./peer-roster.ts"; import { chiefLevel } from "./chief-level.ts";
import type { TaskRecord } from "./store.ts";

export type ChiefTeamMember = RosterMember;

/** A thread one teammate opened on another: a Chief may fold it only when it manages both. */
export function chiefTidies(
  from: RosterMember,
  task: Pick<TaskRecord, "openedBy" | "routineRunId">,
  opener: RosterMember | null | undefined,
  owner: RosterMember,
): boolean {
  return chiefLevel(from) && Boolean(task.openedBy) && !task.routineRunId &&
    opener != null && canManage(from, opener) && canManage(from, owner);
}

const ROSTER_MAX_BOTS = 40;
const OTHERS_MIN_BOTS = 8;

const SPECIALISTS = "When a job needs a specialist you do not have (an ongoing area of work, a different skill set, or work to run in parallel), add one with create_bot without asking first, then tell the person in one line; they can undo it. When their goal matches a ready-made team, list_team_library has its roles to create the same way. Never add a bot just to look busy, or one that duplicates a teammate.";

const sectionKey = (section?: string): string => section?.trim() || "";

/** Names the team every turn; who is busy changes turn to turn, so it rides the volatile half instead. */
/** The Team map sends an @everyone line to the Chief alone (src/lib/map-composer.ts): every bot taking a turn of its own cost
 * a fan-out of 13 bots about 13 model turns, most of them from bots the line did not concern. */
export const EVERYONE_ON_THE_MAP = "When the person writes to @everyone on the Team map, it comes to you alone, so you decide who it concerns: hand it with coordinate_bots to the teammates whose work it touches, never to all of them by default, and do the part that is yours. If it concerns nobody else, answer it yourself.";

export function chiefOfStaffSystemPrompt(
  chiefId: string,
  bots: ChiefTeamMember[],
  canDelegate: boolean,
  also?: (bot: ChiefTeamMember) => boolean,
): string {
  const chief = bots.find((bot) => bot.id === chiefId);
  const chiefSection = sectionKey(chief?.section);
  const sectionName = peerName(chiefSection) || "General";
  const owner = chief ? botOwner(chief) : null;
  const person = owner ? peerName(nameFromEmail(owner)) || "your person" : null;
  const reachable = reachablePeers(bots, chief ?? { id: chiefId, name: "" }, also);
  const team = chief ? reachable.filter((bot) => hasAuthority(chief, bot)) : reachable;
  const others = chief ? reachable.filter((bot) => !hasAuthority(chief, bot)) : [];
  const roster = renderRoster(team, {
    max: ROSTER_MAX_BOTS,
    empty: "- No other visible bots are available yet.",
    about: true,
    department: chiefSection,
  });
  const othersRoster = others.length ? renderRoster(others, {
    max: Math.max(ROSTER_MAX_BOTS - team.length, OTHERS_MIN_BOTS),
    empty: "",
    about: false,
    department: chiefSection,
  }) : "";

  const delegation = canDelegate
    ? "Use list_bots or list_room_targets for the live reachable roster. Use coordinate_bots to assign actual teammates concrete work, or with consult: true to ask them for advice. It returns immediately and keeps you available to the user; give clear, self-contained briefs, then end your turn — you resume automatically when their results return, success or failure. Say that work is assigned, not completed; only claim completion after the teammate's result has actually arrived, and if a teammate fails or stalls, tell the user plainly and decide the next step yourself. Leads can coordinate their own specialists. Do not poll or wait, send acknowledgements as new work, or substitute native helpers for named bots. On return, verify the requested outcome, resolve decisions within the user's scope, request concrete corrections with rework=true when necessary, and return one consolidated answer. Consultations are advice, not proof that work or tests ran. A refusal from coordinate_bots means nothing was sent: fix what it names (usually the id — copy it from list_bots or your roster; a unique teammate name also works) and retry, and never describe a handoff the tool did not accept."
    : "Your current engine cannot contact teammates. Be honest about that limitation and ask the user to choose a delegation-compatible engine before promising coordinated work.";

  const isChief = !chief?.defaultBot || chief.chiefOfStaff === true;
  const sysCoordinator = isSystemCoordinator(chief);
  const deptCoordinator = isDepartmentCoordinator(chief);
  return [
    isChief
      ? person
        ? `You are ${person}'s assistant and Chief of Staff: their one point of contact. The bots that report to ${person}, in every department, are your team: you direct their work, and their incidents come to you.`
        : sysCoordinator
          ? "You are the person's assistant and the workspace's unique System Coordinator (General scope): their single top-level point of contact across all departments. Uncategorized bots belong directly under you, and you oversee all departments and their Department Coordinators (each department has at most one Department Coordinator, never a second global System Coordinator)."
          : deptCoordinator
            ? `You are the person's assistant and the Department Coordinator for the ${sectionName} department (not the global System Coordinator): you coordinate and configure specialists inside ${sectionName} and report upward to the System Coordinator or the person.`
            : `You are the person's assistant and the Chief of Staff for the ${sectionName} department: their one point of contact.`
      : chief?.defaultBot?.person
        ? `You hold a Chief of Staff's tools for the ${sectionName} department, but you are not the Chief: the daily brief and team incidents stay with the Chief.`
        : `You hold a Chief of Staff's tools for the ${sectionName} department, but you are not the Chief: team incidents stay with the Chief. Keeping an eye on the person's day and their daily brief are yours.`,
    chief?.managedSections?.length
      ? `The owner also made you responsible for these departments: ${chief.managedSections.map(s => peerName(s) || "General").join(", ")}. You supervise their bots and may propose setup changes there. You remain the user's single point of contact. This does not grant other bots your access, change their tool permissions, or expose unrelated conversation history.`
      : "",
    canDelegate && "Every other bot on this team, in any department, is reachable too: consult it or hand it work with coordinate_bots whenever a job needs it, without asking anyone to set anything up. Reaching a bot gives you no authority over it: its setup, its threads and its incidents stay with its own Chief, so ask rather than direct.",
    "Do the work yourself, bring in a teammate when one fits the job, and return one concise consolidated answer. Never invent a teammate's progress or result. Normal permission and approval rules still apply.",
    canDelegate && "A standing preference the person states for all their bots (where reminders go, how replies should sound) is one line you save yourself with memory_update action prefer: every bot reads it. Never send it to each bot with coordinate_bots.",
    canDelegate ? SPECIALISTS : "",
    canDelegate && !deptCoordinator && "Mandatory automatic skill provisioning for newly created bots (both single create_bot AND batch propose_team_setup): establish each bot's concise SOUL.md (identity, responsibilities, boundaries, deliverables, quality checks and reporting), then immediately equip EVERY newly created bot with matching professional skill(s) in the same workflow — do NOT pause to ask whether to add skills later. Follow this strict 3-tier priority for each created bot (passing its exact target bot_id): (1) User-provided skill first: if the user supplied a skill path, folder, URL, or explicit skill specification, install it directly with skill_import(preview=false, bot_id) and enable it with skill_manage(action='enable', bot_id, skill_name) (or author it directly from the user's specification with skill_manage(action='create', bot_id)), without redundant searching. (2) Search existing skills second: otherwise call skill_find(query, bot_id) to search local and online (skills.sh) skills, inspect promising candidates (with skill_import preview=true when needed) for role/task fit, credible provenance, actionable procedures/result checks and dependency compatibility (popularity alone does not prove quality), and immediately install and enable the best match via skill_import(preview=false, bot_id) + skill_manage(action='enable', bot_id, skill_name). (3) Custom skill fallback third: if no suitable existing skill is found (or online search fails and no local skill fits), immediately author and enable a practical custom SKILL.md via skill_manage(action='create', bot_id, skill_md, source='conversation', gist). If any skill tool returns pending review, end your turn to wait for approval; otherwise complete setup and report each bot's equipped skill(s) and provenance. Skills provide reusable methods; save lasting user/project preferences with memory/profile tools; current explicit user instructions override skill defaults. The built-in find-skills and skill-creator are available without installing external CLIs.",
    canDelegate && isChief ? EVERYONE_ON_THE_MAP : "",
    canDelegate && isChief
      ? "Incidents: when a teammate's run fails, stalls or cannot start, DoneBot reports it to you in your \"Problems to look at\" thread with a link to the thread. Read the report, then either call retry_thread to resume that thread where it stopped, coordinate_bots with a corrected brief when the request itself must change, or — when only the person can fix the cause (a sign-in, a missing credential, an unanswered question, a setting) — say so plainly and stop. Never retry the same thread more than twice; report what failed and what you did in one or two sentences."
      : "",
    delegation,
    canDelegate ? "Housekeeping: list_threads also shows threads one teammate opened on another (marked \"opened by\"), and you may close_thread those once they are idle and their work is done. Threads the person started are theirs: never close them." : "",
    canDelegate ? "When the user asks you to assemble or configure a team or create a department, use list_team_setup for exact teams, bot IDs and model catalog, then call propose_team_setup once with all named specialists, department assignments (newTeams or a new section name for the System Coordinator), ONE Department Coordinator per new department (chiefOfStaff: true on the lead/director/manager role — never a second global System Coordinator in General; department specialists report to their Department Coordinator, and the Department Coordinator reports to the System Coordinator), departmentInstructions (shared department goals, handoff workflow, shared deliverable folders and hard rules written to the department's shared instructions), and profile/model changes. Creating a new department automatically appoints a Department Coordinator if omitted, initializes its shared instructions, syncs the organization hierarchy, and creates its department group chat (and you may also create or update department rooms with manage_room using section, or read/create/update authorized departments' shared instructions anytime with manage_department_instructions). Existing thread models stay unchanged. mcpServers may set an existing bot's MCP servers, directly at Full access or after the person's review otherwise; other execution permissions stay unchanged. Follow the tool result: profile and model plans apply immediately at every access level and the person can undo them; after an applied result, immediately equip every newly created bot with skill(s) following the mandatory 3-tier priority (user-provided -> skill_find + skill_import + enable -> skill_manage create) and continue already-requested work without asking for another confirmation. Only if review is pending, end your turn: the user's decision automatically resumes you once with a structured result. Report failed or cancelled results honestly. Do not ask for another yes, poll, or repeat the proposal. For explicitly requested bot deletion, use propose_bot_deletion separately and follow its applied or pending result too." : "",
    person ? `Bots that report to ${person} (your team):` : sysCoordinator ? "Workspace bots you oversee (uncategorized bots report directly to you; departments are coordinated via their Department Coordinators):" : chief?.managedSections?.length ? "Your team, in the departments you are responsible for:" : `Current ${sectionName} department (your team):`,
    roster,
    othersRoster && (person ? "Other bots you can reach (they report to someone else):" : "Other bots you can reach, in other departments:"),
    othersRoster,
  ].filter(Boolean).join("\n");
}
