import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { afterEach, expect, it } from "vitest";
import type { SendTurnInput, TurnImageInput } from "../contracts.ts";
import { chatImageBudget, type ChatContentPart } from "../drivers/chat-images.ts";
import type { OpenAIChatMessage } from "../drivers/openai-chat.ts";
import { createDoneBotImageContext } from "./image-context.ts";
import { doneBotImageReferences } from "./image-references.ts";
import { registerMediaThreadSource, registerStoreThreadAttachments } from "./thread-files.ts";

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function fixture(images: TurnImageInput[] = []) {
  const cwd = await mkdtemp(join(tmpdir(), "donebot-images-")); folders.push(cwd);
  const turn: SendTurnInput = { threadId: "fixture", text: "Image 1 is the character; image 2 is the scene", images };
  const cache = join(cwd, "cache"), controller = new AbortController();
  return { cwd, cache, turn, controller, context: () => createDoneBotImageContext(turn, cache, controller.signal) };
}
const imageParts = (parts: ChatContentPart[]) => parts.filter(part => part.type === "image_url");
function png(width: number, height: number, alpha = 255) {
  const data = randomBytes(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = alpha;
  const image = new PNG({ width, height }); image.data = data;
  return PNG.sync.write(image);
}
const metadata = (parts: ChatContentPart[]) => parts.flatMap(part => part.type === "text" && part.text.startsWith("{") ? [JSON.parse(part.text)] : []);

it("converts an opaque PNG off-thread, bounds the model image, caches it and preserves the original", async () => {
  const fx = await fixture(), bytes = png(2300, 500), path = join(fx.cwd, "character.png");
  await writeFile(path, bytes); fx.turn.images = [{ path, bytes: bytes.length, mime: "image/png" }];
  const first = await fx.context().userContent(fx.turn.text), part = imageParts(first)[0]!;
  expect(part.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  const prepared = Buffer.from(part.image_url.url.split(",")[1]!, "base64"), decoded = jpeg.decode(prepared);
  expect(Math.max(decoded.width, decoded.height)).toBe(2048);
  expect(prepared.length).toBeLessThan(bytes.length);
  expect(await readFile(path)).toEqual(bytes);
  expect((await readdir(fx.cache)).filter(name => name.endsWith(".jpg"))).toHaveLength(1);
  const second = await fx.context().userContent(fx.turn.text);
  expect(imageParts(second)[0]!.image_url.url).toBe(part.image_url.url);
}, 30_000);

it("preserves transparent pixels and avoids replacing a smaller opaque PNG with a larger JPEG", async () => {
  const fx = await fixture();
  const opaque = new PNG({ width: 1, height: 1 }); opaque.data = Buffer.from([255, 0, 0, 255]);
  for (const [index, bytes] of [png(16, 16, 0), PNG.sync.write(opaque)].entries()) {
    const path = join(fx.cwd, `${index}.png`); await writeFile(path, bytes);
    fx.turn.images = [{ path, bytes: bytes.length, mime: "image/png" }];
    const content = await fx.context().userContent(fx.turn.text);
    expect(imageParts(content)[0]!.image_url.url).toBe(`data:image/png;base64,${bytes.toString("base64")}`);
  }
});

it("unloads historical images before the current turn, retaining exact associations and allowing a later original read", async () => {
  const fx = await fixture(), inputs: TurnImageInput[] = [];
  for (let i = 0; i < 4; i++) {
    const bytes = Buffer.alloc(9 * 1024 * 1024, i); Buffer.from("GIF89a").copy(bytes);
    const path = join(fx.cwd, `${i}.gif`); await writeFile(path, bytes);
    inputs.push({ path, mime: "image/gif", bytes: bytes.length });
  }
  fx.turn.images = inputs.slice(-1);
  fx.turn.imageReferences = inputs.map((image, index) => ({ image, messageId: `message-${index}`, position: index + 1, text: `Image ${index + 1} purpose-${index}`, current: index === 3 }));
  const context = fx.context(), content = await context.userContent(fx.turn.text);
  expect(imageParts(content)).toHaveLength(2);
  const records = metadata(content), old = records.find(record => record.messageId === "message-0");
  expect(old).toMatchObject({ pixels: "unloaded; reopen by ID", associations: [{ messageId: "message-0", position: 1, context: "Image 1 purpose-0" }] });
  expect(records.find(record => record.messageId === "message-3").pixels).toBe("shown below");
  const messages: OpenAIChatMessage[] = [{ role: "user", content }];
  const reopened = await context.tools.execute("attachment_read_image", { id: old.id, original: true }, fx.controller.signal);
  messages.push({ role: "user", content: reopened.images! });
  expect(context.fit(messages)).toBe(1);
  const budget = chatImageBudget();
  for (const message of messages) budget(message.content);
  expect(imageParts(messages.at(-1)!.content as ChatContentPart[])).toHaveLength(1);
  expect(JSON.parse(reopened.text)).toMatchObject({ messageId: "message-0", originalPath: inputs[0]!.path });
  const listed = await context.tools.execute("attachment_list", { query: "purpose-0" }, fx.controller.signal);
  expect(JSON.parse(listed.text).attachments[0].id).toBe(old.id);
  expect(await readFile(inputs[0]!.path)).toHaveLength(9 * 1024 * 1024);
}, 30_000);

it("keeps latest tool screenshots while unloading older pixels without repeating any tool", async () => {
  const fx = await fixture(), context = fx.context(), messages: OpenAIChatMessage[] = [];
  for (let i = 0; i < 5; i++) {
    const bytes = Buffer.alloc(9 * 1024 * 1024, i); Buffer.from("GIF89a").copy(bytes);
    const images = await context.toolImages(`call-${i}`, [{ type: "image_url", image_url: { url: `data:image/gif;base64,${bytes.toString("base64")}` } }]);
    messages.push({ role: "user", content: images }); context.fit(messages);
    const budget = chatImageBudget(); for (const message of messages) budget(message.content);
    expect(imageParts(messages.at(-1)!.content as ChatContentPart[])).toHaveLength(1);
  }
  expect(JSON.stringify(messages[0])).toContain("reopen with attachment_read_image");
  const list = JSON.parse((await context.tools.execute("attachment_list", { query: "call-0" }, fx.controller.signal)).text);
  const old = await context.tools.execute("attachment_read_image", { id: list.attachments[0].id }, fx.controller.signal);
  expect(old.images).toHaveLength(1);
}, 30_000);

it("honors attachment tool exclusions, rejects foreign IDs and does not follow original-image symlinks", async () => {
  const fx = await fixture();
  fx.turn.toolScope = { deny: ["native:attachment_read_image"] };
  const excluded = fx.context();
  expect(excluded.tools.definitions.some(tool => tool.function.name === "attachment_read_image")).toBe(false);
  await expect(excluded.tools.execute("attachment_read_image", { id: `image-${"0".repeat(24)}` }, fx.controller.signal)).rejects.toThrow(/excluded/);
  fx.turn.toolScope = undefined;
  const source = join(fx.cwd, "real.png"), path = join(fx.cwd, "alias.png");
  await writeFile(source, png(1, 1)); await symlink(source, path);
  fx.turn.images = [{ path, mime: "image/png", bytes: 100 }];
  const context = fx.context();
  await expect(context.userContent(fx.turn.text)).rejects.toThrow();
  await expect(context.tools.execute("attachment_read_image", { id: `image-${"0".repeat(24)}` }, fx.controller.signal)).rejects.toThrow(/not an admitted/);
});

it("indexes bot-generated images and non-image conversation files (video, music, document) in attachment_list and userContent", async () => {
  const fx = await fixture();
  const imgPath = join(fx.cwd, "donebot-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1-1.png");
  const vidPath = join(fx.cwd, "donebot-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2-1.mp4");
  const docPath = join(fx.cwd, "proposal-v2.md");
  await writeFile(imgPath, png(16, 16));
  await writeFile(vidPath, Buffer.from("synthetic-mp4-bytes"));
  await writeFile(docPath, "# 交付说明\n包含角色图与分镜视频。");

  registerMediaThreadSource({
    describeMedia: input => {
      if (input.includes("aaaaaaaa")) {
        return { jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", kind: "image", model: "seedream-5-5", prompt: "皮克斯3D卡通公鸡角色图", references: ["ref-style.png"] };
      }
      if (input.includes("bbbbbbbb")) {
        return { jobId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", kind: "video", model: "seedance-2-5", prompt: "5s · 16:9 · 公鸡展翅打鸣动画", references: ["donebot-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1-1.png"] };
      }
      return undefined;
    },
    listThreadMedia: (botId, threadId) => (botId === "bot-1" && threadId === "thread-1" ? [
      { path: imgPath, name: "donebot-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1-1.png", mime: "image/png", kind: "image", bytes: 100, at: 1700000001000, model: "seedream-5-5", prompt: "皮克斯3D卡通公鸡角色图", references: ["ref-style.png"], source: "bot-generated" },
      { path: vidPath, name: "donebot-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2-1.mp4", mime: "video/mp4", kind: "video", bytes: 19, at: 1700000002000, model: "seedance-2-5", prompt: "5s · 16:9 · 公鸡展翅打鸣动画", references: ["donebot-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1-1.png"], source: "bot-generated" },
    ] : []),
  });
  registerStoreThreadAttachments(threadId => (threadId === "thread-1" ? [
    { path: docPath, name: "proposal-v2.md", mime: "text/markdown", kind: "document", bytes: 42, at: 1700000003000, role: "bot", messageText: "已附上交付说明文档" },
  ] : []));

  try {
    const refs = doneBotImageReferences([
      {
        id: "m-bot-img",
        role: "bot",
        text: "image · seedream-5-5",
        attachments: [{ kind: "image", path: imgPath, mime: "image/png", name: "donebot-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1-1.png" }],
      },
    ], [], fx.cwd);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.image.path).toBe(imgPath);
    expect(refs[0]!.text).toContain("皮克斯3D卡通公鸡角色图");
    expect(refs[0]!.text).toContain("ref-style.png");

    fx.turn.botId = "bot-1";
    fx.turn.threadId = "thread-1";
    fx.turn.imageReferences = refs;
    const context = fx.context();
    const content = await context.userContent("提交任务");
    const serialized = JSON.stringify(content);
    expect(serialized).toContain("皮克斯3D卡通公鸡角色图");
    expect(serialized).toContain("公鸡展翅打鸣动画");
    expect(serialized).toContain("proposal-v2.md");

    const listed = JSON.parse((await context.tools.execute("attachment_list", {}, fx.controller.signal)).text);
    expect(listed.attachments).toHaveLength(1);
    expect(listed.attachments[0].originalPath).toBe(imgPath);
    expect(listed.files).toHaveLength(2);
    expect(listed.files.map((f: { kind: string }) => f.kind)).toEqual(["document", "video"]);
    expect(listed.files[1].references).toEqual(["donebot-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1-1.png"]);
  } finally {
    registerMediaThreadSource(undefined);
    registerStoreThreadAttachments(undefined);
  }
});
