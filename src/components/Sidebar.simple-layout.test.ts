import { Children, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, Group } from "@/state/store";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[], index: 0, effects: [] as EffectCallback[], advanced: false,
  state: {} as AppState, dispatch: vi.fn(), storage: new Map<string, string>(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(fixture.values[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = { current: initial };
    return fixture.values[index];
  },
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); },
  useLayoutEffect: () => {},
}));
vi.mock("react-dom", () => ({ createPortal: (node: ReactNode) => node }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./MenuMotion", () => ({
  useMenuMotion: (open: boolean) => ({ shown: open, closing: false, className: "", exitProps: {} }),
  useHeldMenuMotion: (value: unknown) => ({ shown: value !== null, value, closing: false, className: "", exitProps: {} }),
}));
vi.mock("./DesktopCapabilities", async () => {
  const { initialDesktopCapabilities } = await import("@/lib/desktop");
  return { useDesktopCapabilities: () => ({ capabilities: initialDesktopCapabilities() }), windowFramed: () => false };
});
vi.mock("@/lib/thread-preferences", () => ({ useShowThreadsChoice: () => true, useShowThreads: () => fixture.advanced }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) };
});

import { initialState } from "@/state/store";
import { BOTS_SECTION_ID, CHANNELS_SECTION_ID, PINNED_SECTION_ID, userSectionId } from "@/lib/sidebar-layout";
import { SIDEBAR_COLLAPSED_SECTIONS_KEY, SIDEBAR_DENSITY_KEY, SIDEBAR_SECTION_ORDER_KEY, SIDEBAR_WIDTH_KEY, SIMPLE_SIDEBAR_SECTION_ORDER_KEY, SIMPLE_SIDEBAR_WIDTH_KEY, setSidebarDensity } from "@/lib/sidebar-preferences";
import { Sidebar } from "./Sidebar";
import { PinnedBotRoster } from "./PinnedCircleThreads";
import { SidebarFooter } from "./SidebarFooter";
import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { SidebarTileGrid } from "./SidebarTiles";
import { GlassBar, GlassScrollFrame, GlassScroller } from "./GlassScrollFrame";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { SidebarSearchPill, SidebarSearchToggle } from "./SidebarSimpleTop";
import { SimpleRailFooter } from "./SidebarSimpleRail";

const bot = (id: string, extra: Partial<Bot> = {}): Bot => ({
  id, threadId: `${id}-thread`, name: id, title: "", description: "", notifications: true,
  color: "green", unread: false, modelSelection: { instanceId: "fake", model: "m" }, messages: [], ...extra,
});
const room: Group = {
  id: "room", threadId: "room-thread", name: "Launch room", memberIds: ["atlas"], messages: [],
  defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 1,
};

type Props = { children?: ReactNode; className?: string; style?: Record<string, string>; [key: string]: unknown };
function nodes(value: ReactNode): ReactElement<Props>[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement<Props>(child)) return [];
    return [child, ...nodes(child.props.children)];
  });
}
function render(collapseToIcons = false) {
  fixture.index = 0;
  fixture.effects = [];
  const root = Sidebar({ open: false, onClose: () => {}, collapseToIcons }) as ReactElement<Props>;
  return { root, tree: [root, ...nodes(root.props.children)] };
}
const sectionOrder = (tree: ReactElement<Props>[]) => tree.map((node) => node.props["data-sidebar-section-id"]).filter(Boolean);
const headers = (tree: ReactElement<Props>[]) => tree.filter((node) => node.type === SidebarSectionHeader) as ReactElement<Parameters<typeof SidebarSectionHeader>[0]>[];
const listedBots = (tree: ReactElement<Props>[]) => tree.map((node) => (node.props.bot as Bot | undefined)?.id).filter(Boolean);
const labelled = (tree: ReactElement<Props>[], label: string) => tree.some((node) => node.props["aria-label"] === label);

