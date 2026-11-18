# Built-in coordinator skills and specialist setup

Run the deterministic fixture with a disposable home and fake engine:

```sh
pnpm exec vitest run server/bot-skill-setup.e2e.test.ts server/skill-discovery.test.ts server/skill-import-local.test.ts server/skill-library.test.ts server/host/skill-switch-host.test.ts server/drivers/agents-call.test.ts server/routes/bot-skills.test.ts
pnpm typecheck
pnpm lint
pnpm test:packaged-server
```

The conversation fixture uses `launchVerificationServer` and `control-omb
send` with its explicit temporary URL. It reads the resulting active-turn
capability, then calls the native skill endpoints. Its `.bot-skill-setup.json`
evidence file remains beside the printed fixture log; temporary app data is
removed. No live workspace, gateway account or provider is used.

The fixture verifies:

- Chiefs receive both built-in instruction blocks without task keywords;
  specialists receive their own enabled skills. A preexisting private skill
  with the same name cannot replace or switch off a Chief's built-in skill,
  including with the team library enabled.
- The native Bot creation route persists supplied responsibilities in SOUL.md.
- A Chief previews a local skill without installing it, then imports its
  entire folder into the intended specialist, disabled. References, scripts,
  binary assets and executable flags survive. Scripts are not executed.
- Offline discovery includes disabled local skills. Enabling, custom
  authoring, updates and Undo affect the specialist, with a receipt naming it
  in the Chief's conversation. Cross-target authoring does not auto-share.
- Current management authority is checked on mutation and Undo. Unmanaged
  departments, non-Chief peer access and expired capabilities are refused.
- Built-in evaluation references can be read through `skills_list` with
  `skill_name` and a relative `reference`, without granting general access to
  the application's resource directory.

Focused tests cover registry failures, full-folder local import boundaries,
exact uploaded-file scope, symlink refusal, size limits, pending switch
approval, authority revoked while review is open, denial cleanup and revoked
Undo. The packaged-server smoke copies the actual `skills/` resources beside
the built server, outside the checkout with no `node_modules` in reach. Its
seeded Chief loads both entrypoints, licenses, pinned originals and evaluation
references locally, without sign-in or skill installation. When
`DONEBOT_SMOKE_DIST` names an app's Resources/server, resources come from that
app's sibling skills directory.

The built-ins are DoneBot adaptations of pinned Vercel find-skills and
Anthropic skill-creator sources. Each ships its source commit, original
entrypoint and license. Core discovery and authoring use native DoneBot tools,
without npm, npx, Python or another agent CLI. Online registry search and new
remote skill downloads still require network access; model inference requires
the configured DoneBot service. External skills retain their own dependencies.

Bot planning is scripted in these tests. They prove wiring, persistence and
permissions; recommendation quality, the optional skill interview and the
quality of authored skills need evaluation with representative real tasks.
