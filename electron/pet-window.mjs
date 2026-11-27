import skins from "./skin-overlay.cjs";

export const PET_PATH = "/pet";
export const PET_AVATAR_SIZE = 140;
export const PET_DEFAULT_MARGIN = 28;
export const PET_POPOVER_GAP = 10;

export const PET_POPOVER_DEFAULTS = Object.freeze({
  composer: { width: 348, height: 148, focusable: true, autoBlurClose: true },
  bubble: { width: 320, height: 112, focusable: false, autoBlurClose: false },
  voice: { width: 340, height: 158, focusable: false, autoBlurClose: false },
  approval: { width: 428, height: 460, focusable: true, autoBlurClose: false },
  preview: { width: 880, height: 640, focusable: true, autoBlurClose: false },
});

const petWindows = new WeakSet();

export function isPetWindow(win) {
  return Boolean(win && petWindows.has(win));
}

export function shouldShowPet({ platform, enabled, mainVisible, startupBusy, shuttingDown, temporarilyHidden }) {
  return platform === "darwin" && enabled === true && !mainVisible && !startupBusy && !shuttingDown && !temporarilyHidden;
}

export function clampAvatarPosition(x, y, workArea, size = PET_AVATAR_SIZE) {
  const maxX = workArea.x + Math.max(0, workArea.width - size);
  const maxY = workArea.y + Math.max(0, workArea.height - size);
  return {
    x: Math.round(Math.max(workArea.x, Math.min(maxX, x))),
    y: Math.round(Math.max(workArea.y, Math.min(maxY, y))),
  };
}

export function resolveAvatarBounds(position, displays, primaryDisplay, size = PET_AVATAR_SIZE) {
  const list = Array.isArray(displays) && displays.length > 0 ? displays : [primaryDisplay];
  const matched = position?.displayId !== undefined
    ? list.find((display) => display.id === position.displayId)
    : undefined;
  const target = matched ?? primaryDisplay ?? list[0];
  const area = target.workArea;
  if (!position) {
    const pos = clampAvatarPosition(
      area.x + area.width - size - PET_DEFAULT_MARGIN,
      area.y + area.height - size - PET_DEFAULT_MARGIN,
      area,
      size,
    );
    return { ...pos, width: size, height: size };
  }
  const spanX = Math.max(0, area.width - size);
  const spanY = Math.max(0, area.height - size);
  const pos = clampAvatarPosition(
    area.x + Math.round(spanX * Math.max(0, Math.min(1, position.rx))),
    area.y + Math.round(spanY * Math.max(0, Math.min(1, position.ry))),
    area,
    size,
  );
  return { ...pos, width: size, height: size };
}

export function encodeAvatarPosition(bounds, display, size = PET_AVATAR_SIZE) {
  const area = display.workArea;
  const spanX = Math.max(1, area.width - size);
  const spanY = Math.max(1, area.height - size);
  const rx = Math.max(0, Math.min(1, Math.round(((bounds.x - area.x) / spanX) * 10000) / 10000));
  const ry = Math.max(0, Math.min(1, Math.round(((bounds.y - area.y) / spanY) * 10000) / 10000));
  return {
    rx,
    ry,
    ...(typeof display.id === "number" && Number.isSafeInteger(display.id) ? { displayId: display.id } : {}),
  };
}

