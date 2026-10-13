/**
 * Desktop command bar for voice-browser: a small always-on-top window that sends typed
 * commands to the voice-browser server over the same WebSocket the control page uses.
 *
 * Starts the server itself (reading ../.env) unless one is already running on the port.
 * A global shortcut (default Cmd/Ctrl+Shift+Space, changeable in the bar) shows/focuses it; Esc hides it.
 */
const { app, BrowserWindow, Menu, Tray, nativeImage, globalShortcut, ipcMain, shell, systemPreferences } = require("electron");
const browsers = require("./browsers.cjs");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// The project folder (server + .env). Installed apps carry a root.json pointing at it.
function projectRoot() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "root.json"), "utf8")).root;
  } catch {
    return path.resolve(__dirname, "..");
  }
}
const ROOT = projectRoot();
const PORT = Number(process.env.PORT) || 8787;
const BASE = `http://127.0.0.1:${PORT}`;
const DEFAULT_HOTKEY = "CommandOrControl+Shift+Space";
let hotkey = null; // currently registered accelerator

let win = null;
let tray = null;
let createdOnce = false;
let server = null; // child process, only if we started it
let externalServer = false; // a server we didn't start was already running on the port
let restarting = false;
// Which browser the server drives: { id: "builtin" } or { id, name, port, separate }.
let browserState = { id: "builtin", name: "Built-in Chromium" };

function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2]) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

async function serverUp() {
  try {
    const res = await fetch(`${BASE}/api/state`);
    return res.ok;
  } catch {
    return false;
  }
}

// ── browser app icons (the real Dia / Arc / Chrome icon, from macOS) ──
const appIcons = new Map(); // .app path -> nativeImage
function builtinAppPath() {
  const root = path.join(require("node:os").homedir(), "Library", "Caches", "ms-playwright");
  try {
    for (const dir of fs.readdirSync(root).filter((d) => d.startsWith("chromium-")).sort().reverse()) {
      for (const sub of fs.readdirSync(path.join(root, dir)).filter((d) => d.startsWith("chrome-mac"))) {
        const app = fs.readdirSync(path.join(root, dir, sub)).find((f) => f.endsWith(".app"));
        if (app) return path.join(root, dir, sub, app);
      }
    }
  } catch {}
  return null;
}
const browserAppPath = (id) => (id === "builtin" ? builtinAppPath() : browsers.installedBrowsers().find((b) => b.id === id)?.path || null);
/**
 * The app's own icon: its .icns (Info.plist CFBundleIconFile) converted to PNG once with `sips`
 * and cached in the app's data folder. (app.getFileIcon returns a generic placeholder on macOS 26.)
 */
async function appIcon(appPath) {
  if (!appPath) return null;
  if (appIcons.has(appPath)) return appIcons.get(appPath);
  let img = null;
  try {
    const dir = path.join(app.getPath("userData"), "browser-icons");
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `${path.basename(appPath, ".app").replace(/[^\w.-]+/g, "_")}.png`);
    if (!fs.existsSync(out)) {
      const plist = fs.readFileSync(path.join(appPath, "Contents", "Info.plist"), "utf8");
      let file = plist.match(/<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/)?.[1] || "AppIcon";
      if (!file.endsWith(".icns")) file += ".icns";
      const icns = path.join(appPath, "Contents", "Resources", file);
      await new Promise((resolve, reject) =>
        require("node:child_process").execFile("/usr/bin/sips", ["-s", "format", "png", "-Z", "64", icns, "--out", out], { timeout: 8000 }, (err) => (err ? reject(err) : resolve())),
      );
    }
    img = nativeImage.createFromPath(out);
    if (img.isEmpty()) img = null;
  } catch {
    img = null;
  }
  if (!img) {
    try {
      const f = await app.getFileIcon(appPath, { size: "normal" });
      if (!f.isEmpty()) img = f;
    } catch {}
  }
  appIcons.set(appPath, img);
  return img;
}
const menuIcon = (id) => appIcons.get(browserAppPath(id))?.resize({ width: 16, height: 16 }) || undefined;
async function warmBrowserIcons() {
  await Promise.all([browserAppPath("builtin"), ...browsers.installedBrowsers().map((b) => b.path)].map(appIcon));
  refreshTray();
}
async function browserStateForUI(extra = {}) {
  const img = await appIcon(browserAppPath(browserState.id));
  return { ...browserState, ...extra, icon: img ? img.resize({ width: 32, height: 32 }).toDataURL() : null };
}

