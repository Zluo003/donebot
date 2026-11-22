import { useCallback, useEffect, useState } from "react";
import { ChevronRight, FileText, Folder, Loader2, RefreshCw } from "lucide-react";
import { api } from "@/state/api";
import type { DoneBotSharedFolder } from "../../shared/donebot-collab";
import { cleanError, COLLAB_BUTTON } from "./collab-types";

type RemoteDirEntry = { name: string; kind: "file" | "dir"; size?: number };

function parseDirectoryEntries(rawText: string): RemoteDirEntry[] {
  try {
    const parsed = JSON.parse(rawText) as { entries?: Array<{ name?: string; type?: string }> };
    if (Array.isArray(parsed?.entries)) {
      return parsed.entries
        .filter(item => typeof item?.name === "string" && item.type !== "blocked-link" && item.type !== "protected")
        .map(item => ({ name: item.name!, kind: item.type === "directory" ? "dir" : "file" }));
    }
  } catch { /* Fall back to plain-text line format */ }
  const entries: RemoteDirEntry[] = [];
  for (const line of rawText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.endsWith("/")) {
      entries.push({ name: trimmed.slice(0, -1), kind: "dir" });
    } else {
      const match = /^(.+?)\s+\((\d+)\s*B\)$/.exec(trimmed);
      entries.push(match ? { name: match[1]!, kind: "file", size: Number(match[2]) } : { name: trimmed, kind: "file" });
    }
  }
  return entries;
}

function formatReadFilePreview(rawText: string): string {
  try {
    const parsed = JSON.parse(rawText) as { content?: unknown; encoding?: string };
    if (typeof parsed?.content === "string") {
      return parsed.encoding === "base64" ? `[二进制文件，Base64 长度 ${parsed.content.length}]` : parsed.content;
    }
  } catch { /* Plain text fallback */ }
  return rawText;
}

function extractResultText(payload: unknown): { text: string; isError: boolean } {
  const res = (payload as { result?: { isError?: boolean; content?: Array<{ text?: string }> } })?.result;
  const text = Array.isArray(res?.content) ? res.content.map(part => part?.text ?? "").join("\n") : "";
  return { text, isError: res?.isError === true };
}

export function CollabFolderBrowser({ folder }: { folder: DoneBotSharedFolder }) {
  const [browsePath, setBrowsePath] = useState("");
  const [entries, setEntries] = useState<RemoteDirEntry[]>([]);
  const [rawText, setRawText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ path: string; text: string } | null>(null);

  const loadDir = useCallback(async (relPath: string) => {
    setBrowsePath(relPath);
    setPreview(null);
    setLoading(true);
    setError("");
    try {
      const res = await api(`/api/donebot/collab/folders/${folder.id}/invoke`, {
        method: "POST",
        body: JSON.stringify({ action: "list_files", path: relPath }),
      });
      const parsed = extractResultText(res);
      if (parsed.isError) {
        setError(parsed.text || "无法列出远程目录。");
        setEntries([]);
        setRawText("");
      } else {
        setRawText(parsed.text);
        setEntries(parseDirectoryEntries(parsed.text));
      }
    } catch (cause) {
      setError(cleanError(cause, "读取远程目录失败。"));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [folder.id]);

  useEffect(() => {
    void loadDir("");
  }, [loadDir]);

  const openFile = async (filePath: string) => {
    setLoading(true);
    setError("");
    try {
      const res = await api(`/api/donebot/collab/folders/${folder.id}/invoke`, {
        method: "POST",
        body: JSON.stringify({ action: "read_file", path: filePath }),
      });
      const parsed = extractResultText(res);
      if (parsed.isError) {
        setError(parsed.text || "无法读取该文件。");
      } else {
        setPreview({ path: filePath, text: formatReadFilePreview(parsed.text) });
      }
    } catch (cause) {
      setError(cleanError(cause, "读取远程文件失败。"));
    } finally {
      setLoading(false);
    }
  };

  const parentPath = browsePath.includes("/") ? browsePath.slice(0, browsePath.lastIndexOf("/")) : "";

  return (
    <div className="flex flex-col gap-2.5 rounded-xl bg-inset/80 p-3 ring-1 ring-inset ring-hairline/60">
      <div className="flex items-center justify-between gap-2 text-[12px]">
        <div className="flex min-w-0 items-center gap-1.5 font-mono text-ink-secondary">
          <button type="button" onClick={() => void loadDir("")} className="hover:text-ink">
            /{folder.name}
          </button>
          {browsePath && (
            <>
              <ChevronRight size={12} aria-hidden="true" />
              <span className="truncate text-ink">{browsePath}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {browsePath && (
            <button type="button" onClick={() => void loadDir(parentPath)} className={`${COLLAB_BUTTON} h-7 px-2 text-[11px]`}>
              返回上级
            </button>
          )}
          <button
            type="button"
            aria-label="刷新目录"
            onClick={() => void loadDir(browsePath)}
            className={`${COLLAB_BUTTON} h-7 px-2 text-[11px]`}
          >
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} aria-hidden="true" />
          </button>
        </div>
      </div>

      {error && <div role="alert" className="text-[12px] text-danger">{error}</div>}

      {loading ? (
        <div className="flex items-center gap-2 py-3 text-[12px] text-ink-secondary">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />正在经网关读取对方文件夹…
        </div>
      ) : preview ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-[12px]">
            <span className="font-mono font-medium text-ink">{preview.path}</span>
            <button type="button" onClick={() => setPreview(null)} className={`${COLLAB_BUTTON} h-7 px-2 text-[11px]`}>
              返回目录
            </button>
          </div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-app p-3 font-mono text-[11px] leading-relaxed text-ink ring-1 ring-inset ring-hairline/50">
            {preview.text}
          </pre>
        </div>
      ) : entries.length > 0 ? (
        <ul className="max-h-64 divide-y divide-hairline/30 overflow-y-auto rounded-lg bg-app/70 ring-1 ring-inset ring-hairline/50">
          {entries.map(entry => {
            const fullPath = browsePath ? `${browsePath}/${entry.name}` : entry.name;
            return (
              <li key={fullPath}>
                <button
                  type="button"
                  onClick={() => entry.kind === "dir" ? void loadDir(fullPath) : void openFile(fullPath)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12px] transition-colors hover:bg-ink/[0.04]"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {entry.kind === "dir"
                      ? <Folder size={13} className="shrink-0 text-accent-text" aria-hidden="true" />
                      : <FileText size={13} className="shrink-0 text-ink-tertiary" aria-hidden="true" />}
                    <span className="truncate text-ink">{entry.name}</span>
                  </span>
                  {entry.size !== undefined && (
                    <span className="shrink-0 tabular-nums text-[11px] text-ink-tertiary">{entry.size} B</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="py-2 text-[12px] text-ink-tertiary">
          {rawText ? rawText : "此目录为空。"}
        </p>
      )}
    </div>
  );
}
