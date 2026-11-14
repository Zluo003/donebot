import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir,writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { WebSocket as NativeWebSocket } from "ws";
import { loadConfig } from "../relay/src/config.ts";
import { startRelay } from "../relay/src/server.ts";
import { startRelayManagement } from "../relay/src/management.ts";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { startFakeDoneBotGateway } from "../server/testing/fake-donebot-gateway.ts";

const hub = process.env.DONEBOT_MOBILE_FIXTURE_HUB!;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(hub)) throw new Error("An explicitly launched mobile hub fixture is required");
const install = "11111111-1111-4111-8111-111111111111";
const credential = "sk-donebot-" + "a".repeat(64);
const phone = "22222222-2222-4222-8222-222222222222";
const seed = Buffer.alloc(32,7);
const signing = createPublicKey({ key: { kty: "OKP",crv: "Ed25519",d: seed.toString("base64url"),x: process.env.DONEBOT_MOBILE_FIXTURE_RELAY_PUBLIC! },format: "jwk" });
const config = loadConfig({ RELAY_NODE: "relay1", RELAY_PORT: "0", RELAY_MOBILE_CLIENTS: "1", RELAY_NODE_TOKEN: process.env.DONEBOT_MOBILE_FIXTURE_NODE_TOKEN, RELAY_TOKEN_KEYS: JSON.stringify({ k1: signing.export({format:"jwk"}).x }) });
config.management!.origin = hub;
const relay = await startRelay(config,{ log: () => {} });
const stopManagement = startRelayManagement(relay, config);
const fake = await startFakeDoneBotGateway(undefined,new Map([[credential,install]]),"101");
fake.setPlan([],"Mobile hub verified reply.");
const proxy = createServer(async (req,res) => {
  try {
    const origin = req.url?.startsWith("/v1/donebot/runtime/mobile/") ? hub : fake.origin;
    const chunks: Buffer[]=[];for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !["host","connection","content-length","transfer-encoding"].includes(name)).map(([k,v])=>[k,String(v)]));
    const response = await fetch(origin + req.url,{ method:req.method,headers,body:chunks.length?Buffer.concat(chunks):undefined,signal:AbortSignal.timeout(20_000) });
    res.writeHead(response.status,{"content-type":"application/json"});res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(502);res.end("{}"); }
});
let proxiedPhones = 0;
proxy.on("upgrade", (req, socket, head) => {
  const path = req.url?.replace(/^\/mobile-relay(?=\/)/, "");
  if (!path || !["/v1/host", "/v1/host/data", "/v1/phone"].includes(path)) return socket.destroy();
  if (path === "/v1/phone") {
    assert.equal(req.url, "/mobile-relay/v1/phone");
    assert.equal(req.headers.origin, "capacitor://localhost");
    ++proxiedPhones;
  }
  const upstream = request({ hostname: "127.0.0.1", port: relay.port, path, headers: req.headers });
  upstream.on("upgrade", (res, target, initial) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(res.headers).map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n`);
    if (initial.length) socket.write(initial);
    if (head.length) target.write(head);
    socket.on("error", () => target.destroy()); target.on("error", () => socket.destroy());
    socket.on("close", () => target.destroy()); target.on("close", () => socket.destroy());
    socket.pipe(target).pipe(socket);
  });
  upstream.on("error", () => socket.destroy()); upstream.end();
});
proxy.listen(0,"127.0.0.1");await once(proxy,"listening");
const address=proxy.address();if(!address||typeof address==="string")throw new Error("Invalid proxy fixture");
const fixture=await launchVerificationServer(process.env,undefined,undefined,undefined,undefined,undefined,[],undefined,undefined,`http://127.0.0.1:${address.port}`,{ installationId:install,credential,user:{id:"101",email:"fixture@example.test"}},undefined,`ws://127.0.0.1:${address.port}`);
const control=(...args:string[])=>runControlOmb([...args,"--url",fixture.info.url]) as Promise<any>;
const api=async(path:string,body?:unknown,method?:string)=>{
 const result=await fetch(hub+path,{method:method??(body===undefined?"GET":"POST"),headers:{authorization:"Bearer fixture-mobile","content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
 assert.ok(result.ok,`hub request ${path}: ${result.status}`);return result.status===204?null:result.json();
};
const until=async(check:()=>Promise<boolean>,timeout=20_000)=>{const deadline=Date.now()+timeout;while(!await check()){assert.ok(Date.now()<deadline,"fixture condition timed out");await new Promise(resolve=>setTimeout(resolve,250));}};
let connection: { request<T>(path:string,options?:unknown):Promise<T>; close():void }|undefined;
try {
 await api("/api/v1/donebot/mobile/session",{installationId:phone,name:"Fixture iPhone",platform:"ios"},"PUT");
 await until(async()=>((await api("/api/v1/donebot/mobile/workspaces")) as any).workspaces.some((w:any)=>w.id===install && w.online));
 const devices = await api("/api/v1/donebot/devices");
 assert.equal(devices.desktop.length,1); assert.equal(devices.desktop[0].connection,"connected");
 assert.equal(devices.mobile.length,1); assert.equal(devices.mobile[0].name,"Fixture iPhone");
 const descriptor=await api(`/api/v1/donebot/mobile/workspaces/${install}/connection`,{installationId:phone});
 const out=join(process.cwd(),".omb-scratch","verify-evidence","mobile-hub");await mkdir(out,{recursive:true});
 const bundle=join(out,"mobile-transport.mjs");await build({entryPoints:[join(process.cwd(),"../DoneBot-Mobile/src/core/relay.ts")],outfile:bundle,bundle:true,platform:"node",format:"esm",define:{__FIXTURE__:"false"},logLevel:"silent"});
 assert.deepEqual(descriptor.r,["donebot.cn/mobile-relay"]);
 globalThis.WebSocket=class extends NativeWebSocket {constructor(url:string|URL,protocols?:string|string[]){super(String(url).replace("wss://donebot.cn",`ws://127.0.0.1:${address.port}`),protocols,{origin:"capacitor://localhost"});}} as unknown as typeof WebSocket;
 const {RelayConnection}=await import(pathToFileURL(bundle).href);
 connection=await RelayConnection.connect(descriptor);
 assert.equal(proxiedPhones,1);
 assert.deepEqual(relay.stats(),{hosts:1,sessions:1,sockets:3});
 const {bot}=await control("new-bot","--name","Mobile hub fixture");
 await control("set-model","--bot",bot.id,"--instance","donebot","--model","gpt-6.1-sol");
 const listed=await connection!.request<any>("/api/bots?messages=1");assert.ok(listed.bots.some((b:any)=>b.id===bot.id));
 await api("/api/v1/donebot/mobile/push/subscription",{installationId:phone,platform:"ios",environment:"sandbox",token:"b".repeat(64),preview:false},"PUT");
 await connection!.request(`/api/bots/${bot.id}/messages`,{method:"POST",body:{text:"Verify the self-hosted mobile hub.",threadId:bot.activeTaskId,sendId:crypto.randomUUID()}});
 const settled=await control("wait","--bot",bot.id,"--timeout","30");assert.equal(settled.status,"settled");
 const messages=await connection!.request<any>(`/api/threads/${bot.activeTaskId}/messages?limit=50`);assert.ok(messages.messages.some((m:any)=>m.text?.includes("Mobile hub verified reply.")));
 await assert.rejects(()=>connection!.request("/api/config"));
 await until(async()=>{const events=await api("/fixture/pushes") as any[];return events.some(e=>e.botId===bot.id&&e.threadId===bot.activeTaskId)});
 const pushes=await api("/fixture/pushes") as any[];
 assert.ok(pushes.every(p=>!JSON.stringify(p).includes("Verify the self-hosted")));
 await api("/api/v1/donebot/mobile/session",{installationId:phone},"DELETE");
 await until(async()=>{try{await connection!.request("/api/bots?messages=1");return false;}catch{return true;}});
 await writeFile(join(out,"evidence.json"),JSON.stringify({fixture:fixture.info,bot:bot.id,thread:bot.activeTaskId,wait:settled,messages:messages.messages,pushes,devices,checks:["managed relay policy","same-domain relay proxy","Capacitor WebSocket origin","separate desktop and phone lists","original encrypted transport","real hub persistence","account ownership","original session scope","message outbox","generic notification","logout revocation"]},null,2));
 console.log(JSON.stringify({ok:true,log:fixture.info.logPath,evidence:join(out,"evidence.json")}));
} finally {connection?.close();await fixture.close();stopManagement();await relay.close();await fake.close();proxy.closeAllConnections();await new Promise<void>(resolve=>proxy.close(()=>resolve()));}
