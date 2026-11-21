import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { parsePackageDocument } from "../shared/package-format.ts";
import { parseBotPackage } from "./bot-package.ts";

it("imports, previews, exports and copies reviewed scripts without running them or carrying unlisted files", async () => {
  const fixture = await launchVerificationServer();
  console.log(JSON.stringify({ fixture: fixture.info }));
  const url = fixture.info.url;
  const post = (path: string, body: unknown) => request(path, { method: "POST", body: JSON.stringify(body) }, url);
  const command = (...args: string[]) => runControlOmb([...args, "--url", url]);
  const script = "import os\ntoken = os.environ['REPORT_TOKEN']\nraise RuntimeError('SCRIPT_MUST_NOT_RUN')\n";
  const skillMd = "---\nname: report\ndescription: Report steps.\n---\nRead references/guide.md and run scripts/report.py only when asked.\n";
  const files = [{ path: "references/guide.md", content: "# Fixture report guide\n" }, { path: "scripts/report.py", content: script }];
  const document = {
    format: "openmaus.package", version: 2,
    package: { id: "script-reporter", release: "1.0.0", name: "Script reporter", tagline: "Isolated report.", summary: "Keep scripts inert.",
      category: "Testing", author: { name: "Fixture" }, license: "MIT", outcomes: ["Review code."], setupMinutes: 2,
      requirements: { apps: [], capabilities: [] }, team: { name: "Reports" },
      agents: [{ key: "reporter", name: "Script reporter", appearance: { color: "blue" }, skills: ["report"] }],
      skills: { version: 1, entries: [{ name: "report", description: "Report steps.", instructions: skillMd, files }] } },
  };
  try {
    expect(await command("doctor")).toMatchObject({ ok: true });
    const original = await request("/api/bots", {}, url);
    const root = join(fixture.info.dataDir, "workspaces");
    const workspaceNames = () => existsSync(root) ? readdirSync(root).sort() : [];
    const before = workspaceNames();
    for (const bad of [[{ path: "../escape.sh", content: "echo escaped" }], [{ path: "call.sh", content: `ghp_${"a".repeat(36)}` }],
      [{ path: "a", content: "a" }, { path: "a/b", content: "b" }]]) {
      const rejected = structuredClone(document);
      rejected.package.skills.entries[0]!.files = bad;
      await expect(post("/api/teams/import", rejected)).rejects.toThrow();
      expect(await request("/api/bots", {}, url)).toEqual(original);
      expect(workspaceNames()).toEqual(before);
    }
    const added = await post("/api/teams/import", document);
    const source = added.bots[0];
    const sourceFolder = join(root, source.id, "skills", "report");
    for (const file of files) expect(readFileSync(join(sourceFolder, file.path), "utf8")).toBe(file.content);
    expect((await request(`/api/bots/${source.id}/skills`, {}, url)).skills).toMatchObject([{ name: "report", enabled: false, files: files.map(file => file.path) }]);
    writeFileSync(join(sourceFolder, "unlisted.txt"), "UNLISTED_PRIVATE_FIXTURE");
    const body = { format: "package", version: 2, team: added.section, dryRun: true };
    const exported = await post("/api/teams/export", body);
    expect(exported.skipped).toEqual([]);
    expect(parsePackageDocument(exported.document).package.skills?.entries[0]?.files).toEqual(files);
    expect(JSON.stringify(exported)).not.toContain("UNLISTED_PRIVATE_FIXTURE");
    const oldExport = await post("/api/teams/export", { format: "package", skillIds: ["report"] });
    expect(parseBotPackage(oldExport.markdown).package.skills?.entries[0]?.files).toEqual(files);
    const copy = (await post("/api/teams/import", exported.document)).bots[0];
    expect(readFileSync(join(root, copy.id, "skills/report/scripts/report.py"), "utf8")).toBe(script);
    expect((await request(`/api/bots/${copy.id}/skills`, {}, url)).skills[0]).toMatchObject({ name: "report", enabled: false });
    await command("send", "--bot", copy.id, "--text", "Confirm this isolated copy is ready.");
    expect(await command("wait", "--bot", copy.id, "--timeout", "30")).toMatchObject({ status: "settled" });
    expect(readFileSync(fixture.fixtureDumpPath, "utf8")).not.toContain("SCRIPT_MUST_NOT_RUN");
    const checkpoint = join(root, source.id, "skills/report/scripts/report.py");
    writeFileSync(checkpoint, "changed after review\n");
    const changed = await post("/api/teams/export", body);
    expect(changed.skipped).toContainEqual({ part: "skills[report]", reason: "skill_changed" });
    expect(changed.document.package.skills).toBeUndefined();
    await expect(post("/api/teams/export", { ...body, skills: ["report"] })).rejects.toThrow();
    await expect(request(`/api/bots/${source.id}/skills/report`, { method: "PATCH", body: JSON.stringify({ enabled: true }) }, url)).rejects.toThrow();
    expect(existsSync(join(root, "escape.sh"))).toBe(false);
    console.log(JSON.stringify({ ok: true, reviewedScriptRoundTrip: true, importDoesNotExecute: true, unlistedFilesExcluded: true, changedFilesRejected: true, logPath: fixture.info.logPath }));
  } finally { await fixture.close(); }
}, 90_000);
