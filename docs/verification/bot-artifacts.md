# Bot artifacts

The fourth Bot profile tab, after Computer, lists files that Bot reported in
visible conversations, including delegated files returned to that Bot. It does
not scan workspaces or list incoming user attachments. Rows are ordered by the
latest report and grouped by the viewer's local calendar date.

Names are display labels derived from the user request, without another model
call or a filesystem rename. For example, `画一个皮克斯 3D 卡通风格的驴子`
becomes `皮克斯 3D 卡通驴子`. Matching labels of the same file kind receive a
number. Cleanup is deterministic; long or complicated requests may be truncated
instead of semantically summarized. Images and videos have thumbnails; audio
and documents have icons. Each row opens a preview, downloads the original file,
or navigates to its report. Office files without a built-in preview can be
downloaded for opening in a compatible application.

## Isolated renderer

```sh
node --experimental-strip-types scripts/verify-bot-artifacts.ts
```

This launches a disposable server, fake DoneBot gateway and the real renderer.
It requires `ffmpeg` on PATH to create a synthetic PNG, MP4 and MP3, and also
attaches Markdown and CSV fixtures. Open its printed preview URL. Stop with
Ctrl-C to remove the temporary workspace and stop its processes.

In the Bot profile, open Artifacts and check one row per file, task labels,
thumbnails, video/audio playback, Markdown and CSV rendering, download, and
navigation to the source report. Repeat at a 390 × 844 viewport. Browser checks
on 2026-11-17 verified all five rows, decoded thumbnails, video/audio playback,
Markdown and CSV contents, the downloaded Markdown bytes, and no horizontal
overflow at desktop and phone widths. Screenshots are local ignored evidence
under `output/playwright/`.

## Server and component checks

```sh
pnpm exec vitest run server/bot-artifacts.test.ts server/bot-artifacts.e2e.test.ts server/request-auth.test.ts server/message-file.test.ts server/message-file-range.e2e.test.ts server/reused-attachment.e2e.test.ts server/donebot-media-coordination.e2e.test.ts server/host/handoff-attachments.test.ts src/components/bot-panel/ArtifactsTab.dom.test.ts src/components/bot-panel/page-registry.test.ts src/components/bot-panel/PanelShell.dom.test.ts src/lib/last-bot-section.test.ts
pnpm typecheck
pnpm lint
pnpm i18n:check
```

The 177 targeted tests cover task labels, source aliases, dates, pagination,
deduplication, explicit references, delegated reports, direct chats and rooms,
all four file kinds, download bytes, Range previews, forged paths, client
access and visibility revocation. Component tests cover loading, retries,
source navigation and responses arriving after switching Bots. These fixtures
use synthetic gateway credentials and never contact the user's running app.

## Scope and access

The user authorized the minimal underlying changes for this feature. New
same-conversation report metadata associates a resumed Bot's summary with its
returned attachment messages. It does not reattach files, change dispatch,
grant file access, or replace the original execution promise. The listing
checks Bot, conversation and room visibility before reading history. File
reads continue through the original exact-message attachment authorization,
workspace boundaries, generated-file validation and versioned Range response.
Inline preview accepts media and PDF; HTML continues through the existing
sandboxed document viewer.

No storage migration or duplicate artifact file store is introduced. Historical
own attachments and explicit file references are discoverable. A historical
delegated summary without new report metadata can only be linked when its
exact persisted completed assignment result remains available; missing lineage
is not guessed from nearby messages. Missing original files cannot be restored
by the list. Each page currently reads the visible histories for that Bot and
visible rooms; it does not introduce a persistent search index.
