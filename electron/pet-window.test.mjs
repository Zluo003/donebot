import { describe, expect, it, vi } from "vitest";
import { createDesktopPrefs, DEFAULT_PET_PREFS, parsePetPrefs } from "./desktop-prefs.mjs";
import {
  clampAvatarPosition,
  computePopoverBounds,
  encodeAvatarPosition,
  installDesktopPet,
  isPetWindow,
  PET_AVATAR_SIZE,
  resolveAvatarBounds,
  shouldShowPet,
} from "./pet-window.mjs";

function fakeWindow(bounds = { x: 0, y: 0, width: 140, height: 140 }) {
  const listeners = new Map();
  const webListeners = new Map();
  const sent = [];
  let visible = false;
  let destroyed = false;
  let curBounds = { ...bounds };
  let workspaceOpts = null;

  const emit = (map, event, ...args) => {
    for (const fn of Array.from(map.get(event) ?? [])) fn(...args);
  };

  const win = {
    sent,
    emit: (event, ...args) => emit(listeners, event, ...args),
    webContents: {
      send: (channel, ...args) => sent.push([channel, ...args]),
      setWindowOpenHandler: vi.fn(),
      on: (event, fn) => {
        if (!webListeners.has(event)) webListeners.set(event, new Set());
        webListeners.get(event).add(fn);
      },
      emit: (event, ...args) => emit(webListeners, event, ...args),
    },
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
    },
    isDestroyed: () => destroyed,
    isVisible: () => !destroyed && visible,
    isFocused: () => false,
    show: () => { visible = true; },
    showInactive: () => { visible = true; },
    focus: vi.fn(),
    hide: () => { visible = false; },
    destroy: () => {
      destroyed = true;
      visible = false;
      emit(listeners, "closed");
    },
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn((all, opts) => { workspaceOpts = { all, ...opts }; }),
    getWorkspaceOpts: () => workspaceOpts,
    getBounds: () => ({ ...curBounds }),
    setBounds: (next) => { curBounds = { ...curBounds, ...next }; },
    setPosition: (x, y) => { curBounds = { ...curBounds, x, y }; },
    loadURL: vi.fn(async () => {}),
  };
  return win;
}

