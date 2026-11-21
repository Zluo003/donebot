import { expect, it, vi } from "vitest";
import { parsePackageDocument } from "../../shared/package-format";
import { readShareFolder, writeShareFolder } from "../../shared/share-folder";
import { readTemplateFolder } from "./template-folder";

const pkg = parsePackageDocument({ format: "openmaus.package", version: 2, package: {
  id: "helper", release: "1.0.0", name: "Helper", tagline: "Help.", summary: "A helper.", category: "Testing", author: { name: "Fixture" }, license: "MIT", outcomes: ["Help."], setupMinutes: 2,
  requirements: { apps: [], capabilities: [] }, team: { name: "Helper" }, agents: [{ key: "helper", name: "Helper", appearance: { color: "blue" }, skills: ["report"] }],
  skills: { version: 1, entries: [{ name: "report", description: "Report steps.", instructions: "---\nname: report\ndescription: Report steps.\n---\nRead references/中文指南.md.\n", files: [{ path: "references/中文指南.md", content: "# 中文\r\n" }] }] },
} });
const picked = () => Object.entries(writeShareFolder(pkg, "bot")).map(([path, content]) => {
  const file = new File([content as string], path.split("/").at(-1)!);
  Object.defineProperty(file, "webkitRelativePath", { value: `helper/${path}` });
  return file;
});

it("reads only manifest-declared files from a browser folder and preserves Unicode and CRLF", async () => {
  const unlisted = new File(["PRIVATE"], "unlisted.sh");
  Object.defineProperty(unlisted, "webkitRelativePath", { value: "helper/skills/report/unlisted.sh" });
  const read = vi.spyOn(unlisted, "arrayBuffer");
  const files = await readTemplateFolder([...picked(), unlisted]);
  expect(read).not.toHaveBeenCalled();
  expect(files["skills/report/references/中文指南.md"]).toBe("# 中文\r\n");
  expect(readShareFolder(files)).toMatchObject({ kind: "package", document: pkg });
  expect(JSON.stringify(files)).not.toContain("PRIVATE");
});

it("rejects duplicate paths and invalid text before returning a preview", async () => {
  const files = picked();
  await expect(readTemplateFolder([...files, files[0]!])).rejects.toThrow();
  const invalid = new File([new Uint8Array([0xff])], "bot.md");
  Object.defineProperty(invalid, "webkitRelativePath", { value: "helper/bot.md" });
  await expect(readTemplateFolder([invalid])).rejects.toThrow();
});
