import { describe, expect, it } from "vitest";

import { chiefOfStaffSystemPrompt, chiefTidies, EVERYONE_ON_THE_MAP } from "./chief-of-staff.ts";

describe("chiefTidies", () => {
  const chief = { id: "chief", name: "Chief", section: "Work", chiefOfStaff: true };
  const opener = { id: "opener", name: "Opener", section: "Work" };
  const recipient = { id: "recipient", name: "Recipient", section: "Work" };
  const task = { openedBy: { botId: opener.id, name: opener.name, threadId: "source", at: 1 } };

  it("allows only Chiefs and bot-opened, non-routine threads", () => {
    expect(chiefTidies(chief, task, opener, recipient)).toBe(true);
    expect(chiefTidies({ ...chief, chiefOfStaff: false }, task, opener, recipient)).toBe(false);
    expect(chiefTidies(chief, {}, opener, recipient)).toBe(false);
    expect(chiefTidies(chief, { ...task, routineRunId: "run" }, opener, recipient)).toBe(false);
  });

  it("needs authority over both the opener and the thread's own bot, which reach alone never gives", () => {
    expect(chiefTidies(chief, task, { ...opener, section: "Private" }, recipient)).toBe(false);
    expect(chiefTidies(chief, task, opener, { ...recipient, section: "Private" })).toBe(false);
    expect(chiefTidies(chief, task, { ...opener, hidden: true }, recipient)).toBe(false);
    expect(chiefTidies(chief, task, undefined, recipient)).toBe(false);
    expect(chiefTidies(chief, task, { ...opener, visibility: { people: ["person@example.test"] } }, recipient)).toBe(false);
    expect(chiefTidies({ ...chief, managedSections: ["Private"] }, task, { ...opener, section: "Private" }, { ...recipient, section: "Private" })).toBe(true);
  });
});

describe("chiefOfStaffSystemPrompt roster caps", () => {
  it("clips oversized persona fields instead of interpolating them whole", () => {
    const prompt = chiefOfStaffSystemPrompt(
      "chief",
      [
        { id: "chief", name: "Atlas" },
        {
          id: "big",
          name: "N".repeat(500),
          title: "T".repeat(500),
          description: "D".repeat(10_000),
        },
      ],
      true,
    );
    const rosterLine = prompt.split("\n").find((line) => line.startsWith("- N"))!;
    expect(rosterLine.length).toBeLessThan(500);
    expect(rosterLine).toContain("…");
  });

  it("caps the roster length and says how many were left out", () => {
    const team = Array.from({ length: 60 }, (_, i) => ({ id: `bot${i}`, name: `Bot ${i}` }));
    const prompt = chiefOfStaffSystemPrompt("chief", [{ id: "chief", name: "Atlas" }, ...team], true);
    expect(prompt).toContain("Bot 39");
    expect(prompt).not.toContain("Bot 40 —");
    expect(prompt).toContain("…and 20 more");
  });
});

