import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { parsePackageDocument } from "../shared/package-format.ts";
import { writeShareFolder } from "../shared/share-folder.ts";
import { GITHUB_TOOLS } from "./share-github-repo.ts";
import { startBrokerFake } from "./testing/broker-fake.ts";

it("reads a private template through the selected account, previews without writes, imports inert files, and refuses revoked accounts", async () => {
  const document = parsePackageDocument({ format: "openmaus.package", version: 2, package: {
    id: "private-helper", release: "1.0.0", name: "Private fixture", tagline: "Synthetic template.", summary: "Read only declared files.",
    category: "Testing", author: { name: "Fixture" }, license: "MIT", outcomes: ["Review files."], setupMinutes: 2,
    requirements: { apps: [], capabilities: [] }, team: { name: "Private fixture" },
    agents: [{ key: "helper", name: "Private helper", appearance: { color: "blue" }, skills: ["report"] }],
    skills: { version: 1, entries: [{ name: "report", description: "Report steps.",
      instructions: "---\nname: report\ndescription: Report steps.\n---\nRead scripts/report.py.\n",
      files: [{ path: "scripts/report.py", content: "raise RuntimeError('PRIVATE_SCRIPT_MUST_NOT_RUN')\n" }] }] },
  } });
  const files = writeShareFolder(document, "department");
  const reads: Array<{ user: string; slug: string; args: Record<string, string> }> = [];
  let fixture: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
  const broker = await startBrokerFake({ mcpAnswer(user, params) {
    const tool = (params.arguments as { tools?: Array<{ tool_slug: string; account: string; arguments: Record<string, string> }> })?.tools?.[0];
    if (!tool || !Object.values(GITHUB_TOOLS).includes(tool.tool_slug as never)) return undefined;
    reads.push({ user, slug: tool.tool_slug, args: { ...tool.arguments, account: tool.account } });
    let data: unknown;
    const file = files[tool.arguments.path!];
    if (tool.tool_slug === GITHUB_TOOLS.repository) data = { default_branch: "main" };
    else if (tool.tool_slug === GITHUB_TOOLS.content && file !== undefined) data = {
      type: "file", encoding: "base64", size: Buffer.byteLength(file), content: Buffer.from(file).toString("base64"),
    };
    return { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { results: [{ tool_slug: tool.tool_slug,
      response: data === undefined ? { successful: false, error: "404 Not Found" } : { successful: true, data } }] } }) }] };
  } });
  try {
    const owner = await broker.install();
    const first = broker.account(owner.userId, "github", "personal");
    const second = broker.account(owner.userId, "github", "work");
    const stranger = broker.account("another-user", "github", "secret account");
    fixture = await launchVerificationServer({ ...process.env, DONEBOT_COMPOSIO_BROKER_URL: broker.url, DONEBOT_COMPOSIO_BROKER_TOKEN: owner.token });
    console.info(JSON.stringify({ fixture: fixture.info, broker: broker.url }));
    const api = async (path: string, body?: unknown, status = 200) => {
      const response = await fetch(`${fixture!.info.url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin: fixture!.info.url, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json();
      expect(response.status, `${path}: ${JSON.stringify(value)}`).toBe(status);
      return value as any;
    };
    const before = await api("/api/bots");
    expect((await api("/api/templates/github/accounts")).accounts).toEqual(expect.arrayContaining([{ id: first, alias: "personal" }, { id: second, alias: "work" }]));
    const input = { url: "https://github.com/fixture/private", private: true };
    await api("/api/templates/github", input, 409);
    await api("/api/templates/github", { ...input, account: stranger }, 409);
    await api("/api/templates/github", { ...input, url: "https://example.invalid/repo", account: second }, 400);
    expect(reads).toEqual([]);
    const preview = await api("/api/templates/github", { ...input, account: second });
    expect(preview).toEqual(document);
    expect(await api("/api/bots")).toEqual(before);
    expect(reads.every(read => read.user === owner.userId && read.args.account === second)).toBe(true);
    expect(reads.filter(read => read.slug === GITHUB_TOOLS.content).map(read => read.args.path)).toEqual(["bot.md", "team.md", "skills/report/SKILL.md", "skills/report/scripts/report.py"]);
    const added = await api("/api/teams/import", preview, 201);
    expect((await api(`/api/bots/${added.bots[0].id}/skills`)).skills).toMatchObject([{ name: "report", enabled: false }]);
    expect(readFileSync(join(fixture.info.dataDir, "workspaces", added.bots[0].id, "skills/report/scripts/report.py"), "utf8")).toBe(document.package.skills!.entries[0]!.files![0]!.content);
    const folder = await api("/api/templates/folder", { files: { ...files, "private-notes.txt": "NOT_SHARED" } });
    expect(folder).toEqual(document);
    expect(JSON.stringify(folder)).not.toContain("NOT_SHARED");
    const damaged = { ...files }; delete damaged["skills/report/scripts/report.py"];
    await api("/api/templates/folder", { files: damaged }, 400);
    await broker.expire(second);
    const calls = reads.length;
    await api("/api/templates/github", { ...input, account: second }, 409);
    expect(reads).toHaveLength(calls);
    expect(existsSync(fixture.fixtureDumpPath)).toBe(false);
    const receipt = { ok: true, selectedAccount: second, declaredFilesOnly: true, revokedAccountRefused: true, skillsDisabled: true, reads };
    writeFileSync(`${fixture.info.logPath}.templates.json`, JSON.stringify(receipt, null, 2));
    console.info(JSON.stringify(receipt));
  } finally { await fixture?.close(); await broker.close(); }
}, 90_000);
