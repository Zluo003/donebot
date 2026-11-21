import { existsSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { GITHUB_TOOLS } from "./share-github-repo.ts";
import { startBrokerFake } from "./testing/broker-fake.ts";
import { fakeGithubRepo } from "./testing/fake-composio-github.ts";

it("exports and reviews a fixed template before publishing through the real broker, without replaying accepted writes", async () => {
  const options = { owner: "fixture", repo: "templates", lostResponse: "" };
  const github = fakeGithubRepo(options);
  github.put("main", "README.md", "Existing repository content\n");
  const accounts: string[] = [];
  const broker = await startBrokerFake({ mcpAnswer(_user, params) {
    const tool = (params.arguments as { tools?: Array<{ tool_slug: string; account: string }> })?.tools?.[0];
    if (!tool || !Object.values(GITHUB_TOOLS).includes(tool.tool_slug as never)) return undefined;
    accounts.push(tool.account);
    return github.answer(params);
  } });
  let fixture: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
  try {
    const owner = await broker.install();
    const personal = broker.account(owner.userId, "github", "personal"), work = broker.account(owner.userId, "github", "work");
    const foreign = broker.account("another-user", "github", "private");
    fixture = await launchVerificationServer({ ...process.env, DONEBOT_COMPOSIO_BROKER_URL: broker.url, DONEBOT_COMPOSIO_BROKER_TOKEN: owner.token });
    console.info(JSON.stringify({ fixture: fixture.info }));
    const api = async (path: string, body?: unknown, status = 200, method = body === undefined ? "GET" : "POST") => {
      const response = await fetch(`${fixture!.info.url}${path}`, { method, headers: { origin: fixture!.info.url, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json();
      expect(response.status, `${path}: ${JSON.stringify(value)}`).toBe(status);
      return value as any;
    };
    const document = { format: "openmaus.package", version: 2, package: {
      id: "review-helper", release: "1.0.0", name: "Publication fixture", tagline: "Synthetic template.", summary: "Review files.", category: "Testing", author: { name: "Fixture" }, license: "MIT", outcomes: ["Review."], setupMinutes: 2,
      requirements: { apps: [], capabilities: [] }, team: { name: "Publication fixture" },
      agents: [{ key: "helper", name: "Publication helper", appearance: { color: "blue" }, skills: ["report"] }],
      skills: { version: 1, entries: [{ name: "report", description: "Report.", instructions: "---\nname: report\ndescription: Report.\n---\nRead scripts/report.py.\n", files: [{ path: "scripts/report.py", content: "raise RuntimeError('PUBLICATION_SCRIPT_MUST_NOT_RUN')\r\n" }] }] },
    } };
    await api("/api/teams/import", document, 201);
    const exported = await api("/api/teams/export", { format: "package", version: 2, team: "Publication fixture", includeMemory: false, skills: "all", dryRun: true });
    const input = { repository: "fixture/templates", folder: "templates", direct: false, document: exported.document, account: work };
    await api("/api/templates/publications", { ...input, account: foreign }, 409);
    const review = await api("/api/templates/publications", input, 201);
    expect(review.document).toEqual(exported.document);
    expect(github.calls).toEqual([]);
    expect((await api(`/api/templates/publications/${review.id}`)).status).toBe("ready");
    await api(`/api/templates/publications/${review.id}/publish`, {}, 400);
    await api(`/api/templates/publications/${review.id}/publish`, { confirm: true, account: personal }, 400);
    expect(github.calls).toEqual([]);
    const published = await api(`/api/templates/publications/${review.id}/publish`, { confirm: true });
    expect(published.status).toBe("published");
    expect(accounts.every(account => account === work)).toBe(true);
    const count = github.calls.length;
    expect(await api(`/api/templates/publications/${review.id}/publish`, { confirm: true })).toEqual(published);
    expect(github.calls).toHaveLength(count);
    expect(github.pulls).toHaveLength(1);
    expect(github.branches.get(published.result.branch)?.get("README.md")).toEqual(new TextEncoder().encode("Existing repository content\n"));
    const scriptPath = `templates/${exported.document.package.id}/skills/report/scripts/report.py`;
    expect(Buffer.from(github.branches.get(published.result.branch)!.get(scriptPath)!)).toEqual(Buffer.from(document.package.skills.entries[0]!.files[0]!.content));
    options.lostResponse = GITHUB_TOOLS.pullRequest;
    const nextInput = { ...input, document: { ...exported.document, package: { ...exported.document.package, release: "1.0.1" } } };
    const uncertainReview = await api("/api/templates/publications", nextInput, 201);
    expect((await api(`/api/templates/publications/${uncertainReview.id}/publish`, { confirm: true })).status).toBe("uncertain");
    const uncertainCount = github.calls.length;
    await api(`/api/templates/publications/${uncertainReview.id}/publish`, { confirm: true });
    await api("/api/templates/publications", nextInput, 409);
    expect(github.calls).toHaveLength(uncertainCount);
    options.lostResponse = "";
    const revoked = await api("/api/templates/publications", { ...input, account: personal }, 201);
    await broker.expire(personal);
    expect((await api(`/api/templates/publications/${revoked.id}/publish`, { confirm: true })).status).toBe("refused");
    expect(github.calls).toHaveLength(uncertainCount);
    expect((await api("/api/templates/publications")).publications).toHaveLength(3);
    expect(existsSync(fixture.fixtureDumpPath)).toBe(false);
    const receipt = { ok: true, fixedSnapshot: true, explicitAccount: true, inertScripts: true, repeatedConfirmationNoWrites: true, acceptedResponseLossNoReplay: true, revocationStopsWrites: true, published, calls: github.calls };
    writeFileSync(`${fixture.info.logPath}.template-publications.json`, JSON.stringify(receipt, null, 2));
    console.info(JSON.stringify(receipt));
  } finally { await fixture?.close(); await broker.close(); }
}, 120_000);
