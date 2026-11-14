import { expect,it } from "vitest";
import { mobileChatRoute } from "./mobile-host.ts";

it("limits mobile connections to the four chat operations before the original auth gate",()=>{
  for(const [method,path] of [["GET","/api/bots?messages=1"],["GET","/api/threads/thread-1/messages?limit=50&before=message-1"],["POST","/api/bots/bot-1/messages"],["POST","/api/bots/bot-1/read"]]) expect(mobileChatRoute(method,path)).toBe(true);
  for(const [method,path] of [["GET","/api/config"],["POST","/api/bots"],["GET","//evil.test/api/bots"],["GET","/api/x/../bots"],["GET","/api/threads/thread-1/messages?limit=99"],["GET","/api/bots?messages=1&ticket=x"],["POST","/api/bots/bot-1/computer/control"],["POST","/api/bots/bot-1/messages?admin=1"]]) expect(mobileChatRoute(method,path)).toBe(false);
});
