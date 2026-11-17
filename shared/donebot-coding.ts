export const DONEBOT_CODING = {
  codex: { instanceId: "donebot-codex", name: "Codex · DoneBot gateway", driver: "codex" },
  claude: { instanceId: "donebot-claude", name: "Claude Code · DoneBot gateway", driver: "claudeAgent" },
} as const;
export type DoneBotCodingEngine = keyof typeof DONEBOT_CODING;
export const subscriptionCodingId = (engine: DoneBotCodingEngine) => `${DONEBOT_CODING[engine].instanceId}-subscription`;
export const isDoneBotCodingInstance = (id: string): boolean => Object.values(DONEBOT_CODING).some(engine => engine.instanceId === id || `${engine.instanceId}-subscription` === id);
export const codingInstanceAction = (path: string, method: string): boolean => method === "POST" && (
  /^\/api\/instances\/donebot-(?:codex|claude)(?:-subscription)?\/(?:install|refresh-models|check)$/.test(path) ||
  /^\/api\/instances\/donebot-(?:codex|claude)-subscription\/auth\/(?:start|complete|cancel|sign-out)$/.test(path));
