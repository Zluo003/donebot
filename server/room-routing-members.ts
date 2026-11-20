import type { GroupDefaultResponder } from "./store.ts";

export function roomTurnMembers<Member extends { id: string; hidden?: boolean; home?: { gone?: unknown } }>(
  members: readonly Member[],
  heldInRoom: (member: Member) => boolean,
  botHeld: (member: Member) => boolean,
) {
  const availableMembers = members.filter((member) => !member.hidden);
  const present = availableMembers.filter((member) => !heldInRoom(member));

  const goalMembers = present.filter((member) => !member.home);

  const routableMembers = present.filter((member) => !botHeld(member) && !member.home?.gone);
  return { availableMembers, goalMembers, routableMembers };
}

export function autoRoomDefault(
  responder: GroupDefaultResponder,
  routableMembers: readonly { id: string }[],
  replyBot?: { id: string },
): GroupDefaultResponder {
  if (responder.kind !== "auto") return responder;
  const lead = replyBot ?? routableMembers.find((member) => member.id === responder.fallbackBotId) ?? routableMembers[0];
  return lead ? { kind: "member", botId: lead.id } : responder;
}
