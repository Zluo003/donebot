# DoneBot client updates

Run the isolated update checks:

```sh
node --test electron/client-update-feed.node-test.mjs electron/client-update-package.node-test.mjs electron/client-update-http.node-test.mjs electron/mac-updater.node-test.mjs electron/updater-coordinator.node-test.mjs electron/updater-staged-recheck.node-test.mjs
pnpm exec vitest run electron/updater.test.mjs
```

The package fixture runs electron-builder's actual `afterPack` publish handler
with `--publish never` for macOS DMG/ZIP and Windows NSIS. It verifies that
`app-update.yml` contains the platform's DoneBot feed and a cache directory.
The HTTP fixture uses the shipped MacUpdater and a loopback gateway: version
0.1.0 detects 0.1.1 and resolves the update ZIP URL; an equal version has no
update. The native staging fixture transfers ZIP bytes through the actual
authenticated loopback proxy, with the native installer simulated.

The runtime fixture checks that a packaged application missing `app-update.yml`
reports an unavailable updater, including after a manual check. Development
sessions continue to skip packaged updates.

For release acceptance, verify `Contents/Resources/app-update.yml` in the built
application, the mounted DMG, and an isolated ZIP extraction. Check the extracted
application's signature, notarization ticket, version, and architecture. A feed
or staging fixture does not prove that Squirrel.Mac replaced a signed application.

The originally distributed 0.1.0 and 0.1.1 applications lack this configuration
and exit before starting the updater. They require one manual installation of
a corrected package. Publishing another gateway release cannot enable their
disabled updater.
