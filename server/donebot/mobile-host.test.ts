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
