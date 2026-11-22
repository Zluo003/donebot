import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import type { BotRecord } from "../store.ts";
import {
  buildCollabChatBotAppearance,
  chatBotNeedsSync,
  compressAvatarBytesToDataUrl,
} from "./collab-bot-avatar.ts";

function makePng(width: number, height: number, alpha = 255): Buffer {
  const png = new PNG({ width, height });
  let seed = 0x9e3779b9;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const idx = (y * width + x) * 4;
      png.data[idx] = seed & 0xff;
      png.data[idx + 1] = (seed >>> 8) & 0xff;
      png.data[idx + 2] = (seed >>> 16) & 0xff;
      png.data[idx + 3] = x === 0 && y === 0 ? alpha : 255;
    }
  }
  return PNG.sync.write(png);
}

function makeBot(overrides: Partial<BotRecord> = {}): BotRecord {
  return {
    id: "bot-1",
    threadId: "thread-1",
    name: "多宝",
    title: "主协调",
    description: "",
    soul: "",
    soulHash: "",
    notifications: true,
    color: "chrome",
    mascotBody: "circle",
    unread: false,
    modelSelection: { instanceId: "donebot", model: "auto" },
    resumeCursors: {},
    createdAt: 1,
    ...overrides,
  };
}

describe("collab bot avatar appearance", () => {
  it("normalizes missing or legacy cursor body to circle and preserves custom mascot fields", () => {
    const legacy = buildCollabChatBotAppearance(makeBot({ mascotBody: "cursor" }));
    expect(legacy.bot_mascot_body).toBe("circle");
    expect(legacy.bot_color).toBe("chrome");
    expect(legacy.bot_avatar_crop).toBe("mascot");
    expect(legacy.bot_avatar_url).toBe("");

    const star = buildCollabChatBotAppearance(makeBot({
      color: "purple",
      mascotBody: "star",
      mascotFaceColor: "white",
      mascotExpression: "happy",
      avatarUrl: "/api/attachments/stale-1.png",
      avatarCrop: "mascot",
    }));
    expect(star.bot_mascot_body).toBe("star");
    expect(star.bot_mascot_face_color).toBe("white");
    expect(star.bot_mascot_expression).toBe("happy");
    expect(star.bot_avatar_crop).toBe("mascot");
    expect(star.bot_avatar_url).toBe("");
  });

  it("inlines small images directly and compresses oversized opaque and transparent PNGs", () => {
    const tinyGif = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "binary");
    const gifOut = compressAvatarBytesToDataUrl(tinyGif, "image/gif");
    expect(gifOut.startsWith("data:image/gif;base64,")).toBe(true);

    const bigOpaque = makePng(640, 480, 255);
    expect(bigOpaque.length).toBeGreaterThan(480_000);
    const opaqueOut = compressAvatarBytesToDataUrl(bigOpaque, "image/png");
    expect(opaqueOut.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(opaqueOut.length).toBeLessThanOrEqual(720_000);

    const bigAlpha = makePng(640, 480, 0);
    expect(bigAlpha.length).toBeGreaterThan(480_000);
    const alphaOut = compressAvatarBytesToDataUrl(bigAlpha, "image/png");
    expect(alphaOut.startsWith("data:image/png;base64,")).toBe(true);
    expect(alphaOut.length).toBeLessThanOrEqual(720_000);
    const decoded = PNG.sync.read(Buffer.from(alphaOut.slice("data:image/png;base64,".length), "base64"));
    expect(decoded.width).toBe(256);
    expect(decoded.height).toBe(192);
  });

  it("builds custom photo appearance with crop/zoom/focus and detects sync drift", () => {
    const tinyPng = makePng(16, 16, 255);
    const appearance = buildCollabChatBotAppearance(
      makeBot({
        avatarUrl: "/api/attachments/photo-1.png",
        avatarCrop: "rounded",
        avatarZoom: 1.75,
        avatarFocusX: 0.2,
        avatarFocusY: 0.8,
      }),
      undefined,
      () => ({ bytes: tinyPng, mime: "image/png" }),
    );
    expect(appearance.bot_avatar_crop).toBe("rounded");
    expect(appearance.bot_avatar_zoom).toBe(1.75);
    expect(appearance.bot_avatar_focus_x).toBe(0.2);
    expect(appearance.bot_avatar_focus_y).toBe(0.8);
    expect(appearance.bot_avatar_url.startsWith("data:image/png;base64,")).toBe(true);

    expect(chatBotNeedsSync(appearance, appearance)).toBe(false);
    expect(chatBotNeedsSync({ ...appearance, bot_mascot_body: "" }, appearance)).toBe(true);
    expect(chatBotNeedsSync({ ...appearance, bot_avatar_crop: "circle" }, appearance)).toBe(true);
    expect(chatBotNeedsSync({ ...appearance, bot_avatar_focus_x: 0.5 }, appearance)).toBe(true);
  });
});
