# First-use coordinator setup

A fresh personal workspace opens five steps: name and user address, personality,
DoneBot model, avatar, and review. This applies to local and Cloud owners. Blank
names save as 多宝. Personality tags and custom text are saved through the
existing Bot profile/SOUL route, alongside the model and avatar. Established
workspaces, imported Chiefs, hosted members and another person's Chief do not
get this setup. Completed setups do not reopen.

Launch a disposable full-app fixture with a synthetic DoneBot account and model
catalog:

```sh
node --experimental-strip-types scripts/verify-donebot-chief-setup.ts
```

Open its printed `previewUrl` in a separate browser session. Never substitute
the user's running server. The fixture uses `launchVerificationServer`, its
temporary home and the fake gateway; it contacts no real provider.

1. Leave the Bot name blank, enter 小林 as the user address, then continue.
2. Select multiple personality tags and enter a custom communication preference.
   Reload; the current step and inputs must survive.
3. Choose a model from the enabled DoneBot catalog. Continue to the avatar step;
   nine normal shapes and twelve colors are available, with no triangle.
4. Choose a shape and color and check the live preview. At 390×844 the page must
   scroll vertically without horizontal overflow. Return to a desktop viewport.
5. Review every field. Before saving, send `POST /__fixture/fail-save` to the
   printed preview origin. This fails only the next completion-config write,
   after the real Bot profile save. Save, check the visible retry message, then
   reload. The draft must resume at review even though the Bot is now welcomed.
6. Retry Save. Read `GET /__fixture/evidence` and the real
   `GET /api/bots/:id/system-prompt`: the profile must contain the chosen model,
   shape and color; the prompt must contain the address, tag instructions and
   custom preference once, preserving any preexisting SOUL text. Reload again;
   no setup dialog should open.

Stop the launcher with Ctrl-C, then run a fresh Cloud fixture:

```sh
node --experimental-strip-types scripts/verify-donebot-chief-setup.ts --cloud
```

This changes the preview's session response to a Cloud owner while retaining
the isolated server. Complete the five steps. The saved onboarding hints must
include `donebot-chief-setup-v1`, `cloud-welcome-done` and `cloud-intent-asked`;
there must be no second legacy Cloud welcome after saving or reloading. Stop
the launcher and close only this browser session when done.

Offline checks:

```sh
pnpm exec vitest run src/donebot/chief-setup.test.ts src/donebot/ChiefSetup.dom.test.ts src/components/onboarding/WelcomeGate.test.ts src/components/onboarding/WelcomeFlow.test.ts src/components/MausBotWelcome.gate.test.ts src/components/MausBotWelcome.test.ts src/components/BotProfileAvatarCard.test.ts src/lib/bot-creation-draft.test.ts src/lib/new-bot.test.ts src/lib/ready-bots.test.ts src/lib/new-look.test.ts server/bot-look.test.ts server/store.test.ts
pnpm exec vitest run src/components/BotSettingsDialog.simple.test.ts -t 'the avatar editor'
pnpm lint
pnpm i18n:check
pnpm build
```

The creation tests cover direct Bot creation, team setup and fresh looks, and
preserve explicitly supplied/imported shapes. Frontend creation templates
normalize the triangle to a circle. Avatar editors hide the triangle and reset
to a circle without rewriting existing Bot profiles.

Verified November 18, 2026: both browser workflows above, partial-save recovery,
persisted runtime prompt, Cloud completion hints and reload behavior; 279 tests
in the main command and 8 avatar-editor tests passed. Lint, locale validation
and production build passed. Evidence is in
`.omb-scratch/verify-evidence/donebot-chief-{local,cloud,prompt}.json`, with
screenshots in `output/playwright/donebot-chief-*.png`. A wider run of
`BotSettingsDialog.simple.test.ts` still has an unrelated assertion expecting
three profile tabs when the existing UI exposes the Artifacts tab as well.
The fixtures do not prove a deployed Cloud image, native Electron permissions
or actual provider adherence to personality preferences.

## Simple mode without an introduction dialog

DoneBot disables interface-mode introduction dialogs through
`DONEBOT_ONBOARDING.showInterfaceModePrompt`. A fresh browser still defaults to
Simple through the existing interface-mode settings. The same rule covers
local workspaces and Cloud pages, including pending mode-migration notices.
The desktop Cloud page uses the frontend shipped in the client, so this change
requires a new desktop package rather than a Cloud service image update.

```sh
pnpm exec vitest run src/components/AppNotices.test.ts src/lib/interface-mode.test.ts src/lib/new-look.test.ts src/lib/skins.default.test.ts --maxWorkers=1
```

Verified November 18, 2026: 133 checks, lint and production build passed. In a
fresh `--cloud` fixture, completed all five setup steps and sent a synthetic
chat message. After reloading and opening a new page session, Simple remained
the default with no mode dialog and no prompt-dismissal marker. A pending
Advanced-mode migration notice also stayed hidden. Light, dark and 840×680
views had no dialog or visible overflow. Evidence is in
`.omb-scratch/verify-evidence/donebot-cloud-simple-no-prompt.json`, with
screenshots under `output/playwright/donebot-cloud-simple-no-prompt-*.png`.
