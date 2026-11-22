import { Check } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { FarMemberOption } from "@/lib/linked-bots";
import { MAUS_COLOR_NAMES, type MausColor } from "@/lib/mascot";
import type { Bot, Group } from "@/state/store";
import { BotAvatar } from "./Avatar";

export function farMembersOf(group: Pick<Group, "memberIds" | "farMembers">): FarMemberOption[] {
  return (group.farMembers ?? []).filter((member) => group.memberIds.includes(member.id));
}

function safeColor(color?: string): MausColor {
  return (MAUS_COLOR_NAMES as readonly string[]).includes(color ?? "") ? (color as MausColor) : "blue";
}

export function RoomFarMembers({
  members,
  picked,
  onToggle,
  heading,
  showAvatar = false,
}: {
  members: readonly FarMemberOption[];
  picked: Set<string>;
  onToggle: (id: string) => void;
  heading?: string;
  showAvatar?: boolean;
}) {
  if (!members.length) return null;
  return (
    <div data-testid="room-far-members" className={cn("flex flex-col gap-0.5", heading ? "mt-2 border-t border-hairline/40 pt-2" : "mt-0.5")}>
      {heading && <div className="px-2 pb-1 text-[11px] font-medium text-ink-secondary">{heading}</div>}
      {members.map((member) => {
        const why =
          member.state === "off" ? t("room.members.far.off")
            : member.state === "offline" ? t("room.members.far.offline")
              : member.state === "missing" ? t("room.members.far.missing")
                : "";
        const where = [member.place ? t("room.members.far.place", { place: member.place }) : "", why].filter(Boolean).join(" · ");
        return (
          <button
            key={member.id}
            onClick={() => onToggle(member.id)}
            role="checkbox"
            aria-label={where ? `${member.name}, ${where}` : member.name}
            aria-checked={picked.has(member.id)}
            data-far-member={member.id}
            data-far-state={member.state}
            className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-raised/50"
          >
            {showAvatar && (
              <span className={cn("inline-flex shrink-0", member.state !== "ok" && "opacity-60")}>
                <BotAvatar
                  bot={{
                    name: member.name,
                    color: safeColor(member.color),
                    ...(member.mascotBody ? { mascotBody: member.mascotBody as Bot["mascotBody"] } : {}),
                    ...(member.mascotFaceColor ? { mascotFaceColor: member.mascotFaceColor as Bot["mascotFaceColor"] } : {}),
                  }}
                  state="happy"
                  size={28}
                  animated={false}
                />
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className={cn("block truncate text-[14px]", member.state === "ok" ? "text-ink" : "text-ink-secondary")}>{member.name}</span>
              {where && <span className="block truncate text-[12px] text-ink-secondary">{where}</span>}
            </span>
            <span
              className={cn(
                "flex size-[18px] shrink-0 items-center justify-center rounded-full border",
                picked.has(member.id) ? "border-accent bg-accent text-white" : "border-hairline/60",
              )}
            >
              {picked.has(member.id) && <Check size={12} />}
            </span>
          </button>
        );
      })}
    </div>
  );
}
