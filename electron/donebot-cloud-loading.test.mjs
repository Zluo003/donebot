import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { cloudLoadingHtml, cloudLoadingTheme, createDoneBotCloudLoading } from "./donebot-cloud-loading.mjs";

function fixture() {
  const views = [];
  let skin = "daylight";
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, getContentSize: () => [800, 600],
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  });
  const loading = createDoneBotCloudLoading({ window: () => win, local: vi.fn(), skin: () => skin, createView: () => {
    let resolve;
    const ready = new Promise(yes => { resolve = yes; });
    const contents = Object.assign(new EventEmitter(), {
      isDestroyed: vi.fn(() => false), close: vi.fn(), setWindowOpenHandler: vi.fn(),
      executeJavaScript: vi.fn(async () => true), loadURL: vi.fn(() => ready),
    });
    const view = { webContents: contents, setBounds: vi.fn(), ready: resolve };
    views.push(view);
    return view;
  } });
  return { loading, views, setSkin: value => { skin = value; } };
}

describe("Cloud loading theme", () => {
  it.each([["daylight", "light", "#fcfcfc"], ["midnight", "dark", "#121212"], ["atelier", "light", "#f5f1eb"]])("starts in the desktop's %s skin", (skin, scheme, background) => {
    expect(cloudLoadingTheme(skin)).toMatchObject({ "color-scheme": scheme, "--bg": background });
    expect(cloudLoadingHtml("darwin", skin)).toContain(`color-scheme:${scheme};--bg:${background}`);
  });

  it("waits for the page before applying the latest theme", async () => {
    const f = fixture();
    try {
      const handle = f.loading.start(vi.fn());
      handle.update("loading");
      f.setSkin("midnight"); f.loading.refreshTheme();
      expect(f.views[0].webContents.executeJavaScript).not.toHaveBeenCalled();
      f.views[0].ready(); await Promise.resolve();
      expect(f.views[0].webContents.executeJavaScript.mock.calls.map(([code]) => code).join("\n")).toContain('"--bg":"#121212"');
    } finally { f.loading.hide(); }
  });

  it("does not update a superseded loading view or a closed view", async () => {
    const f = fixture();
    try {
      f.loading.start(vi.fn()); f.loading.refreshTheme();
      f.loading.start(vi.fn());
      f.views[0].ready(); await Promise.resolve();
      expect(f.views[0].webContents.executeJavaScript).not.toHaveBeenCalled();
      expect(f.views[0].webContents.close).toHaveBeenCalledOnce();
      f.loading.refreshTheme(); f.loading.hide();
      f.views[1].ready(); await Promise.resolve();
      expect(f.views[1].webContents.executeJavaScript).not.toHaveBeenCalled();
    } finally { f.loading.hide(); }
  });
});
