import { z } from "zod";
import { PackageFormatError } from "../../shared/package-format.ts";
import { readShareFolder, SHARE_FOLDER_MAX_BYTES } from "../../shared/share-folder.ts";
import { TEAM_TEMPLATE_SLUG } from "../../shared/team-templates.ts";
import type { RequestAuth } from "../request-auth.ts";
import { TeamFilesError, type TeamFilesActor } from "../host/team-files.ts";
import type { TeamTemplates } from "../team-templates.ts";
import { PASS, type RouteHandler } from "./table.ts";

const revision = z.string().regex(/^[a-f0-9]{64}$/);
const publishInput = z.object({
  confirm: z.literal(true), slug: z.string().regex(TEAM_TEMPLATE_SLUG), scope: z.enum(["bot", "department"]),
  revision: revision.nullable(), document: z.unknown(),
}).strict();
const removeInput = z.object({ confirm: z.literal(true), revision }).strict();

export function createTeamTemplateRoutes(deps: { templates: TeamTemplates | null; actor(auth: RequestAuth): TeamFilesActor | null }): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/team-templates" && !path.startsWith("/api/team-templates/")) return PASS;
    const templates = deps.templates;
    if (!templates) return PASS;
    res.setHeader("cache-control", "private, no-store");
    const actor = deps.actor(auth);
    if (!actor) { req.resume(); return json(res, 403, { error: "Sign in to the team to read its templates.", code: "forbidden" }); }
    const assertActor = () => {
      const current = deps.actor(auth);
      if (req.aborted || res.destroyed || !current || current.person !== actor.person || current.admin !== actor.admin) throw new TeamFilesError(403, "forbidden", "Team access changed. Reconnect before using templates.");
    };
    const slug = path.startsWith("/api/team-templates/") ? path.slice("/api/team-templates/".length) : null;
    if (slug !== null && !TEAM_TEMPLATE_SLUG.test(slug)) { req.resume(); return json(res, 404, { error: "Template not found.", code: "not_found" }); }
    try {
      assertActor();
      if (method === "GET") {
        if (slug === null) return json(res, 200, { templates: templates.list(), admin: actor.admin });
        const entry = templates.list().find(template => template.slug === slug);
        if (!entry) return json(res, 404, { error: "Template not found.", code: "not_found" });
        const parsed = readShareFolder(templates.files(slug));
        if (parsed.kind !== "package") throw new TeamFilesError(400, "bad_path", "This template is not a supported package.");
        assertActor();
        return json(res, 200, { template: entry, document: parsed.document });
      }
      if (!(method === "POST" && slug === null || method === "DELETE" && slug !== null)) { req.resume(); return json(res, 405, { error: "method not allowed" }); }
      if (!actor.admin) { req.resume(); return json(res, 403, { error: "Only an administrator can publish or remove templates.", code: "forbidden" }); }
      const body = await readBody(req, SHARE_FOLDER_MAX_BYTES * 2);
      assertActor();
      if (method === "POST") {
        const input = publishInput.parse(body);
        const result = templates.add(input.slug, input.document, input.scope, actor, assertActor, input.revision);
        return json(res, 201, result);
      }
      const input = removeInput.parse(body);
      templates.remove(slug!, actor, assertActor, input.revision);
      return json(res, 200, { removed: true });
    } catch (error) {
      if (!req.readableEnded) req.resume();
      if (error instanceof TeamFilesError) return json(res, error.status, { error: error.message, code: error.code });
      if (error instanceof PackageFormatError) return json(res, 400, { error: error.message, code: error.code });
      if (error instanceof z.ZodError) return json(res, 400, { error: "Review the template, its current revision and the confirmation before publishing or removing it.", code: "bad_path" });
      if (error instanceof Error && "status" in error && (error.status === 400 || error.status === 413)) return json(res, error.status, { error: error.status === 413 ? "The template request is too large." : "Send a valid template JSON request.", code: error.status === 413 ? "too_large" : "bad_path" });
      return json(res, 503, { error: "The template library could not complete the request. Refresh its state before trying again.", code: "unavailable" });
    }
  };
}
