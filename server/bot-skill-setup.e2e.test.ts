import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

it("configures a managed bot's full skill folder and custom skill with native tools, scoped receipts and Undo in an isolated workspace", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "donebot-skill-setup-"));
  const gate = join(scratch, "finish");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const api = async (method: string, path: string, body?: unknown, expected = 200, token?: string) => {
    const response = await fetch(fixture.info.url + path, { method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : { origin: fixture.info.url }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    evidence.push({ method, path, status: response.status, result });
    expect(response.status, JSON.stringify(result)).toBe(expected);
    return result;
  };
  const dump = () => { try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); } catch { return {}; } };
  const start = async (bot: any, marker: string) => {
    rmSync(gate, { force: true });
    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", marker, "--url", fixture.info.url]);
    await expect.poll(() => JSON.stringify(dump().prompt), { timeout: hostTimeout(25_000) }).toContain(marker);
    return dump().mcpConfig.mcpServers.agents.env.DONEBOT_COMMS_TOKEN as string;
  };
  const finish = async () => {
    writeFileSync(gate, "finish");
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).bots.some((bot: any) => bot.busy), { timeout: hostTimeout(25_000) }).toBe(false);
  };
  try {
    await api("PATCH", "/api/config", { features: { skillsLibrary: true } });
    // Built-in find-skills and skill-creator belong strictly to the workspace's unique System Coordinator (General scope), never Department Coordinators.
    const initialBots = (await api("GET", "/api/bots?messages=0")).bots as any[];
    const sysChief = initialBots.find((b) => b.chiefOfStaff && !(b.section ?? "").trim()) ?? initialBots[0];
    await api("PATCH", `/api/bots/${sysChief.id}`, { chiefOfStaff: true, section: "" });
    const sysToken = await start(sysChief, "verify-system-coordinator-builtin-skills");
    for (const name of ["find-skills", "skill-creator"]) {
      expect(dump().systemPrompt).toContain(`<donebot-skill id="${name}"`);
      expect((await api("GET", `/api/bots/${sysChief.id}/skills`)).skills.find((skill: any) => skill.name === name)).toMatchObject({ enabled: true, source: `builtin:${name}`, editable: false });
      expect((await api("GET", `/api/bots/${sysChief.id}/skills/${name}`)).text).toContain("DoneBot");
      await api("PATCH", `/api/bots/${sysChief.id}/skills/${name}`, { enabled: false }, 409);
      await api("DELETE", `/api/bots/${sysChief.id}/skills/${name}`, undefined, 409);
      await api("POST", "/api/internal/skills/stage", { action: "disable", skill_name: name }, 422, sysToken);
    }
    expect((await api("GET", "/api/internal/skills?skillName=skill-creator&reference=references/grader.md", undefined, 200, sysToken)).text).toContain("Grade");
    await api("GET", "/api/internal/skills?skillName=skill-creator&reference=references/../../AGENTS.md", undefined, 404, sysToken);
    await finish();

    const chief = (await api("POST", "/api/bots", { name: "Skill setup chief", section: "Studio" }, 201)).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    const other = (await api("POST", "/api/bots", { name: "Other department", section: "Other" }, 201)).bot;
    const token = await start(chief, "create-a-reporting-specialist-fixture");
    for (const name of ["find-skills", "skill-creator"]) {
      expect(dump().systemPrompt).not.toContain(`<donebot-skill id="${name}"`);
      expect((await api("GET", `/api/bots/${chief.id}/skills`)).skills.some((skill: any) => skill.name === name)).toBe(false);
    }
    const soul = "You prepare weekly reports. Check source facts, return one report and state any unverified claims.";
    await api("POST", "/api/internal/create-bot", { name: "Reporting specialist", role: "Report writer", instructions: soul }, 201, token);
    const target = (await api("GET", "/api/bots")).bots.find((bot: any) => bot.name === "Reporting specialist");
    expect(target.soul).toBe(soul);
    expect((await api("GET", `/api/bots/${target.id}/skills`)).skills).toEqual([]);
    const list = () => api("GET", `/api/bots/${target.id}/skills`);
    const post = (action: string, body: Record<string, unknown>, expected = 201) =>
      api("POST", `/api/internal/skills/${action}`, { bot_id: target.id, ...body }, expected, token);
    await api("GET", `/api/internal/skills?bot_id=${other.id}`, undefined, 403, token);

    const folder = join(dump().cwd, "report-skill");
    mkdirSync(join(folder, "references"), { recursive: true });
    mkdirSync(join(folder, "scripts"));
    mkdirSync(join(folder, "assets"));
    const skillMd = "---\nname: report-check\ndescription: Check weekly report facts and totals.\n---\n\nRead references/checks.md. Verify the report before delivery.\n";
    writeFileSync(join(folder, "SKILL.md"), skillMd);
    writeFileSync(join(folder, "references", "checks.md"), "Check the source and add the totals.");
    writeFileSync(join(folder, "scripts", "check.js"), "console.log('fixture only');\n");
    writeFileSync(join(folder, "assets", "sample.bin"), Buffer.from([0, 1, 2]));
    const preview = await post("import", { source: folder }, 200);
    expect(preview).toMatchObject({ preview: true, botId: target.id, skills: [{ name: "report-check", skill_md: skillMd }] });
    expect((await list()).skills).toEqual([]);
    await post("import", { source: folder, preview: false });
    expect((await list()).skills).toMatchObject([{ name: "report-check", enabled: false }]);
    const installedRoot = join(fixture.info.dataDir, "workspaces", target.id, "skills", "report-check");
    expect(readFileSync(join(installedRoot, "references", "checks.md"), "utf8")).toBe("Check the source and add the totals.");
    expect(readFileSync(join(installedRoot, "assets", "sample.bin"))).toEqual(Buffer.from([0, 1, 2]));
    expect(existsSync(join(installedRoot, "scripts", "check.js"))).toBe(true);
    expect(await post("find", { query: "report", online: false }, 200)).toMatchObject({ botId: target.id, online: false, local: [{ name: "report-check", enabled: false }] });
    expect(await api("GET", `/api/internal/skills?bot_id=${target.id}&skillName=report-check`, undefined, 200, token)).toMatchObject({ text: skillMd });
    await post("stage", { action: "enable", skill_name: "report-check" });
    const cards = () => api("GET", `/api/threads/${chief.threadId}/messages`);
    const enabled = (await cards()).messages.findLast((message: any) => message.card?.skillRequest?.name === "report-check").card;
    expect(enabled.skillRequest).toMatchObject({ botId: chief.id, targetBotId: target.id, targetBotName: target.name });
    expect((await list()).skills[0].enabled).toBe(true);
    await api("POST", `/api/threads/${chief.threadId}/undo`, { requestId: enabled.requestId });
    expect((await list()).skills[0].enabled).toBe(false);
    await post("stage", { action: "enable", skill_name: "report-check" });

    const custom = "---\nname: report-format\ndescription: Format a report for this user's weekly review.\n---\n\nRead references/style.md.\n";
    await post("stage", { action: "create", skill_md: custom, source: "conversation", references: [{ path: "references/style.md", content: "Default to one page, unless this task asks otherwise." }] });
    expect((await api("GET", `/api/bots/${chief.id}/skills`)).skills.map((skill: any) => skill.name)).not.toContain("report-format");
    expect((await list()).skills.map((skill: any) => skill.name)).toEqual(expect.arrayContaining(["report-format", "report-check"]));
    await post("stage", { action: "update", skill_name: "report-format", skill_md: custom + "Check the heading.\n", source: "conversation" });
    const updated = (await cards()).messages.findLast((message: any) => message.card?.skillRequest?.action === "update").card;
    await api("POST", `/api/threads/${chief.threadId}/undo`, { requestId: updated.requestId });
    expect((await api("GET", `/api/bots/${target.id}/skills/report-format`)).text).toBe(custom);
    await post("stage", { action: "update", skill_name: "report-format", skill_md: custom + "Check the totals.\n", source: "conversation" });
    const latestUpdate = (await cards()).messages.findLast((message: any) => message.card?.skillRequest?.action === "update").card;
    await api("PATCH", `/api/bots/${target.id}`, { section: "Other" });
    await post("stage", { action: "disable", skill_name: "report-check" }, 403);
    await api("POST", `/api/threads/${chief.threadId}/undo`, { requestId: latestUpdate.requestId }, 403);
    expect((await api("GET", `/api/bots/${target.id}/skills/report-format`)).text).toBe(custom + "Check the totals.\n");
    await api("PATCH", `/api/bots/${target.id}`, { section: "Studio" });
    await api("POST", `/api/threads/${chief.threadId}/undo`, { requestId: latestUpdate.requestId });
    await finish();

    const specialistToken = await start(target, "check-the-specialist-skill-index-fixture");
    expect(dump().systemPrompt).toContain("report-check");
    expect(dump().systemPrompt).toContain("report-format");
    expect(dump().systemPrompt).not.toContain('<donebot-skill id="skill-creator"');
    await api("GET", `/api/internal/skills?bot_id=${chief.id}`, undefined, 403, specialistToken);
    await api("POST", "/api/internal/skills/import", { source: folder, bot_id: chief.id, preview: false }, 403, specialistToken);
    await api("POST", "/api/internal/skills/import", { source: folder, preview: false }, 422, specialistToken);
    await finish();
    await api("POST", "/api/internal/skills/stage", { action: "disable", skill_name: "report-check" }, 401, specialistToken);
  } finally {
    const evidencePath = `${fixture.info.logPath}.bot-skill-setup.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.log(`Bot skill setup evidence: ${evidencePath}`);
    await fixture.close();
    await removeTempDir(scratch);
  }
}, hostTimeout(180_000));