export function computePopoverBounds(avatarBounds, workArea, mode, requestedSize = null) {
  const preset = PET_POPOVER_DEFAULTS[mode] ?? PET_POPOVER_DEFAULTS.composer;
  if (mode === "preview") {
    const width = Math.min(Math.max(520, requestedSize?.width ?? preset.width), Math.max(360, workArea.width - 56));
    const height = Math.min(Math.max(400, requestedSize?.height ?? preset.height), Math.max(320, workArea.height - 64));
    return {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width: Math.round(width),
      height: Math.round(height),
    };
  }

  const width = Math.min(
    Math.max(240, Math.round(requestedSize?.width ?? preset.width)),
    Math.max(240, workArea.width - 24),
  );
  const height = Math.min(
    Math.max(68, Math.round(requestedSize?.height ?? preset.height)),
    Math.max(180, workArea.height - 32),
  );

  const avatarCenterX = avatarBounds.x + avatarBounds.width / 2;
  const areaCenterX = workArea.x + workArea.width / 2;
  const openLeft = avatarCenterX >= areaCenterX;

  let x = openLeft
    ? avatarBounds.x - width - PET_POPOVER_GAP
    : avatarBounds.x + avatarBounds.width + PET_POPOVER_GAP;

  if (x < workArea.x + 8 || x + width > workArea.x + workArea.width - 8) {
    x = avatarBounds.x + avatarBounds.width - width;
  }
  x = Math.max(workArea.x + 8, Math.min(workArea.x + workArea.width - width - 8, x));

  const avatarCenterY = avatarBounds.y + avatarBounds.height / 2;
  const areaCenterY = workArea.y + workArea.height / 2;
  const alignBottom = avatarCenterY >= areaCenterY;

  let y = alignBottom
    ? avatarBounds.y + avatarBounds.height - height
    : avatarBounds.y;
  y = Math.max(workArea.y + 8, Math.min(workArea.y + workArea.height - height - 8, y));

  return { x: Math.round(x), y: Math.round(y), width, height };
}

function live(win) {
  return Boolean(win && !win.isDestroyed());
}

/**
 * Installs the macOS desktop pet dual-window controller and its IPC bridge.
 * `avatarWin` is the always-on-top mascot & runtime host; `popoverWin` is a focus-capable
 * companion sheet for input, brief bubbles, voice captions, workbench approvals and previews.
 */
