// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsDialog } from "./SettingsDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

it("keeps Tab and Escape in the top dialog and restores focus to each opener", async () => {
  const parentClose = vi.fn();
  function Dialogs() {
    const [open, setOpen] = useState(false);
    const [child, setChild] = useState(false);
    return createElement("div", null,
      createElement("button", { "data-opener": true, onClick: () => setOpen(true) }, "Open"),
      open && createElement(SettingsDialog, {
        title: "Outer", onClose: () => { parentClose(); setOpen(false); }, children: [
          createElement("button", { key: "opener", "data-autofocus": true, "data-child-opener": true, onClick: () => setChild(true) }, "Inner"),
          child && createElement(SettingsDialog, {
            key: "child", title: "Inner", onClose: () => setChild(false),
            footer: createElement("button", { "data-last": true }, "Save"),
            children: createElement("input", { "aria-label": "Value" }),
          }),
        ],
      }),
    );
  }
  await act(async () => root.render(createElement(Dialogs)));
  const opener = host.querySelector<HTMLButtonElement>("[data-opener]")!;
  opener.focus();
  await act(async () => opener.click());
  const childOpener = document.querySelector<HTMLButtonElement>("[data-child-opener]")!;
  expect(document.activeElement).toBe(childOpener);
  await act(async () => childOpener.click());
  expect(document.activeElement).toBe(document.querySelector('[aria-label="Value"]'));
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(document.querySelector("[data-last]"));
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(document.querySelector('[role="dialog"][aria-label="Inner"]')).toBeNull();
  expect(document.querySelector('[role="dialog"][aria-label="Outer"]')).not.toBeNull();
  expect(parentClose).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(childOpener);
  await act(async () => childOpener.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(parentClose).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(opener);
});
