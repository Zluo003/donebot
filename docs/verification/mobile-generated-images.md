# Agent image attachments on mobile (MOCA-212)

The server puts engine-generated images in `Message.attachments`, including
late patches onto a text reply and replies with no text. Both native clients
previously discarded this wire field. Desktop rendered it, but the mobile chat
showed only the accompanying sentence (or an empty bubble).

The native models now preserve that field and the text bubbles display its
image entries using the existing authenticated attachment previews. Unknown
attachment kinds remain decodable, duplicate paths render once, and old text
messages still work. Image placeholders, labels, and errors use the appropriate
foreground color for the message. iOS keeps image view identity by path.

The message file endpoint now accepts the exact generated image listed on the
stored bot message. This grant is restricted to the private attachment directory
and image files; it does not grant arbitrary workspace reads. Existing Markdown
and user-upload authorization still applies to their respective requests.

**Compatibility:** this fix needs the updated native client and server. An older
server rejects the new message-scoped generated-image request. This verification
covers structured `Message.attachments`, not arbitrary Markdown image syntax,
remote image URLs, or a specific reporter's provider/device (none was supplied).

## Isolation and regressions

No paired computer, live account, or user conversation was used.

- Swift and Kotlin wire/cache round-trip regressions both failed before the model
  change (the image path disappeared) and passed afterward.
- Native core regressions cover legacy text, image-only replies, future attachment
  kinds, duplicate paths, and late message patches.
- Android `GeneratedImageWiringTest` mounts the real message row and Session with
  disposable MockWebServers. The tests cover a late patch, an image-only reply,
  dark/light surfaces, failed-download retry, preview callback bytes and the
  originating message, plus the POST path/body and bearer. All sockets are closed.
- iOS `GeneratedImageUITests` runs in a disposable iPhone 17 Pro simulator. The
  explicit `-images-preview` flag uses a bundled synthetic fleet and PNG. Its
  URLProtocol intercepts all traffic and only returns the PNG for the exact
  message-scoped POST, synthetic bearer, and file path. The same test fails with
  the original renderer and passes with the image row, then waits for the full-screen image canvas and closes the preview.
- Real HTTP regressions in `server/index.test.ts` use its disposable home/server.
  They reproduce the prior 403 for an image-only attachment, prove image download,
  and reject another message/path, a path outside the private attachment directory,
  and a non-image file. The targeted run also checks existing file/image previews.

The iOS protocol fixture and Android HTTP stubs test the native request and UI;
the separate real-server tests test server authorization. They do not constitute
a physical phone connected end to end to a released desktop build.

## Commands and evidence

From the repository root, with Node 24, Android SDK and the repository's JDK setup:

```sh
swift test --package-path ios
android/gradlew -p android :core:test :app:testDebugUnitTest :app:assemblePreview --max-workers=2
pnpm exec vitest run server/index.test.ts -t 'structured generated image|downloads only a file|downloads an image|streams an authorized|shared in a user|user attachment|preview'
pnpm typecheck
pnpm test
```

Native results: **462 Swift core tests; 544 Android core + 916 Android app tests**.
The Android preview APK builds and passes APK v2 signature verification. The
focused real-server run passes **10 tests** (220 unrelated tests filtered out).

Repository-wide run on 2026-09-19: **7,351 passed, 1 failed, 60 skipped,
1 todo** across 586 Vitest files (569 passed, 1 failed, 16 skipped). The only
failure is the existing delegate replay assertion at
`server/delta-context.e2e.test.ts:963`, previously reproduced against pristine
main `0c327bca` during the mobile queue investigation. It is unrelated to these
attachment changes. `pnpm test` therefore exits nonzero before its chained
checks; running those separately passes **9 broker tests**, **347 Electron tests
(3 skipped)**, and the packaged-server smoke. Typecheck, lint, and locale
validation pass. The full suite is not claimed green.

Generate the Xcode project with `xcodegen generate --spec ios/project.yml`.
Create a fresh simulator, then run:

```sh
xcodebuild -project ios/OpenMausCompanion.xcodeproj \
  -scheme OpenMausCompanion \
  -destination 'platform=iOS Simulator,id=YOUR_DISPOSABLE_SIMULATOR_ID' \
  -resultBundlePath /tmp/mobile-images.xcresult \
  -parallel-testing-enabled NO \
  -only-testing:OpenMausCompanionUITests/GeneratedImageUITests \
  CODE_SIGNING_ALLOWED=NO test
```

Shut down and delete only that simulator afterward. No signing or release is
performed. The preview protocol and fleet selection are compiled only in DEBUG.

| Before | After |
| --- | --- |
| ![Original iOS renderer omits the attached image](assets/mobile-generated-images/before.png) | ![iOS now displays the generated image](assets/mobile-generated-images/after.png) |

![Full-screen preview of the synthetic image](assets/mobile-generated-images/preview.png)

## DoneBot React / Capacitor client

The sibling `DoneBot-Mobile` client now carries binary files over the existing
Noise / yamux connection. The custom DoneBot mobile origin admits idempotent
image uploads, stored raster avatars, and message-scoped POST downloads before
the original request authorization and file checks. The gateway and independent
relay keep forwarding opaque encrypted records.

`server/donebot/mobile-host.test.ts` covers the restricted routes, and
`scripts/verify-mobile-hub.ts` exercises PNG / MP4 / WAV / PDF / TXT through an
isolated original server, the PostgreSQL hub and independent relay. It compares
all returned bytes, checks repeated upload IDs, and rejects a file not shared by
the requested message and the private server configuration. Evidence is written
to `.omb-scratch/verify-evidence/mobile-hub/evidence.json`.

Run with the sibling projects available:

```sh
cd ../donebot-api
DONEBOT_MOBILE_PG_FIXTURE=1 \
DONEBOT_MOBILE_DESKTOP_ROOT=/Users/zluo/Dev/DoneBot \
DONEBOT_MOBILE_RELAY_ROOT=/Users/zluo/Dev/DoneBot-Relay \
go -C backend test -tags integration ./internal/mobilehub \
  -run TestPostgresDesktopMobileWorkflow -count=1 -v -timeout 150s
```

The 2026-11-15 run passed, including notification and logout revocation checks.
Mobile unit tests and simulator compilation are recorded in the sibling
`DoneBot-Mobile/docs/verification.md`. Physical camera access and iOS document /
share destinations still require device verification. Existing desktop and Cloud
runtimes need the new mobile route gate; no gateway or relay protocol deployment
is required for these file operations.

The follow-up 2026-11-15 workflow also calls the original `attach_file` tool on a
synthetic `jimeng-image-generate-20261114155450727-fixture.png`. It finds the
resulting structured image on the stored bot message and compares the bytes
downloaded through the encrypted mobile connection. This passed alongside the
five Markdown file downloads and the existing upload / notification checks.

Read-only inspection of the installed `/Applications/DoneBot.app` found the old
chat-only mobile gate, which returns `mobile request refused` for file requests.
The new unsigned arm64 DMG is under `release/mobile-media-20261115/`; its packaged
server includes the attachment routes. The packaged-server smoke and DMG checksum
verification passed. Neither the installed application nor a running Cloud was
replaced during verification.