beforeEach(() => {
  fixture.values = [];
  fixture.advanced = false;
  fixture.storage = new Map();
  fixture.dispatch.mockClear();
  fixture.state = {
    ...initialState,
    bots: [bot("atlas"), bot("bea"), bot("dodo", { section: "Work" })],
    groups: [room],
    sections: ["Work"],
  };
  vi.stubGlobal("window", Object.assign(new EventTarget(), { innerWidth: 1280, innerHeight: 800, ogb: undefined, setTimeout, clearTimeout }));
  vi.stubGlobal("document", { body: {} });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => fixture.storage.get(key) ?? null,
    setItem: (key: string, value: string) => { fixture.storage.set(key, value); },
    removeItem: (key: string) => { fixture.storage.delete(key); },
  });
});
afterEach(() => {
  setSidebarDensity("comfortable");
  vi.unstubAllGlobals();
});

describe("shared desktop sidebar layout", () => {
  it.each([false, true])("uses the same lists and section controls when Advanced is %s", (advanced) => {
    fixture.advanced = advanced;
    const { tree } = render();
    expect(sectionOrder(tree)).toEqual([CHANNELS_SECTION_ID, BOTS_SECTION_ID, userSectionId("Work")]);
    expect(listedBots(tree)).toEqual(["atlas", "bea", "dodo"]);
    expect(headers(tree).map((header) => [header.props.name, header.props.line, header.props.count])).toEqual([
      ["Group chats", false, undefined], ["Bots", false, undefined], ["Work", false, undefined],
    ]);
    expect(headers(tree)[2]!.props.onContextMenu).toBeTypeOf("function");
    expect(labelled(tree, "Add or remove bots in Work")).toBe(true);
    expect(tree.some((node) => node.type === SidebarTileGrid)).toBe(false);
    for (const node of tree.filter((node) => node.props.bot)) {
      expect(node.props.advancedLayout).toBe(true);
      expect(node.props.showThreads).toBe(true);
    }
    expect(fixture.advanced).toBe(advanced);
  });

  it.each([false, true])("keeps Chief and pinned bots in lists when Advanced is %s", (advanced) => {
    fixture.advanced = advanced;
    fixture.state = { ...fixture.state, bots: [bot("chief", { chiefOfStaff: true }), bot("atlas", { pinned: true }), bot("bea")] };
    const { tree } = render();
    expect(tree.some((node) => node.type === SidebarTileGrid)).toBe(false);
    expect(sectionOrder(tree)).toContain(PINNED_SECTION_ID);
    expect(listedBots(tree)).toEqual(["chief", "bea"]);
    const roster = tree.find((node) => node.type === PinnedBotRoster)!.props as Parameters<typeof PinnedBotRoster>[0];
    expect(roster.bots.map((candidate) => candidate.id)).toEqual(["atlas"]);
    expect(headers(tree).map((header) => header.props.name)).toContain("Pinned");
  });

  it("keeps the glass frame and footer navigation in Simple mode", () => {
    const { root, tree } = render();
    expect(tree.find((node) => node.type === GlassScrollFrame)!.props.fade).toBe(true);
    expect(tree.some((node) => node.type === GlassBar && node.props.edge === "top")).toBe(true);
    expect(tree.some((node) => node.type === GlassScroller)).toBe(true);
    expect(root.props.className).toContain("border-r-[0.5px] border-edge");
    const footer = tree.find((node) => node.type === SidebarFooter)!.props;
    expect(footer.simple).toBe(false);
    expect(footer.advancedLayout).toBe(true);
  });

  it("filters from a persistent search field and Escape clears the filter", () => {
    const search = () => render().tree.find((node) => node.type === "input" && node.props["aria-label"] === "Search bots and messages")!.props;
    expect(search().value).toBe("");
    expect(render().tree.some((node) => node.type === SidebarSearchToggle || node.type === SidebarSearchPill)).toBe(false);
    (search().onChange as (event: { target: { value: string } }) => void)({ target: { value: "bea" } });
    expect(listedBots(render().tree)).toEqual(["bea"]);
    (search().onKeyDown as (event: { key: string }) => void)({ key: "Escape" });
    expect(search().value).toBe("");
    expect(listedBots(render().tree)).toEqual(["atlas", "bea", "dodo"]);
  });

  it("shares section ordering and collapse state with Advanced mode", () => {
    fixture.storage.set(SIDEBAR_SECTION_ORDER_KEY, JSON.stringify([userSectionId("Work"), BOTS_SECTION_ID, CHANNELS_SECTION_ID]));
    fixture.storage.set(SIMPLE_SIDEBAR_SECTION_ORDER_KEY, JSON.stringify([CHANNELS_SECTION_ID, BOTS_SECTION_ID]));
    fixture.storage.set(SIDEBAR_COLLAPSED_SECTIONS_KEY, JSON.stringify([BOTS_SECTION_ID]));
    expect(sectionOrder(render().tree)).toEqual([userSectionId("Work"), BOTS_SECTION_ID, CHANNELS_SECTION_ID]);
    expect(listedBots(render().tree)).toEqual(["dodo"]);
    headers(render().tree).find((header) => header.props.name === "Bots")!.props.onToggle!();
    expect(listedBots(render().tree)).toEqual(["dodo", "atlas", "bea"]);
    headers(render().tree).find((header) => header.props.name === "Work")!.props.onMove!(1);
    expect(JSON.parse(fixture.storage.get(SIDEBAR_SECTION_ORDER_KEY)!)).toEqual([BOTS_SECTION_ID, userSectionId("Work"), CHANNELS_SECTION_ID]);
  });

  it("uses Advanced's 320px default and saved width, including when a side panel opens", () => {
    const width = () => render().root.props.style!["--sidebar-width"];
    expect(width()).toBe("320px");
    fixture.storage.set(SIDEBAR_WIDTH_KEY, "360");
    fixture.storage.set(SIMPLE_SIDEBAR_WIDTH_KEY, "300");
    fixture.values = [];
    expect(width()).toBe("360px");
    fixture.state = { ...fixture.state, computerOpen: true };
    const { root, tree } = render();
    const handle = tree.find((node) => node.type === SidebarResizeHandle)!.props as Parameters<typeof SidebarResizeHandle>[0];
    expect(handle.sizing.defaultWidth).toBe(320);
    expect(handle.sizing.maxWidth).toBe(320);
    expect(root.props.className).toContain("md:max-w-[320px]");
    fixture.values = [];
    fixture.advanced = true;
    expect(width()).toBe("360px");
  });

  it("collapses to Advanced's avatar column and expands through the same edge", () => {
    const edge = () => render().tree.find((node) => node.type === SidebarResizeHandle)!.props as Parameters<typeof SidebarResizeHandle>[0];
    edge().onAvatars(true);
    expect(fixture.storage.get(SIDEBAR_DENSITY_KEY)).toBe("avatars");
    expect(render().root.props.className).toContain("w-[80px]");
    expect(edge().avatarsWidth).toBe(80);
    expect(render().tree.some((node) => node.type === SimpleRailFooter)).toBe(false);
    edge().onAvatars(false);
    expect(render().root.props.className).toContain("w-[320px]");
  });

  it.each([false, true])("keeps the original New Bot action when Advanced is %s", (advanced) => {
    fixture.advanced = advanced;
    const plus = render().tree.find((node) => node.type === "button" && node.props["aria-label"] === "New or share")!;
    (plus.props.onClick as () => void)();
    const item = render().tree.find((node) => node.type === "button" && Children.toArray(node.props.children).some((child) => isValidElement<Props>(child) && Children.toArray(child.props.children).includes("New Bot")))!;
    (item.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "newBot" });
  });

  it("keeps the phone sidebar's separate layout", () => {
    Object.assign(window, { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
    const { tree } = render();
    expect(tree.some((node) => node.type === SidebarFooter || node.type === SidebarResizeHandle)).toBe(false);
    expect(tree.some((node) => node.type === "input" && node.props["aria-label"] === "Search bots and messages")).toBe(false);
  });
});
