/**
 * Desktop command bar for voice-browser: a small always-on-top window that sends typed
 * commands to the voice-browser server over the same WebSocket the control page uses.
 *
 * Starts the server itself (reading ../.env) unless one is already running on the port.
 * A global shortcut (default Cmd/Ctrl+Shift+Space, changeable in the bar) shows/focuses it; Esc hides it.
 */
const { app, BrowserWindow, Menu, Tray, nativeImage, globalShortcut, ipcMain, shell, systemPreferences, Notification, clipboard } = require("electron");
const browsers = require("./browsers.cjs");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// The project folder (server + .env). Installed apps carry a root.json pointing at it;
// packaged builds carry the server in resources/server and keep .env in ~/.voice-browser.
function projectRoot() {
  if (app.isPackaged && fs.existsSync(path.join(process.resourcesPath, "server", "src", "server.js"))) {
    return path.join(process.resourcesPath, "server");
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "root.json"), "utf8")).root;
  } catch {
    return path.resolve(__dirname, "..");
  }
}
const ROOT = projectRoot();
const PACKAGED = ROOT === path.join(process.resourcesPath || "", "server");
const DATA_DIR = path.join(require("node:os").homedir(), ".voice-browser");
const ENV_FILE = PACKAGED ? path.join(DATA_DIR, ".env") : path.join(ROOT, ".env");
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
    attachedApp = b.path;
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

let crashes = 0;
let attachedApp = null; // the attached browser's .app, so the server can ask it which tab is showing
let quitting = false;
/** Server output goes to ~/.voice-browser/server.log (kept small) so crashes can be diagnosed. */
function serverLog() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, "server.log");
  try {
    if (fs.statSync(file).size > 2_000_000) fs.renameSync(file, file + ".1");
  } catch {}
  const s = fs.createWriteStream(file, { flags: "a" });
  s.write(`\n[${new Date().toISOString()}] starting server\n`);
  return s;
}

