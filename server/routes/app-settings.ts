import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

export const INTERNAL_APP_SETTINGS_PATH = "/api/internal/app-settings";

/** Dispatch only inside the opaque agents capability gate with its guarded body reader. */
export function createInternalAppSettingsRoutes(deps: {
  readBody(): ReturnType<RouteContext["readBody"]>;
  handle(body: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
}): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (method !== "POST" || path !== INTERNAL_APP_SETTINGS_PATH) return PASS;
    const result = await deps.handle(await deps.readBody());
    return json(res, result.status, result.body);
  };
}
