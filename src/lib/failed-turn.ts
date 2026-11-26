import { offersSignIn } from "@/components/EngineSetup";
import { t } from "@/lib/i18n";
import { plainErrorLine } from "@/lib/plain-error";
import type { Bot, InstanceInfo, Message } from "@/state/store";
import { failedTurnCause } from "../../shared/failed-turn";
import { toolStepLabel } from "@/lib/tool-step-label";
import { activityText, isNoticeCode } from "@/lib/activity-text";
import { isClientCancellation, isStoppedTurnName } from "../../shared/client-cancel";

export const STATUS_MARKER = /^(?:recovery|notice):\s*/;

export { failedTurnCause };

type ActivityTool = NonNullable<Message["tool"]>;

export function engineSignedOut(engine: InstanceInfo | undefined): boolean {
  return Boolean(engine?.snapshot) && offersSignIn(engine);
}

export function signedOutEngine(tool: ActivityTool, engine: InstanceInfo | undefined): InstanceInfo | undefined {
  return tool.setup && !tool.claudeUpdate && engineSignedOut(engine) ? engine : undefined;
}

export function claudeUpdateTarget(engine: InstanceInfo | undefined): InstanceInfo | undefined {
  return engine?.driverKind === "claudeAgent" && !engine.readOnly ? engine : undefined;
}

export function botEngine(bot: Bot | undefined, instances: InstanceInfo[]): InstanceInfo | undefined {
  return bot && instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
}

export function failedTurnNotice(tool: ActivityTool): { cause: string; notice: string | null } {
  const cause = failedTurnCause(tool.name) ?? tool.name;
  return { cause, notice: isNoticeCode(tool.nameCode) ? activityText(tool, cause) : null };
}

export function failedTurnText(tool: ActivityTool, cause: string): string {
  return isNoticeCode(tool.nameCode) ? activityText(tool, cause) : plainErrorLine(cause) ?? cause;
}

export interface PartialStepView {
  summary: string;
  detail: string;
  refused: boolean;
}

const QUOTED_CALL = /“([^”]+)”/g;

function extractStepNames(clause: string): string[] {
  return [...clause.matchAll(QUOTED_CALL)].map((match) => match[1]!).filter(Boolean);
}

/** Turns the engine's English `toolFailureMessage` into a calm, localized note naming the exact step(s). */
export function describePartialCause(cause: string): PartialStepView {
  const mixed = /^Stopped because the tool calls? (.+?) failed and (.+?) (?:wasn't|weren't) allowed\./.exec(cause);
  if (mixed) {
    const failedNames = extractStepNames(mixed[1]!);
    const refusedNames = extractStepNames(mixed[2]!);
    const all = [...failedNames, ...refusedNames].join("、");
    return {
      summary: all ? t("chat.error.partialStepMixed", { steps: all }) : t("chat.error.partial"),
      detail: t("chat.error.partialDetailRefused"),
      refused: true,
    };
  }
  const refused = /^Stopped because the tool calls? (.+?) (?:wasn't|weren't) allowed\./.exec(cause);
  if (refused) {
    const steps = extractStepNames(refused[1]!).join("、");
    return {
      summary: steps ? t("chat.error.partialStepRefused", { steps }) : t("chat.error.partial"),
      detail: t("chat.error.partialDetailRefused"),
      refused: true,
    };
  }
  const failed = /^Stopped because the tool calls? (.+?) failed\./.exec(cause);
  if (failed) {
    const steps = extractStepNames(failed[1]!).join("、");
    return {
      summary: steps ? t("chat.error.partialStepFailed", { steps }) : t("chat.error.partial"),
      detail: t("chat.error.partialDetailFailed"),
      refused: false,
    };
  }
  return {
    summary: t("chat.error.partial"),
    detail: cause,
    refused: false,
  };
}

export function activityPreview(tool: ActivityTool, engine: InstanceInfo | undefined, dataResult?: Message["dataResult"], advanced = false): string {
  if (dataResult) return dataResult.title;
  if (isStoppedTurnName(tool.name)) return t("chat.turnStopped");
  const cause = failedTurnCause(tool.name);
  if (cause !== null && isClientCancellation(cause)) return t("chat.turnStopped");
  if (cause !== null && tool.partial) return t("chat.error.partialPreview");
  if (cause === null && isNoticeCode(tool.nameCode)) return activityText(tool, tool.name.replace(STATUS_MARKER, ""));
  if (cause === null) return advanced ? tool.name : STATUS_MARKER.test(tool.name) ? tool.name.replace(STATUS_MARKER, "") : toolStepLabel(tool);
  const signedOut = signedOutEngine(tool, engine);
  return signedOut ? t("sidebar.preview.signedOut", { name: signedOut.displayName }) : failedTurnText(tool, cause);
}
