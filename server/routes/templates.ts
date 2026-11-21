import { z } from "zod";
import { readShareFolder, SHARE_FOLDER_MAX_BYTES, SHARE_FOLDER_MAX_FILES } from "../../shared/share-folder.ts";
import { parseTeamManifest } from "../team-manifest.ts";
import { ownerOrAdmin } from "../request-auth.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { createShareGithubAccess } from "../host/share-github-access.ts";
import { GithubTemplateError, fetchGithubTemplate } from "../share-github.ts";
import { readRepoFolder, repoFolderOf } from "../share-github-repo.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface TemplateRouteDeps {
  github: ReturnType<typeof createShareGithubAccess>;
  accessLive(auth: RequestAuth): boolean;
}

const githubInput = z.object({ url: z.string().min(1).max(2_000), private: z.boolean().optional(), account: z.string().min(1).max(200).optional() }).strict();
const folderInput = z.object({ files: z.record(z.string().max(300), z.string()).refine(files => Object.keys(files).length <= SHARE_FOLDER_MAX_FILES * 4) }).strict();

export function createTemplateRoutes(deps: TemplateRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (!((method === "GET" && path === "/api/templates/github/accounts") ||
      (method === "POST" && (path === "/api/templates/github" || path === "/api/templates/folder")))) return PASS;
    if (!ownerOrAdmin(auth)) return json(res, 403, { error: "Only the workspace owner or an administrator can import templates." });
    const assertActor = () => {
      if (!deps.accessLive(auth)) throw new GithubTemplateError("This session can no longer read templates.", 403);
    };
    try {
      assertActor();
      if (method === "GET") {
        const accounts = await deps.github.accounts();
        assertActor();
        return json(res, 200, { accounts });
      }
      const body = await readBody(req, SHARE_FOLDER_MAX_BYTES * 2);
      assertActor();
      let folder: ReturnType<typeof readShareFolder>;
      if (path.endsWith("/folder")) {
        const input = folderInput.safeParse(body);
        if (!input.success) return json(res, 400, { error: "Choose a template folder containing bot.md or team.md." });
        folder = readShareFolder(input.data.files);
      } else {
        const input = githubInput.safeParse(body);
        if (!input.success) return json(res, 400, { error: "Choose a GitHub template link and an available account." });
        if (input.data.private) {
          const at = repoFolderOf(input.data.url);
          if (!at) return json(res, 400, { error: "Choose an HTTPS GitHub repository, folder, bot.md or team.md link." });
          folder = await readRepoFolder(await deps.github.connect(input.data.account, assertActor), at);
        } else folder = await fetchGithubTemplate(input.data.url);
      }
      assertActor();
      return json(res, 200, folder.kind === "package" ? folder.document : parseTeamManifest(folder.manifest));
    } catch (error) {
      if (error instanceof GithubTemplateError) return json(res, error.status, { error: error.message });
      return json(res, 400, { error: error instanceof Error ? error.message : "The template could not be read." });
    }
  };
}
