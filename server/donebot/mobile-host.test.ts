import { expect,it } from "vitest";
import { mobileChatRoute } from "./mobile-host.ts";

it("limits mobile connections to chat and scoped attachment operations before the original auth gate",()=>{
  for(const [method,path] of [["GET","/api/bots?messages=1"],["GET","/api/bots?messages=20"],["POST","/api/groups/group-1/messages"],["POST","/api/groups/group-1/read"],["GET","/api/threads/thread-1/messages?limit=50&before=message-1"],["POST","/api/bots/bot-1/messages"],["POST","/api/bots/bot-1/read"]]) expect(mobileChatRoute(method,path)).toBe(true);
  for(const [method,path] of [["GET","/api/bots?messages=21"],["POST","/api/groups/group-1/messages?admin=1"],["POST","/api/groups/group-1/members"],["GET","/api/config"],["POST","/api/bots"],["GET","//evil.test/api/bots"],["GET","/api/x/../bots"],["GET","/api/threads/thread-1/messages?limit=99"],["GET","/api/bots?messages=1&ticket=x"],["POST","/api/bots/bot-1/computer/control"],["POST","/api/bots/bot-1/messages?admin=1"]]) expect(mobileChatRoute(method,path)).toBe(false);
});


it("only admits idempotent image uploads, stored raster avatars and message-scoped downloads", () => {
  expect(mobileChatRoute("POST", "/api/attachments?uploadId=11111111-1111-4111-8111-111111111111")).toBe(true);
  expect(mobileChatRoute("GET", "/api/attachments/avatar.png")).toBe(true);
  expect(mobileChatRoute("POST", "/api/threads/thread/messages/message/file")).toBe(true);
  for (const [method, path] of [
    ["POST", "/api/attachments"], ["POST", "/api/attachments?uploadId=invalid"],
    ["POST", "/api/attachments?uploadId=11111111-1111-4111-8111-111111111111&admin=1"],
    ["GET", "/api/attachments/private.pdf"], ["GET", "/api/attachments/avatar.svg"],
    ["GET", "/api/attachments/%2e%2e/config"], ["GET", "/api/attachments/a.png?admin=1"],
    ["DELETE", "/api/attachments/avatar.png"], ["POST", "/api/files"],
    ["GET", "/api/threads/t/messages/m/file"], ["POST", "/api/threads/t/messages/m/file?entry=secret"],
  ]) expect(mobileChatRoute(method!, path!)).toBe(false);
});

it("admits automation switches and public connection lists without other setup operations", () => {
  for (const path of ["/api/routines", "/api/webhooks", "/api/app-triggers", "/api/connectors/connected"]) expect(mobileChatRoute("GET", path)).toBe(true);
  expect(mobileChatRoute("PATCH", "/api/routines/daily")).toBe(true);
  expect(mobileChatRoute("POST", "/api/webhooks/hook/enabled")).toBe(true);
  expect(mobileChatRoute("POST", "/api/app-triggers/event/enabled")).toBe(true);
  for (const [method, path] of [["POST", "/api/routines"], ["DELETE", "/api/routines/daily"], ["PATCH", "/api/webhooks/hook"], ["POST", "/api/webhooks/hook/rotate"], ["GET", "/api/connectors/catalog"], ["GET", "/api/routines?admin=1"], ["POST", "/api/app-triggers/event/enabled?admin=1"]]) expect(mobileChatRoute(method!, path!)).toBe(false);
});

it("admits named document uploads without arbitrary file access or extra query parameters", () => {
  const path = "/api/files?uploadId=11111111-1111-4111-8111-111111111111&name=";
  expect(mobileChatRoute("POST", path + encodeURIComponent("工作说明.pdf"))).toBe(true);
  for (const name of ["", ".", "..", "../secret.pdf", "a\\b.pdf", "a\u0000.pdf", "a".repeat(181)]) expect(mobileChatRoute("POST", path + encodeURIComponent(name))).toBe(false);
  for (const suffix of ["&admin=1", "&name=another.pdf", "#fragment"]) expect(mobileChatRoute("POST", path + "note.pdf" + suffix)).toBe(false);
  expect(mobileChatRoute("GET", path + "note.pdf")).toBe(false);
});

it("admits bounded remote browser takeover, chat controls, and Boss Desk review routes", () => {
  for (const [method, path] of [
    ["GET", "/api/bots/bot-1/browser/live"],
    ["GET", "/api/bots/bot-1/browser/live?threadId=thread-1&width=390&height=700"],
    ["GET", "/api/events?screens=off&frames=thread"],
    ["GET", "/api/events?frames=thread&screens=off"],
    ["POST", "/api/bots/bot-1/browser/action"],
    ["POST", "/api/bots/bot-1/browser/action?threadId=thread-1"],
    ["POST", "/api/bots/bot-1/sign-in-cards/msg-1/done"],
    ["POST", "/api/bots/bot-1/sign-in-cards/msg-1/cancel"],
    ["POST", "/api/bots/bot-1/interrupt"],
    ["POST", "/api/groups/group-1/interrupt"],
    ["POST", "/api/bots/bot-1/tasks"],
    ["POST", "/api/groups/group-1/tasks"],
    ["POST", "/api/bots/bot-1/respond"],
    ["POST", "/api/threads/thread-1/respond"],
    ["GET", "/api/donebot/opc/overview"],
    ["GET", "/api/donebot/opc/overview?days=30"],
    ["POST", "/api/donebot/opc/reports/review"],
    ["POST", "/api/donebot/opc/artifacts/abc123def/review"],
    ["POST", "/api/donebot/opc/workflow-runs/run-1/decision"],
  ]) expect(mobileChatRoute(method, path)).toBe(true);

  for (const [method, path] of [
    ["GET", "/api/bots/bot-1/browser/live?admin=1"],
    ["GET", "/api/bots/bot-1/browser/live?width=99999"],
    ["GET", "/api/events"],
    ["GET", "/api/events?screens=on&frames=thread"],
    ["GET", "/api/events?screens=off"],
    ["GET", "/api/events?screens=off&frames=thread&since=1"],
    ["GET", "/api/events?screens=off&frames=thread&admin=1"],
    ["POST", "/api/events?screens=off&frames=thread"],
    ["GET", "/api/bots/bot-1/browser/stream"],
    ["POST", "/api/bots/bot-1/browser/upload"],
    ["POST", "/api/bots/bot-1/sign-in-cards/msg-1/save-login"],
    ["POST", "/api/bots/bot-1/sign-in-cards/msg-1/use-login"],
    ["GET", "/api/donebot/opc/overview?days=999"],
    ["GET", "/api/donebot/opc/overview?days=0"],
    ["GET", "/api/donebot/opc/org"],
    ["POST", "/api/donebot/opc/workflows"],
    ["DELETE", "/api/donebot/opc/goals/g-1"],
    ["POST", "/api/bots/bot-1/tasks/delete"],
    ["POST", "/api/bots/bot-1/respond?admin=1"],
  ]) expect(mobileChatRoute(method, path)).toBe(false);
});
