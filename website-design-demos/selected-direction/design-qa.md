# Design QA

**Findings**
- Visual verification is blocked. The Codex in-app browser rejected the prototype's `file://` URL because the browser policy allows only `http:` and `https:` URLs. The rejection explicitly prohibited trying another browser surface or serving the same prototype through an alternate route.

**Source visual truth**
- DoneBot brand avatar: `/Users/zluo/Dev/DoneBot/branding/donebot/app-icon.svg`.
- Actual desktop client screens: `assets/client-commerce.png`, `assets/client-tiktok-shop.png`, and `assets/client-creator-studio.png` (each 1280 x 577 px).
- Actual mobile client screen: `assets/client-mobile.png` (390 x 844 px).
- These references supply the product imagery and avatar. There is no full-page design mock to compare against.

**Implementation evidence**
- Pages: `index.html`, `capabilities.html`, and `scenarios.html`.
- Implementation screenshot: not captured because the browser rejected the local page URL.
- Intended review viewports: desktop 1440 x 900 CSS px and mobile 390 x 844 CSS px. Neither was visually verified.
- State: light theme, page top, default navigation state.
- Full-view and focused-region comparisons: not performed.
- Navigation, responsive menu, download feedback, console errors, and reduced-motion behavior: not browser-tested.

**Static checks**
- `node --check assets/site.js` passed.
- Confirmed the pages use the local client screenshots and brand asset, and that the prototype contains no `fetch`, `XMLHttpRequest`, or `WebSocket` calls.
- The original three HTML drafts in the parent directory remain untouched.

**Implementation checklist**
- [x] Build three linked Chinese pages with red, black, white, and neutral colors.
- [x] Use actual DoneBot client screenshots and the round DoneBot brand avatar.
- [x] Add a reduced-motion rule for the avatar idle animation.
- [x] Keep download controls in local demonstration state without backend requests.
- [ ] Capture desktop and mobile browser screenshots and test page navigation and download feedback.
- [ ] Compare rendered pages with the available product references.

final result: blocked
