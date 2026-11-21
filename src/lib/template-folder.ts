import { namedFolderFiles, normalizeShareFolder, safeFolderPath, SHARE_FOLDER_MAX_BYTES, SHARE_FOLDER_MAX_FILES } from "../../shared/share-folder";
import { t } from "./i18n";

export async function readTemplateFolder(picked: readonly File[]): Promise<Record<string, string>> {
  if (picked.length > SHARE_FOLDER_MAX_FILES * 4) throw new Error(t("templates.folderTooLarge"));
  const originals = new Map<string, File>();
  for (const file of picked) {
    const path = safeFolderPath(file.webkitRelativePath || file.name);
    if (!path) continue;
    if (originals.has(path)) throw new Error(t("templates.folderInvalid"));
    originals.set(path, file);
  }
  const normalized = normalizeShareFolder(Object.fromEntries([...originals.keys()].map(path => [path, ""])));
  const roots = Object.keys(normalized).filter(path => !path.includes("/"));
  const prefix = roots.some(path => originals.has(path)) ? "" : `${[...originals.keys()][0]?.split("/")[0]}/`;
  const entries: Record<string, string> = Object.create(null);
  let total = 0;
  const read = async (path: string) => {
    const file = originals.get(`${prefix}${path}`);
    if (!file) return;
    total += file.size;
    if (total > SHARE_FOLDER_MAX_BYTES) throw new Error(t("templates.folderTooLarge"));
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (path.startsWith("avatars/")) {
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      entries[path] = `data:image/${/\.webp$/i.test(path) ? "webp" : /\.png$/i.test(path) ? "png" : "jpeg"};base64,${btoa(binary)}`;
    } else entries[path] = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  };
  for (const path of roots) await read(path);
  const manifest = entries["bot.md"] ?? entries["team.md"];
  if (manifest) for (const path of namedFolderFiles(manifest)) await read(path);
  return entries;
}
