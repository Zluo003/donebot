---
name: skill-creator
description: Create, test and improve a reusable professional skill when the user explicitly requests custom creation or discovery and inspection find no suitable existing skill.
---

# Skill Creator

Adapted from Anthropic's skill-creator. The pinned original, evaluation references and license ship with this skill. Authoring and installation use DoneBot tools and need no Claude CLI, Python or network access. Model inference still uses the user's configured DoneBot service.

## Capture intent

Follow the strict 3-tier skill priority for newly created bots (both single `create_bot` and batch `propose_team_setup`) and general skill setup: (1) install any user-provided skill first; (2) otherwise search and inspect existing high-quality options with `find-skills` / `skill_find` and install/enable the best match; (3) immediately create and enable a custom skill via `skill_manage` (`action: create`, passing target `bot_id`) whenever the user explicitly requests custom creation OR search and inspection find no suitable existing skill (including when online search is unavailable and no local skill fits). Do not pause new-bot setup just to ask whether to create a skill. User-requested updates to a named skill can proceed directly.

Extract the role, recurring work, inputs, expected outputs, useful examples and quality criteria from the conversation. Ask only about material gaps. A one-time task detail belongs in the task; stable identity and responsibilities belong in SOUL.md; reusable professional methods belong in the skill. Use `skills_list` with the target `bot_id` to avoid duplicate skills. Do not modify a named existing skill unless the user requested that modification.

## Write a useful skill

Write SKILL.md with YAML `name` and `description`, then the procedure. Use a lowercase hyphenated name. Make the description specific about when the skill applies. Include decision criteria, output expectations, non-obvious steps, common failure handling and ways to check the result. Add examples where they materially improve the work. Keep the entrypoint focused; put longer details in `references/<topic>.md` and explain when to read them.

Preserve the user's tools, task and authorization scope. Never invent access, credentials, domain facts or successful checks. Identify actual dependencies and explain unavailable ones. Prefer methods the target bot can execute in its environment.

Within platform and permission constraints, the current explicit request takes priority over saved user/project preferences, and these take priority over the skill's defaults. Save lasting user preferences with the existing memory/profile tools. Keep imported source skills intact; make a separately named tailored version when customization is needed. Do not turn one task's exception into a universal rule.

## Install into the intended bot

Call `skill_manage` with `action: create`, the target `bot_id`, complete `skill_md`, any `references`, a short `gist`, and `source: conversation` or the actual source used. A user-requested update uses `action: update` and the exact `skill_name`. Follow applied/pending/failed honestly; a pending skill is inactive until approved. Use the existing Undo/version mechanisms. Never write into another bot's data folder with shell commands.

When a skill needs scripts or templates, build and check the complete folder in this conversation's working files using the available file tools. Use `skill_import` to preview and import that local folder into the target bot, then `skill_manage` to enable it with the same `bot_id`. Importing preserves those resources and does not execute scripts or install their dependencies.

## Test and iterate

Choose representative tasks and edge cases proportional to the skill: for example a normal deliverable, a changed user requirement, and a missing dependency. Evaluate the actual files or results against the user's criteria, not the presence of matching phrases in the reply. Distinguish objective checks from subjective user judgment. Where useful and already within scope, use `coordinate_bots` to ask the target to try the skill and return its real output and checks. This uses DoneBot's runtime, not an external agent CLI.

Compare with the previous behavior when it helps assess an improvement. Preserve test inputs, observed results and unresolved limitations. Request feedback on the output, then revise only what the evidence supports. Do not run chargeable generation, external publication or unrelated actions solely to test a skill without appropriate authorization. Report "created, not yet tested" when no representative run was performed.

For deeper evaluation, consult the bundled `references/grader.md`, `references/comparator.md`, `references/analyzer.md` and `references/schemas.md`. Read them with `skills_list`, `skill_name: skill-creator`, and `reference` set to the relative path; omit `bot_id` to read your own built-in skill. Treat their agent-specific execution examples as reference: use DoneBot's native execution and permission model. There is no requirement to install or invoke Claude Code or Codex.
