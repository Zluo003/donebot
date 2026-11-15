import assert from "node:assert/strict";
import { createHash, createPublicKey } from "node:crypto";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir,writeFile,readFile } from "node:fs/promises";
import { build } from "esbuild";
import { WebSocket as NativeWebSocket } from "ws";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { startFakeDoneBotGateway } from "../server/testing/fake-donebot-gateway.ts";
import { fixtureApi } from "./testing/preview-fixture.ts";

const hub = process.env.DONEBOT_MOBILE_FIXTURE_HUB!;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(hub)) throw new Error("An explicitly launched mobile hub fixture is required");
const relayRoot = process.env.DONEBOT_MOBILE_RELAY_ROOT;
if (!relayRoot) throw new Error("DONEBOT_MOBILE_RELAY_ROOT must point to the independent DoneBot-Relay project");
const { loadConfig } = await import(pathToFileURL(join(relayRoot, "src/config.ts")).href);
const { startRelay } = await import(pathToFileURL(join(relayRoot, "src/server.ts")).href);
const { startRelayManagement } = await import(pathToFileURL(join(relayRoot, "src/management.ts")).href);
const install = "11111111-1111-4111-8111-111111111111";
const credential = "sk-donebot-" + "a".repeat(64);
const phone = "22222222-2222-4222-8222-222222222222";
const workspaceKind = process.env.DONEBOT_MOBILE_FIXTURE_KIND === "cloud" ? "cloud" : "computer";
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
  const path = req.url;
  if (!path || !["/v1/host", "/v1/host/data", "/v1/phone"].includes(path)) return socket.destroy();
  if (path === "/v1/phone") {
    assert.equal(req.url, "/v1/phone");
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
 const workspaces = await api("/api/v1/donebot/mobile/workspaces");
 assert.ok(workspaces.workspaces.some((workspace:any)=>workspace.id===install && workspace.kind===workspaceKind && workspace.online));
 const devices = await api("/api/v1/donebot/devices");
 assert.equal(devices.desktop.length,workspaceKind === "cloud" ? 0 : 1); if (workspaceKind === "computer") assert.equal(devices.desktop[0].connection,"connected");
 assert.equal(devices.mobile.length,1); assert.equal(devices.mobile[0].name,"Fixture iPhone");
 const descriptor=await api(`/api/v1/donebot/mobile/workspaces/${install}/connection`,{installationId:phone});
 const out=join(process.cwd(),".omb-scratch","verify-evidence",workspaceKind === "cloud" ? "mobile-cloud" : "mobile-hub");await mkdir(out,{recursive:true});
 const bundle=join(out,"mobile-transport.mjs");await build({entryPoints:[join(process.cwd(),"../DoneBot-Mobile/src/core/relay.ts")],outfile:bundle,bundle:true,platform:"node",format:"esm",define:{__FIXTURE__:"false"},logLevel:"silent"});
 const contractsBundle=join(out,"mobile-contracts.mjs");
 await build({entryPoints:[join(process.cwd(),"../DoneBot-Mobile/src/core/contracts.ts")],outfile:contractsBundle,bundle:true,platform:"node",format:"esm",logLevel:"silent"});
 const {directorySchema,messagePageSchema}=await import(pathToFileURL(contractsBundle).href);
 const workspaceBundle=join(out,"mobile-workspace.mjs");
 await build({entryPoints:[join(process.cwd(),"../DoneBot-Mobile/src/core/automations.ts")],outfile:workspaceBundle,bundle:true,platform:"node",format:"esm",logLevel:"silent"});
 const {readAutomations,connectedAppsSchema}=await import(pathToFileURL(workspaceBundle).href);
 assert.deepEqual(descriptor.r,["relay1.donebot.cn"]);
 globalThis.WebSocket=class extends NativeWebSocket {constructor(url:string|URL,protocols?:string|string[]){super(String(url).replace("wss://relay1.donebot.cn",`ws://127.0.0.1:${address.port}`),protocols,{origin:"capacitor://localhost"});}} as unknown as typeof WebSocket;
 const {RelayConnection}=await import(pathToFileURL(bundle).href);
 connection=await RelayConnection.connect(descriptor);
 assert.equal(proxiedPhones,1);
 assert.deepEqual(relay.stats(),{hosts:1,sessions:1,sockets:3});
 const {bot}=await control("new-bot","--name","Mobile hub fixture");
 await control("set-model","--bot",bot.id,"--instance","donebot","--model","gpt-6.1-sol");
 const listed=directorySchema.parse(await connection!.request<any>("/api/bots?messages=20"));assert.ok(listed.bots.some((b:any)=>b.id===bot.id));
 const defaultBot=listed.bots.find((b:any)=>b.defaultBot);
 assert.deepEqual(defaultBot?.defaultBot,{},"the original workspace coordinator must retain its object marker");
 const desktopApi=fixtureApi(fixture.info.url,{headers:{origin:fixture.info.url}});
 const {routine:automation}=await desktopApi("POST","/api/routines",{name:"Mobile switch fixture",prompt:"Keep this original instruction",botId:bot.id,enabled:true,schedule:{type:"once",at:Date.now()+86400_000}});
 const {webhook}=await desktopApi("POST","/api/webhooks",{name:"Mobile event switch fixture",prompt:"Keep this event instruction",botId:bot.id});
 const automations=await readAutomations(connection);
 assert.ok(automations.some((item:any)=>item.kind==="schedule"&&item.id===automation.id));
 assert.ok(automations.some((item:any)=>item.kind==="webhook"&&item.id===webhook.id));
 for(const enabled of [false,true]) {
   const changed=await connection!.request<any>(`/api/routines/${automation.id}`,{method:"PATCH",body:{enabled}});
   assert.equal(changed.routine.enabled,enabled);assert.equal(changed.routine.prompt,automation.prompt);
   const event=await connection!.request<any>(`/api/webhooks/${webhook.id}/enabled`,{method:"POST",body:{enabled}});
   assert.equal(event.webhook.enabled,enabled);assert.equal(event.webhook.prompt,webhook.prompt);assert.equal(event.credential,undefined);
 }
 await assert.rejects(()=>connection!.request(`/api/routines/${automation.id}`,{method:"PATCH",body:{enabled:false,prompt:"Must not change"}}));
 await assert.rejects(()=>connection!.request(`/api/webhooks/${webhook.id}/enabled`,{method:"POST",body:{enabled:false,prompt:"Must not change"}}));
 const persistedAutomations=await desktopApi("GET","/api/routines");
 assert.ok(persistedAutomations.routines.some((item:any)=>item.id===automation.id&&item.enabled&&item.prompt===automation.prompt));
 connectedAppsSchema.parse(await connection!.request("/api/connectors/connected"));
 const media = await Promise.all(["photo.png", "demo.mp4", "note.wav", "guide.pdf", "notes.txt"].map(async name => ({ name, data: await readFile(join(process.cwd(), "../DoneBot-Mobile/tests/fixtures/media", name)) })));
 const folder = join(fixture.info.dataDir, "workspaces", bot.id);
 await mkdir(folder, { recursive: true });
 for (const file of media) await writeFile(join(folder, file.name), file.data);
 const generatedImage = join(folder, "jimeng-image-generate-20261114155450727-fixture.png");
 await writeFile(generatedImage, media[0]!.data);
 fake.setPlan([{ name: "attach_file", arguments: { path: generatedImage } }], "Mobile hub verified reply.\n\n" + media.map(file => `[${file.name}](${join(folder, file.name)})`).join("\n\n"));
 const uploadId = crypto.randomUUID();
 const upload = await connection!.request<any>(`/api/attachments?uploadId=${uploadId}`, { method: "POST", rawBody: media[0]!.data, contentType: "image/png" });
 const retry = await connection!.request<any>(`/api/attachments?uploadId=${uploadId}`, { method: "POST", rawBody: media[0]!.data, contentType: "image/png" });
 assert.equal(upload.path, retry.path);
 await api("/api/v1/donebot/mobile/push/subscription",{installationId:phone,platform:"ios",environment:"sandbox",token:"b".repeat(64),preview:false},"PUT");
 const beforeImageSend = fake.requests.length;
 await connection!.request(`/api/bots/${bot.id}/messages`,{method:"POST",body:{text:`Verify the self-hosted mobile hub.\n\n<attached-image path="${upload.path}" name="fixture.png" />`,threadId:bot.activeTaskId,sendId:crypto.randomUUID()}});
 const settled=await control("wait","--bot",bot.id,"--timeout","30");assert.equal(settled.status,"settled");
 const modelImageRequest = fake.requests.slice(beforeImageSend).find(request => request.path === "/v1/responses"
   && Array.isArray(request.body.input) && request.body.input.some((message:any) => message.role === "user"
     && (typeof message.content === "string" ? message.content.includes("Verify the self-hosted mobile hub.")
       : Array.isArray(message.content) && message.content.some((part:any) => part.type === "input_text" && part.text?.includes("Verify the self-hosted mobile hub.")))));
 assert.ok(modelImageRequest, "the uploaded-image message must reach the model");
 const modelImageParts = (modelImageRequest.body.input as any[]).filter(message => message.role === "user").flatMap(message => message.content ?? []).filter(part => part.type === "input_image");
 assert.equal(modelImageParts.length, 1, "the model request must carry the actual uploaded image, not just its chat preview");
 assert.equal(modelImageParts[0].image_url, `data:image/png;base64,${media[0]!.data.toString("base64")}`);
 const modelImageInput = { model: modelImageRequest.body.model, path: modelImageRequest.path, mime: "image/png", bytes: media[0]!.data.length, sha256: createHash("sha256").update(media[0]!.data).digest("hex") };
 const messages=messagePageSchema.parse(await connection!.request<any>(`/api/threads/${bot.activeTaskId}/messages?limit=50`));assert.ok(messages.messages.some((m:any)=>m.text?.includes("Mobile hub verified reply.")));
 const reply = messages.messages.find((m:any) => m.role === "bot" && m.text?.includes("Mobile hub verified reply."));
 const downloads = [];
 const generated = messages.messages.find((m:any) => m.role === "bot" && m.attachments?.some((file:any) => file.kind === "image"));
 assert.ok(generated, "the original attach_file tool must deliver a structured image");
 const generatedAttachment = generated.attachments.find((file:any) => file.kind === "image");
 const generatedDownload = await connection!.request<any>(`/api/threads/${bot.activeTaskId}/messages/${generated.id}/file`, { method: "POST", body: { path: generatedAttachment.path }, responseType: "bytes" });
 assert.deepEqual(Buffer.from(generatedDownload.data), media[0]!.data);
 downloads.push({ name: "generated structured image", bytes: generatedDownload.data.length, mime: generatedDownload.mime });
 for (const file of media) {
   const path = join(folder, file.name);
   const downloaded = await connection!.request<any>(`/api/threads/${bot.activeTaskId}/messages/${reply.id}/file`, { method: "POST", body: { path }, responseType: "bytes" });
   assert.deepEqual(Buffer.from(downloaded.data), file.data);
   downloads.push({ name: file.name, bytes: downloaded.data.length, mime: downloaded.mime });
 }
 const sent = messages.messages.find((m:any) => m.role === "user" && m.text?.includes(upload.path));
 const photo = await connection!.request<any>(`/api/threads/${bot.activeTaskId}/messages/${sent.id}/file`, { method: "POST", body: { path: upload.path }, responseType: "bytes" });
 assert.deepEqual(Buffer.from(photo.data), media[0]!.data);
 await assert.rejects(() => connection!.request(`/api/threads/${bot.activeTaskId}/messages/${sent.id}/file`, { method: "POST", body: { path: join(folder, "guide.pdf") }, responseType: "bytes" }));
 await assert.rejects(() => connection!.request(`/api/threads/${bot.activeTaskId}/messages/${reply.id}/file`, { method: "POST", body: { path: join(fixture.info.dataDir, "config.json") }, responseType: "bytes" }));
 const {bot: member}=await control("new-bot","--name","Mobile room member");
 await control("set-model","--bot",member.id,"--instance","donebot","--model","gpt-6.1-sol");
 const {channel}=await control("new-channel","--name","Mobile room fixture","--members",`${bot.id},${member.id}`);
 const directory=directorySchema.parse(await connection!.request<any>("/api/bots?messages=20"));
 assert.ok(Array.isArray(directory.sections));
 assert.ok(directory.groups.some((group:any)=>group.id===channel.id && group.memberIds.includes(member.id)));
 fake.setPlan([],"Mobile group verified reply.");
 await connection!.request(`/api/groups/${channel.id}/messages`,{method:"POST",body:{text:"Verify the mobile group route.",threadId:channel.activeTaskId,sendId:crypto.randomUUID()}});
 const groupSettled=await control("wait","--channel",channel.id,"--timeout","30");assert.equal(groupSettled.status,"settled");
 const groupMessages=messagePageSchema.parse(await connection!.request<any>(`/api/threads/${channel.activeTaskId}/messages?limit=50`));
 assert.ok(groupMessages.messages.some((message:any)=>message.role==="bot" && message.text?.includes("Mobile group verified reply.")));
 await connection!.request(`/api/groups/${channel.id}/read`,{method:"POST",body:{threadId:channel.activeTaskId}});
 await assert.rejects(()=>connection!.request("/api/config"));
 await until(async()=>{const events=await api("/fixture/pushes") as any[];return events.some(e=>e.botId===bot.id&&e.threadId===bot.activeTaskId)});
 const pushes=await api("/fixture/pushes") as any[];
 assert.ok(pushes.every(p=>!JSON.stringify(p).includes("Verify the self-hosted")));
 await api("/api/v1/donebot/mobile/session",{installationId:phone},"DELETE");
 await until(async()=>{try{await connection!.request("/api/bots?messages=1");return false;}catch{return true;}});
 await writeFile(join(out,"evidence.json"),JSON.stringify({fixture:fixture.info,workspaceKind,workspaces,bot:bot.id,thread:bot.activeTaskId,wait:settled,messages:messages.messages,group:{channel,wait:groupSettled,messages:groupMessages.messages},pushes,devices,downloads,modelImageInput,checks:["mobile schema parses original directory and message responses","automation lists and public connected-app status","enabled-only routine and webhook updates preserve instructions","automation content changes refused","managed relay policy","independent relay domain and preserved paths","Capacitor WebSocket origin","separate desktop and phone lists","original encrypted transport","real hub persistence","account ownership","original session scope","department and group directory","original group send, reply and read","binary image/video/audio/PDF/text round trips","uploaded image bytes reach the model native input","idempotent image upload","message-scoped file denials","message outbox","generic notification","logout revocation"]},null,2));
 console.log(JSON.stringify({ok:true,log:fixture.info.logPath,evidence:join(out,"evidence.json")}));
} finally {connection?.close();await fixture.close();stopManagement();await relay.close();await fake.close();proxy.closeAllConnections();await new Promise<void>(resolve=>proxy.close(()=>resolve()));}
