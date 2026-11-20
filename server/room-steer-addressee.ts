import type { GroupDefaultResponder } from "../shared/wire.ts";

export function roomLeadId(defaultResponder: GroupDefaultResponder): string | undefined {
  if (defaultResponder.kind === "member") return defaultResponder.botId;
  if (defaultResponder.kind === "auto") return defaultResponder.fallbackBotId;
  return undefined;
}

export function steerMeantForSpeaker(input: {
  speakerId: string;
  mentioned: readonly string[];
  leadId: string | undefined;
  speakerOnHandedWork: boolean;
}): boolean {
  if (input.mentioned.length > 0) return input.mentioned.includes(input.speakerId);
  return !input.speakerOnHandedWork || input.leadId === input.speakerId;
}