describe("desktop pet prefs & geometry", () => {
  it("parses and persists desktop pet prefs safely", () => {
    let saved = null;
    const prefs = createDesktopPrefs({
      read: () => saved,
      write: (next) => { saved = next; },
    });
    expect(prefs.pet()).toEqual(DEFAULT_PET_PREFS);

    const updated = prefs.setPet({
      enabled: true,
      replyMode: "text",
      voiceMode: true,
      wakeWord: "  小宝\u0007  同学  ",
      autoAnnounceReports: false,
      hideInFullscreen: false,
      muted: true,
      position: { rx: 1.5, ry: -0.2, displayId: 42 },
    });
    expect(updated).toEqual({
      enabled: true,
      replyMode: "text",
      voiceMode: true,
      wakeWord: "小宝 同学",
      autoAnnounceReports: false,
      hideInFullscreen: false,
      muted: true,
      position: { rx: 1, ry: 0, displayId: 42 },
    });
    expect(parsePetPrefs({ replyMode: "invalid", wakeWord: 123 })).toMatchObject({
      replyMode: "tts",
      wakeWord: "",
    });
    expect(parsePetPrefs({ wakeWord: "一".repeat(40) }).wakeWord).toBe("一".repeat(24));
  });

  it("enforces macOS-only & hidden-while-main-visible rule", () => {
    const base = { platform: "darwin", enabled: true, mainVisible: false, startupBusy: false, shuttingDown: false, temporarilyHidden: false };
    expect(shouldShowPet(base)).toBe(true);
    expect(shouldShowPet({ ...base, mainVisible: true })).toBe(false);
    expect(shouldShowPet({ ...base, enabled: false })).toBe(false);
    expect(shouldShowPet({ ...base, platform: "win32" })).toBe(false);
    expect(shouldShowPet({ ...base, startupBusy: true })).toBe(false);
    expect(shouldShowPet({ ...base, temporarilyHidden: true })).toBe(false);
  });

  it("clamps avatar positions and restores across displays", () => {
    const displayA = { id: 1, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
    const displayB = { id: 2, workArea: { x: 1440, y: 0, width: 1920, height: 1080 } };

    const fallback = resolveAvatarBounds(null, [displayA], displayA, PET_AVATAR_SIZE);
    expect(fallback.x).toBe(1440 - PET_AVATAR_SIZE - 28);
    expect(fallback.y).toBe(25 + 875 - PET_AVATAR_SIZE - 28);

    const encoded = encodeAvatarPosition({ x: 1440 + 400, y: 300 }, displayB, PET_AVATAR_SIZE);
    expect(encoded.displayId).toBe(2);
    const restoredOnB = resolveAvatarBounds(encoded, [displayA, displayB], displayA, PET_AVATAR_SIZE);
    expect(restoredOnB.x).toBeGreaterThanOrEqual(displayB.workArea.x);
    expect(restoredOnB.x).toBeLessThanOrEqual(displayB.workArea.x + displayB.workArea.width - PET_AVATAR_SIZE);

    // Disconnecting displayB falls back safely inside primary displayA.
    const restoredAfterUnplug = resolveAvatarBounds(encoded, [displayA], displayA, PET_AVATAR_SIZE);
    expect(restoredAfterUnplug.x).toBeGreaterThanOrEqual(displayA.workArea.x);
    expect(restoredAfterUnplug.x).toBeLessThanOrEqual(displayA.workArea.x + displayA.workArea.width - PET_AVATAR_SIZE);

    expect(clampAvatarPosition(-50, 9999, displayA.workArea, PET_AVATAR_SIZE)).toEqual({
      x: 0,
      y: 25 + 875 - PET_AVATAR_SIZE,
    });
  });

  it("positions popover beside avatar without overflowing workArea and centers preview", () => {
    const area = { x: 0, y: 25, width: 1440, height: 875 };
    const bottomRightAvatar = { x: 1270, y: 730, width: 140, height: 140 };
    const composer = computePopoverBounds(bottomRightAvatar, area, "composer");
    expect(composer.x + composer.width).toBeLessThanOrEqual(bottomRightAvatar.x);
    expect(composer.y + composer.height).toBeLessThanOrEqual(area.y + area.height - 8);

    const topLeftAvatar = { x: 24, y: 40, width: 140, height: 140 };
    const bubble = computePopoverBounds(topLeftAvatar, area, "bubble");
    expect(bubble.x).toBeGreaterThanOrEqual(topLeftAvatar.x + topLeftAvatar.width);

    const preview = computePopoverBounds(bottomRightAvatar, area, "preview");
    expect(preview.x).toBe(Math.round((1440 - preview.width) / 2));
    expect(preview.width).toBe(880);
  });
});

describe("installDesktopPet lifecycle and guards", () => {
  it("shows pet when main window closes/minimizes, hides when main shows, and enforces pet-only IPC", async () => {
    const handlers = new Map();
    const createdWindows = [];
    let mainVisible = true;
    let stored = null;
    const prefs = createDesktopPrefs({
      read: () => stored,
      write: (next) => { stored = next; },
    });

    const primary = { id: 1, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
    const mainWin = fakeWindow({ x: 100, y: 100, width: 1200, height: 800 });

    class FakeBrowserWindow {
      constructor(opts) {
        const win = fakeWindow({ x: opts.x ?? 0, y: opts.y ?? 0, width: opts.width, height: opts.height });
        createdWindows.push(win);
        return win;
      }
      static getAllWindows() {
        return [mainWin, ...createdWindows].filter((w) => !w.isDestroyed());
      }
      static fromWebContents(sender) {
        return FakeBrowserWindow.getAllWindows().find((w) => w.webContents === sender) ?? null;
      }
    }

    const screen = {
      getPrimaryDisplay: () => primary,
      getAllDisplays: () => [primary],
      getDisplayMatching: () => primary,
      getDisplayNearestPoint: () => primary,
      on: vi.fn(),
      removeListener: vi.fn(),
    };

    const speech = { start: vi.fn(), stop: vi.fn(), finish: vi.fn() };
    const pet = installDesktopPet({
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      BrowserWindow: FakeBrowserWindow,
      Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
      screen,
      platform: "darwin",
      appleSpeech: true,
      speech,
      prefs: () => prefs,
      preload: "/preload.cjs",
      rendererArgs: () => [],
      localOrigin: () => "http://127.0.0.1:18899",
      pageGuard: (_ch, fn) => fn,
      openMainWindow: vi.fn(),
      openWorkbench: vi.fn(),
      openSettings: vi.fn(),
      quitApp: vi.fn(),
      isMainVisible: () => mainVisible,
    });

    pet.attachMainWindow(mainWin);

    // Enable desktop pet while main window is visible -> stays hidden.
    const enabledState = await handlers.get("desktop-pet:set")({ sender: mainWin.webContents }, { enabled: true });
    expect(enabledState.enabled).toBe(true);
    expect(createdWindows).toHaveLength(0);

    // Main window minimizes -> only avatar window is created lazily and shown.
    mainVisible = false;
    mainWin.emit("minimize");
    await Promise.resolve();
    await Promise.resolve();
    expect(createdWindows).toHaveLength(1);
    const [avatarWin] = createdWindows;
    expect(isPetWindow(avatarWin)).toBe(true);
    expect(isPetWindow(mainWin)).toBe(false);
    expect(avatarWin.isVisible()).toBe(true);
    expect(avatarWin.getWorkspaceOpts().visibleOnFullScreen).toBe(false);

    // Non-pet window cannot call pet-only IPC.
    expect(() => handlers.get("desktop-pet:move-by")({ sender: mainWin.webContents }, { dx: 10, dy: 10 })).toThrow();

    // Opening popover lazily creates popoverWin and shows it; pet window can invoke pet-scoped speech.
    expect(handlers.get("desktop-pet:open-popover")({ sender: avatarWin.webContents }, "composer")).toBe(true);
    expect(createdWindows).toHaveLength(2);
    const popoverWin = createdWindows[1];
    expect(isPetWindow(popoverWin)).toBe(true);
    expect(popoverWin.isVisible()).toBe(true);
    expect(() => handlers.get("desktop-pet:speech-start")({ sender: mainWin.webContents }, { endpointMs: 900 })).toThrow();
    handlers.get("desktop-pet:speech-start")({ sender: avatarWin.webContents }, { endpointMs: 900 });
    expect(speech.start).toHaveBeenCalledWith(avatarWin, { endpointMs: 900 });

    // Skin broadcasts deduplicate identical ids so main/pet never enter a skin IPC ping-pong loop.
    const avatarSkinBefore = avatarWin.sent.filter(([ch]) => ch === "desktop-pet:skin").length;
    pet.skin("midnight");
    pet.skin("midnight");
    expect(avatarWin.sent.filter(([ch]) => ch === "desktop-pet:skin")).toHaveLength(avatarSkinBefore + 1);

    // Main window comes back -> pet hides automatically.
    mainVisible = true;
    mainWin.emit("show");
    await Promise.resolve();
    expect(avatarWin.isVisible()).toBe(false);
    expect(popoverWin.isVisible()).toBe(false);

    pet.close();
    expect(avatarWin.isDestroyed()).toBe(true);
    expect(popoverWin.isDestroyed()).toBe(true);
  });
});
