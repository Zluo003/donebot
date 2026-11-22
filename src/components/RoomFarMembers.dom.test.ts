// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { nextMemberIds, resolveGroupMembers } from "@/lib/room-members";
import { mergeFarMembers, type LinkedBot } from "@/lib/linked-bots";
import type { Bot } from "@/state/store";
import { RoomFarMembers, farMembersOf } from "./RoomFarMembers";

let container: HTMLDivElement, root: Root;
const rows = () => [...document.body.querySelectorAll<HTMLElement>("[data-far-member]")];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const far = [
  { id: "link-0000abcd-atlas", name: "Atlas", place: "My Cloud", state: "ok" as const },
  { id: "link-0000abcd-nova", name: "Nova", place: "My Cloud", state: "off" as const },
  { id: "link-0000abcd-scout", name: "Scout", place: "My Cloud", state: "missing" as const },
];

it("a room with no member from another place draws nothing", async () => {
  await act(async () => root.render(createElement(RoomFarMembers, { members: farMembersOf({ memberIds: ["writer"] }), picked: new Set(["writer"]), onToggle: () => {} })));
  expect(document.body.querySelector("[data-testid=room-far-members]")).toBeNull();
});

it("each member from another place is listed with where it lives and why it cannot answer, and can be unticked", async () => {
  const group = { memberIds: ["writer", far[0].id, far[1].id, far[2].id], farMembers: [...far, { id: "link-0000abcd-left", name: "Left", place: "My Cloud", state: "ok" as const }] };
  const picked = new Set(group.memberIds), toggled: string[] = [];
  const draw = () => act(async () => root.render(createElement(RoomFarMembers, { members: farMembersOf(group), picked: new Set(picked), onToggle: (id: string) => { toggled.push(id); if (!picked.delete(id)) picked.add(id); } })));
  await draw();
  
  expect(rows().map((row) => [row.dataset.farMember, row.dataset.farState, row.getAttribute("aria-checked"), row.textContent])).toEqual([
    [far[0].id, "ok", "true", "Atlason My Cloud"],
    [far[1].id, "off", "true", "Novaon My Cloud · Link is off"],
    [far[2].id, "missing", "true", "Scouton My Cloud · No longer available"],
  ]);
  await act(async () => rows()[2]!.click());
  await draw();
  expect(toggled).toEqual([far[2].id]);
  expect(rows()[2]!.getAttribute("aria-checked")).toBe("false");
  
  expect(nextMemberIds(group.memberIds, picked, ["writer"])).toEqual(["writer", far[0].id, far[1].id]);
});

it("merges linked bots so new remote bots can be added to rooms and resolved for display", async () => {
  const linked: LinkedBot[] = [
    { id: far[0].id, home: { id: "cloud-1", key: "0000abcd", kind: "cloud", name: "DoneBot Cloud", online: true }, botId: "atlas", name: "Atlas", color: "teal", title: "Cloud Analyst" },
    { id: "link-0000abcd-spark", home: { id: "cloud-1", key: "0000abcd", kind: "cloud", name: "DoneBot Cloud", online: false }, botId: "spark", name: "Spark", color: "coral" },
  ];
  const merged = mergeFarMembers([far[0], far[2]], linked);
  expect(merged.map((m) => [m.id, m.place, m.state, m.color])).toEqual([
    [far[0].id, "DoneBot Cloud", "ok", "teal"],
    [far[2].id, "My Cloud", "missing", undefined],
    ["link-0000abcd-spark", "DoneBot Cloud", "offline", "coral"],
  ]);

  const picked = new Set(["writer", "link-0000abcd-spark"]);
  expect(nextMemberIds(["writer"], picked, ["writer", ...merged.map((m) => m.id)])).toEqual(["writer", "link-0000abcd-spark"]);

  const localWriter = { id: "writer", threadId: "t1", name: "Writer", title: "", description: "", notifications: false, color: "green", unread: false, modelSelection: { instanceId: "claude", model: "sonnet" }, messages: [] } as Bot;
  const resolved = resolveGroupMembers(
    { memberIds: ["writer", far[0].id], farMembers: [{ id: far[0].id, name: "Atlas", place: "DoneBot Cloud", state: "ok", color: "teal", title: "Cloud Analyst" }] },
    [localWriter],
  );
  expect(resolved.map((b) => [b.id, b.name, b.color, b.title])).toEqual([
    ["writer", "Writer", "green", ""],
    [far[0].id, "Atlas", "teal", "Cloud Analyst · on DoneBot Cloud"],
  ]);
});
