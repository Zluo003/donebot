// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Message } from "@/state/store";
import { UnreadContextOverlay } from "./UnreadContextOverlay";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const messages: Message[] = [
  { id: "question", role: "user", kind: "text", text: "My question before the unread reply", at: 1 },
  { id: "reply", role: "bot", kind: "text", text: "The unread reply", at: 2 },
];
let root: Root;
let container: HTMLDivElement;
let scroller: HTMLDivElement;
let row: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
let sequence: number;
const jump = vi.fn();
const card = () => container.querySelector('[data-testid="unread-context-card"]');
const rect = (top: number, height: number) => ({ top, bottom: top + height, height }) as DOMRect;

beforeEach(() => {
  jump.mockReset();
  frames = new Map();
  sequence = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  scroller = document.body.appendChild(document.createElement("div"));
  const wrapper = scroller.appendChild(document.createElement("div"));
  wrapper.dataset.mid = "question";
  row = wrapper.appendChild(document.createElement("div"));
  row.dataset.messageRow = "";
  scroller.getBoundingClientRect = () => rect(100, 500);
  row.getBoundingClientRect = () => rect(10, 40);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  scroller.remove();
  vi.unstubAllGlobals();
});

function draw(patch: Partial<ComponentProps<typeof UnreadContextOverlay>> = {}) {
  act(() => root.render(createElement(UnreadContextOverlay, {
    messages, windowedMessages: messages, unreadMessageId: "reply", scrollRef: { current: scroller },
    visitKey: "visit-1", onJump: jump, ...patch,
  })));
  act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0)); });
}

it("shows an offscreen question and jumps to its original message", () => {
  draw();
  expect(card()?.textContent).toContain(messages[0]!.text);
  act(() => card()!.querySelectorAll("button")[0]!.click());
  expect(jump).toHaveBeenCalledExactlyOnceWith("question");
  expect(card()).toBeNull();
  draw();
  expect(card()).toBeNull();
});

it("does not repeat an already visible question when the person scrolls later", () => {
  row.getBoundingClientRect = () => rect(200, 40);
  draw();
  expect(card()).toBeNull();
  row.getBoundingClientRect = () => rect(10, 40);
  draw();
  expect(card()).toBeNull();
  draw({ visitKey: "visit-2" });
  expect(card()).not.toBeNull();
});

it("can dismiss a question outside the rendered history for this visit only", () => {
  draw({ windowedMessages: messages.slice(1) });
  expect(card()).not.toBeNull();
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(card()).toBeNull();
  draw({ windowedMessages: messages.slice(1) });
  expect(card()).toBeNull();
  draw({ windowedMessages: messages.slice(1), visitKey: "visit-2" });
  expect(card()).not.toBeNull();
  act(() => card()!.querySelectorAll("button")[1]!.click());
  expect(card()).toBeNull();
});

it("removes stale context when switching to a conversation without unread replies", () => {
  draw();
  expect(card()).not.toBeNull();
  draw({ unreadMessageId: null, visitKey: "other-conversation" });
  expect(card()).toBeNull();
  expect(frames.size).toBe(0);
});
