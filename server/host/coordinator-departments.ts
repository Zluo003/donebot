import { fitsOnOneLine } from "../bot-profile.ts";
import { chiefLevel } from "../chief-level.ts";
import type { ModelSelection } from "../contracts.ts";
import { hasTeamAuthority, isSystemCoordinator, outsideDepartmentReason } from "../peer-roster.ts";
import { redactSecretsInText } from "../redact.ts";
import { readSectionContext, writeSectionContext } from "../section-context.ts";
import type { BotRecord, GroupRecord, Store } from "../store.ts";
import type { TeamSetupRequest, TeamSetupResult } from "../../shared/team-setup.ts";

const sectionKey = (section?: string): string => section?.trim() || "";

export function createTeamSetupDepartmentHooks(deps: {
  store: Store;
  syncOrgChart(bots: readonly BotRecord[]): void;
  roomDeciderReady(): boolean;
  createChannel(input: {
    name: string;
    memberIds: string[];
    section?: string;
    setup: {
      bulletin: string;
      defaultResponder: { kind: "auto"; fallbackBotId: string } | { kind: "member"; botId: string };
    };
  }): GroupRecord;
}) {
  return {
    onApplied: (request: TeamSetupRequest, result: TeamSetupResult) => {
      const updatedDepartmentInstructions: string[] = [];
      const previousSectionContexts: Array<{ section: string; previousText: string | null; writtenText: string }> = [];
      for (const [rawDept, text] of Object.entries(request.departmentInstructions ?? {})) {
        const dept = sectionKey(rawDept);
        if (!dept || !text.trim()) continue;
        try {
          const previousText = readSectionContext(dept)?.text ?? null;
          writeSectionContext(dept, text);
          updatedDepartmentInstructions.push(dept);
          previousSectionContexts.push({ section: dept, previousText, writtenText: text });
        } catch (error) {
          console.warn(`[team-setup] could not write department shared instructions for "${dept}": ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      deps.syncOrgChart(deps.store.bots);
      const createdRooms: Array<{ id: string; name: string; section: string; memberIds: string[] }> = [];
      for (const rawDept of result.newTeams) {
        const dept = sectionKey(rawDept);
        if (!dept) continue;
        if (deps.store.groups.some((group) => !group.dm && sectionKey(group.section) === dept)) continue;
        const deptBots = deps.store.bots.filter((bot) => !bot.hidden && sectionKey(bot.section) === dept);
        if (!deptBots.length) continue;
        const deptCoordinator = deptBots.find((bot) => bot.chiefOfStaff);
        const lead = deptCoordinator ?? deptBots[0]!;
        try {
          const room = deps.createChannel({
            name: `${dept}群聊`,
            memberIds: deptBots.map((bot) => bot.id),
            section: dept,
            setup: {
              bulletin: `${dept}部门群聊${deptCoordinator ? `，由部门协调机器人 @${deptCoordinator.name} 统筹本部门分工与协作` : ""}。`,
              defaultResponder: deps.roomDeciderReady() ? { kind: "auto", fallbackBotId: lead.id } : { kind: "member", botId: lead.id },
            },
          });
          createdRooms.push({ id: room.id, name: room.name, section: dept, memberIds: room.memberIds });
        } catch (error) {
          console.warn(`[team-setup] could not auto-create department group chat for "${dept}": ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { createdRooms, updatedDepartmentInstructions, previousSectionContexts };
    },
    deleteUnusedRoom: (roomId: string) => {
      const room = deps.store.group(roomId);
      if (!room || room.dm) return;
      if (deps.store.messagesFor(room.threadId).some((message) => message.role === "user")) return;
      deps.store.deleteGroup(room.id);
    },
    readSectionContext: (dept: string) => readSectionContext(dept)?.text ?? null,
    restoreSectionContext: (entry: { section: string; previousText: string | null; writtenText: string }) => {
      const current = readSectionContext(entry.section)?.text ?? null;
      if (current !== entry.writtenText) return;
      try {
        writeSectionContext(entry.section, entry.previousText ?? "");
      } catch (error) {
        console.warn(`[team-setup] could not restore department shared instructions for "${entry.section}": ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

export async function fillTeamSetupDefaultModels(
  plan: unknown,
  defaultSelection: () => Promise<ModelSelection>,
): Promise<unknown> {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return plan;
  const rawPlan = plan as Record<string, unknown>;
  if (!Array.isArray(rawPlan.operations)) return plan;
  const createKeyOf = (op: Record<string, unknown>, idx: number) => {
    if (typeof op.key === "string" && op.key.trim()) return op.key.trim();
    const fields = op.fields && typeof op.fields === "object" && !Array.isArray(op.fields) ? op.fields as Record<string, unknown> : undefined;
    return typeof fields?.name === "string" && fields.name.trim() ? fields.name.trim() : `new-bot-${idx + 1}`;
  };
  const keysWithModel = new Set<string>();
  rawPlan.operations.forEach((op, idx) => {
    if (!op || typeof op !== "object") return;
    const rec = op as Record<string, unknown>;
    if (rec.action !== "create" || !rec.fields || typeof rec.fields !== "object" || Array.isArray(rec.fields)) return;
    if ((rec.fields as Record<string, unknown>).modelSelection !== undefined) keysWithModel.add(createKeyOf(rec, idx));
  });
  const needsDefaultModel = rawPlan.operations.some((op, idx) => {
    if (!op || typeof op !== "object") return false;
    const rec = op as Record<string, unknown>;
    return rec.action === "create" && !keysWithModel.has(createKeyOf(rec, idx));
  });
  if (!needsDefaultModel) return plan;
  const fallbackSelection = await defaultSelection();
  return {
    ...rawPlan,
    operations: rawPlan.operations.map((op, idx) => {
      if (!op || typeof op !== "object") return op;
      const rec = op as Record<string, unknown>;
      if (rec.action !== "create" || !rec.fields || typeof rec.fields !== "object" || Array.isArray(rec.fields)) return op;
      if (keysWithModel.has(createKeyOf(rec, idx))) return op;
      const f = rec.fields as Record<string, unknown>;
      return { ...rec, fields: { ...f, modelSelection: fallbackSelection } };
    }),
  };
}

export function collectInternalRoomsPayload(deps: {
  store: Store;
  from: BotRecord;
  fromThreadId: string;
  roomPostEligibility(from: BotRecord, group: GroupRecord, fromThreadId: string): { ok: true } | { ok: false; error: string };
}) {
  const rooms: Array<{ id: string; name: string; section?: string; members: string[] }> = [];
  const managedRooms: Array<{ id: string; name: string; section: string; members: string[] }> = [];
  const unpostable: Array<{ name: string; reason: string }> = [];
  const sysCoordinator = isSystemCoordinator(deps.from);
  for (const group of deps.store.groups) {
    if (group.dm) continue;
    const members = group.memberIds
      .map((id) => deps.store.bot(id))
      .filter((member): member is BotRecord => Boolean(member))
      .map((member) => member.name);
    if (!group.memberIds.includes(deps.from.id)) {
      if (sysCoordinator && sectionKey(group.section)) {
        managedRooms.push({ id: group.id, name: group.name, section: sectionKey(group.section), members });
      }
      continue;
    }
    const eligibility = deps.roomPostEligibility(deps.from, group, deps.fromThreadId);
    if (!eligibility.ok) {
      unpostable.push({ name: group.name, reason: eligibility.error });
      continue;
    }
    rooms.push({
      id: group.id,
      name: group.name,
      ...(sectionKey(group.section) ? { section: sectionKey(group.section) } : {}),
      members,
    });
  }
  return {
    rooms: rooms.slice(0, 50),
    ...(managedRooms.length ? { managedRooms: managedRooms.slice(0, 50) } : {}),
    unpostable: unpostable.slice(0, 50),
  };
}

export function resolveCreateBotDepartment(
  body: Record<string, unknown>,
  chief: BotRecord,
  knownTeamNames: readonly string[],
): { ok: true; targetSection: string; departmentCoordinator: boolean; creatingNewTeam: boolean } | { ok: false; status: number; error: string } {
  let targetSection = sectionKey(chief.section);
  if (body.section !== undefined) {
    if (typeof body.section !== "string") return { ok: false, status: 400, error: "section must be a string" };
    targetSection = sectionKey(body.section);
    if (targetSection.length > 60) return { ok: false, status: 400, error: "department name must be at most 60 characters" };
    if (targetSection && !fitsOnOneLine(targetSection)) return { ok: false, status: 400, error: "department name must fit on one line" };
    if (targetSection && redactSecretsInText(targetSection) !== targetSection) return { ok: false, status: 400, error: "department name cannot contain credentials" };
  }
  const departmentCoordinator = body.department_coordinator === true;
  if (body.department_coordinator !== undefined && typeof body.department_coordinator !== "boolean") {
    return { ok: false, status: 400, error: "department_coordinator must be a boolean" };
  }
  if (departmentCoordinator && !targetSection) {
    return { ok: false, status: 400, error: "全局只能有一个总协调机器人，不能在未归入部门区创建第二个总协调机器人；请指定具体的 section 部门名称来创建部门协调机器人。" };
  }
  const knownTeams = new Set(knownTeamNames.map(sectionKey));
  const creatingNewTeam = Boolean(targetSection && !knownTeams.has(targetSection));
  if (creatingNewTeam && !chief.chiefOfStaff) {
    return { ok: false, status: 403, error: "only a Coordinator can create a new department" };
  }
  if (!creatingNewTeam && !hasTeamAuthority(chief, targetSection)) {
    return { ok: false, status: 403, error: outsideDepartmentReason(chief, { section: targetSection }) };
  }
  return { ok: true, targetSection, departmentCoordinator, creatingNewTeam };
}

export function resolveCreateRoomTarget(deps: {
  section?: string;
  memberIds: string[];
  chief: BotRecord;
  botById(id: string): BotRecord | null | undefined;
  allowedRoster(ids: string[], keepFar?: boolean, requireChief?: boolean): boolean;
}): { ok: true; targetSection: string; memberIds: string[]; fallbackBotId: string } | { ok: false; status: number; error: string } {
  const targetSection = deps.section !== undefined ? sectionKey(deps.section) : sectionKey(deps.chief.section);
  if (targetSection && (!fitsOnOneLine(targetSection) || redactSecretsInText(targetSection) !== targetSection)) {
    return { ok: false, status: 400, error: "invalid department name for room" };
  }
  if (!hasTeamAuthority(deps.chief, targetSection)) {
    return { ok: false, status: 403, error: outsideDepartmentReason(deps.chief, { section: targetSection }) };
  }
  const sameOwnSection = targetSection === sectionKey(deps.chief.section);
  const memberIds = sameOwnSection
    ? [...new Set([deps.chief.id, ...deps.memberIds])]
    : [...new Set(deps.memberIds)];
  if (!deps.allowedRoster(memberIds, false, sameOwnSection)) {
    return {
      ok: false,
      status: 403,
      error: sameOwnSection ? "include yourself and only active bots you can reach (list_bots)" : "include only active bots you can reach (list_bots)",
    };
  }
  const deptLead = targetSection
    ? memberIds.map((id) => deps.botById(id)).find((bot) => bot && bot.chiefOfStaff && sectionKey(bot.section) === targetSection)
    : undefined;
  const fallbackBotId = sameOwnSection
    ? deps.chief.id
    : (deptLead?.id ?? (memberIds.includes(deps.chief.id) ? deps.chief.id : memberIds[0]!));
  return { ok: true, targetSection, memberIds, fallbackBotId };
}

export function buildCoordinatorSkillFindPayload<T extends { remote: readonly unknown[] }>(
  internalSender: BotRecord,
  target: BotRecord,
  result: T,
): T & { guidance?: string } {
  if (!chiefLevel(internalSender) || target.id === internalSender.id) return result;
  return {
    ...result,
    guidance: result.remote.length > 0
      ? "Search results are candidates for this managed bot. Inspect the best matching candidate (with skill_import preview=true when needed), then immediately install and enable it via skill_import(preview=false, bot_id) + skill_manage(action='enable', bot_id) without asking the user first; if none fits well, immediately create and enable a custom skill via skill_manage(action='create', bot_id)."
      : "No suitable online candidate matched. If a local skill fits, enable it; otherwise immediately author and enable a custom skill for this bot via skill_manage(action='create', bot_id, skill_md, source='conversation') without asking the user first.",
  };
}