export function installDesktopPet({
  ipcMain,
  BrowserWindow,
  Menu,
  screen,
  platform = process.platform,
  appleSpeech = false,
  speech = null,
  prefs,
  preload,
  rendererArgs,
  localOrigin,
  activeOrigin = localOrigin,
  probeFetch = null,
  pageGuard,
  openMainWindow,
  openWorkbench,
  openSettings,
  quitApp,
  isStartupBusy = () => false,
  isMainVisible = () => true,
  initialSkin = null,
  log = () => {},
}) {
  const available = platform === "darwin";
  let avatarWin = null;
  let popoverWin = null;
  let loadedOrigin = null;
  let popoverMode = null;
  let popoverSize = null;
  let popoverVisible = false;
  let temporarilyHidden = false;
  let shuttingDown = false;
  let pendingReportCount = 0;
  let currentSkin = initialSkin;
  let refreshTicket = 0;
  let blurCloseTimer = null;

  const currentSettings = () => prefs().pet();
  const stateSnapshot = () => ({
    available,
    visible: live(avatarWin) && avatarWin.isVisible(),
    temporarilyHidden,
    popoverMode: popoverVisible ? popoverMode : null,
    ...currentSettings(),
  });

  const broadcastState = () => {
    const snapshot = stateSnapshot();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!live(win)) continue;
      try { win.webContents.send("desktop-pet:state", snapshot); } catch {}
    }
  };

  const applyWorkspacePolicy = (win) => {
    if (!live(win)) return;
    const hideInFullscreen = currentSettings().hideInFullscreen;
    try {
      win.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: !hideInFullscreen,
        skipTransformProcessType: true,
      });
    } catch {}
  };

  async function resolveTargetOrigin() {
    const local = localOrigin();
    const candidate = activeOrigin?.() || local;
    if (!candidate || candidate === local || !probeFetch) return local;
    try {
      const res = await probeFetch(`${candidate}${PET_PATH}`, { method: "GET" });
      if (res.ok) {
        const html = await res.text();
        if (html.includes("data-donebot-pet-root")) return candidate;
      }
    } catch {}
    return local;
  }

  function configureWebContents(win, role) {
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, targetUrl) => {
      try {
        const parsed = new URL(targetUrl);
        if (loadedOrigin && parsed.origin === loadedOrigin && parsed.pathname === PET_PATH) return;
      } catch {}
      event.preventDefault();
    });
    win.webContents.on("did-finish-load", () => {
      if (!live(win)) return;
      if (currentSkin) {
        try { win.webContents.send("desktop-pet:skin", currentSkin); } catch {}
      }
      try { win.webContents.send("desktop-pet:state", stateSnapshot()); } catch {}
      if (role === "avatar" && win.isVisible()) {
        try { win.webContents.send("desktop-pet:active", true); } catch {}
      }
      if (role === "popover" && popoverMode) {
        try { win.webContents.send("desktop-pet:popover-mode", popoverMode); } catch {}
      }
    });
    win.webContents.on("render-process-gone", () => {
      log(`desktop pet (${role}): renderer exited`);
      if (role === "avatar" && avatarWin === win) {
        avatarWin = null;
        if (!shuttingDown) void syncVisibility();
      } else if (role === "popover" && popoverWin === win) {
        popoverWin = null;
        popoverVisible = false;
        popoverMode = null;
      }
    });
  }

  function createAvatarWindow(origin) {
    const primary = screen.getPrimaryDisplay();
    const bounds = resolveAvatarBounds(currentSettings().position, screen.getAllDisplays(), primary, PET_AVATAR_SIZE);
    const win = new BrowserWindow({
      type: "panel",
      ...bounds,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      acceptFirstMouse: true,
      hiddenInMissionControl: true,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        autoplayPolicy: "no-user-gesture-required",
        preload,
        additionalArguments: rendererArgs(),
      },
    });
    petWindows.add(win);
    win.excludedFromShownWindowsMenu = true;
    win.setAlwaysOnTop(true, "floating");
    applyWorkspacePolicy(win);
    configureWebContents(win, "avatar");
    win.on("closed", () => {
      if (avatarWin === win) avatarWin = null;
    });
    void win.loadURL(`${origin}${PET_PATH}?view=avatar`).catch((err) => {
      log(`desktop pet avatar load failed: ${err?.message ?? err}`);
    });
    return win;
  }

  function createPopoverWindow(origin) {
    const win = new BrowserWindow({
      width: PET_POPOVER_DEFAULTS.composer.width,
      height: PET_POPOVER_DEFAULTS.composer.height,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      focusable: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      acceptFirstMouse: true,
      hiddenInMissionControl: true,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        autoplayPolicy: "no-user-gesture-required",
        preload,
        additionalArguments: rendererArgs(),
      },
    });
    petWindows.add(win);
    win.excludedFromShownWindowsMenu = true;
    win.setAlwaysOnTop(true, "floating");
    applyWorkspacePolicy(win);
    configureWebContents(win, "popover");
    win.on("blur", () => {
      if (!popoverVisible || !popoverMode) return;
      const preset = PET_POPOVER_DEFAULTS[popoverMode];
      if (!preset?.autoBlurClose) return;
      clearTimeout(blurCloseTimer);
      blurCloseTimer = setTimeout(() => {
        if (popoverVisible && popoverMode && PET_POPOVER_DEFAULTS[popoverMode]?.autoBlurClose && live(popoverWin) && !popoverWin.isFocused()) {
          closePopover();
        }
      }, 120);
    });
    win.on("closed", () => {
      if (popoverWin === win) {
        popoverWin = null;
        popoverVisible = false;
        popoverMode = null;
      }
    });
    void win.loadURL(`${origin}${PET_PATH}?view=popover`).catch((err) => {
      log(`desktop pet popover load failed: ${err?.message ?? err}`);
    });
    return win;
  }

  function repositionPopover() {
    if (!live(avatarWin) || !live(popoverWin) || !popoverMode) return;
    const avatarBounds = avatarWin.getBounds();
    const display = screen.getDisplayMatching(avatarBounds) ?? screen.getPrimaryDisplay();
    const bounds = computePopoverBounds(avatarBounds, display.workArea, popoverMode, popoverSize);
    popoverWin.setBounds(bounds, false);
  }

  function closePopover() {
    clearTimeout(blurCloseTimer);
    popoverVisible = false;
    popoverMode = null;
    popoverSize = null;
    if (live(popoverWin)) popoverWin.hide();
    if (live(avatarWin)) {
      try { avatarWin.webContents.send("desktop-pet:popover-closed"); } catch {}
    }
    broadcastState();
  }

  function openPopover(mode, size = null) {
    if (!available || shuttingDown || !live(avatarWin) || !avatarWin.isVisible()) return false;
    const validMode = Object.hasOwn(PET_POPOVER_DEFAULTS, mode) ? mode : "composer";
    clearTimeout(blurCloseTimer);
    if (!live(popoverWin)) {
      popoverWin = createPopoverWindow(loadedOrigin ?? localOrigin());
    }
    popoverMode = validMode;
    popoverSize = size;
    popoverVisible = true;
    const preset = PET_POPOVER_DEFAULTS[validMode];
    repositionPopover();
    try { popoverWin.webContents.send("desktop-pet:popover-mode", validMode); } catch {}
    if (preset.focusable) {
      popoverWin.show();
      popoverWin.focus();
    } else {
      popoverWin.showInactive();
    }
    broadcastState();
    return true;
  }

  function hideWindows() {
    closePopover();
    if (live(avatarWin)) {
      try { avatarWin.webContents.send("desktop-pet:active", false); } catch {}
      avatarWin.hide();
    }
    broadcastState();
  }

  async function syncVisibility({ resetTemporaryHide = false } = {}) {
    if (resetTemporaryHide) temporarilyHidden = false;
    const ticket = ++refreshTicket;
    const show = shouldShowPet({
      platform,
      enabled: currentSettings().enabled,
      mainVisible: isMainVisible(),
      startupBusy: isStartupBusy(),
      shuttingDown,
      temporarilyHidden,
    });
    if (!show) {
      hideWindows();
      return;
    }
    const targetOrigin = await resolveTargetOrigin();
    if (ticket !== refreshTicket || shuttingDown) return;
    const stillShow = shouldShowPet({
      platform,
      enabled: currentSettings().enabled,
      mainVisible: isMainVisible(),
      startupBusy: isStartupBusy(),
      shuttingDown,
      temporarilyHidden,
    });
    if (!stillShow) {
      hideWindows();
      return;
    }
    if (loadedOrigin && loadedOrigin !== targetOrigin) {
      if (live(popoverWin)) popoverWin.destroy();
      if (live(avatarWin)) avatarWin.destroy();
      popoverWin = null;
      avatarWin = null;
    }
    loadedOrigin = targetOrigin;
    ensureDisplayListeners();
    const wasVisible = live(avatarWin) && avatarWin.isVisible();
    if (!live(avatarWin)) {
      avatarWin = createAvatarWindow(targetOrigin);
    } else {
      const primary = screen.getPrimaryDisplay();
      const bounds = resolveAvatarBounds(currentSettings().position, screen.getAllDisplays(), primary, PET_AVATAR_SIZE);
      avatarWin.setBounds(bounds, false);
      applyWorkspacePolicy(avatarWin);
    }
    if (live(popoverWin)) {
      applyWorkspacePolicy(popoverWin);
    }
    if (!wasVisible) {
      avatarWin.showInactive();
      try { avatarWin.webContents.send("desktop-pet:active", true); } catch {}
    }
    broadcastState();
  }

  function showContextMenu() {
    if (!live(avatarWin)) return;
    const settings = currentSettings();
    const menu = Menu.buildFromTemplate([
      {
        label: "打开 DoneBot 主窗口",
        click: () => {
          closePopover();
          openMainWindow();
        },
      },
      {
        label: pendingReportCount > 0 ? `查看待审批汇报（${pendingReportCount}）` : "打开工作台",
        click: () => {
          if (pendingReportCount > 0) openPopover("approval");
          else {
            closePopover();
            openWorkbench();
          }
        },
      },
      { type: "separator" },
      {
        label: "回复默认语音播报（TTS）",
        type: "radio",
        checked: settings.replyMode === "tts",
        click: () => {
          prefs().setPet({ replyMode: "tts" });
          broadcastState();
        },
      },
      {
        label: "回复使用极简文本气泡",
        type: "radio",
        checked: settings.replyMode === "text",
        click: () => {
          prefs().setPet({ replyMode: "text" });
          broadcastState();
        },
      },
      { type: "separator" },
      {
        label: "语音唤醒（免点击喊「你好 主协调」）",
        type: "checkbox",
        checked: settings.voiceMode,
        click: (item) => {
          prefs().setPet({ voiceMode: item.checked === true });
          broadcastState();
        },
      },
      {
        label: "静音播报",
        type: "checkbox",
        checked: settings.muted,
        click: (item) => {
          prefs().setPet({ muted: item.checked === true });
          broadcastState();
        },
      },
      { type: "separator" },
      {
        label: "暂时隐藏桌宠",
        click: () => {
          temporarilyHidden = true;
          hideWindows();
        },
      },
      {
        label: "桌宠设置…",
        click: () => {
          closePopover();
          openSettings();
        },
      },
      { type: "separator" },
      {
        label: "退出 DoneBot",
        click: () => quitApp(),
      },
    ]);
    menu.popup({ window: avatarWin });
  }

  const petOnly = (channel, handler) => (event, ...args) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!isPetWindow(win)) throw new Error(`${channel} is only available to the desktop pet window`);
    return handler(event, ...args);
  };

  const settingsGuard = (channel, handler) => (event, ...args) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (isPetWindow(win)) return handler(event, ...args);
    return pageGuard(channel, handler)(event, ...args);
  };

  ipcMain.handle("desktop-pet:state", settingsGuard("desktop-pet:state", () => stateSnapshot()));
  ipcMain.handle("desktop-pet:set", settingsGuard("desktop-pet:set", (_event, patch) => {
    if (!patch || typeof patch !== "object") return stateSnapshot();
    const nextPatch = {};
    if (typeof patch.enabled === "boolean") nextPatch.enabled = patch.enabled;
    if (patch.replyMode === "tts" || patch.replyMode === "text") nextPatch.replyMode = patch.replyMode;
    if (typeof patch.voiceMode === "boolean") nextPatch.voiceMode = patch.voiceMode;
    if (typeof patch.autoAnnounceReports === "boolean") nextPatch.autoAnnounceReports = patch.autoAnnounceReports;
    if (typeof patch.hideInFullscreen === "boolean") nextPatch.hideInFullscreen = patch.hideInFullscreen;
    if (typeof patch.muted === "boolean") nextPatch.muted = patch.muted;
    prefs().setPet(nextPatch);
    if (typeof nextPatch.hideInFullscreen === "boolean") {
      applyWorkspacePolicy(avatarWin);
      applyWorkspacePolicy(popoverWin);
    }
    if (nextPatch.enabled === true) temporarilyHidden = false;
    void syncVisibility();
    return stateSnapshot();
  }));

  ipcMain.handle("desktop-pet:move-by", petOnly("desktop-pet:move-by", (_event, delta) => {
    if (!live(avatarWin)) return false;
    const dx = Number(delta?.dx);
    const dy = Number(delta?.dy);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    const current = avatarWin.getBounds();
    const display = screen.getDisplayNearestPoint({ x: current.x + Math.round(dx) + current.width / 2, y: current.y + Math.round(dy) + current.height / 2 }) ?? screen.getPrimaryDisplay();
    const clamped = clampAvatarPosition(current.x + dx, current.y + dy, display.workArea, current.width);
    avatarWin.setPosition(clamped.x, clamped.y, false);
    if (popoverVisible && popoverMode && popoverMode !== "preview") repositionPopover();
    return true;
  }));

  ipcMain.handle("desktop-pet:commit-position", petOnly("desktop-pet:commit-position", () => {
    if (!live(avatarWin)) return false;
    const bounds = avatarWin.getBounds();
    const display = screen.getDisplayMatching(bounds) ?? screen.getPrimaryDisplay();
    const encoded = encodeAvatarPosition(bounds, display, bounds.width);
    prefs().setPet({ position: encoded });
    return true;
  }));

  ipcMain.handle("desktop-pet:open-popover", petOnly("desktop-pet:open-popover", (_event, mode, size) => openPopover(mode, size ?? null)));
  ipcMain.handle("desktop-pet:close-popover", petOnly("desktop-pet:close-popover", () => { closePopover(); return true; }));
  ipcMain.handle("desktop-pet:resize-popover", petOnly("desktop-pet:resize-popover", (_event, size) => {
    if (!popoverVisible || !popoverMode || !live(popoverWin)) return false;
    popoverSize = {
      width: Number.isFinite(Number(size?.width)) ? Number(size.width) : undefined,
      height: Number.isFinite(Number(size?.height)) ? Number(size.height) : undefined,
    };
    repositionPopover();
    return true;
  }));
  ipcMain.handle("desktop-pet:context-menu", petOnly("desktop-pet:context-menu", () => { showContextMenu(); return true; }));
  ipcMain.handle("desktop-pet:set-report-count", petOnly("desktop-pet:set-report-count", (_event, count) => {
    pendingReportCount = Math.max(0, Math.floor(Number(count) || 0));
    return true;
  }));
  ipcMain.handle("desktop-pet:open-main", petOnly("desktop-pet:open-main", () => { closePopover(); openMainWindow(); return true; }));
  ipcMain.handle("desktop-pet:open-workbench", petOnly("desktop-pet:open-workbench", () => { closePopover(); openWorkbench(); return true; }));
  ipcMain.handle("desktop-pet:open-settings", petOnly("desktop-pet:open-settings", () => { closePopover(); openSettings(); return true; }));
  ipcMain.handle("desktop-pet:post", petOnly("desktop-pet:post", (_event, target, payload) => {
    const dest = target === "popover" ? popoverWin : avatarWin;
    if (!live(dest)) return false;
    try {
      dest.webContents.send("desktop-pet:message", payload);
      return true;
    } catch {
      return false;
    }
  }));
  ipcMain.handle("desktop-pet:speech-start", petOnly("desktop-pet:speech-start", (event, options) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (!appleSpeech || !speech) {
      win.webContents.send("speech:end", { code: 2, reason: "unsupported-platform" });
      return;
    }
    speech.start(win, options);
  }));
  ipcMain.handle("desktop-pet:speech-stop", petOnly("desktop-pet:speech-stop", (event) => {
    if (appleSpeech && speech) speech.stop(BrowserWindow.fromWebContents(event.sender));
  }));
  ipcMain.handle("desktop-pet:speech-finish", petOnly("desktop-pet:speech-finish", (event) => {
    if (appleSpeech && speech) speech.finish(BrowserWindow.fromWebContents(event.sender));
  }));

  let displayListenersAttached = false;
  const clampOnDisplayChange = () => {
    if (!live(avatarWin)) return;
    const bounds = resolveAvatarBounds(currentSettings().position, screen.getAllDisplays(), screen.getPrimaryDisplay(), PET_AVATAR_SIZE);
    avatarWin.setBounds(bounds, false);
    if (popoverVisible) repositionPopover();
  };
  const ensureDisplayListeners = () => {
    if (!available || displayListenersAttached || typeof screen?.on !== "function") return;
    displayListenersAttached = true;
    screen.on("display-metrics-changed", clampOnDisplayChange);
    screen.on("display-removed", clampOnDisplayChange);
  };

  return {
    available,
    attachMainWindow(win) {
      if (!live(win)) return;
      const onVisibleChange = () => { void syncVisibility(); };
      const onShown = () => {
        temporarilyHidden = false;
        void syncVisibility();
      };
      win.on("show", onShown);
      win.on("restore", onShown);
      win.on("minimize", onVisibleChange);
      win.on("hide", onVisibleChange);
      win.on("closed", onVisibleChange);
      void syncVisibility();
    },
    syncVisibility,
    originChanged() {
      if (live(avatarWin) && avatarWin.isVisible()) void syncVisibility();
      else loadedOrigin = null;
    },
    skin(id) {
      if (!skins.isKnownSkin(id) || id === currentSkin) return;
      currentSkin = id;
      for (const win of [avatarWin, popoverWin]) {
        if (!live(win)) continue;
        try { win.webContents.send("desktop-pet:skin", id); } catch {}
      }
    },
    close() {
      shuttingDown = true;
      clearTimeout(blurCloseTimer);
      if (displayListenersAttached && typeof screen?.removeListener === "function") {
        displayListenersAttached = false;
        screen.removeListener("display-metrics-changed", clampOnDisplayChange);
        screen.removeListener("display-removed", clampOnDisplayChange);
      }
      if (live(popoverWin)) popoverWin.destroy();
      if (live(avatarWin)) avatarWin.destroy();
      popoverWin = null;
      avatarWin = null;
      popoverVisible = false;
      popoverMode = null;
    },
  };
}
