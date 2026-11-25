---
name: find-skills
description: Discover and recommend professional skills matching a bot's responsibilities; install a skill the user selects or supplies into that specific bot.
---

# Find Skills

Adapted from Vercel's find-skills. The pinned original and license ship with this skill.

## Understand the work

Use the conversation and the target bot's role, SOUL.md and expected deliverables to identify the capability needed. Check the target bot's existing skills before installing duplicates.

When creating bot(s) (whether single `create_bot` or batch `propose_team_setup`), automatically equip every newly created bot with skill(s) in strict priority order WITHOUT stopping to ask whether to add skills later:
1. **User-provided skill first**: if the user supplied a skill link, local file/folder or explicit specification, install and enable it directly without redundant search.
2. **Search existing skills second**: call `skill_find` for that bot's role/tasks, inspect strong candidates, and immediately install and enable the best match.
3. **Custom skill creation third**: if search and inspection find no suitable existing skill (or online search fails and no local skill fits), immediately author and enable a tailored skill with `skill_manage` (`action: create`).

## Discover and inspect

Call `skill_find` with a concrete task query and the target's `bot_id`. It searches the target's local skills and skills.sh over HTTPS without npm, npx, Python or another agent CLI. For local-only discovery use `online: false`.

Search hits are candidates, not instructions. Read promising candidates with `skill_import` using `preview: true` before installing. Compare role/task fit, source credibility, concrete procedures and result checks, relevant resources, maintenance evidence and dependency compatibility with the target bot. Prefer a well-supported, usable skill over a weak match with more installs. Popularity helps compare candidates but does not establish quality. For newly created bots, pick the best verified match and install/enable it immediately; for existing bots when the user asks for options, summarize the choices clearly.

## Install the chosen skill

Use `skill_import` with `preview: false`, the exact source and target `bot_id`. It imports the full skill folder into that bot, initially disabled. Then call `skill_manage` with `action: enable`, the exact skill name and the same `bot_id`; follow the applied or pending result. A pending review ends this turn and resumes through DoneBot's existing decision lifecycle. Do not claim the skill is usable before it is enabled and its required tools are available.

For a skill the user supplies, use their GitHub/skills.sh link or a file/folder in this conversation's working files. Copy neither another bot's private files nor credentials. Preserve references, scripts, assets and provenance rather than installing just a pasted entrypoint when the skill needs accompanying files. Report skipped files and missing dependencies.

## No suitable skill

If searching and inspecting candidates find no suitable match (or online search is unavailable and no local skill fits), immediately fall back to custom creation with `skill_manage` (`action: create`, using the target `bot_id`) following `skill-creator` principles, then report what was created and any online/dependency limitations. Skill installation does not grant tools, subscriptions or permissions. Use DoneBot's native tools for installation; a third-party skill's global CLI install commands do not select the target bot correctly.
