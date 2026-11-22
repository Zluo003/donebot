export type ExternalCodingAgentId =
  | "claude"
  | "codex"
  | "antigravity"
  | "deepseek"
  | "zcode";

export type ExternalCodingAgentDriverKind =
  | "claudeAgent"
  | "codex"
  | "antigravityAgent"
  | "deepseekAgent"
  | "zcodeAgent";

export interface ExternalCodingAgentSpec {
  readonly id: ExternalCodingAgentId;
  readonly instanceId: string;
  readonly driverKind: ExternalCodingAgentDriverKind;
  readonly name: string;
  readonly displayName: string;
  readonly vendor: string;
  readonly tagline: string;
  readonly defaultColor: "orange" | "blue" | "teal" | "purple" | "green";
  readonly defaultTitle: string;
  readonly defaultDescription: string;
  readonly loginGuide: string;
  readonly docsUrl: string;
  readonly supportsInAppAuth: boolean;
  readonly supportsManagedInstall: boolean;
}

export const EXTERNAL_CODING_AGENTS: readonly ExternalCodingAgentSpec[] = [
  {
    id: "claude",
    instanceId: "coding-claude",
    driverKind: "claudeAgent",
    name: "Claude Code",
    displayName: "Claude Code",
    vendor: "Anthropic",
    tagline: "Anthropic 官方本地编程 Agent，沿用你本机 Claude 订阅或登录态",
    defaultColor: "orange",
    defaultTitle: "Claude Code 编程助手",
    defaultDescription: "直连本机 Claude Code 引擎，使用你自己的 Claude 订阅完成代码分析、重构与调试。",
    loginGuide: "在 Claude 桌面端或终端执行 claude login 完成登录后，点击重新检测即可使用。",
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code",
    supportsInAppAuth: true,
    supportsManagedInstall: false,
  },
  {
    id: "codex",
    instanceId: "coding-codex",
    driverKind: "codex",
    name: "Codex",
    displayName: "Codex",
    vendor: "OpenAI",
    tagline: "OpenAI 官方本地编程 Agent，沿用你本机 ChatGPT / Codex 订阅",
    defaultColor: "green",
    defaultTitle: "Codex 编程助手",
    defaultDescription: "直连本机 Codex 引擎，使用你自己的 ChatGPT / OpenAI 订阅执行工程开发与测试。",
    loginGuide: "在 Codex / ChatGPT 桌面端登录或执行 codex login 后，点击重新检测即可使用。",
    docsUrl: "https://developers.openai.com/codex",
    supportsInAppAuth: true,
    supportsManagedInstall: false,
  },
  {
    id: "antigravity",
    instanceId: "coding-antigravity",
    driverKind: "antigravityAgent",
    name: "Antigravity",
    displayName: "Antigravity",
    vendor: "Google",
    tagline: "Google 官方本地编程 Agent，沿用你自己的 Google / Antigravity 账号",
    defaultColor: "blue",
    defaultTitle: "Antigravity 编程助手",
    defaultDescription: "直连 Google 官方 Antigravity 运行时，使用你自己的 Google 账号协作编程。",
    loginGuide: "点击一键安装官方运行时并使用 Google 账号登录，即可直接在 DoneBot 中对话编程。",
    docsUrl: "https://github.com/agentclientprotocol/registry/tree/main/antigravity-acp",
    supportsInAppAuth: true,
    supportsManagedInstall: true,
  },
  {
    id: "deepseek",
    instanceId: "coding-deepseek",
    driverKind: "deepseekAgent",
    name: "DeepSeek Harness",
    displayName: "DeepSeek Harness",
    vendor: "DeepSeek",
    tagline: "DeepSeek 官方本地编程 Agent，自动复用本机 DeepSeek Harness 桌面端或 CLI",
    defaultColor: "blue",
    defaultTitle: "DeepSeek 编程助手",
    defaultDescription: "直连本机 DeepSeek Harness 引擎，沿用你在 DeepSeek 客户端中的账号或密钥。",
    loginGuide: "打开 DeepSeek Harness 桌面端完成登录，或配置 DEEPSEEK_API_KEY 后点击重新检测。",
    docsUrl: "https://github.com/deepseek-ai/deepseek-harness",
    supportsInAppAuth: false,
    supportsManagedInstall: false,
  },
  {
    id: "zcode",
    instanceId: "coding-zcode",
    driverKind: "zcodeAgent",
    name: "ZCode",
    displayName: "ZCode",
    vendor: "智谱 AI",
    tagline: "智谱官方本地编程 Agent，自动复用本机 ZCode 桌面端与智谱订阅",
    defaultColor: "purple",
    defaultTitle: "ZCode 编程助手",
    defaultDescription: "直连本机 ZCode 引擎，沿用你在 ZCode 桌面端登录的智谱 / Z.AI 账号与 Coding Plan。",
    loginGuide: "打开 ZCode 桌面端完成账号登录后，点击重新检测即可直接使用。",
    docsUrl: "https://zcode.bigmodel.cn",
    supportsInAppAuth: false,
    supportsManagedInstall: false,
  },
] as const;