async function startServer(cdpUrl = null) {
  const env = { ...process.env, ...readEnv(ENV_FILE), ELECTRON_RUN_AS_NODE: "1", PORT: String(PORT) };
  env.VB_ENV_FILE = ENV_FILE; // keys added from the panel are written here
  env.CDP_URL = cdpUrl || ""; // overrides .env: the bar's browser menu is the source of truth
  env.VB_BROWSER_APP = cdpUrl && attachedApp ? attachedApp : "";
  if (PACKAGED) {
    // The app bundle is read-only: the browser profile and Chromium download live in ~/.voice-browser.
    env.BROWSER_PROFILE_DIR ||= path.join(DATA_DIR, "browser-profile");
    env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(DATA_DIR, "chromium");
  }
  if (!env.SUBQ_API_KEY && !env.TYPESAFE_API_KEY && !env.JEV_API_KEY) {
    if (PACKAGED && !fs.existsSync(ENV_FILE)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(ENV_FILE, "# Voice Browser keys. Fill these in, then reopen the app.\nSUBQ_API_KEY=\nGEMINI_API_KEY=\n");
    }
    throw new Error(`No API key. Add SUBQ_API_KEY to ${ENV_FILE}`);
  }
  if (PACKAGED && !cdpUrl) await ensureChromium(env);
  // Electron's own binary runs as plain Node here, so no separate Node install is needed.
  server = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  const log = serverLog();
  server.stdout.on("data", (d) => (process.stdout.write(d), log.write(d)));
  server.stderr.on("data", (d) => {
    stderr += d;
    process.stderr.write(d);
    log.write(d);
  });
  const child = server;
  const startedAt = Date.now();
  child.on("exit", (code, signal) => {
    log.write(`\n[${new Date().toISOString()}] server exited (code ${code}, signal ${signal})\n`);
    log.end();
    if (server === child) server = null;
    if (restarting || quitting) return;
    // Unexpected exit: start it again on the same browser, unless it keeps dying right away.
    crashes = Date.now() - startedAt < 60000 ? crashes + 1 : 0;
    if (crashes >= 3) return win?.webContents.send("server-exit", { code, stderr: stderr.slice(-400) });
    setTimeout(() => startServer(cdpUrl).catch(() => {}), 1000 * crashes);
  });
  // Attaching to a browser with many tabs (Dia, Arc) can take a while: allow up to 2 minutes.
  for (let i = 0; i < 480; i++) {
    if (await serverUp()) return { started: true };
    if (!server) throw new Error(`Server exited: ${stderr.slice(-300) || "unknown error"}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("The browser service is taking longer than usual to start. It keeps trying in the background.");
}

/** Packaged builds download Playwright's Chromium on first use (about 150 MB). */
async function ensureChromium(env) {
  const dir = env.PLAYWRIGHT_BROWSERS_PATH;
  if (fs.existsSync(dir) && fs.readdirSync(dir).some((d) => d.startsWith("chromium"))) return;
  sendBrowserState({ busy: "Downloading Chromium (first run only)…" });
  const cli = path.join(ROOT, "node_modules", "playwright", "cli.js");
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [cli, "install", "chromium"], { cwd: ROOT, env, stdio: "inherit" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("Couldn't download Chromium. Check your connection and reopen the app."))));
  });
  sendBrowserState();
}

// Window size/position persist between launches. "compact" = prompt only, "expanded" = with activity.
const COMPACT_HEIGHT = 128;
const EXPANDED_HEIGHT = 660;
const boundsFile = () => path.join(app.getPath("userData"), "window-chat.json");

function loadBounds() {
  try {
    return JSON.parse(fs.readFileSync(boundsFile(), "utf8"));
  } catch {
    return { width: 440, height: EXPANDED_HEIGHT };
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

// macOS 26+: the panel sits on Apple's Liquid Glass (NSGlassEffectView). Older systems keep the blur.
let liquidGlass = null;
function glassSupported() {
  if (process.platform !== "darwin" || process.env.VB_NO_GLASS) return false;
  try {
    liquidGlass ??= require("electron-liquid-glass");
    return liquidGlass.isGlassSupported();
  } catch (err) {
    console.warn(`Liquid Glass unavailable: ${err.message}`);
    return false;
  }
}

/**
 * The panel records voice requests: grant microphone access (audio only, nothing else) to our own
 * bar.html, and let macOS ask the user the first time.
 */
let micAllowed = false;
function allowMicrophone(ses) {
  if (micAllowed) return;
  micAllowed = true;
  const ours = (url) => String(url || "").startsWith("file://") && String(url).includes("bar.html");
  const audioOnly = (details) => {
    const types = details?.mediaTypes || [];
    return types.length > 0 && types.every((t) => t === "audio");
  };
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission !== "media" || !ours(details?.requestingUrl || wc.getURL()) || !audioOnly(details)) return callback(false);
    if (process.platform !== "darwin") return callback(true);
    systemPreferences.askForMediaAccess("microphone").then(callback, () => callback(false));
  });
  ses.setPermissionCheckHandler((wc, permission, origin, details) => {
    if (permission !== "media") return false;
    return (details?.mediaType === "audio" || details?.mediaType === undefined) && ours(wc?.getURL() || details?.requestingUrl || origin);
  });
}

function createWindow() {
  const b = loadBounds();
  const glass = glassSupported();
  win = new BrowserWindow({
    ...b,
    minWidth: 360,
    minHeight: COMPACT_HEIGHT,
    frame: false,
    transparent: glass, // the glass view sits behind the page, so the page must be see-through
    backgroundColor: "#00000000",
    ...(glass ? {} : { vibrancy: "under-window", visualEffectState: "active" }),
    roundedCorners: true,
    resizable: true,
    alwaysOnTop: true,
    fullscreenable: false,
    hasShadow: true,
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  allowMicrophone(win.webContents.session);
  if (b.x === undefined) win.center();
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, "bar.html"), { query: { ws: `ws://127.0.0.1:${PORT}`, port: String(PORT), glass: glass ? "1" : "" } });
  if (glass) {
    win.webContents.once("did-finish-load", () => {
      try {
        liquidGlass.addView(win.getNativeWindowHandle(), { cornerRadius: 22 });
      } catch (err) {
        console.warn(`Liquid Glass failed: ${err.message}`);
      }
    });
  }
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
    { label: "New chat", accelerator: "Command+N", click: send("new-chat") },
    { label: "Past chats", accelerator: "Command+4", click: send("view-chats") },
    { label: "Saved commands", accelerator: "Command+2", click: send("view-saved") },
    { label: "Passwords", accelerator: "Command+3", click: send("view-secrets") },
    { label: "AI models…", click: send("models") },
    { type: "separator" },
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

ipcMain.on("open-url", (_e, url) => {
  if (/^https:\/\/[\w.-]+\//.test(String(url))) shell.openExternal(String(url));
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

// Screenshots and exports open in Preview; only files the app itself wrote (failure shots in
// ~/.voice-browser, "Voice Browser …" files in Downloads).
function ownFile(p) {
  const home = require("node:os").homedir();
  const resolved = path.resolve(String(p || ""));
  const inData = resolved.startsWith(path.join(home, ".voice-browser") + path.sep);
  const inDownloads = path.dirname(resolved) === path.join(home, "Downloads") && path.basename(resolved).startsWith("Voice Browser ");
  return (inData || inDownloads) && fs.existsSync(resolved) ? resolved : null;
}
ipcMain.on("open-path", (_e, p) => {
  const f = ownFile(p);
  if (f) shell.openPath(f);
});
ipcMain.on("reveal-path", (_e, p) => {
  const f = ownFile(p);
  if (f) shell.showItemInFolder(f);
});
ipcMain.handle("copy-image", (_e, p) => {
  const f = ownFile(p);
  const img = f && nativeImage.createFromPath(f);
  if (!img || img.isEmpty()) return false;
  clipboard.writeImage(img);
  return true;
});

// The browser picker in the panel: every browser with its own app icon.
ipcMain.handle("list-browsers", async () => {
  const icon = async (p) => (await appIcon(p).catch(() => null))?.resize({ width: 48, height: 48 }).toDataURL() || null;
  const saved = loadSettings().browser;
  const list = [{ id: "builtin", name: "Built-in Chromium", note: "Its own window and profile", icon: await icon(browserAppPath("builtin")) }];
  for (const b of browsers.installedBrowsers()) {
    list.push({ id: b.id, name: b.name, note: b.ownProfile || (saved?.id === b.id && saved?.separate) ? "Uses a separate profile" : "Your tabs and sign-ins", icon: await icon(b.path) });
  }
  return { current: browserState.id, busy: switching, list };
});
ipcMain.on("choose-browser", (_e, id) => {
  if (id === browserState.id) return;
  if (id === "builtin") return switchBrowser("builtin");
  const b = browsers.installedBrowsers().find((x) => x.id === id);
  if (b) askBrowserSwitch(b);
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
      attachedApp = b.path;
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
// Finished work while the bar was in the background: a notification that reopens the bar.
ipcMain.on("notify", (_e, { title, body } = {}) => {
  if (!Notification.isSupported() || (win?.isVisible() && win.isFocused())) return;
  const n = new Notification({ title: String(title || "Voice Browser").slice(0, 120), body: String(body || "").slice(0, 240) });
  n.on("click", () => { win?.show(); win?.focus(); });
  n.show();
});
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
  quitting = true;
  globalShortcut.unregisterAll();
  if (server) server.kill("SIGTERM"); // server closes the controlled Chromium on SIGTERM
});