describe("chiefOfStaffSystemPrompt", () => {
  const bots = [
    { id: "chief", name: "Atlas", title: "Operations", section: "Work" },
    { id: "writer", name: "Quill", title: "Writer", description: "Drafts concise copy", section: "Work" },
    { id: "coder", name: "Patch", title: "Engineer", busy: true, section: "Work" },
    { id: "hidden", name: "Secret", hidden: true, section: "Work" },
    { id: "personal", name: "Scout", title: "Travel planner", section: "Personal" },
  ];

  it("describes visible teammates and roles, but not who is busy", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", bots, true);

    expect(prompt).toContain("Chief of Staff for the Work department");
    expect(prompt).toContain("Quill — Writer: Drafts concise copy [id: writer]");
    expect(prompt).toContain("Patch — Engineer [id: coder]");
    expect(prompt).not.toContain("working right now");
    expect(prompt).not.toContain("(available)");
    expect(prompt).not.toContain("Secret");
    expect(prompt).toContain("Other bots you can reach, in other departments:\n- Scout — Travel planner (Personal) [id: personal]");
    expect(prompt).not.toContain("Travel planner (Personal): ");
    expect(prompt).not.toContain("Atlas —");
    expect(prompt).toContain("Use coordinate_bots to assign actual teammates concrete work");
    expect(prompt).toContain("keeps you available to the user");
    expect(prompt).toContain("you resume automatically when their results return, success or failure");
    expect(prompt).toContain("Do not poll or wait");
    expect(prompt).toContain("with consult: true to ask them for advice");
    expect(prompt).toContain("Consultations are advice, not proof that work or tests ran");
    expect(prompt).not.toMatch(/\b(delegate_bot|ask_bot|send_to_bot|check_delegation|wait_delegation)\b/);
    expect(prompt).toContain("propose_team_setup once");
    expect(prompt).toContain("structured result");
  });

  it("is the person's assistant, does the work itself and adds a specialist without asking", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", [{ id: "chief", name: "Atlas" }], true);

    expect(prompt).toContain("You are the person's assistant");
    expect(prompt).toContain("Do the work yourself");
    expect(prompt).toContain("add one with create_bot without asking first, then tell the person in one line");
    expect(prompt).toContain("an ongoing area of work, a different skill set, or work to run in parallel");
    expect(prompt).toContain("When their goal matches a ready-made team, list_team_library has its roles");
    expect(prompt, "a suggestion no longer waits on a card").not.toMatch(/suggestion|Not now/);
  });

  it("does not promise delegation when the engine cannot mount agent tools", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", bots, false);

    expect(prompt).toContain("cannot contact teammates");
    expect(prompt).not.toContain("coordinate_bots");
    expect(prompt, "never name a tool the engine cannot call").not.toContain("create_bot");
  });

  it("follows staffing result states and enforces mandatory 3-tier automatic skill provisioning", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", bots, true);
    expect(prompt).toContain("after an applied result, immediately equip every newly created bot with skill(s)");
    expect(prompt).toContain("user-provided -> skill_find + skill_import + enable -> skill_manage create");
    expect(prompt).toContain("both single create_bot AND batch propose_team_setup");
    expect(prompt).toContain("Only if review is pending, end your turn");
    expect(prompt).toContain("Report failed or cancelled results honestly");
    expect(prompt).toContain("Existing thread models stay unchanged");
    expect(prompt).toContain("directly at Full access or after the person's review otherwise");
    expect(prompt).toContain("For explicitly requested bot deletion");
    expect(prompt).not.toContain("End your turn after the proposal:");
  });

  it("distinguishes the unique System Coordinator from Department Coordinators in prompts", () => {
    const sysPrompt = chiefOfStaffSystemPrompt("sys", [
      { id: "sys", name: "多宝", chiefOfStaff: true },
      { id: "lead", name: "掌镜", section: "短剧部", chiefOfStaff: true },
      { id: "writer", name: "笔客", section: "短剧部" },
      { id: "solo", name: "独立助手" },
    ], true);
    expect(sysPrompt).toContain("workspace's unique System Coordinator");
    expect(sysPrompt).toContain("Uncategorized bots belong directly under you");
    expect(sysPrompt).toContain("[Department Coordinator]");
    expect(sysPrompt).toContain("Creating a new department automatically appoints a Department Coordinator if omitted, initializes its shared instructions, syncs the organization hierarchy, and creates its department group chat");

    const deptPrompt = chiefOfStaffSystemPrompt("lead", [
      { id: "sys", name: "多宝", chiefOfStaff: true },
      { id: "lead", name: "掌镜", section: "短剧部", chiefOfStaff: true },
      { id: "writer", name: "笔客", section: "短剧部" },
    ], true);
    expect(deptPrompt).toContain("Department Coordinator for the 短剧部 department (not the global System Coordinator)");
    expect(deptPrompt).toContain("[System Coordinator]");
    expect(deptPrompt).toContain("When the person writes to @短剧部 on the Team map, it comes to you alone as the Department Coordinator");
    expect(deptPrompt).not.toContain("The built-in find-skills and skill-creator");
  });

  it("pins the one coordination guidance and the shared staffing text", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", bots, true);

    expect(prompt).toBe(
      [
        "You are the person's assistant and the Chief of Staff for the Work department: their one point of contact.",
        "Every other bot on this team, in any department, is reachable too: consult it or hand it work with coordinate_bots whenever a job needs it, without asking anyone to set anything up. Reaching a bot gives you no authority over it: its setup, its threads and its incidents stay with its own Chief, so ask rather than direct.",
        "Do the work yourself, bring in a teammate when one fits the job, and return one concise consolidated answer. Never invent a teammate's progress or result. Normal permission and approval rules still apply.",
        "A standing preference the person states for all their bots (where reminders go, how replies should sound) is one line you save yourself with memory_update action prefer: every bot reads it. Never send it to each bot with coordinate_bots.",
        "When a job needs a specialist you do not have (an ongoing area of work, a different skill set, or work to run in parallel), add one with create_bot without asking first, then tell the person in one line; they can undo it. When their goal matches a ready-made team, list_team_library has its roles to create the same way. Never add a bot just to look busy, or one that duplicates a teammate.",
        "Mandatory automatic skill provisioning for newly created bots (both single create_bot AND batch propose_team_setup): establish each bot's concise SOUL.md (identity, responsibilities, boundaries, deliverables, quality checks and reporting), then immediately equip EVERY newly created bot with matching professional skill(s) in the same workflow — do NOT pause to ask whether to add skills later. Follow this strict 3-tier priority for each created bot (passing its exact target bot_id): (1) User-provided skill first: if the user supplied a skill path, folder, URL, or explicit skill specification, install it directly with skill_import(preview=false, bot_id) and enable it with skill_manage(action='enable', bot_id, skill_name) (or author it directly from the user's specification with skill_manage(action='create', bot_id)), without redundant searching. (2) Search existing skills second: otherwise call skill_find(query, bot_id) to search local and online (skills.sh) skills, inspect promising candidates (with skill_import preview=true when needed) for role/task fit, credible provenance, actionable procedures/result checks and dependency compatibility (popularity alone does not prove quality), and immediately install and enable the best match via skill_import(preview=false, bot_id) + skill_manage(action='enable', bot_id, skill_name). (3) Custom skill fallback third: if no suitable existing skill is found (or online search fails and no local skill fits), immediately author and enable a practical custom SKILL.md via skill_manage(action='create', bot_id, skill_md, source='conversation', gist). If any skill tool returns pending review, end your turn to wait for approval; otherwise complete setup and report each bot's equipped skill(s) and provenance. Skills provide reusable methods; save lasting user/project preferences with memory/profile tools; current explicit user instructions override skill defaults. The built-in find-skills and skill-creator are available without installing external CLIs.",
        EVERYONE_ON_THE_MAP,
        "Incidents: when a teammate's run fails, stalls or cannot start, DoneBot reports it to you in your \"Problems to look at\" thread with a link to the thread. Read the report, then either call retry_thread to resume that thread where it stopped, coordinate_bots with a corrected brief when the request itself must change, or — when only the person can fix the cause (a sign-in, a missing credential, an unanswered question, a setting) — say so plainly and stop. Never retry the same thread more than twice; report what failed and what you did in one or two sentences.",
        "Use list_bots or list_room_targets for the live reachable roster. Use coordinate_bots to assign actual teammates concrete work, or with consult: true to ask them for advice. It returns immediately and keeps you available to the user; give clear, self-contained briefs, then end your turn — you resume automatically when their results return, success or failure. Say that work is assigned, not completed; only claim completion after the teammate's result has actually arrived, and if a teammate fails or stalls, tell the user plainly and decide the next step yourself. Leads can coordinate their own specialists. Do not poll or wait, send acknowledgements as new work, or substitute native helpers for named bots. On return, verify the requested outcome, resolve decisions within the user's scope, request concrete corrections with rework=true when necessary, and return one consolidated answer. Consultations are advice, not proof that work or tests ran. A refusal from coordinate_bots means nothing was sent: fix what it names (usually the id — copy it from list_bots or your roster; a unique teammate name also works) and retry, and never describe a handoff the tool did not accept.",
        "Housekeeping: list_threads also shows threads one teammate opened on another (marked \"opened by\"), and you may close_thread those once they are idle and their work is done. Threads the person started are theirs: never close them.",
        "When the user asks you to assemble or configure a team or create a department, use list_team_setup for exact teams, bot IDs and model catalog, then call propose_team_setup once with all named specialists, department assignments (newTeams or a new section name for the System Coordinator), ONE Department Coordinator per new department (chiefOfStaff: true on the lead/director/manager role — never a second global System Coordinator in General; department specialists report to their Department Coordinator, and the Department Coordinator reports to the System Coordinator), departmentInstructions (shared department goals, handoff workflow, shared deliverable folders and hard rules written to the department's shared instructions), and profile/model changes. Creating a new department automatically appoints a Department Coordinator if omitted, initializes its shared instructions, syncs the organization hierarchy, and creates its department group chat (and you may also create or update department rooms with manage_room using section, or read/create/update authorized departments' shared instructions anytime with manage_department_instructions). Existing thread models stay unchanged. mcpServers may set an existing bot's MCP servers, directly at Full access or after the person's review otherwise; other execution permissions stay unchanged. Follow the tool result: profile and model plans apply immediately at every access level and the person can undo them; after an applied result, immediately equip every newly created bot with skill(s) following the mandatory 3-tier priority (user-provided -> skill_find + skill_import + enable -> skill_manage create) and continue already-requested work without asking for another confirmation. Only if review is pending, end your turn: the user's decision automatically resumes you once with a structured result. Report failed or cancelled results honestly. Do not ask for another yes, poll, or repeat the proposal. For explicitly requested bot deletion, use propose_bot_deletion separately and follow its applied or pending result too.",
        "Current Work department (your team):",
        "- Quill — Writer: Drafts concise copy [id: writer]",
        "- Patch — Engineer [id: coder]",
        "Other bots you can reach, in other departments:",
        "- Scout — Travel planner (Personal) [id: personal]",
      ].join("\n"),
    );
  });

  it("tells a place's DoneBot that is not the Chief that the person's day and brief are its own, and a member's that they are not", () => {
    const place = chiefOfStaffSystemPrompt("maus", [{ id: "maus", name: "DoneBot", defaultBot: {} }], true);
    expect(place).toContain("but you are not the Chief: team incidents stay with the Chief.");
    expect(place).toContain("Keeping an eye on the person's day and their daily brief are yours.");
    const member = chiefOfStaffSystemPrompt("maus", [{ id: "maus", name: "DoneBot", defaultBot: { person: "ada@example.test" } }], true);
    expect(member).toContain("but you are not the Chief: the daily brief and team incidents stay with the Chief.");
    expect(member).not.toContain("daily brief are yours");
  });
});

describe("an @everyone line from the Team map", () => {
  const team = [{ id: "chief", name: "Clive", chiefOfStaff: true }, { id: "mail", name: "Mail" }, { id: "books", name: "Books" }];

  it("tells the Chief it alone gets the line and passes it only to the bots it concerns", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", team, true);
    expect(prompt).toContain(EVERYONE_ON_THE_MAP);
    expect(EVERYONE_ON_THE_MAP).toContain("never to all of them by default");
  });

  it("says nothing of it to a Chief that cannot hand work on, or to a DoneBot that only holds the tools", () => {
    expect(chiefOfStaffSystemPrompt("chief", team, false)).not.toContain(EVERYONE_ON_THE_MAP);
    const maus = [{ id: "maus", name: "DoneBot", defaultBot: { person: "ada@example.test" } }, ...team.slice(1)];
    expect(chiefOfStaffSystemPrompt("maus", maus, true)).not.toContain(EVERYONE_ON_THE_MAP);
  });
});
