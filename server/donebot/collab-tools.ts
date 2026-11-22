import type { ToolCallContext, ToolCallResult } from "../drivers/agents-call.ts";
import type { Json } from "../drivers/agents-client.ts";

export const DONEBOT_COLLAB_TOOL_DEFINITIONS = [
  {
    name: "list_collab_folders",
    description: "List remote folders that friends or team members have shared with the signed-in DoneBot user over the DoneBot gateway. Returns each folder's folder_id, name, owner_email, device_name, access ('read' or 'write'), and whether the host computer is online right now. Always call this before using collab_folder.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "collab_folder",
    description: "Read or edit files inside a remote folder shared by a friend or team member over the DoneBot gateway. Get folder_id from list_collab_folders. Paths are relative to the shared folder root. read_file returns sha256, which is required as expected_sha256 before overwriting with write_file or deleting with delete_file. edit_file replaces old_text once with new_text; append_file appends content. Use base64 encoding for binary files. Write actions require 'write' access. Never substitute local files if the remote computer is offline.",
    annotations: undefined,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        folder_id: { type: "string", format: "uuid", description: "The shared folder_id returned by list_collab_folders." },
        action: { type: "string", enum: ["list_files", "read_file", "write_file", "edit_file", "append_file", "delete_file"] },
        path: { type: "string", maxLength: 2048, description: "Relative path inside the shared folder; omit or empty string for folder root in list_files." },
        content: { type: "string", maxLength: 350_000 },
        encoding: { type: "string", enum: ["utf8", "base64"] },
        old_text: { type: "string", minLength: 1, maxLength: 350_000 },
        new_text: { type: "string", maxLength: 350_000 },
        expected_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      required: ["folder_id", "action"],
    },
  },
];

export const DONEBOT_COLLAB_TOOL_NAMES: ReadonlySet<string> = new Set(DONEBOT_COLLAB_TOOL_DEFINITIONS.map(tool => tool.name));

export async function callDoneBotCollabTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  if (name === "list_collab_folders") {
    const { ok, body } = await context.client.apiResponse("/api/internal/donebot/collab/folders", { method: "POST", body: "{}" });
    return ok ? { text: JSON.stringify(body) } : { text: String(body.error ?? "无法获取远程共享文件夹列表。"), isError: true };
  }
  const { ok, body } = await context.client.apiResponse("/api/internal/donebot/collab/invoke", {
    method: "POST",
    body: JSON.stringify(args ?? {}),
  });
  if (!ok) return { text: String(body.error ?? "远程共享文件夹操作失败。"), isError: true };
  const result = body.result as Json;
  if (Array.isArray(result?.content)) return { text: "", passthrough: result };
  return { text: JSON.stringify(result ?? body) };
}
