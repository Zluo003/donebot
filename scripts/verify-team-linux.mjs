import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

async function command(program, args, timeout = 90_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = chunk => {
      output += chunk;
      if (output.length > 4 * 1024 * 1024) child.kill("SIGKILL");
    };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
  });
}

async function containerCheck() {
  const check = await command(process.execPath, ["/app/dist-server/bot-box/box-check.js", "--public=none", "--root=/data/probes"]);
  const probe = JSON.parse(check.output.trim().split("\n").at(-1));
  assert.ok([0, 1, 2].includes(check.code), check.output);
  if (check.code === 0) assert.ok(probe.total > 0 && probe.passed === probe.total && probe.failed.length === 0);
  let bwrapDiagnostic;
  if (check.code === 2 && probe.reason === "userns-refused") {
    const diag = await command("bwrap", [
      "--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--die-with-parent",
      "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "/bin/true",
    ], 10_000);
    bwrapDiagnostic = diag.output.trim().slice(0, 500) || `exit ${diag.code}`;
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const teamId = randomUUID(), instanceId = randomUUID(), origin = "http://127.0.0.1:18899";
  const dataDir = "/data/qualification";
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const logPath = join(dataDir, "server.log"), fd = openSync(logPath, "w", 0o600);
  const child = spawn(process.execPath, ["/app/dist-server/index.js"], {
    env: {
      PATH: process.env.PATH, HOME: "/data", TMPDIR: "/tmp", NODE_ENV: "production", LANG: "C.UTF-8",
      DONEBOT_DATA_DIR: dataDir, DONEBOT_PORT: "18899", DONEBOT_WEBHOOK_PORT: "18900",
      DONEBOT_DUCKDB_DIR: "/app/duckdb", DONEBOT_TEAM_RUNTIME: "1", DONEBOT_TEAM_ID: teamId,
      DONEBOT_TEAM_INSTANCE_ID: instanceId, DONEBOT_TEAM_NAME: "Isolated qualification",
      DONEBOT_TEAM_PUBLIC_KEY: publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"),
      DONEBOT_TEAM_EXECUTION_ENABLED: "1", DONEBOT_TELEMETRY: "0",
    }, stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  let exited = false;
  const stopped = new Promise(resolve => child.once("exit", () => { exited = true; resolve(); }));
  const call = (method, path, body, patch = {}) => {
    const payload = Buffer.from(JSON.stringify({ protocol: "donebot.teams.v1", team_id: teamId, instance_id: instanceId,
      user_id: "3", email: "member@example.invalid", role: "owner", member_version: 1,
      expires: Math.floor(Date.now() / 1000) + 9,
      runtime_hash: createHash("sha256").update(`${method}\n${path}`).digest("hex"), ...patch }));
    return fetch(origin + path, { method, signal: AbortSignal.timeout(5_000),
      headers: { origin, "content-type": "application/json", "x-donebot-team-grant": `${payload.toString("base64url")}.${sign(null, payload, privateKey).toString("base64url")}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  try {
    let health;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && !exited) {
      try { health = await fetch(origin + "/api/health", { signal: AbortSignal.timeout(1000) }); break; }
      catch { await delay(150); }
    }
    assert.ok(health, `Runtime did not start: ${readFileSync(logPath, "utf8").slice(-6000)}`);
    let readiness = await health.json();
    assert.equal(readiness.app, "donebot"); assert.equal(readiness.team_protocol, "donebot.teams.v1");
    assert.equal((await fetch(origin + "/api/bots")).status, 401);
    assert.equal((await call("GET", "/api/bots", undefined, { team_id: randomUUID() })).status, 401);
    assert.equal((await call("GET", "/api/donebot/account")).status, 403);
    const configRes = await call("GET", "/api/config");
    assert.equal(configRes.status, 200, await configRes.clone().text());
    const config = await configRes.json();
    assert.equal(config.team?.id, teamId);
    assert.equal(config.donebot?.enabled, true);
    assert.equal(config.donebot?.authenticated, true);
    assert.equal(config.donebot?.user?.email, "member@example.invalid");
    const response = await call("GET", "/api/bots");
    assert.equal(response.status, 200, await response.clone().text());
    const bots = await response.json();
    assert.ok(bots.bots[0]?.id, "The synthetic member's default Bot was not created");
    const bot = bots.bots[0];
    if (check.code === 0) {
      while (!readiness.ready && Date.now() < deadline) {
        await delay(200);
        health = await fetch(origin + "/api/health"); readiness = await health.json();
      }
      assert.equal(readiness.ready, true, "Runtime self-check did not become ready");
      assert.equal(health.status, 200);
    } else {
      assert.equal(readiness.ready, false); assert.equal(health.status, 503);
      const sent = await call("POST", `/api/bots/${bot.id}/messages`, { text: "This isolated request must never execute", threadId: bot.activeTaskId });
      assert.equal(sent.status, 503, await sent.clone().text());
      assert.match(await sent.text(), /isolation/i);
      const result = await call("GET", "/api/bots");
      const unchanged = (await result.json()).bots.find(item => item.id === bot.id);
      assert.ok(unchanged); assert.equal(Boolean(unchanged.busy), false);
    }
    const result = { probeExit: check.code, probe, ...(bwrapDiagnostic ? { bwrapDiagnostic } : {}), readiness, authenticatedReads: "passed", foreignTeam: "refused",
      execution: check.code === 0 ? "not exercised" : "refused with 503", acceptance: check.code === 0 ? "isolation-only" : "blocked" };
    console.log(JSON.stringify(result));
    return check.code === 0 ? 0 : 2;
  } finally {
    if (!exited) child.kill("SIGTERM");
    const timer = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 5_000);
    await stopped; clearTimeout(timer);
  }
}

async function hostCheck() {
  let image = null, seccomp = null, apparmor = null;
  for (let i = 2; i < process.argv.length; i += 2) {
    const flag = process.argv[i], value = process.argv[i + 1];
    assert.ok(value, "Usage: node scripts/verify-team-linux.mjs --image LOCAL_IMAGE [--seccomp FILE] [--apparmor PROFILE]");
    if (flag === "--image") image = value;
    else if (flag === "--seccomp") seccomp = value;
    else if (flag === "--apparmor") apparmor = value;
    else assert.fail(`Unknown option: ${flag}`);
  }
  assert.ok(image, "Usage: node scripts/verify-team-linux.mjs --image LOCAL_IMAGE [--seccomp FILE] [--apparmor PROFILE]");
  if (seccomp !== null) {
    assert.notEqual(seccomp.toLowerCase(), "unconfined", "seccomp=unconfined is forbidden");
    const parsed = JSON.parse(readFileSync(seccomp, "utf8"));
    assert.equal(parsed.defaultAction, "SCMP_ACT_ERRNO", "team seccomp must deny by default");
  }
  if (apparmor !== null) {
    assert.match(apparmor, /^[a-z0-9][a-z0-9._-]{1,63}$/);
    assert.notEqual(apparmor, "unconfined", "apparmor=unconfined is forbidden");
    assert.notEqual(apparmor, "docker-default", "docker-default cannot compensate systempaths");
  }
  const compensateSystemPaths = Boolean(seccomp && apparmor);
  if (compensateSystemPaths) {
    try {
      const profiles = readFileSync("/sys/kernel/security/apparmor/profiles", "utf8").split("\n").map(line => line.trim());
      assert.ok(profiles.includes(`${apparmor} (enforce)`), `AppArmor profile ${apparmor} is not loaded in enforce mode`);
    } catch (error) {
      if (error?.code !== "EACCES") throw error;
    }
  }
  const inspected = await command("docker", ["image", "inspect", image]);
  assert.equal(inspected.code, 0, inspected.output);
  const info = JSON.parse(inspected.output)[0];
  assert.equal(info.Os, "linux"); assert.equal(info.Config.Labels?.["cn.donebot.teams.protocol"], "donebot.teams.v1");
  const revision = info.Config.Labels?.["org.opencontainers.image.revision"];
  assert.match(revision ?? "", /^[a-f0-9]{40}$/);
  const evidence = mkdtempSync(join(tmpdir(), "donebot-team-linux-evidence-")), name = `donebot-team-check-${randomUUID()}`;
  const args = ["run", "--rm", "--pull=never", "--name", name, "--init", "--network", "none", "--user", "1001:1001", "--read-only",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    ...(seccomp ? ["--security-opt", `seccomp=${seccomp}`] : []),
    ...(apparmor ? ["--security-opt", `apparmor=${apparmor}`] : []),
    ...(compensateSystemPaths ? ["--security-opt", "systempaths=unconfined"] : []),
    "--memory", "1g", "--cpus", "1", "--pids-limit", "256",
    "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777", "--tmpfs", "/run:rw,nosuid,nodev,mode=755",
    "--tmpfs", "/data:rw,exec,nosuid,nodev,uid=1001,gid=1001,mode=700",
    "--mount", `type=bind,source=${fileURLToPath(import.meta.url)},target=/opt/team-qualification.mjs,readonly`,
    info.Id, "node", "/opt/team-qualification.mjs", "--container"];
  try {
    const result = await command("docker", args, 150_000);
    writeFileSync(join(evidence, "container.log"), result.output, { mode: 0o600 });
    let container;
    try { container = JSON.parse(result.output.trim().split("\n").at(-1)); } catch { container = null; }
    const record = { imageId: info.Id, digests: info.RepoDigests, revision, architecture: info.Architecture,
      code: result.code, security: { unprivileged: true, readOnly: true, capabilities: [], noNewPrivileges: true, network: "none", seccomp: seccomp ? "team-minimal" : "docker-default", apparmor: apparmor ?? "docker-default", systempaths: compensateSystemPaths ? "unconfined-compensated-by-apparmor" : "docker-default" },
      container, ...(container ? {} : { outputTail: result.output.slice(-2000) }) };
    writeFileSync(join(evidence, "receipt.json"), JSON.stringify(record, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ evidence, ...record }, null, 2));
    return container && (result.code === 0 && container.acceptance === "isolation-only" || result.code === 2 && container.acceptance === "blocked") ? result.code : 1;
  } finally { await command("docker", ["rm", "--force", name]); }
}

process.exitCode = await (process.argv[2] === "--container" ? containerCheck() : hostCheck());
