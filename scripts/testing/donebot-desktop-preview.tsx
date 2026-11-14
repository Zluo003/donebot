import { createRoot } from "react-dom/client";
import { ComputerPanel } from "../../src/components/ComputerPanel";
import { BotEditorStore, initialState, type Bot } from "../../src/state/store";
import { applySkin } from "../../src/lib/skins";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { setLocale } from "../../src/lib/i18n";
import "../../src/styles.css";

setAnalyticsEnabled(false); setLocale("zh-CN"); applySkin("daylight");
const bots = await fetch("/api/bots?messages=0").then(response => response.json());
const bot: Bot = bots.bots.find((row: Bot) => row.name === "Cloud desktop fixture");
const value = { state: { ...initialState, bots: [bot], selectedId: bot.id }, dispatch: () => {}, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
createRoot(document.getElementById("root")!).render(<BotEditorStore value={value}><main className="flex h-screen justify-end bg-app text-ink"><ComputerPanel bot={bot} /></main></BotEditorStore>);
