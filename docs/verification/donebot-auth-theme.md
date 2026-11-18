# Account and first-use themes

Login, registration and password recovery use the active app skin for surfaces,
text, fields, buttons, status messages and the brand mark. Native account and
Chief setup controls use that skin's color scheme. Fresh installations default
to System; an explicitly chosen skin remains selected.

Launch the isolated account fixture and open its printed URL with `?surface=app`:

```sh
node --experimental-strip-types scripts/verify-donebot-auth-ui.ts
```

Use a fresh browser profile with no saved skin. Emulate light and dark system
preferences on each account view without reloading. The resolved skin must
change between `daylight` and `midnight`, while `omb-skin` remains `system`.
Inspect the form background, text, brand mark, native `color-scheme`, focus,
buttons, errors and notices. Repeat registration at 390×844 and check horizontal
overflow.

Use only the fixture email `fixture@example.invalid` and synthetic passwords.
Password recovery accepts `123456`; `000000` produces the error state. After a
successful reset, verify the login success notice in both modes. Register with
matching passwords, the synthetic code and an invitation value; the full app
must continue to the Chief setup without changing the selected theme. Verify
the login-to-setup transition in a fresh isolated account session too.

Launch the Cloud-owner setup separately:

```sh
node --experimental-strip-types scripts/verify-donebot-chief-setup.ts --cloud
```

Inspect all five steps in both modes, including the native model selector,
avatar picker and review. At 390×844 verify scrolling without horizontal
overflow. Stop each launcher with Ctrl-C and close its browser session.

```sh
pnpm exec vitest run src/lib/skins.default.test.ts src/donebot/ChiefSetup.dom.test.ts src/donebot/chief-setup.test.ts src/components/onboarding/WelcomeGate.test.ts --maxWorkers=1
pnpm lint
pnpm build
```

Verified November 18, 2026: 38 tests, lint and production build passed. Browser
checks covered registration and login into local setup, password reset errors
and success, live system changes, all five Cloud-owner setup steps and narrow
screens. Sampled normal text, input, button, error and notice contrast exceeded
4.5:1 in the settled light and dark states. Evidence is in
`.omb-scratch/verify-evidence/donebot-auth-theme.json`; screenshots are under
`output/playwright/donebot-theme-*.png`. All accounts and servers were isolated
fixtures. This does not verify a deployed Cloud frontend or packaged Electron
window chrome.
