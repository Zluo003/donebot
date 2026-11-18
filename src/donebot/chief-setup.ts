import { z } from "zod";
import { botBodySchema } from "../../shared/bot-body";
import { MAUS_COLOR_NAMES } from "../../shared/wire";
import { BOT_PROFILE_LIMITS, fitsOnOneLine } from "../../shared/bot-profile";
import { chiefFor, myDefaultBot } from "@/lib/default-bot";
import type { WelcomeViewer } from "@/lib/onboarding";
import type { Bot, ConfigStatus, InstanceInfo } from "@/state/store";
import { newBotBody } from "./avatars";

export const CHIEF_SETUP_HINT = "donebot-chief-setup-v1";
export const CHIEF_TRAITS = ["concise", "warm", "professional", "analytical", "proactive", "humorous", "patient"] as const;
export type ChiefTrait = typeof CHIEF_TRAITS[number];
const traitInstructions: Record<ChiefTrait, string> = {
  concise: "Lead with the answer. Keep replies concise and avoid repetition.",
  warm: "Use a warm, friendly and considerate tone.",
  professional: "Use precise, professional language and organize replies clearly.",
  analytical: "Explain the reasoning and relevant evidence; distinguish facts from assumptions.",
  proactive: "Suggest useful next steps and anticipate missing details within the user's existing permissions.",
  humorous: "Use light, appropriate humor without obscuring the answer.",
  patient: "Explain unfamiliar ideas patiently, with examples when helpful.",
};
const singleLine = (max: number) => z.string().max(max).refine(fitsOnOneLine);
const draftSchema = z.object({
  name: singleLine(BOT_PROFILE_LIMITS.name), address: singleLine(100),
  traits: z.array(z.enum(CHIEF_TRAITS)).max(CHIEF_TRAITS.length), custom: z.string().max(2000),
  model: z.string().max(200), color: z.enum(MAUS_COLOR_NAMES), body: botBodySchema,
  step: z.number().int().min(0).max(4),
});
export type ChiefSetupDraft = z.infer<typeof draftSchema>;
export const chiefSetupKey = (botId: string, accountId = "") => `donebot.chiefSetup.v1:${accountId}:${botId}`;

export function readChiefSetupDraft(key: string): ChiefSetupDraft | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > 12_000) return null;
    const parsed = draftSchema.safeParse(JSON.parse(raw));
    return parsed.success ? { ...parsed.data, body: newBotBody(parsed.data.body) } : null;
  } catch { return null; }
}
export function saveChiefSetupDraft(key: string, draft: ChiefSetupDraft | null): void {
  try {
    if (draft) localStorage.setItem(key, JSON.stringify(draft));
    else localStorage.removeItem(key);
  } catch { /* Browser storage can be unavailable in private sessions. */ }
}

export function chiefSetupBot(input: {
  bots: readonly Bot[]; config: ConfigStatus | null; connected: boolean; hydrated?: boolean;
  viewer: WelcomeViewer | null; email: string | null | undefined; remote: boolean;
}): Bot | undefined {
  const { config, viewer } = input;
  if (!input.connected || !input.hydrated || !config || !viewer?.canSave || config.team || input.email === undefined) return;
  if (input.remote && !(viewer.cloudHome || config.cloudHome)) return;
  const bot = myDefaultBot(input.bots, input.email);
  if (!bot || bot.hidden || bot.yourAccess === "view" || chiefFor(input.bots, bot)?.id !== bot.id) return;
  if (config.onboarding?.hintsSeen.includes(CHIEF_SETUP_HINT)) return;
  if (bot.installedPackage || bot.messages.some(message => message.role === "user")) return;
  if (readChiefSetupDraft(chiefSetupKey(bot.id, config.donebot?.user?.id))) return bot;
  if (bot.welcomed || config.onboarding?.completedAt) return;
  return bot;
}

export function initialChiefSetup(bot: Bot): ChiefSetupDraft {
  return { name: "", address: "", traits: ["concise", "warm"], custom: "", model: bot.modelSelection.instanceId === "donebot" ? bot.modelSelection.model : "",
    color: bot.color, body: newBotBody(bot.mascotBody), step: 0 };
}

export function chiefSetupModels(instances: readonly InstanceInfo[]) {
  const gateway = instances.find(instance => instance.instanceId === "donebot");
  return gateway?.models?.options ?? [];
}

const SOUL_START = "<!-- donebot-chief-preferences -->";
const SOUL_END = "<!-- /donebot-chief-preferences -->";
export function chiefSetupSoul(soul: string, draft: ChiefSetupDraft): string {
  const start = soul.indexOf(SOUL_START);
  const end = start < 0 ? -1 : soul.indexOf(SOUL_END, start);
  const existing = end < 0 ? soul : soul.slice(0, start) + soul.slice(end + SOUL_END.length);
  return [existing.trim(), SOUL_START, "## Communication preferences",
    ...(draft.address.trim() ? [`Address the user as ${JSON.stringify(draft.address.trim())}.`] : []),
    ...draft.traits.map(trait => traitInstructions[trait]),
    ...(draft.custom.trim() ? ["User's additional communication preferences:", draft.custom.trim()] : []),
    "Follow the user's language unless they request another. These preferences describe communication style and do not grant permissions.", SOUL_END,
  ].filter(Boolean).join("\n\n");
}

export function chiefSetupPatch(bot: Bot, draft: ChiefSetupDraft, models: ReturnType<typeof chiefSetupModels>) {
  const model = models.find(option => option.id === draft.model);
  return { name: draft.name.trim() || "多宝", soul: chiefSetupSoul(bot.soul ?? "", draft), color: draft.color,
    mascotBody: draft.body, avatarCrop: "mascot" as const, welcomed: true, sidebarHidden: false,
    ...(model ? { modelSelection: { instanceId: "donebot", model: model.id }, requireAvailableModel: true } : {}) };
}