const BY_ID = new Map<string, ExternalCodingAgentSpec>(
  EXTERNAL_CODING_AGENTS.map((agent) => [agent.id, agent]),
);
const BY_INSTANCE_ID = new Map<string, ExternalCodingAgentSpec>(
  EXTERNAL_CODING_AGENTS.map((agent) => [agent.instanceId, agent]),
);
const BY_DRIVER_KIND = new Map<string, ExternalCodingAgentSpec>(
  EXTERNAL_CODING_AGENTS.map((agent) => [agent.driverKind, agent]),
);

export const EXTERNAL_CODING_AGENT_GROUP_REFUSAL =
  "外部本地编程 Agent 仅限个人本地使用，不允许加入群聊或团队群聊。";

export const EXTERNAL_CODING_AGENT_SHARE_REFUSAL =
  "外部本地编程 Agent 仅限个人本地使用，不允许共享到好友或团队。";

export const EXTERNAL_CODING_AGENT_SWITCH_REFUSAL =
  "外部本地编程 Agent 机器人与普通 DoneBot 机器人不可互相切换引擎。";

export function codingAgentById(id?: string | null): ExternalCodingAgentSpec | undefined {
  return id ? BY_ID.get(id) : undefined;
}

export function codingAgentByInstanceId(instanceId?: string | null): ExternalCodingAgentSpec | undefined {
  return instanceId ? BY_INSTANCE_ID.get(instanceId) : undefined;
}

export function codingAgentByDriverKind(driverKind?: string | null): ExternalCodingAgentSpec | undefined {
  return driverKind ? BY_DRIVER_KIND.get(driverKind) : undefined;
}

export function isExternalCodingAgentInstance(instanceId?: string | null): boolean {
  return codingAgentByInstanceId(instanceId) !== undefined;
}

export function isExternalCodingAgentDriver(driverKind?: string | null): boolean {
  return codingAgentByDriverKind(driverKind) !== undefined;
}

export function isExternalCodingAgentBot(
  bot?: { modelSelection?: { instanceId?: string | null } } | null,
): boolean {
  return isExternalCodingAgentInstance(bot?.modelSelection?.instanceId);
}

export type ExternalCodingAgentSource = "desktop" | "cli" | "managed" | "none";

export interface ExternalCodingAgentStatus {
  id: ExternalCodingAgentId;
  instanceId: string;
  driverKind: ExternalCodingAgentDriverKind;
  name: string;
  displayName: string;
  vendor: string;
  tagline: string;
  loginGuide: string;
  docsUrl: string;
  installed: boolean;
  desktopAppDetected: boolean;
  source: ExternalCodingAgentSource;
  cliPath: string | null;
  version: string | null;
  authenticated: boolean;
  account: string | null;
  reason: string | null;
  supportsInAppAuth: boolean;
  supportsManagedInstall: boolean;
  models: {
    default: string;
    options: Array<{ id: string; label: string }>;
  };
  bots: Array<{
    id: string;
    name: string;
    cwd?: string;
  }>;
}
