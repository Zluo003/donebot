import { describe, expect, it } from "vitest";
import type { Message } from "./store.ts";
import type { HandoffView } from "./coordinator.ts";
import { artifactPage, artifactTitle, collectBotArtifacts, type ArtifactThread } from "./bot-artifacts.ts";

const user = (id: string, at: number, text = "画一个皮克斯 3D 卡通风格的驴子"): Message => ({ id, at, role: "user", kind: "text", text });
const file = (name: string) => ({ kind: "file" as const, name, path: `/data/attachments/${name}`, mime: name.endsWith("pdf") ? "application/pdf" : "video/mp4" });
const reply = (id: string, at: number, extra: Partial<Message> = {}): Message => ({ id, at, role: "bot", kind: "text", text: "Done.", ...extra });
const thread = (messages: Message[], extra: Partial<ArtifactThread> = {}): ArtifactThread => ({ threadId: "chat", title: "Studio", ownerBotId: "editor", messages, ...extra });

describe("a bot's reported artifacts", () => {
  it("uses the task for the display name, preserving meaningful style and subject", () => {
    expect(artifactTitle("画一个皮克斯 3D 卡通风格的驴子", "1234.png")).toBe("皮克斯 3D 卡通驴子");
    expect(artifactTitle("请帮我写一份季度销售报告", "uuid.pdf")).toBe("季度销售报告");
    expect(artifactTitle("让设计师设计一个皮克斯 3D 卡通风格的驴子的形象", "uuid.png")).toBe("皮克斯 3D 卡通驴子");
    expect(artifactTitle("Please draw a Pixar 3D cartoon donkey", "uuid.png")).toBe("Pixar 3D cartoon donkey");
    expect(artifactTitle("Write a report\n" + "x".repeat(500), "report.pdf").length).toBeLessThanOrEqual(64);
  });

  it("excludes inputs, tool pictures and internal-only replies; collects reported references and four file kinds", () => {
    const request = user("request", 1);
    request.attachments = [file("reference.pdf")];
    const rows = [request, reply("report", 2, { attachments: [
      { kind: "image", name: "uuid.png", path: "/data/attachments/uuid.png", mime: "image/png" },
      file("film.mp4"), { ...file("music.mp3"), mime: "audio/mpeg" }, file("brief.pdf"),
      { kind: "image", name: "screen.png", path: "/data/attachments/screen.png", mime: "image/png", fromTool: true },
    ] }), reply("link", 3, { text: "[Notes](/workspace/notes.md) and `/workspace/log.txt`" })];
    const items = collectBotArtifacts("editor", [thread(rows), thread([reply("private", 5, { attachments: [file("internal.pdf")] })], { threadId: "work", internal: true })]);
    expect(items).toHaveLength(6);
    expect(new Set(items.map(item => item.kind))).toEqual(new Set(["image", "video", "audio", "document"]));
    expect(items.some(item => /reference|screen|internal/.test(item.name))).toBe(false);
    expect(items[0]!.at).toBe(3);
    expect(items.every(item => item.title.startsWith("皮克斯 3D 卡通驴子"))).toBe(true);
  });

  it("includes a teammate's files only after this bot reports them and keeps the source message's authority", () => {
    const incoming = reply("incoming", 2, { text: "", attachments: [file("brief.pdf")], from: { botId: "artist", name: "Artist", color: "blue" } });
    const rows = [user("request", 1), incoming];
    expect(collectBotArtifacts("editor", [thread(rows)])).toEqual([]);
    rows.push(reply("summary", 4, { reportedAttachmentMessageIds: ["incoming", "not-in-this-chat", "request"] }));
    const items = collectBotArtifacts("editor", [thread(rows)]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ at: 4, messageId: "incoming", reportMessageId: "summary", threadId: "chat" });
    expect(items[0]!.previewUrl).toContain("messages/incoming/file");
  });

  it("recognizes historical coordinator results without guessing adjacent messages", () => {
    const incoming = reply("incoming", 2, { text: "", attachments: [file("brief.pdf")], handoffAssignmentIds: ["assignment"], from: { botId: "artist", name: "Artist", color: "blue" } });
    const assignment = { id: "assignment", botId: "editor", threadId: "chat", status: "completed", result: "Delivered." } as HandoffView;
    const rows = [user("request", 1), incoming, reply("unrelated", 3), reply("summary", 4, { text: "Delivered." })];
    expect(collectBotArtifacts("editor", [thread(rows)], () => assignment)[0]).toMatchObject({ reportMessageId: "summary", messageId: "incoming" });
    expect(collectBotArtifacts("editor", [thread(rows)], () => ({ ...assignment, botId: "someone-else" }))).toEqual([]);
  });

  it("retains the most recent report across chats and deduplicates stored files and their original links", () => {
    const attachment = { ...file("brief.pdf"), source: "/workspace/original.pdf" };
    const rows = [user("request", 1), reply("report", 2, { attachments: [attachment], text: "[brief](/workspace/original.pdf)" }), reply("again", 4, { attachments: [attachment] })];
    const items = collectBotArtifacts("editor", [thread(rows), thread([user("r2", 1), reply("earlier", 3, { attachments: [attachment] })], { threadId: "other" })]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ at: 4, messageId: "again", path: attachment.path });
  });

  it("attributes room reports to their speaker and ignores other bots' replies", () => {
    const rows = [user("request", 1), reply("artist", 2, { from: { botId: "artist", name: "Artist", color: "blue" }, attachments: [file("brief.pdf")] }),
      reply("editor", 3, { from: { botId: "editor", name: "Editor", color: "green" }, reportedAttachmentMessageIds: ["artist"] })];
    const items = collectBotArtifacts("editor", [thread(rows, { ownerBotId: undefined })]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ reportMessageId: "editor", messageId: "artist" });
  });

  it("paginates tied timestamps without duplicates and survives a removed cursor item", () => {
    const rows = [user("request", 1), reply("report", 2, { attachments: Array.from({ length: 8 }, (_, index) => file(`${index}.pdf`)) })];
    const items = collectBotArtifacts("editor", [thread(rows)]);
    const first = artifactPage(items, 3);
    const second = artifactPage(items, 3, first.nextCursor);
    const third = artifactPage(items, 3, second.nextCursor);
    expect([...first.items, ...second.items, ...third.items]).toEqual(items);
    expect(third.nextCursor).toBeNull();
    expect(artifactPage(items.filter(item => item !== first.items.at(-1)), 3, first.nextCursor)).toEqual(second);
    expect(() => artifactPage(items, 3, "bad")).toThrow();
  });
});
