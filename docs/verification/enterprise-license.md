# Open-source edition and optional layer boundary

DoneBot excludes the upstream proprietary enterprise directory from source,
server bundles, npm packages and desktop resources. The Apache core's optional
loader and entitlement checks remain. A normal standalone server reports
`{"edition":"oss","features":[]}`. Configuring hosted access without an
adapter must deny remote access; deleting the adapter must never grant it.

Run these checks only with disposable fixtures:

```sh
pnpm exec vitest run server/enterprise.test.ts server/license-expiry-api.test.ts server/hosted-access.test.ts
pnpm test:packaged-server
```

`server/enterprise.test.ts` creates synthetic adapters in temporary directories
to verify the optional loader, key notice windows and entitlement expiry.
`server/license-expiry-api.test.ts` checks synthetic expiry notices through an
isolated running server. These stand-ins contain no proprietary adapter code.
Adapter-specific hosted integration tests skip when the optional layer is
absent; the core's fail-closed checks continue to run.

The packaged smoke verifies standalone startup, all proxy entry points, CLI,
encrypted backups, and the loopback trust boundary outside the source tree.
It expects the OSS edition and does not require a real license key. The build
removes stale enterprise output, and npm packaging rejects any remaining
enterprise bundle.

See [the fork record](../development/donebot-fork.md) for package inspection and
isolation evidence. Upstream enterprise license tests are outside this fork.