async function sendBrowserState(extra = {}) {
  win?.webContents.send("browser-state", await browserStateForUI(extra));
  refreshTray();
}

// ── menu bar icon ─────────────────────────────────────────────
function trayIconPath() {
  for (const p of [path.join(__dirname, "trayTemplate.png"), path.join(__dirname, "build", "trayTemplate.png")]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const showBar = () => {
  if (!win) createWindow();
  win.show();
  win.focus();
  win.webContents.send("focus-input");
};

const SYM = { Command: "⌘", CommandOrControl: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧" };
const prettyKey = (accel) => (accel || "").split("+").map((k) => SYM[k] || k).join("");

function refreshTray() {
  if (!tray) return;
  const login = app.getLoginItemSettings().openAtLogin;
  const browserItems = [
    { label: "Built-in Chromium", icon: menuIcon("builtin"), type: "radio", checked: browserState.id === "builtin", click: () => switchBrowser("builtin") },
    ...browsers.installedBrowsers().map((b) => ({
      label: b.name,
      icon: menuIcon(b.id),
      type: "radio",
      checked: browserState.id === b.id,
      click: () => {
        showBar();
        askBrowserSwitch(b);
      },
    })),
  ];
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Show Voice Browser${hotkey ? `   ${prettyKey(hotkey)}` : ""}`, click: showBar },
      { type: "separator" },
      { label: `Browser: ${browserState.name}`, submenu: browserItems },
      { label: "Open control page (live details)", click: () => shell.openExternal(`http://localhost:${PORT}`) },
      { label: "Open data folder", click: () => shell.openPath(path.join(require("node:os").homedir(), ".voice-browser")) },
      { type: "separator" },
      {
        label: "Start at login",
        type: "checkbox",
        checked: login,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked });
          refreshTray();
        },
      },
      { type: "separator" },
      { label: "Quit Voice Browser", accelerator: "Command+Q", click: () => app.quit() },
    ]),
  );
  tray.setToolTip(`Voice Browser: ${browserState.name}`);
}

function createTray() {
  const icon = trayIconPath();
  if (!icon) return;
  const img = nativeImage.createFromPath(icon);
  img.setTemplateImage(true);
  tray = new Tray(img);
  refreshTray();
}

/** Attach to the browser saved in settings, if it can be reached without quitting anything. */
async function resolveSavedBrowser(env) {
  const saved = loadSettings().browser;
  if (!saved || saved.id === "builtin") return null;
  const b = browsers.installedBrowsers().find((x) => x.id === saved.id);
  if (!b) return null;
  try {
    const r = await browsers.connect(b, { prev: saved, allowRestart: false });
    browserState = { id: b.id, name: b.name, port: r.port, separate: r.separate };
    saveSettings({ browser: { id: b.id, port: r.port, separate: r.separate } });
    return r.cdpUrl;
  } catch (err) {
    browserState = { id: "builtin", name: "Built-in Chromium", note: String(err.message || err) };
    return null;
  }
}

async function ensureServer() {
  if (await serverUp()) {
    externalServer = true;
    return { started: false };
  }
  const cdpUrl = await resolveSavedBrowser();
  const started = await startServer(cdpUrl);
  sendBrowserState(); // the bar asked before we knew which browser we'd attach to
  return started;
}

async function stopServer() {
  if (!server) return;
  const child = server;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM"); // closes the built-in Chromium, or just disconnects from your browser
    setTimeout(() => (child.kill("SIGKILL"), resolve()), 8000);
  });
  server = null;
}

