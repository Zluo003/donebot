import { parsePackageDocument } from "../../shared/package-format.ts";

export const teamTemplateFixture = (release = "1.0.0") => parsePackageDocument({ format: "openmaus.package", version: 2, package: {
  id: "helper", release, name: "Shared helper", tagline: "Synthetic template.", summary: "Review before installing.", category: "Testing",
  author: { name: "Fixture" }, license: "MIT", outcomes: ["Read files."], setupMinutes: 2, requirements: { apps: [], capabilities: [] }, team: { name: "Shared helper" },
  agents: [{ key: "helper", name: "Helper", appearance: { color: "blue" }, skills: ["report"] }],
  skills: { version: 1, entries: [{ name: "report", description: "Report steps.", instructions: "---\nname: report\ndescription: Report steps.\n---\nRead scripts/report.py.\n",
    files: [{ path: "scripts/report.py", content: "raise RuntimeError('TEMPLATE_SCRIPT_MUST_NOT_RUN')\n" }] }] },
} });
