# Failed desktop workspace navigation

```sh
node --test electron/workspace-navigation.node-test.mjs electron/main-navigation.node-test.mjs electron/desktop-prefs.node-test.mjs
node scripts/verify-workspace-navigation.mjs
```

The Electron fixture creates a temporary home, profile and saved-server file,
plus two loopback HTTP servers. It accepts no live URL and blocks external
requests. It loads the production preload and main process navigation wiring,
with the production workspace permission helpers and native menu template.

It verifies an expired-session redirect blocked by the existing navigation
guard restores the visible computer's saved selection, so its menu works
again. It also checks a successful Cloud round trip, failed startup from an
empty window, retention of the saved server list, and denial of menu access
from a different window. Unit cases cover overlapping navigations, a newer
selection, named local environments, closed windows and bounded fallback.

The printed evidence directory retains `receipt.json`, `electron.log`, the
synthetic `environments.json` and a screenshot. Successful cleanup removes
only the fixture's home and profile. Native menu items are selected
programmatically; this does not test physical popup interaction, an installed
DMG, real Cloud authentication or the server's `ERR_HTTP_HEADERS_SENT` error.
