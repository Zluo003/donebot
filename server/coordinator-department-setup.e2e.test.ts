import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

it("enforces unique System Coordinator, auto-creates departments + department group chats, allows name-based dispatch under enforced org chart, and equips cross-department skills", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "donebot-coordinator-dept-"));
  const gate = join(scratch, "finish");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
  const api = async (method: string, path: string, body?: unknown, expected = 200, token?: string) => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : { origin: fixture.info.url }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path} -> ${JSON.stringify(result)}`).toBe(expected);
    return result;
  };
  const dump = () => { try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); } catch { return {}; } };
  let lastPid: number | undefined;
  const start = async (bot: any, marker: string) => {
    rmSync(gate, { force: true });
    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", marker, "--url", fixture.info.url]);
    await expect.poll(() => {
      const current = dump();
      return current.pid !== lastPid && JSON.stringify(current.prompt ?? "").includes(marker);
    }, { timeout: hostTimeout(25_000) }).toBe(true);
    const current = dump();
    lastPid = current.pid;
    return {
      token: current.mcpConfig.mcpServers.agents.env.DONEBOT_COMMS_TOKEN as string,
      dump: current,
    };
  };
  const finish = async (botId?: string) => {
    writeFileSync(gate, "finish");
    await expect.poll(async () => {
      const bots = (await api("GET", "/api/bots?messages=0")).bots as any[];
      return botId ? Boolean(bots.find(b => b.id === botId)?.busy) : bots.some(b => b.busy);
    }, { timeout: hostTimeout(25_000) }).toBe(false);
  };

  try {
    // 1. Identify the workspace's unique System Coordinator (General scope, chiefOfStaff=true) and enable enforced org chart
    const initialBots = (await api("GET", "/api/bots?messages=0")).bots as any[];
    const sysChief = initialBots.find((b) => b.chiefOfStaff && !(b.section ?? "").trim()) ?? initialBots[0];
    expect(sysChief).toBeDefined();
    await api("PATCH", `/api/bots/${sysChief.id}`, { chiefOfStaff: true, section: "", approvalMode: "full" });
    await api("PUT", "/api/donebot/opc/org/mode", { enforcementMode: "enforced", allowChiefCrossDispatch: false });

    const { token: sysToken, dump: sysDump } = await start(sysChief, "setup-drama-dept-e2e");
    // System prompt carries System Coordinator identity + mandatory 3-tier automatic skill provisioning
    expect(sysDump.systemPrompt).toContain("workspace's unique System Coordinator");
    expect(sysDump.systemPrompt).toContain("Mandatory automatic skill provisioning for newly created bots");
    expect(sysDump.systemPrompt).toContain("both single create_bot AND batch propose_team_setup");

    // 2. list_team_setup reports system_coordinator role
    const catalog = await api("GET", "/api/internal/team-setup-catalog", undefined, 200, sysToken);
    expect(catalog.coordinatorRole).toBe("system_coordinator");

    // 3. Batch-create a brand-new department ("短剧部") WITHOUT newTeams, WITHOUT key, WITHOUT modelSelection,
    //    WITHOUT explicit chiefOfStaff, and WITHOUT explicit departmentInstructions ->
    //    auto-appoints 掌镜 (导演) as Department Coordinator, initializes department shared instructions,
    //    auto-creates "短剧部群聊", and syncs Paperclip Org Chart!
    const teamSetup = await api("POST", "/api/internal/team-setup-requests", {
      plan: {
        reason: "新建短剧部、配置作家与导演并协同交付短剧",
        operations: [
          { action: "create", fields: { name: "笔客", title: "短剧作家（写小说）", soul: "撰写短剧小说与故事大纲。", section: "短剧部" } },
          { action: "create", fields: { name: "掌镜", title: "短剧导演（分镜脚本）", soul: "统筹短剧分镜与质量。", section: "短剧部" } },
        ],
      },
    }, 201, sysToken);
    expect(teamSetup).toMatchObject({
      applied: true,
      state: "applied",
      result: {
        state: "applied",
        newTeams: ["短剧部"],
        createdRooms: [{ name: "短剧部群聊", section: "短剧部" }],
        updatedDepartmentInstructions: ["短剧部"],
      },
    });

    const stateAfterBatch = await api("GET", "/api/bots?messages=0");
    expect(stateAfterBatch.sections).toContain("短剧部");
    const director = stateAfterBatch.bots.find((b: any) => b.name === "掌镜");
    const writer = stateAfterBatch.bots.find((b: any) => b.name === "笔客");
    expect(director).toMatchObject({ section: "短剧部", chiefOfStaff: true });
    expect(writer).toMatchObject({ section: "短剧部" });
    expect(writer.chiefOfStaff).toBeFalsy();
    const dramaRoom = stateAfterBatch.groups.find((g: any) => g.name === "短剧部群聊" && g.section === "短剧部");
    expect(dramaRoom).toBeDefined();
    expect(dramaRoom.memberIds).toEqual(expect.arrayContaining([director.id, writer.id]));
    const dramaSharedInstructions = await api("GET", `/api/section-context?section=${encodeURIComponent("短剧部")}`);
    expect(dramaSharedInstructions.text).toContain("短剧部");
    expect(dramaSharedInstructions.text).toContain("@掌镜");
    expect(dramaSharedInstructions.text).toContain("@笔客");

    // System Coordinator can also directly read and update/append any department's shared instructions via manage_department_instructions.
    const readDramaBrief = await api("POST", "/api/internal/department-instructions", { action: "read", section: "短剧部" }, 200, sysToken);
    expect(readDramaBrief.text).toContain("@掌镜");
    await api("POST", "/api/internal/department-instructions", {
      action: "append",
      section: "短剧部",
      text: "## 视频规格\n- 统一 9:16 竖屏，单集 90-120 秒。",
    }, 200, sysToken);
    expect((await api("GET", `/api/section-context?section=${encodeURIComponent("短剧部")}`)).text).toContain("统一 9:16 竖屏");

    // Adding bots to an EXISTING empty department without a coordinator also auto-appoints a Department Coordinator and initializes blank shared instructions.
    await api("POST", "/api/sidebar-sections", { name: "自媒体部" }, 200);
    await api("POST", "/api/internal/team-setup-requests", {
      plan: {
        reason: "为自媒体部配齐内容策划与主编",
        operations: [
          { action: "create", fields: { name: "策策", title: "内容策划", soul: "策划选题。", section: "自媒体部" } },
          { action: "create", fields: { name: "主笔", title: "内容主编", soul: "统筹内容质量。", section: "自媒体部" } },
        ],
      },
    }, 201, sysToken);
    const mediaBots = ((await api("GET", "/api/bots?messages=0")).bots as any[]).filter((b) => b.section === "自媒体部");
    expect(mediaBots.find((b) => b.name === "主笔")?.chiefOfStaff).toBe(true);
    expect((await api("GET", `/api/section-context?section=${encodeURIComponent("自媒体部")}`)).text).toContain("自媒体部");

    // Coordinator skill_find targeting a managed bot returns auto-provisioning guidance (not "install only after the user chooses").
    const skillFindForWriter = await api("POST", "/api/internal/skills/find", {
      bot_id: writer.id,
      query: "screenplay writing",
      online: false,
    }, 200, sysToken);
    expect(String(skillFindForWriter.guidance)).toContain("without asking the user first");
    expect(String(skillFindForWriter.guidance)).not.toContain("install only after the user chooses");

    // 4. Create an uncategorized bot (reports directly to System Coordinator) and another department via create_bot
    const soloRes = await api("POST", "/api/internal/create-bot", {
      name: "独立研究员",
      role: "调研员",
      instructions: "负责临时资料调研。",
    }, 201, sysToken);
    expect(soloRes).toMatchObject({ name: "独立研究员", section: "General" });

    // Refuses creating a second global System Coordinator in General
    await api("POST", "/api/internal/create-bot", {
      name: "第二个总协调",
      role: "冲突角色",
      instructions: "不应允许。",
      department_coordinator: true,
    }, 400, sysToken);

    // Creating a department + Department Coordinator via single create_bot also auto-creates its group chat
    const shopRes = await api("POST", "/api/internal/create-bot", {
      name: "掌柜",
      role: "电商总监",
      instructions: "统筹电商选品与运营。",
      section: "电商部",
      department_coordinator: true,
    }, 201, sysToken);
    expect(shopRes).toMatchObject({
      name: "掌柜",
      section: "电商部",
      chiefOfStaff: true,
      createdRooms: [{ name: "电商部群聊", section: "电商部" }],
    });

    // 5. Verify Org Chart auto-synced hierarchy:
    //    - 独立研究员 (uncategorized) -> reports directly to sysChief
    //    - 掌镜 & 掌柜 (department coordinators) -> report to sysChief
    //    - 笔客 (短剧部 member) -> reports to 掌镜
    const orgRes = await api("GET", "/api/donebot/opc/org");
    const orgState = orgRes.org ?? orgRes;
    expect(orgState.nodes[sysChief.id]?.reportsToBotId).toBeNull();
    expect(orgState.nodes[soloRes.id]?.reportsToBotId).toBe(sysChief.id);
    expect(orgState.nodes[director.id]?.reportsToBotId).toBe(sysChief.id);
    expect(orgState.nodes[writer.id]?.reportsToBotId).toBe(director.id);
    expect(orgState.nodes[shopRes.id]?.reportsToBotId).toBe(sysChief.id);

    // 6. Verify System Coordinator dispatches under enforced Org Chart BY NAME ("掌镜") AND BY UUID!
    const byNameDispatch = await api("POST", "/api/internal/coordinate-bots", {
      botIds: ["掌镜"],
      reply: "none",
      message: "请审核第一版分镜表（按名称派发回归验证）。",
    }, 200, sysToken);
    expect(byNameDispatch.receipts?.[0]).toMatchObject({ botId: director.id, outcome: "queued" });

    const byIdDispatch = await api("POST", "/api/internal/coordinate-bots", {
      botIds: [shopRes.id],
      reply: "none",
      message: "请整理冬季羽绒服选品清单。",
    }, 200, sysToken);
    expect(byIdDispatch.receipts?.[0]).toMatchObject({ botId: shopRes.id, outcome: "queued" });

    // 7. Verify System Coordinator can install & enable skills (local user-provided & custom create) on department bots!
    const skillFolder = join(sysDump.cwd, "drama-storyboard");
    mkdirSync(skillFolder, { recursive: true });
    writeFileSync(
      join(skillFolder, "SKILL.md"),
      "---\nname: drama-storyboard\ndescription: Break down short drama scripts into camera shots.\n---\n\n# Storyboard\nCheck shot durations.\n",
    );
    await api("POST", "/api/internal/skills/import", { source: skillFolder, bot_id: director.id, preview: false }, 201, sysToken);
    await api("POST", "/api/internal/skills/stage", { action: "enable", skill_name: "drama-storyboard", bot_id: director.id }, 201, sysToken);
    expect((await api("GET", `/api/bots/${director.id}/skills`)).skills).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "drama-storyboard", enabled: true })]),
    );

    await api("POST", "/api/internal/skills/stage", {
      action: "create",
      bot_id: writer.id,
      source: "conversation",
      gist: "短剧剧本结构规范",
      skill_md: "---\nname: drama-script-guide\ndescription: Write punchy short drama scripts.\n---\n\n# Script Guide\nKeep scenes tight.\n",
    }, 201, sysToken);
    expect((await api("GET", `/api/bots/${writer.id}/skills`)).skills).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "drama-script-guide", enabled: true })]),
    );

    // 8. Verify System Coordinator can see & manage department group chats and create rooms in departments
    const listedRooms = await api("GET", "/api/internal/rooms", undefined, 200, sysToken);
    expect(listedRooms.managedRooms).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: dramaRoom.id, name: "短剧部群聊", section: "短剧部" })]),
    );
    await api("POST", "/api/internal/manage-room", { roomId: dramaRoom.id, action: "rename", name: "短剧部主群" }, 200, sysToken);
    const extraRoom = await api("POST", "/api/internal/create-room", {
      name: "短剧部审片群",
      section: "短剧部",
      memberIds: [director.id, writer.id],
    }, 201, sysToken);
    expect(extraRoom).toMatchObject({ name: "短剧部审片群", section: "短剧部" });

    // Finish sysChief + queued turns before testing Department Coordinator isolation
    await finish();
    // Wait for the two reply="none" handoff turns to drain while the slow gate stays open.
    await expect.poll(async () => {
      const bots = (await api("GET", "/api/bots?messages=0")).bots as any[];
      const dirBot = bots.find(b => b.id === director.id);
      const shopBot = bots.find(b => b.id === shopRes.id);
      const dirWorkDone = (dirBot?.tasks ?? []).some((t: any) => t.threadId !== dirBot.threadId && !t.busy);
      const shopWorkDone = (shopBot?.tasks ?? []).some((t: any) => t.threadId !== shopBot.threadId && !t.busy);
      return dirWorkDone && shopWorkDone && !bots.some(b => b.busy);
    }, { timeout: hostTimeout(25_000) }).toBe(true);

    // 9. Verify Department Coordinator (掌镜) is scoped strictly to "短剧部" (NOT a global System Coordinator)
    //    and does NOT inherit the System Coordinator's built-in find-skills / skill-creator skills.
    expect((await api("GET", `/api/bots/${sysChief.id}/skills`)).skills.map((s: any) => s.name)).toEqual(
      expect.arrayContaining(["find-skills", "skill-creator"]),
    );
    expect((await api("GET", `/api/bots/${director.id}/skills`)).skills.map((s: any) => s.name)).not.toEqual(
      expect.arrayContaining(["find-skills"]),
    );
    expect((await api("GET", `/api/bots/${director.id}/skills`)).skills.map((s: any) => s.name)).not.toEqual(
      expect.arrayContaining(["skill-creator"]),
    );
    const { token: deptToken, dump: deptDump } = await start(director, "dept-coordinator-scope-check");
    expect(deptDump.systemPrompt).not.toContain('<donebot-skill id="find-skills"');
    expect(deptDump.systemPrompt).not.toContain('<donebot-skill id="skill-creator"');
    const deptCatalog = await api("GET", "/api/internal/team-setup-catalog", undefined, 200, deptToken);
    expect(deptCatalog.coordinatorRole).toBe("department_coordinator");
    expect(deptCatalog.teams).toEqual(["短剧部"]);
    // Department Coordinator CAN update its own department's shared instructions, but CANNOT touch another department's.
    await api("POST", "/api/internal/department-instructions", {
      action: "append",
      text: "## 分镜门禁\n- 分镜定稿前不启动出图与出片。",
    }, 200, deptToken);
    expect((await api("GET", `/api/section-context?section=${encodeURIComponent("短剧部")}`)).text).toContain("分镜定稿前不启动出图与出片");
    await api("POST", "/api/internal/department-instructions", {
      action: "set",
      section: "电商部",
      text: "越权修改测试",
    }, 403, deptToken);
    // Cannot install/manage skills on another department's bot
    await api("POST", "/api/internal/skills/stage", {
      action: "create",
      bot_id: shopRes.id,
      source: "conversation",
      skill_md: "---\nname: cross-dept-illegal\ndescription: Should fail.\n---\nNo.\n",
    }, 403, deptToken);
    // Under enforced mode with cross-dept off, 掌镜 cannot directly dispatch to 电商部's 掌柜 (must route via 总协调机器人)
    const crossDenied = await api("POST", "/api/internal/coordinate-bots", {
      botIds: ["掌柜"],
      message: "越权跨部门派单测试。",
    }, 403, deptToken);
    expect(String(crossDenied.error)).toContain("跨部门沟通");
    expect(String(crossDenied.error)).toContain("总协调机器人");
    await finish(director.id);
    expect(existsSync(fixture.info.logPath)).toBe(true);
  } finally {
    await fixture.close();
    await removeTempDir(scratch);
  }
}, hostTimeout(180_000));
