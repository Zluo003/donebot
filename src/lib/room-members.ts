import { t } from "@/lib/i18n";
import { MAUS_COLOR_NAMES, type MausColor } from "@/lib/mascot";
import type { Bot, Group } from "@/state/store";

type FarMember = NonNullable<Group["farMembers"]>[number];

export function nextMemberIds(current: string[], picked: Set<string>, order: string[]): string[] {
  return [...current.filter((id) => picked.has(id)), ...order.filter((id) => picked.has(id) && !current.includes(id))];
}

function safeColor(color?: string): MausColor {
  return (MAUS_COLOR_NAMES as readonly string[]).includes(color ?? "") ? (color as MausColor) : "blue";
}

export function farBotAsMember(far: FarMember): Bot {
  const where = far.place ? t("room.members.far.place", { place: far.place }) : "";
  const title = [far.title?.trim(), where].filter(Boolean).join(" · ");
  return {
    id: far.id,
    threadId: "",
    name: far.name,
    title,
    description: "",
    notifications: false,
    color: safeColor(far.color),
    ...(far.mascotBody ? { mascotBody: far.mascotBody as Bot["mascotBody"] } : {}),
    ...(far.mascotFaceColor ? { mascotFaceColor: far.mascotFaceColor as Bot["mascotFaceColor"] } : {}),
    unread: false,
    modelSelection: { instanceId: "", model: "" },
    messages: [],
  };
}

export function resolveGroupMembers(group: Pick<Group, "memberIds" | "farMembers">, bots: readonly Bot[]): Bot[] {
  const farById = group.farMembers?.length ? new Map(group.farMembers.map((member) => [member.id, member])) : null;
  const resolved: Bot[] = [];
  for (const id of group.memberIds) {
    const local = bots.find((bot) => bot.id === id);
    if (local) { resolved.push(local); continue; }
    const far = farById?.get(id);
    if (far) resolved.push(farBotAsMember(far));
  }
  return resolved;
}
