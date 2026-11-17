import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function installFakeCodingClis(dataDir: string): string {
  const directory = join(dataDir, "fixture-coding-bin");
  mkdirSync(directory, { recursive: true });
  for (const [name, source] of [["codex", "fake-codex-app-server.ts"], ["claude", "fake-claude-cli.ts"]]) {
    const target = new URL(`../../server/testing/${source}`, import.meta.url);
    if (process.platform === "win32") writeFileSync(join(directory, `${name}.cmd`), `@"${process.execPath}" --experimental-strip-types "${fileURLToPath(target)}" %*\r\n`);
    else {
      const wrapper = join(directory, `${name}.mjs`);
      writeFileSync(wrapper, `#!/usr/bin/env node\nawait import(${JSON.stringify(target.href)});\n`, { mode: 0o700 });
      symlinkSync(wrapper, join(directory, name));
    }
  }
  return directory;
}
