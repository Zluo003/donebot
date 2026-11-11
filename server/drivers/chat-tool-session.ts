import { ChatToolSessionError, type ChatToolSession } from "./chat-mcp-tools.ts";
import { ChatProtocolError } from "./openai-chat-protocol.ts";

export type LocalChatTools = Pick<ChatToolSession, "definitions" | "validate" | "view" | "execute" | "close">;

export async function mountChatToolSession(
  local: LocalChatTools | undefined,
  mount: (reservedTools?: number) => Promise<ChatToolSession>,
): Promise<ChatToolSession> {
  let mounted: ChatToolSession;
  try {
    mounted = await mount(local?.definitions.length);
  } catch (error) { await local?.close(); throw error; }
  if (!local) return mounted;
  const names = new Set(local.definitions.map(({ function: fn }) => fn.name));
  if (mounted.definitions.some(({ function: fn }) => names.has(fn.name))) {
    await Promise.allSettled([local.close(), mounted.close()]);
    throw new ChatProtocolError("Local tools collide with an MCP tool name");
  }
  const tools: ChatToolSession = {
    ...mounted,
    definitions: [...local.definitions, ...mounted.definitions],
    refit: async (limit) => {
      await mounted.refit(limit);
      tools.definitions.splice(0, tools.definitions.length, ...local.definitions, ...mounted.definitions);
      tools.budget.listed += local.definitions.length;
    },
    validate: (name, args) => (names.has(name) ? local : mounted).validate(name, args),
    view: (name, args) => (names.has(name) ? local : mounted).view(name, args),
    execute: (name, args, signal) => (names.has(name) ? local : mounted).execute(name, args, signal),
    close: async () => {
      const ended = await Promise.allSettled([local.close(), mounted.close()]);
      if (ended.some((one) => one.status === "rejected")) throw new ChatToolSessionError("Tool shutdown could not be confirmed");
    },
  };
  tools.budget.listed += local.definitions.length;
  return tools;
}
