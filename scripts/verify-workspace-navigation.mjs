import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const flag = "--donebot-workspace-navigation-fixture";
if (!process.versions.electron) {
  const output = fs.mkdtempSync(path.join(tmpdir(), "donebot-workspace-navigation-"));
  const home = path.join(output, "home");
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, "roaming"), LOCALAPPDATA: path.join(home, "local") };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(createRequire(import.meta.url)("electron"),
    [fileURLToPath(import.meta.url), flag, output], { env, stdio: "inherit" });
  const watchdog = setTimeout(() => child.kill(), 45_000);
  const code = await new Promise(resolve => {
    child.on("error", error => { console.error(error); resolve(1); });
    child.on("exit", value => resolve(value ?? 1));
  });
  clearTimeout(watchdog);
  console.log(`Workspace navigation evidence: ${output}`);
  assert.equal(code, 0, "Electron fixture failed");
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, "receipt.json"), "utf8")).passed, true);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(path.join(output, "profile"), { recursive: true, force: true });
} else {
  assert.ok(process.argv.includes(flag));
  const output = process.argv[process.argv.indexOf(flag) + 1];
  const { app, BrowserWindow, Menu, ipcMain, session } = await import("electron");
  const { createWorkspaceNavigation } = await import("../electron/workspace-navigation.mjs");
  const { createEnvironmentsFile } = await import("../electron/environments-file.mjs");
  const { default: environments } = await import("../electron/environments.cjs");
  const { withActive, workspaceNavigationAllowed, workspaceSenderAllowed, workspaceMenuTemplate } = environments;
  const source = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
  const start = source.indexOf("const workspaceNavigation = createWorkspaceNavigation(");
  const end = source.indexOf("\nlet rememberedHome", start);
  assert.ok(start > 0 && end > start);
  app.setPath("userData", path.join(output, "profile"));
  app.setPath("sessionData", path.join(output, "profile"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.on("window-all-closed", () => {});
  const logs = [], checks = [], windows = [];
  const record = line => { logs.push(line); fs.appendFileSync(path.join(output, "electron.log"), `${line}\n`); };
  const page = title => `<!doctype html><title>${title}</title><h1>${title}</h1>`;
  const localHttp = createServer((_request, response) => { response.setHeader("Content-Type", "text/html"); response.end(page("This computer")); });
  let signedIn = false;
  const cloudHttp = createServer((_request, response) => {
    if (!signedIn) { response.writeHead(303, { location: "https://fixture-master.invalid/cloud" }); response.end(); return; }
    response.setHeader("Content-Type", "text/html"); response.end(page("Fixture Cloud"));
  });
  const close = () => { for (const win of windows) if (!win.isDestroyed()) win.destroy(); localHttp.close(); cloudHttp.close(); };
  void app.whenReady().then(async () => {
    try {
      await Promise.all([localHttp, cloudHttp].map(server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve))));
      const local = `http://127.0.0.1:${localHttp.address().port}`;
      const cloud = `http://127.0.0.1:${cloudHttp.address().port}`;
      session.defaultSession.webRequest.onBeforeRequest((request, callback) => {
        let allowed = false;
        try { allowed = [local, cloud].includes(new URL(request.url).origin); } catch {}
        callback({ cancel: !allowed });
      });
      const store = createEnvironmentsFile({ file: () => path.join(output, "environments.json"), fs, path, log: record });
      const context = vm.createContext({ createWorkspaceNavigation, withActive, LOCAL_ID: "local", runningDataDir: null,
        environmentsState: { activeId: "local", environments: [{ id: "cloud", kind: "remote", name: "Fixture Cloud", origin: cloud }] },
        mainWindow: null, rendererOrigin: () => local, homeWindow: { cancel() {} }, slog: record,
        persistEnvironments(next) { store.write(next); context.environmentsState = next; },
      });
      vm.runInContext(`${source.slice(start, end)}; this.navigate = navigateMainWindow;`, context);
      const blocked = [];
      const makeWindow = () => {
        const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: {
          preload: fileURLToPath(new URL("../electron/preload.cjs", import.meta.url)),
          sandbox: true, contextIsolation: true, nodeIntegration: false, additionalArguments: [`--omb-local-origin=${local}`],
        } });
        windows.push(win);
        const guard = (event, url) => {
          if (workspaceNavigationAllowed(url, context.environmentsState, local)) return;
          event.preventDefault(); blocked.push(url); record(`blocked ${url}`);
        };
        win.webContents.on("will-navigate", guard);
        win.webContents.on("will-redirect", guard);
        return win;
      };
      for (const channel of ["home:page", "update:offered", "home:updating", "desktop-analytics:read"]) ipcMain.on(channel, event => { event.returnValue = false; });
      ipcMain.on("desktop-language:read", event => { event.returnValue = "en"; });
      let menuOpened = 0, menu;
      ipcMain.handle("workspaces:menu", event => {
        assert.ok(workspaceSenderAllowed(event, context.mainWindow?.webContents, context.environmentsState, local), "only the active main frame may open the menu");
        menu = Menu.buildFromTemplate(workspaceMenuTemplate(context.environmentsState, {
          onSwitch: id => { context.persistEnvironments(withActive(context.environmentsState, id)); context.switchDone = context.navigate(id === "local" ? local : cloud); },
          onConnect() {}, onForget() {},
        }));
        menuOpened++;
        return "menu-opened";
      });
      const openMenu = () => context.mainWindow.webContents.executeJavaScript("window.ogb.workspaces.menu()");
      const choose = async id => {
        assert.ok(menu.getMenuItemById(`workspace-${id}`));
        menu.getMenuItemById(`workspace-${id}`).click();
        await context.switchDone;
      };
      context.mainWindow = makeWindow();
      await context.navigate(local);
      assert.equal(await openMenu(), "menu-opened");
      await choose("cloud");
      assert.equal(blocked.length, 1);
      assert.equal(context.mainWindow.webContents.getURL(), `${local}/`);
      assert.equal(store.read().activeId, "local");
      assert.equal(await openMenu(), "menu-opened");
      checks.push("blocked expired-session redirect restores the visible computer and menu");
      fs.writeFileSync(path.join(output, "local-after-failed-cloud.png"), (await context.mainWindow.webContents.capturePage()).toPNG());
      signedIn = true;
      await choose("cloud");
      assert.equal(store.read().activeId, "cloud");
      assert.equal(context.mainWindow.webContents.getURL(), `${cloud}/`);
      assert.equal(await openMenu(), "menu-opened");
      await choose("local");
      assert.equal(store.read().activeId, "local");
      assert.equal(context.mainWindow.webContents.getURL(), `${local}/`);
      assert.equal(await openMenu(), "menu-opened");
      checks.push("a reachable Cloud opens and its menu returns to the computer");
      signedIn = false;
      context.mainWindow.destroy();
      context.mainWindow = makeWindow();
      context.persistEnvironments(withActive(context.environmentsState, "cloud"));
      assert.equal(await context.navigate(cloud, true), false);
      assert.equal(context.mainWindow.webContents.getURL(), `${local}/`);
      assert.equal(store.read().activeId, "local");
      assert.equal(await openMenu(), "menu-opened");
      assert.equal(store.read().environments[0].origin, cloud);
      checks.push("failed Cloud startup recovers from an empty window and retains saved servers");
      assert.equal(workspaceNavigationAllowed("https://fixture-master.invalid/cloud", context.environmentsState, local), false);
      assert.equal(await context.mainWindow.webContents.executeJavaScript("typeof process"), "undefined");
      const outsider = makeWindow();
      await outsider.loadURL(local);
      assert.match(await outsider.webContents.executeJavaScript("window.ogb.workspaces.menu().then(() => '', error => error.message)"), /active main frame/);
      checks.push("sandbox, redirect restriction and main-window-only menu authority are preserved");
      fs.writeFileSync(path.join(output, "receipt.json"), JSON.stringify({ passed: true, checks, menuOpened, blocked,
        limitations: "Synthetic loopback pages, production preload/navigation and permission helpers; native menu items are selected programmatically. No live Cloud, production account, full app or installed DMG exercised.",
      }, null, 2));
      record("workspace navigation checks passed");
      close(); app.exit(0);
    } catch (error) { record(error.stack ?? String(error)); console.error(error); close(); app.exit(1); }
  }).catch(error => { console.error(error); close(); app.exit(1); });
}
