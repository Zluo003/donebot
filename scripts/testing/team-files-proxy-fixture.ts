import { readFileSync } from "node:fs";
import { launchVerificationServer } from "../control-omb.ts";
import { parkUntilSignal } from "./preview-fixture.ts";
import { FAKE_DONEBOT_CATALOG, startFakeDoneBotGateway } from "../../server/testing/fake-donebot-gateway.ts";

const team = JSON.parse(readFileSync(0, "utf8")) as {
  id: string; name: string; instanceId: string; publicKey: string; files: { cap: number; uploadMax: number; templates?: boolean };
};
const gateway = await startFakeDoneBotGateway(FAKE_DONEBOT_CATALOG, undefined, "1");
let fixture: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
try {
  fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, gateway.origin, undefined, undefined, undefined, team);
  console.log(JSON.stringify(fixture.info));
  await parkUntilSignal();
} finally { await fixture?.close(); await gateway.close(); }
