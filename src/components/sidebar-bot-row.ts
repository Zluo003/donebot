import type { Dispatch } from "react";
import type { Action, AppState, Bot, InstanceInfo } from "@/state/store";
import { llmThreadTitlesEnabled } from "@/lib/feature-flags";
import { activeLocale } from "@/lib/i18n";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import type { BotDropPlace } from "@/lib/sidebar-bot-drop";
import type { BotRowDrag } from "./SidebarBotDrag";
import type { MenuState } from "./Sidebar";

export interface BotRowProps {
  bot: Bot;
  selected: boolean;
  deleting: boolean;
  mascotMotion: AppState["mascotMotion"];
  reveal: AppState["revealThread"];
  pendingQueued: AppState["pendingQueued"];
  instances: InstanceInfo[];
  liveCall: AppState["liveCall"];
  locale: string;
  generatedTitles: boolean;
  density: SidebarDensity;
  query: string;
  dispatch: Dispatch<Action>;
  onMenu: (menu: MenuState) => void;
  renameRequest?: number;
  botDrag?: BotRowDrag;
  botDrop?: BotDropPlace | null;
  botDragging?: boolean;
  advancedLayout?: boolean;
  showThreads?: boolean;
}

export function botRowProps(
  state: AppState,
  dispatch: Dispatch<Action>,
  bot: Bot,
  layout: Pick<BotRowProps, "density" | "query" | "onMenu" | "renameRequest" | "botDrag" | "botDrop" | "botDragging" | "advancedLayout" | "showThreads">,
): BotRowProps {
  const selected = state.activeView === "chat" && state.selectedId === bot.id;
  const reveal = state.revealThread;
  return {
    ...layout,
    bot,
    selected,
    deleting: state.deletingBots[bot.id] === true,
    mascotMotion: selected && state.mascotMotion?.botId === bot.id ? state.mascotMotion : null,
    reveal: reveal && (bot.threadId === reveal.threadId || bot.tasks?.some((task) => task.threadId === reveal.threadId)) ? reveal : null,
    pendingQueued: state.pendingQueued,
    instances: state.instances,
    liveCall: state.liveCall,
    locale: activeLocale(),
    generatedTitles: llmThreadTitlesEnabled(state.config),
    dispatch,
  };
}
