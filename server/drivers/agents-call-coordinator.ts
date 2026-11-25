import type { ToolCallResult } from "./agents-call.ts";
import type { HarnessClient, Json } from "./agents-client.ts";

const isJsonRecord = (value: unknown): value is Json =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

export function formatManagedRoomsBlock(managedRooms: Json[]): string {
  if (!managedRooms.length) return "";
  return `\n\nDepartment rooms you oversee (use manage_room with these ids):\n${
    managedRooms.map((room) => {
      const members = Array.isArray(room.members) ? room.members.map(String).join(", ") : "";
      return `- ${String(room.name)} (${String(room.section)}) [id: ${String(room.id)}]${members ? ` — members: ${members}` : ""}`;
    }).join("\n")
  }`;
}

export function enhanceTeamSetupResult(
  completed: ToolCallResult,
  result: Json,
  deleting: boolean,
): ToolCallResult {
  if (deleting || completed.isError || !isJsonRecord(result.result)) return completed;
  const createdBots = Array.isArray(result.result.bots)
    ? result.result.bots.filter(isJsonRecord).filter((bot) => bot.action === "created" && typeof bot.id === "string")
    : [];
  const createdRooms = Array.isArray(result.result.createdRooms)
    ? result.result.createdRooms.filter(isJsonRecord)
    : [];
  const updatedInstructions = Array.isArray(result.result.updatedDepartmentInstructions)
    ? result.result.updatedDepartmentInstructions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const deptCoordinators = Array.isArray(result.result.bots)
    ? result.result.bots.filter(isJsonRecord).filter((bot) => bot.chiefOfStaff === true && typeof bot.section === "string" && bot.section.trim().length > 0)
    : [];
  const extras: string[] = [];
  if (deptCoordinators.length) {
    extras.push(
      `Appointed Department Coordinator(s): ${deptCoordinators.map((bot) => `@${String(bot.name ?? bot.id)} (${String(bot.section)})`).join(", ")}.`,
    );
  }
  if (createdRooms.length) {
    extras.push(
      `Auto-created department group chat(s): ${createdRooms.map((room) => `“${String(room.name)}” (department: ${String(room.section)}, room_id: ${String(room.id)})`).join(", ")}.`,
    );
  }
  if (updatedInstructions.length) {
    extras.push(
      `Initialized department shared instructions for: ${updatedInstructions.map((dept) => `“${dept}”`).join(", ")}.`,
    );
  }
  if (createdBots.length) {
    const targets = createdBots.map((bot) => `@${String(bot.name ?? bot.id)} [bot_id: ${String(bot.id)}]`).join(", ");
    extras.push(
      `Required next step — automatically equip skill(s) for EVERY newly created bot (${targets}) now without asking first, in strict priority order: (1) user-provided skill via skill_import(preview=false, bot_id) + skill_manage(action="enable", bot_id), (2) skill_find(query, bot_id) -> skill_import(preview=false, bot_id) + skill_manage(action="enable", bot_id), (3) skill_manage(action="create", bot_id, skill_md, source="conversation") custom skill if no suitable skill exists.`,
    );
  }
  return extras.length ? { ...completed, text: `${completed.text}\n\n${extras.join("\n")}` } : completed;
}

export function formatCreateBotResult(r: Json, botName: string): ToolCallResult {
  const createdRooms = Array.isArray(r.createdRooms) ? r.createdRooms.filter(isJsonRecord) : [];
  const roomNote = createdRooms.length
    ? ` Auto-created department group chat: ${createdRooms.map((room) => `“${String(room.name)}” [room_id: ${String(room.id)}]`).join(", ")}.`
    : "";
  const coordNote = r.chiefOfStaff ? " (Department Coordinator)" : "";
  return {
    text: `Created @${r.name ?? botName}${coordNote} in ${r.section ?? "General"} [id: ${r.id}].${r.modelSelection ? ` Model: ${JSON.stringify(r.modelSelection)}.` : ""}${roomNote} Required next step: immediately equip @${r.name ?? botName} [bot_id: ${r.id}] with matching skill(s) without asking first in strict priority order: (1) user-provided skill via skill_import(preview=false, bot_id) + skill_manage(enable), (2) skill_find(query, bot_id) -> skill_import(preview=false, bot_id) + skill_manage(enable), (3) skill_manage(action="create", bot_id) custom skill if no suitable skill exists. Then assign work with coordinate_bots.`,
  };
}

