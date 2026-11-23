import { DoneBotGatewayError, type DoneBotCredential } from "./gateway.ts";

export interface CollabGatewayTransport {
  readonly origin: string;
  readonly fetcher: typeof fetch;
  readonly controllers: Set<AbortController>;
  epoch(): number;
  checkEpoch(epoch: number): void;
  validSession(): Promise<DoneBotCredential>;
  readGatewayJson(res: Response): Promise<unknown>;
}

export const COLLAB_TRANSFER_TIMEOUT_MS = 15 * 60_000;

function extractGatewayError(value: unknown, status: number, fallback: string): string {
  if (value && typeof value === "object") {
    const rec = value as { message?: unknown; error?: unknown };
    if (typeof rec.message === "string" && rec.message.trim()) return rec.message.trim();
    if (typeof rec.error === "string" && rec.error.trim()) return rec.error.trim();
  }
  return status === 401 ? "登录或安装凭据已失效，请重新登录。" : fallback;
}

export async function collabJsonCall(
  ctx: CollabGatewayTransport,
  mode: "user" | "runtime",
  fullPath: string,
  method: string,
  body?: unknown,
  timeoutMs = 15_000,
): Promise<unknown> {
  const epoch = ctx.epoch();
  const session = await ctx.validSession();
  ctx.checkEpoch(epoch);
  if (mode === "user" && session.mode === "installation") {
    throw new DoneBotGatewayError(403, "collab_login_required", "请在本机登录 DoneBot 账号后使用远程协作。");
  }
  const controller = new AbortController();
  ctx.controllers.add(controller);
  const headers: Record<string, string> = mode === "runtime"
    ? { authorization: `Bearer ${session.credential}`, "X-DoneBot-Installation": session.installationId, "content-type": "application/json" }
    : { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json" };
  try {
    const response = await ctx.fetcher(`${ctx.origin}${fullPath}`, {
      method,
      redirect: "error",
      credentials: "omit",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
    });
    const value = await ctx.readGatewayJson(response) as { code?: number; data?: unknown };
    ctx.checkEpoch(epoch);
    if (!response.ok || (value.code !== undefined && value.code !== 0)) {
      throw new DoneBotGatewayError(
        response.status,
        mode === "runtime" ? "collab_runtime_failed" : "collab_request_failed",
        extractGatewayError(value, response.status, "远程协作请求失败，请稍后重试。"),
      );
    }
    return value.code === 0 && "data" in value ? value.data : value;
  } finally {
    ctx.controllers.delete(controller);
  }
}

export async function collabStreamCall(
  ctx: CollabGatewayTransport,
  mode: "auto" | "runtime",
  pathBuilder: (runtime: boolean) => string,
  options: {
    method: "GET" | "POST" | "PUT";
    body?: ReadableStream<Uint8Array> | Uint8Array | Buffer;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<Response> {
  const epoch = ctx.epoch();
  const session = await ctx.validSession();
  ctx.checkEpoch(epoch);
  const useRuntime = mode === "runtime" || session.mode === "installation";
  const controller = new AbortController();
  ctx.controllers.add(controller);
  const headers = new Headers(options.headers);
  for (const key of ["authorization", "cookie", "proxy-authorization", "host"]) headers.delete(key);
  if (useRuntime) {
    headers.set("authorization", `Bearer ${session.credential}`);
    headers.set("X-DoneBot-Installation", session.installationId);
  } else {
    headers.set("authorization", `Bearer ${session.accessToken}`);
  }
  const timeout = AbortSignal.timeout(options.timeoutMs ?? COLLAB_TRANSFER_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal, timeout])
    : AbortSignal.any([controller.signal, timeout]);
  const release = () => { ctx.controllers.delete(controller); };
  try {
    const fetchInit: RequestInit & { duplex?: "half" } = {
      method: options.method,
      redirect: "error",
      credentials: "omit",
      headers,
      signal,
      ...(options.body !== undefined ? { body: options.body as RequestInit["body"], duplex: "half" } : {}),
    };
    const response = await ctx.fetcher(`${ctx.origin}${pathBuilder(useRuntime)}`, fetchInit);
    ctx.checkEpoch(epoch);
    if (!response.body) {
      release();
      return response;
    }
    const reader = response.body.getReader();
    let closed = false;
    const done = () => { if (!closed) { closed = true; release(); } };
    const stream = new ReadableStream<Uint8Array>({
      async pull(target) {
        try {
          const next = await reader.read();
          if (next.done) { done(); target.close(); } else target.enqueue(next.value);
        } catch (error) {
          done();
          target.error(error);
        }
      },
      async cancel(reason) {
        done();
        controller.abort(reason);
        await reader.cancel(reason).catch(() => {});
      },
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    release();
    throw error;
  }
}

export function collabSetTeamAvatar(ctx: CollabGatewayTransport, teamId: string, avatarUrl: string) {
  return collabJsonCall(ctx, "user", `/api/v1/donebot/teams/${teamId}/avatar`, "PUT", { avatar_url: avatarUrl });
}
export function collabListGroups(ctx: CollabGatewayTransport) {
  return collabJsonCall(ctx, "user", "/api/v1/donebot/collab/groups", "GET");
}
export function collabCreateGroup(ctx: CollabGatewayTransport, name: string, memberIds: number[]) {
  return collabJsonCall(ctx, "user", "/api/v1/donebot/collab/groups", "POST", { name, member_ids: memberIds });
}
export function collabRenameGroup(ctx: CollabGatewayTransport, groupId: string, name: string) {
  return collabJsonCall(ctx, "user", `/api/v1/donebot/collab/groups/${groupId}`, "PATCH", { name });
}
export function collabSetGroupAvatar(ctx: CollabGatewayTransport, groupId: string, avatarUrl: string) {
  return collabJsonCall(ctx, "user", `/api/v1/donebot/collab/groups/${groupId}/avatar`, "PUT", { avatar_url: avatarUrl });
}
export function collabAddGroupMembers(ctx: CollabGatewayTransport, groupId: string, memberIds: number[]) {
  return collabJsonCall(ctx, "user", `/api/v1/donebot/collab/groups/${groupId}/members`, "POST", { member_ids: memberIds });
}
export function collabLeaveGroup(ctx: CollabGatewayTransport, groupId: string) {
  return collabJsonCall(ctx, "user", `/api/v1/donebot/collab/groups/${groupId}/leave`, "POST", {});
}
export function collabListChatBots(ctx: CollabGatewayTransport, scopeType: string, targetId: string) {
  return collabJsonCall(ctx, "user", `/api/v1/donebot/collab/chats/${scopeType}/${targetId}/bots`, "GET");
}
export function collabAddChatBot(ctx: CollabGatewayTransport, scopeType: string, targetId: string, payload: Record<string, unknown>) {
  return collabJsonCall(ctx, "user", `/api/v1/donebot/collab/chats/${scopeType}/${targetId}/bots`, "POST", payload);
}
export function collabUpdateChatBotGrants(ctx: CollabGatewayTransport, scopeType: string, targetId: string, botId: string, payload: { allow_all_members: boolean; allowed_user_ids: number[] }) {
  return collabJsonCall(ctx, "user", `/api/v1/donebot/collab/chats/${scopeType}/${targetId}/bots/${botId}/grants`, "PUT", payload);
}
export function collabRemoveChatBot(ctx: CollabGatewayTransport, scopeType: string, targetId: string, botId: string) {
  return collabJsonCall(ctx, "user", `/api/v1/donebot/collab/chats/${scopeType}/${targetId}/bots/${botId}`, "DELETE");
}
export function collabClaimBotInvocation(ctx: CollabGatewayTransport, installationId: string) {
  return collabJsonCall(ctx, "user", "/api/v1/donebot/collab/chat-bots/claim", "POST", { installation_id: installationId }, 15_000);
}
export function collabSyncChatBots(ctx: CollabGatewayTransport, installationId: string, bots: Record<string, unknown>[]) {
  return collabJsonCall(ctx, "user", "/api/v1/donebot/collab/chat-bots/sync", "POST", { installation_id: installationId, bots }, 15_000);
}
export function collabReplyBotInvocation(ctx: CollabGatewayTransport, invocationId: string, payload: { body?: string; error?: string }) {
  return collabJsonCall(ctx, "user", `/api/v1/donebot/collab/chat-bots/invocations/${invocationId}/reply`, "POST", payload, 15_000);
}

// --- Team Channels, Member Job Titles & Tasks ---

export function collabListTeamChannels(ctx: CollabGatewayTransport, teamId: string, includeArchived = false) {
  const qs = includeArchived ? "?include_archived=1" : "";
  return collabJsonCall(ctx, "user", `/api/v1/donebot/teams/${teamId}/channels${qs}`, "GET");
}
export function collabCreateTeamChannel(ctx: CollabGatewayTransport, teamId: string, payload: Record<string, unknown>) {
  return collabJsonCall(ctx, "user", `/api/v1/donebot/teams/${teamId}/channels`, "POST", payload);
}
export function collabUpdateTeamChannel(ctx: CollabGatewayTransport, teamId: string, channelId: string, payload: Record<string, unknown>) {
  return collabJsonCall(ctx, "user", `/api/v1/donebot/teams/${teamId}/channels/${channelId}`, "PATCH", payload);
}
export function collabListTeamMemberProfiles(ctx: CollabGatewayTransport, teamId: string) {
  return collabJsonCall(ctx, "user", `/api/v1/donebot/teams/${teamId}/member-profiles`, "GET");
}
export function collabSetTeamMemberJobTitle(ctx: CollabGatewayTransport, teamId: string, userId: number, jobTitle: string) {
  return collabJsonCall(ctx, "user", `/api/v1/donebot/teams/${teamId}/members/${userId}/profile`, "PUT", { job_title: jobTitle });
}
export function collabTeamTaskCounts(ctx: CollabGatewayTransport) {
  return collabJsonCall(ctx, "user", "/api/v1/donebot/collab/tasks/counts", "GET");
}
export function collabListTeamTasks(ctx: CollabGatewayTransport, teamId: string, query: string) {
  return collabJsonCall(ctx, "user", `/api/v1/donebot/teams/${teamId}/tasks${query ? `?${query}` : ""}`, "GET");
}
export function collabCreateTeamTask(ctx: CollabGatewayTransport, teamId: string, payload: Record<string, unknown>) {
  return collabJsonCall(ctx, "user", `/api/v1/donebot/teams/${teamId}/tasks`, "POST", payload);
}
export function collabGetTeamTaskDetail(ctx: CollabGatewayTransport, teamId: string, taskId: string) {
  return collabJsonCall(ctx, "user", `/api/v1/donebot/teams/${teamId}/tasks/${taskId}`, "GET");
}
export function collabUpdateTeamTask(ctx: CollabGatewayTransport, teamId: string, taskId: string, payload: Record<string, unknown>) {
  return collabJsonCall(ctx, "user", `/api/v1/donebot/teams/${teamId}/tasks/${taskId}`, "PATCH", payload);
}
export function collabDeleteTeamTask(ctx: CollabGatewayTransport, teamId: string, taskId: string) {
  return collabJsonCall(ctx, "user", `/api/v1/donebot/teams/${teamId}/tasks/${taskId}`, "DELETE");
}
export function collabAddTeamTaskComment(ctx: CollabGatewayTransport, teamId: string, taskId: string, body: string) {
  return collabJsonCall(ctx, "user", `/api/v1/donebot/teams/${teamId}/tasks/${taskId}/comments`, "POST", { body });
}
export function collabSubmitTeamTask(ctx: CollabGatewayTransport, teamId: string, taskId: string, payload: { body: string; notify_channel: boolean }) {
  return collabJsonCall(ctx, "user", `/api/v1/donebot/teams/${teamId}/tasks/${taskId}/submit`, "POST", payload);
}
export function collabReviewTeamTask(ctx: CollabGatewayTransport, teamId: string, taskId: string, payload: { decision: "approve" | "request_changes"; body: string; notify_channel: boolean }) {
  return collabJsonCall(ctx, "user", `/api/v1/donebot/teams/${teamId}/tasks/${taskId}/review`, "POST", payload);
}
export function collabUploadTeamTaskFile(
  ctx: CollabGatewayTransport,
  teamId: string,
  taskId: string,
  query: string,
  body: ReadableStream<Uint8Array> | Buffer,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  return collabStreamCall(ctx, "auto", () => `/api/v1/donebot/teams/${teamId}/tasks/${taskId}/files${query ? `?${query}` : ""}`, { method: "POST", body, headers, signal });
}
export function collabDownloadTeamTaskFile(
  ctx: CollabGatewayTransport,
  fileId: string,
  inline: boolean,
  signal?: AbortSignal,
  range?: string,
): Promise<Response> {
  return collabStreamCall(ctx, "auto", () => `/api/v1/donebot/collab/tasks/files/${fileId}${inline ? "?inline=1" : ""}`, { method: "GET", headers: range ? { range } : undefined, signal });
}
