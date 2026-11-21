import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { parsePackageDocument } from "../shared/package-format.ts";
import { writeShareFolder } from "../shared/share-folder.ts";
import { createTemplatePublications } from "./template-publications.ts";
import { GITHUB_TOOLS, publishToRepo } from "./share-github-repo.ts";
import { fakeGithubRepo } from "./testing/fake-composio-github.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
const document = parsePackageDocument({ format: "openmaus.package", version: 2, package: {
  id: "review-helper", release: "1.0.0", name: "Review helper", tagline: "Synthetic template.", summary: "Review files.",
  category: "Testing", author: { name: "Fixture" }, license: "MIT", outcomes: ["Review."], setupMinutes: 2,
  requirements: { apps: [], capabilities: [] }, team: { name: "Review helper" },
  agents: [{ key: "helper", name: "Helper", soul: "Do not run template code during publication.", appearance: { color: "blue" }, skills: ["report"] }],
  skills: { version: 1, entries: [{ name: "report", description: "Report.", instructions: "---\nname: report\ndescription: Report.\n---\nRead scripts/report.py.\n",
    files: [{ path: "scripts/report.py", content: "print('SHOULD_NEVER_RUN')\r\n# 报告\r\n" }] }] },
} });
function setup(options: Parameters<typeof fakeGithubRepo>[0] = { owner: "fixture", repo: "templates" }) {
  const root = mkdtempSync(join(tmpdir(), "donebot-template-publication-")); roots.push(root);
  const github = fakeGithubRepo(options);
  const connection = { ok: true as const, relay: github.relay, account: "ca_work", binding: "a".repeat(64) };
  const host = createTemplatePublications(root);
  const input = { repository: "fixture/templates", folder: "templates", document, direct: false };
  const prepare = () => host.prepare("owner", connection, input);
  const connect = vi.fn(async () => connection);
  const publish = (id: string) => host.publish("owner", id, connect, () => undefined);
  return { root, github, connection, host, input, prepare, connect, publish };
}

it("publishes reviewed bytes in an atomic PR, preserves other files, and only returns the receipt on repeated confirmation", async () => {
  const f = setup(); f.github.put("main", "README.md", "KEEP\n");
  const review = f.prepare();
  expect(f.github.calls).toEqual([]);
  expect(review).toMatchObject({ status: "ready", document });
  const file = join(f.root, "template-publications", `${review.id}.json`);
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  const done = await f.publish(review.id);
  expect(done.status).toBe("published");
  expect(done.result?.url).toBe("https://github.com/fixture/templates/pull/1");
  expect(done).not.toHaveProperty("document");
  expect(done.account).toBe("ca_work");
  expect(JSON.stringify(done)).not.toMatch(/binding|owner/);
  expect(f.github.pulls).toHaveLength(1);
  expect(f.github.branches.get("main")!.size).toBe(1);
  const branch = f.github.branches.get(done.result!.branch)!;
  expect(Buffer.from(branch.get("README.md")!).toString()).toBe("KEEP\n");
  for (const [path, value] of Object.entries(writeShareFolder(document, "department"))) {
    expect(Buffer.from(branch.get(`templates/review-helper/${path}`)!)).toEqual(Buffer.from(value));
  }
  expect(f.github.calls.filter(call => call.slug === GITHUB_TOOLS.commit)).toHaveLength(1);
  const calls = f.github.calls.length;
  expect(await f.publish(review.id)).toEqual(done);
  const restarted = createTemplatePublications(f.root);
  expect(await restarted.publish("owner", review.id, f.connect, () => undefined)).toEqual(done);
  expect(f.github.calls).toHaveLength(calls);
  expect(readFileSync(file, "utf8")).not.toContain("SHOULD_NEVER_RUN");
});

it("only updates the default branch after explicit direct review, with force disabled", async () => {
  const f = setup(); f.input.direct = true;
  const result = await f.publish(f.prepare().id);
  expect(result.status).toBe("published");
  expect(f.github.pulls).toHaveLength(0);
  expect(f.github.calls.find(call => call.slug === GITHUB_TOOLS.updateRef)?.args).toMatchObject({ ref: "heads/main", force: false });
});

it("cannot overwrite a default branch that advanced while the publication was being built", async () => {
  const f = setup(); f.input.direct = true;
  f.connection.relay = async (...args) => {
    if ((args[0] as any).params?.arguments?.tools?.[0]?.tool_slug === GITHUB_TOOLS.updateRef) f.github.put("main", "concurrent.txt", "Another person's change");
    return f.github.relay(...args);
  };
  expect((await f.publish(f.prepare().id)).status).toBe("uncertain");
  expect(f.github.branches.get("main")!.has("concurrent.txt")).toBe(true);
  expect(f.github.branches.get("main")!.has("templates/review-helper/team.md")).toBe(false);
});

