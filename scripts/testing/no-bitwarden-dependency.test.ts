// Bitwarden's GPL CLI runs in a separate process. Its code and SDKs must not enter DoneBot's package or bundle.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url);
const SELF = "scripts/testing/no-bitwarden-dependency.test.ts";
const tracked = (...patterns: string[]) => execFileSync("git", ["ls-files", "-z", "--", ...patterns], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);

it("no package.json or lockfile names a @bitwarden/ package", () => {
  const files = tracked("package.json", "*/package.json", "**/package.json", "pnpm-lock.yaml", "**/pnpm-lock.yaml", "package-lock.json", "**/package-lock.json", "yarn.lock", "**/yarn.lock");
  expect(files).toContain("package.json");
  expect(files).toContain("pnpm-lock.yaml");
  expect(files.filter((file) => readFileSync(new URL(file, ROOT), "utf8").includes("@bitwarden/"))).toEqual([]);
});

it("no code imports or requires a @bitwarden/ package", () => {
  const code = tracked("*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.mjs", "*.cjs").filter((file) => file !== SELF && !file.startsWith("third_party/"));
  const reaches = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["']@bitwarden\//u;
  expect(code.filter((file) => reaches.test(readFileSync(new URL(file, ROOT), "utf8")))).toEqual([]);
});