async function startServer(cdpUrl = null) {
  const env = { ...process.env, ...readEnv(path.join(ROOT, ".env")), ELECTRON_RUN_AS_NODE: "1", PORT: String(PORT) };
  env.CDP_URL = cdpUrl || ""; // overrides .env: the bar's browser menu is the source of truth
  if (!env.SUBQ_API_KEY && !env.TYPESAFE_API_KEY && !env.JEV_API_KEY) {
    throw new Error("No API key. Add SUBQ_API_KEY to .env in the project folder.");
  }
  // Electron's own binary runs as plain Node here, so no separate Node install is needed.
  server = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  server.stdout.on("data", (d) => process.stdout.write(d));
  server.stderr.on("data", (d) => {
    stderr += d;
    process.stderr.write(d);
  });
  const child = server;
  child.on("exit", (code) => {
    if (server === child) server = null;
    if (!restarting) win?.webContents.send("server-exit", { code, stderr: stderr.slice(-400) });
  });
  // Attaching to a browser with many tabs (Dia, Arc) can take a while: allow up to 2 minutes.
  for (let i = 0; i < 480; i++) {
    if (await serverUp()) return { started: true };
    if (!server) throw new Error(`Server exited: ${stderr.slice(-300) || "unknown error"}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("The browser service is taking longer than usual to start. It keeps trying in the background.");
}

// Window size/position persist between launches. "compact" = prompt only, "expanded" = with activity.
const COMPACT_HEIGHT = 128;
const EXPANDED_HEIGHT = 420;
const boundsFile = () => path.join(app.getPath("userData"), "window.json");

function loadBounds() {
  try {
    return JSON.parse(fs.readFileSync(boundsFile(), "utf8"));
  } catch {
    return { width: 680, height: EXPANDED_HEIGHT };
  }
}

let saveTimer = null;
function saveBounds() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    fs.writeFile(boundsFile(), JSON.stringify(win.getBounds()), () => {});
  }, 300);
}

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  } catch {
    return {};
  }
}
function saveSettings(patch) {
  fs.writeFileSync(settingsFile(), JSON.stringify({ ...loadSettings(), ...patch }, null, 2));
}

/** Swap the global shortcut; keeps the old one if the new one is taken. */
function setHotkey(accel) {
  const prev = hotkey;
  if (prev) globalShortcut.unregister(prev);
  let ok = false;
  try {
    ok = globalShortcut.register(accel, toggle);
  } catch {
    ok = false; // invalid accelerator
  }
  if (ok) {
    hotkey = accel;
    return true;
  }
  if (prev) globalShortcut.register(prev, toggle);
  return false;
}

function createWindow() {
  const b = loadBounds();
  win = new BrowserWindow({
    ...b,
    minWidth: 460,
    minHeight: COMPACT_HEIGHT,
    frame: false,
    transparent: false,
    backgroundColor: "#00000000",
    vibrancy: "under-window",
    visualEffectState: "active",
    roundedCorners: true,
    resizable: true,
    alwaysOnTop: true,
    fullscreenable: false,
    hasShadow: true,
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  if (b.x === undefined) win.center();
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, "bar.html"), { query: { ws: `ws://127.0.0.1:${PORT}`, port: String(PORT) } });
  // Started at login: stay in the menu bar until summoned.
  const hidden = !createdOnce && app.getLoginItemSettings().wasOpenedAtLogin;
  createdOnce = true;
  win.once("ready-to-show", () => !hidden && win.show());
  win.on("resize", saveBounds);
  win.on("move", saveBounds);
  win.on("closed", () => (win = null));
}

/** The shortcut: hide the bar if it's showing (focused or not), otherwise show and focus it. */
function toggle() {
  if (!win) return createWindow();
  if (win.isVisible()) win.hide();
  else {
    win.show();
    win.focus();
    win.webContents.send("focus-input");
  }
}

ipcMain.on("hide", () => win?.hide());
ipcMain.handle("get-browser", () => browserStateForUI());
// The user's macOS accent colour ("rrggbbaa"), so focus and primary actions match the system.
ipcMain.handle("get-accent", () => {
  try {
    return `#${systemPreferences.getAccentColor().slice(0, 6)}`;
  } catch {
    return null;
  }
});
// The ⋯ menu in the bar: secondary actions live here, not as header buttons.
ipcMain.on("app-menu", (_e, { model } = {}) => {
  const send = (action) => () => win?.webContents.send("menu-action", action);
  Menu.buildFromTemplate([
    { label: "Undo last action", click: send("undo") },
    { label: "Open control page", click: () => shell.openExternal(`http://localhost:${PORT}`) },
    { label: "Compact / expanded", click: () => ipcMain.emit("toggle-size") },
    { label: "Change shortcut…", click: send("record-hotkey") },
    { type: "separator" },
    ...(model ? [{ label: `Model: ${model}`, enabled: false }, { type: "separator" }] : []),
    { label: "Hide", accelerator: "Esc", click: () => win?.hide() },
    { label: "Quit Voice Browser", accelerator: "Command+Q", click: () => app.quit() },
  ]).popup({ window: win });
});

/** Native menu of installed browsers; choosing one asks the bar to confirm the restart. */
ipcMain.on("browser-menu", () => {
  const items = [
    { label: "Built-in Chromium", icon: menuIcon("builtin"), type: "radio", checked: browserState.id === "builtin", click: () => switchBrowser("builtin") },
    { type: "separator" },
    ...browsers.installedBrowsers().map((b) => ({
      label: b.name,
      icon: menuIcon(b.id),
      type: "radio",
      checked: browserState.id === b.id,
      click: () => askBrowserSwitch(b),
    })),
  ];
  Menu.buildFromTemplate(items).popup({ window: win });
});

function askBrowserSwitch(b) {
  const saved = loadSettings().browser;
  win?.webContents.send("browser-confirm", { id: b.id, name: b.name, ownProfile: Boolean(b.ownProfile), separate: Boolean(saved?.id === b.id && saved?.separate) });
}

// Failure screenshots open in Preview; only files the app itself wrote.
ipcMain.on("open-path", (_e, p) => {
  const allowed = path.join(require("node:os").homedir(), ".voice-browser", "failures");
  const resolved = path.resolve(String(p || ""));
  if (resolved.startsWith(allowed + path.sep)) shell.openPath(resolved);
});

let switching = false;
async function switchBrowser(id) {
  if (switching) return { ok: false, error: "Already switching browsers" };
  if (externalServer) return { ok: false, error: "Another Voice Browser server is already running on this port. Stop it (for example ./run.sh) and reopen the app." };
  switching = true;
  const progress = (msg) => sendBrowserState({ busy: msg });
  try {
    let cdpUrl = null;
    let next = { id: "builtin", name: "Built-in Chromium" };
    if (id !== "builtin") {
      const b = browsers.installedBrowsers().find((x) => x.id === id);
      if (!b) throw new Error("That browser isn't installed");
      const saved = loadSettings().browser;
      const r = await browsers.connect(b, { prev: saved?.id === id ? saved : null, allowRestart: true, onProgress: progress });
      cdpUrl = r.cdpUrl;
      next = { id: b.id, name: b.name, port: r.port, separate: r.separate };
    }
    progress("Connecting…");
    restarting = true;
    await stopServer();
    await startServer(cdpUrl);
    browserState = next;
    saveSettings({ browser: next.id === "builtin" ? { id: "builtin" } : { id: next.id, port: next.port, separate: next.separate } });
    sendBrowserState();
    return { ok: true, browser: browserState };
  } catch (err) {
    // Make sure something is running again after a failed switch.
    if (!server && !(await serverUp())) await startServer(null).catch(() => {});
    sendBrowserState({ error: String(err.message || err) });
    return { ok: false, error: String(err.message || err) };
  } finally {
    restarting = false;
    switching = false;
  }
}
ipcMain.handle("switch-browser", (_e, id) => switchBrowser(id));
ipcMain.handle("get-hotkey", () => hotkey);
// While the bar records a new shortcut, the current one must not fire (it would hide the bar).
ipcMain.on("pause-hotkey", (_e, paused) => {
  if (!hotkey) return;
  if (paused) globalShortcut.unregister(hotkey);
  else if (!globalShortcut.isRegistered(hotkey)) globalShortcut.register(hotkey, toggle);
});
ipcMain.handle("set-hotkey", (_e, accel) => {
  if (!setHotkey(accel)) return { ok: false, hotkey, error: `${accel} is already used by another app or isn't valid` };
  saveSettings({ hotkey: accel });
  refreshTray();
  return { ok: true, hotkey };
});
ipcMain.on("toggle-size", () => {
  if (!win) return;
  const [w, h] = win.getSize();
  win.setSize(w, h > COMPACT_HEIGHT + 20 ? COMPACT_HEIGHT : EXPANDED_HEIGHT, true);
});
ipcMain.on("quit", () => app.quit());
ipcMain.on("open-control-page", () => shell.openExternal(`http://localhost:${PORT}`));
ipcMain.handle("ensure-server", async () => {
  try {
    return { ok: true, ...(await ensureServer()) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

app.whenReady().then(() => {
  // Lives in the menu bar; no Dock icon.
  app.dock?.hide();
  createTray();
  warmBrowserIcons();
  createWindow();
  const wanted = loadSettings().hotkey || DEFAULT_HOTKEY;
  if (!setHotkey(wanted) && wanted !== DEFAULT_HOTKEY) setHotkey(DEFAULT_HOTKEY);
  if (!hotkey) console.warn(`Could not register ${wanted} (in use by another app)`);
  // Clicking the Dock icon always brings the bar up.
  app.on("activate", () => (win ? (win.show(), win.focus()) : createWindow()));
});

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (server) server.kill("SIGTERM"); // server closes the controlled Chromium on SIGTERM
});