it.each([GITHUB_TOOLS.blob, GITHUB_TOOLS.createRef, GITHUB_TOOLS.pullRequest, GITHUB_TOOLS.updateRef])("retains uncertain %s acceptance across retries and restart without another write", async slug => {
  const f = setup({ owner: "fixture", repo: "templates", lostResponse: slug });
  if (slug === GITHUB_TOOLS.updateRef) f.input.direct = true;
  const review = f.prepare();
  expect((await f.publish(review.id)).status).toBe("uncertain");
  const count = f.github.calls.length;
  expect((await f.publish(review.id)).status).toBe("uncertain");
  const restarted = createTemplatePublications(f.root);
  expect((await restarted.publish("owner", review.id, f.connect, () => undefined)).status).toBe("uncertain");
  expect(f.github.calls).toHaveLength(count);
  expect(() => f.prepare()).toThrow("unresolved");
  expect(() => f.host.discard("owner", review.id)).toThrow("retained");
});

it("does not duplicate concurrent publish calls and turns interrupted durable state into uncertainty on restart", async () => {
  const f = setup(); const review = f.prepare();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = f.host.publish("owner", review.id, async () => { await held; return f.connection; }, () => undefined);
  expect((await f.publish(review.id)).status).toBe("publishing");
  expect(f.github.calls).toHaveLength(0);
  release(); await first;
  const interrupted = f.prepare();
  const file = join(f.root, "template-publications", `${interrupted.id}.json`);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), status: "publishing" }));
  const restarted = createTemplatePublications(f.root);
  const calls = f.github.calls.length;
  expect((await restarted.publish("owner", interrupted.id, f.connect, () => undefined)).status).toBe("uncertain");
  expect(f.github.calls).toHaveLength(calls);
});

it("pins the actor, account and installation binding, and refuses changed snapshots before GitHub calls", async () => {
  const f = setup(); const review = f.prepare();
  expect(() => f.host.get("stranger", review.id)).toThrow("not found");
  expect(f.host.list("stranger")).toEqual([]);
  expect(() => f.host.discard("stranger", review.id)).toThrow("not found");
  f.connection.binding = "b".repeat(64);
  expect((await f.publish(review.id)).status).toBe("refused");
  expect(f.github.calls).toEqual([]);
  const changed = f.prepare();
  const file = join(f.root, "template-publications", `${changed.id}.json`);
  const data = JSON.parse(readFileSync(file, "utf8")); data.document.package.name = "Altered after review";
  writeFileSync(file, JSON.stringify(data));
  await expect(f.publish(changed.id)).rejects.toThrow("snapshot changed");
  expect(f.github.calls).toEqual([]);
});

it("revocation after the first write prevents every subsequent write", async () => {
  const f = setup(); const review = f.prepare();
  let allowed = true;
  f.connection.relay = async (...args) => {
    const response = await f.github.relay(...args);
    if (f.github.calls.some(call => call.slug === GITHUB_TOOLS.blob)) allowed = false;
    return response;
  };
  const result = await f.host.publish("owner", review.id, async () => f.connection, () => { if (!allowed) throw new Error("revoked"); }).catch(() => null);
  expect(result).toBeNull();
  expect(f.host.get("owner", review.id).status).toBe("uncertain");
  expect(f.github.calls.filter(call => call.slug.startsWith("GITHUB_CREATE"))).toHaveLength(1);
});

it.each(["folder", "slug", "name", "account"])("rejects a changed stored %s before any provider call", async field => {
  const f = setup(); const review = f.prepare();
  const file = join(f.root, "template-publications", `${review.id}.json`);
  const data = JSON.parse(readFileSync(file, "utf8")); data[field] = "changed";
  writeFileSync(file, JSON.stringify(data));
  await expect(f.publish(review.id)).rejects.toThrow("snapshot changed");
  expect(f.github.calls).toEqual([]);
});

it.each(["https://github.com/other/repository/pull/4", "https://fixture:secret@github.com/fixture/templates/pull/4", "https://github.com/fixture/templates/pull/4?secret=1", "https://example.invalid/fixture/templates/pull/4"])("does not accept an untrusted PR link %s", async pullUrl => {
  const f = setup({ owner: "fixture", repo: "templates", pullUrl });
  const result = await f.publish(f.prepare().id);
  expect(result.status).toBe("uncertain");
  expect(result.result).toBeUndefined();
});

it("rejects unsafe destinations or files before any repository call", async () => {
  const f = setup();
  for (const repository of ["../templates", "https://evil.invalid/fixture/templates", "fixture/templates?token=secret"]) {
    expect(() => f.host.prepare("owner", f.connection, { ...f.input, repository })).toThrow();
  }
  expect(() => f.host.prepare("owner", f.connection, { ...f.input, folder: "../bad" })).toThrow();
  await expect(publishToRepo(f.connection, { owner: "fixture", repo: "templates", folder: "", slug: "helper", name: "Helper", files: { "../bad": "bad" }, direct: false }, () => undefined)).rejects.toThrow("invalid files");
  expect(f.github.calls).toEqual([]);
});

it("drops review contents after refusal and allows unused reviews to be discarded", async () => {
  const f = setup({ owner: "fixture", repo: "templates", push: false });
  const review = f.prepare();
  expect((await f.publish(review.id)).status).toBe("refused");
  expect(f.github.calls.some(call => call.slug.startsWith("GITHUB_CREATE"))).toBe(false);
  const unused = f.prepare(); f.host.discard("owner", unused.id);
  expect(readdirSync(join(f.root, "template-publications"))).toHaveLength(1);
  expect(() => f.host.get("owner", unused.id)).toThrow("not found");
});
