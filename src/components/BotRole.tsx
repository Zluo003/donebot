import { Crown } from "lucide-react";
import { activeLocale, t } from "@/lib/i18n";
import type { Bot } from "@/state/store";

export function isDepartmentCoordinator(bot: Pick<Bot, "chiefOfStaff" | "section">): boolean {
  return Boolean(bot.chiefOfStaff && bot.section?.trim());
}

export function coordinatorRoleLabel(bot: Pick<Bot, "chiefOfStaff" | "section">): string {
  if (!bot.chiefOfStaff) return "";
  if (bot.section?.trim()) {
    const locale = activeLocale();
    if (locale === "zh-tw" || locale === "zh-hant" || locale === "zh-hk") return "部門協調機器人";
    if (locale === "zh") return "部门协调机器人";
    return "Department Coordinator";
  }
  return t("chat.chiefOfStaff");
}

export function coordinatorSidebarLabel(bot: Pick<Bot, "chiefOfStaff" | "section">): string {
  if (!bot.chiefOfStaff) return "";
  if (bot.section?.trim()) return coordinatorRoleLabel(bot);
  return t("sidebar.bot.chiefOfStaff");
}

export function coordinatorArchiveHint(bot: Pick<Bot, "chiefOfStaff" | "section">): string {
  if (bot.section?.trim()) {
    const locale = activeLocale();
    if (locale === "zh-tw" || locale === "zh-hant" || locale === "zh-hk") return "請先取消或更換該部門協調機器人";
    if (locale === "zh") return "请先取消或更换该部门协调机器人";
    return "Choose or remove this department's coordinator first";
  }
  return t("sidebar.bot.archiveBlockedChief");
}

export function SidebarBotRole({ role }: { role: string }) {
  return (
    <span data-testid="bot-role" className="@container -ms-1.5 min-w-0 grow">
      <span title={role} className="block truncate ps-1.5 text-[13px] font-normal leading-[18px] text-ink-secondary @max-[3rem]:sr-only">
        <span className="sr-only">, </span>{role}
      </span>
    </span>
  );
}

export function ChatHeadRole({ bot }: { bot: Pick<Bot, "title" | "chiefOfStaff" | "section"> }) {
  const role = bot.title.trim();
  const badgeLabel = coordinatorRoleLabel(bot);
  const repeatsChiefBadge = Boolean(bot.chiefOfStaff && badgeLabel && role.toLocaleLowerCase() === badgeLabel.toLocaleLowerCase());
  if (!role || repeatsChiefBadge) return null;
  return (
    <span data-chathead-role className="flex min-w-0 max-w-fit grow basis-0">
      <span title={role} className="max-w-[16rem] truncate text-[13px] text-ink-secondary">{role}</span>
    </span>
  );
}

export function chiefOfStaffBadge(bot: Bot) {
  if (!bot.chiefOfStaff) return null;
  const label = coordinatorRoleLabel(bot);
  return (
    <span title={label} className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-accent/12 px-2 py-0.5 text-[11px] font-medium text-accent @max-4xl/chathead:px-1.5">
      <Crown size={11} aria-hidden="true" /> <span className="@max-4xl/chathead:sr-only">{label}</span>
    </span>
  );
}
