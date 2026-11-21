import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bitwardenCliPath, bitwardenCliPin } from "../host/bitwarden-cli.ts";
import type { FakeBwAccount } from "./fake-bw.ts";

export function installFakeBw(dataDir: string, account: FakeBwAccount): void {
  const pin = bitwardenCliPin();
  if (!pin || process.platform === "win32") throw new Error("This fixture needs a POSIX Bitwarden launcher.");
  const path = bitwardenCliPath(dataDir, pin);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const accountPath = join(dirname(path), "fixture-account.json");
  writeFileSync(accountPath, JSON.stringify(account), { mode: 0o600 });
  const runner = fileURLToPath(new URL("./fake-bw-process.ts", import.meta.url));
  writeFileSync(path, `#!${process.execPath}\nprocess.env.FAKE_BW_VAULT = ${JSON.stringify(accountPath)};\nawait import(${JSON.stringify(runner)});\n`, { mode: 0o700 });
}
