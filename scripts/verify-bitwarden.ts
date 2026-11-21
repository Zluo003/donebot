import { launchVerificationServer } from "./control-omb.ts";
import { installFakeBw } from "../server/testing/install-fake-bw.ts";
import { fixtureApi, mountPreview, parkUntilSignal } from "./testing/preview-fixture.ts";

const fixture = await launchVerificationServer();
let ui: Awaited<ReturnType<typeof mountPreview>> | undefined;
try {
  installFakeBw(fixture.info.dataDir, { clientId: "user.fixture", clientSecret: "fake-client-key", password: "fake-master", email: "bots@example.test", items: [
    { id: "github", name: "GitHub", type: 1, login: { uris: [{ uri: "https://github.com/login" }], username: "fixture", password: "fake-login-value" } },
    { id: "note", name: "Deploy", type: 2, notes: "fake-note-value" },
  ] });
  await fixtureApi(fixture.info.url)("PUT", "/api/config", { language: "en" });
  ui = await mountPreview(fixture, { entry: "/scripts/testing/vault-preview.tsx", route: "/__vault.html", title: "Isolated DoneBot Vault", logLevel: "silent" });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl }));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
}
