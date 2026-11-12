import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { cloudDesktopSocket, withCloudDesktopFile } from "./cloud-desktop.ts";
import { containerComputerAction, containerComputerMcp, containerExec, perBotLocalVmTarget, SHARED_LOCAL_VM_TARGET, setupCommands } from "./container-computer.ts";

afterEach(() => vi.unstubAllEnvs());

it("refuses arbitrary Cloud socket paths and non-shared targets", async () => {
  vi.stubEnv("DONEBOT_CLOUD_DESKTOP_SOCKET", "/var/run/docker.sock");
  expect(() => cloudDesktopSocket()).toThrow("Invalid Cloud");
  vi.stubEnv("DONEBOT_CLOUD_DESKTOP_SOCKET", "/run/donebot/cloud-desktop.sock");
  await expect(containerComputerAction("run", undefined, undefined, perBotLocalVmTarget("a"))).rejects.toMatchObject({ status: 409 });
  expect(() => containerComputerMcp("docker", undefined, perBotLocalVmTarget("a"))).toThrow("one private desktop");
  expect(setupCommands("docker").run).toBeNull();
});

it("routes execution and lifecycle to the private socket and cleans downloaded attachments", async () => {
  const dir = await mkdtemp("/tmp/dbc-adapter-"), socket = join(dir, "desktop.sock"), calls: string[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    calls.push(`${req.url} ${body}`);
    if (req.url === "/file") { res.end("private desktop report"); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/exec" ? { exitCode: 0, stdout: "1000", stderr: "", timedOut: false } : { ready: true }));
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  vi.stubEnv("DONEBOT_CLOUD_DESKTOP_SOCKET", socket);
  let localPath = "";
  try {
    expect((await containerExec(SHARED_LOCAL_VM_TARGET, "id -u")).stdout).toBe("1000");
    await containerComputerAction("run");
    expect(calls).toContain('/action {"action":"run"}');
    expect(calls[0]).toBe('/exec {"command":"id -u"}');
    expect(containerComputerMcp("docker").args).toContain("cloud");
    expect(await withCloudDesktopFile(SHARED_LOCAL_VM_TARGET, "report.txt", async local => {
      expect(local).toBeDefined(); localPath = local!.path; return readFile(local!.path, "utf8");
    })).toBe("private desktop report");
    await expect(readFile(localPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toContain('/file {"path":"/home/cua/workspace/report.txt"}');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});
