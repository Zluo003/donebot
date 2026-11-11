# Hosted workspace boundary in the open-source edition

DoneBot does not ship the proprietary hosted sign-in adapter. The core's
hosted configuration, contract interfaces and authorization checks are kept
so removing the optional layer cannot turn a configured hosted workspace
into an unrestricted standalone server.

With hosted configuration present, partial or invalid settings, an absent
adapter, or a missing entitlement deny remote access. Loopback remains a
service unless explicitly configured as the owner for recovery. Ordinary
standalone operation continues to use the original open-source mechanisms.
The public hosted health probe returns unavailable without the required
adapter and entitlement.

Read [the verification entry point](README.md) before running these isolated
fixtures:

```sh
pnpm exec vitest run server/hosted-access.test.ts server/email-signin.test.ts server/sessions.test.ts server/request-auth.test.ts server/enterprise.test.ts server/browser-live.test.ts server/fleet.test.ts server/fleet-cli.test.ts server/fleet-agent.test.ts server/fleet-cli-filesystem.test.ts src/components/WorkspacesSection.test.ts
pnpm test:packaged-server
```

Adapter-specific sign-in and revocation cases skip when the licensed layer
is absent. Core boundary tests, session tests and synthetic entitlement tests
still run. These checks do not deploy an identity service or prove a licensed
hosted workflow.

The [upstream hosted protocol documentation](https://github.com/milind-soni/OpenMausBot/blob/main/docs/verification/hosted-workspaces.md)
describes its optional adapter. It is a reference for upstream behavior and
does not describe a service distributed with DoneBot. Linux tenant isolation
requires the separately isolated [fleet verification](fleet.md).