export async function callCreateRoom(
  args: Json,
  api: HarnessClient["api"],
  botId: string,
  threadId: string,
): Promise<ToolCallResult> {
  const roomName = String(args.name ?? "").trim();
  const memberIds = Array.isArray(args.member_bot_ids)
    ? args.member_bot_ids.map((id) => String(id).trim()).filter(Boolean)
    : [];
  const bulletin = typeof args.bulletin === "string" ? args.bulletin.trim() : undefined;
  const section = typeof args.section === "string" ? args.section.trim() : undefined;
  if (!roomName) {
    return { text: "manage_room action=create needs a room name.", isError: true };
  }
  if (!memberIds.length) {
    return { text: "manage_room action=create needs at least one bot ID in member_bot_ids.", isError: true };
  }
  const r = await api(`/api/internal/create-room`, {
    method: "POST",
    body: JSON.stringify({
      fromBotId: botId,
      fromThreadId: threadId,
      name: roomName,
      memberIds,
      ...(section !== undefined ? { section } : {}),
      bulletin,
    }),
  });
  if (r.error) return { text: `Couldn't create room: ${r.error}`, isError: true };
  return {
    text: `Created room “${r.name ?? roomName}” in section “${r.section ?? "General"}” [id: ${r.id}] with ${r.memberCount ?? memberIds.length} members.`,
  };
}

export async function callManageRoom(
  args: Json,
  api: HarnessClient["api"],
  botId: string,
  threadId: string,
): Promise<ToolCallResult> {
  if (args.section !== undefined || args.action === "set_section") return { text: "Moving rooms between sections is user-only.", isError: true };
  const roomId = String(args.room_id ?? "").trim();
  const action = String(args.action ?? "").trim();
  if (!roomId || !action) {
    return { text: "manage_room needs action and, for any action but create, the room_id from list_rooms.", isError: true };
  }
  const memberIds = Array.isArray(args.member_bot_ids)
    ? args.member_bot_ids.map((id) => String(id).trim()).filter(Boolean)
    : undefined;
  const roomName = typeof args.name === "string" ? args.name.trim() : undefined;
  const bulletin = typeof args.bulletin === "string" ? args.bulletin.trim() : undefined;
  const r = await api(`/api/internal/manage-room`, {
    method: "POST",
    body: JSON.stringify({
      fromBotId: botId,
      fromThreadId: threadId,
      roomId,
      action,
      memberIds,
      name: roomName,
      bulletin,
    }),
  });
  if (r.error) return { text: `Couldn't manage room: ${r.error}`, isError: true };
  const message = typeof r.message === "string" ? r.message : `Updated room ${roomId}.`;
  return { text: message };
}

export async function callManageDepartmentInstructions(
  args: Json,
  api: HarnessClient["api"],
): Promise<ToolCallResult> {
  const action = String(args.action ?? "").trim();
  if (!["read", "set", "append"].includes(action)) {
    return { text: "manage_department_instructions needs action: read, set, or append.", isError: true };
  }
  if ((action === "set" || action === "append") && typeof args.text !== "string") {
    return { text: `manage_department_instructions action=${action} requires text.`, isError: true };
  }
  if (action === "append" && !String(args.text ?? "").trim()) {
    return { text: "manage_department_instructions action=append requires non-empty text.", isError: true };
  }
  const r = await api("/api/internal/department-instructions", {
    method: "POST",
    body: JSON.stringify({
      action,
      ...(args.section !== undefined ? { section: String(args.section) } : {}),
      ...(args.text !== undefined ? { text: String(args.text) } : {}),
    }),
  });
  if (r.error) return { text: `Couldn't manage department shared instructions: ${String(r.error)}`, isError: true };
  const label = String(r.label ?? "General");
  if (action === "read") {
    const text = typeof r.text === "string" ? r.text : "";
    return {
      text: text.trim()
        ? `Shared instructions for “${label}” (${String(r.bytes ?? Buffer.byteLength(text, "utf8"))} / ${String(r.maxBytes ?? 24000)} bytes):\n\n${text}`
        : `No shared instructions are set yet for “${label}”.`,
    };
  }
  const bytes = typeof r.bytes === "number" ? r.bytes : 0;
  return {
    text: bytes > 0
      ? `Updated shared instructions for “${label}” (${bytes} / ${String(r.maxBytes ?? 24000)} bytes).`
      : `Cleared shared instructions for “${label}”.`,
  };
}
