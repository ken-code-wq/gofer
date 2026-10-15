/**
 * Your own Chromium browsers as the controlled window: detect installed ones, quit one gracefully
 * (it saves its session), reopen it with --remote-debugging-port and hand back a CDP URL.
 *
 * Chrome 136+ refuses remote debugging on its default profile. When a browser ignores the flag we
 * open a separate instance with its own profile under ~/.voice-browser/profiles/<id> instead, and
 * remember that for next time (no restart of your main window needed then).
 */
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

// ownProfile: Chrome 136+ (and Edge) never allow remote control of the main profile, so these open
// a separate instance straight away instead of pointlessly restarting your main window.
const KNOWN = [
  { id: "chrome", name: "Google Chrome", app: "Google Chrome.app", ownProfile: true },
  { id: "chrome-beta", name: "Google Chrome Beta", app: "Google Chrome Beta.app", ownProfile: true },
  { id: "chrome-canary", name: "Google Chrome Canary", app: "Google Chrome Canary.app", ownProfile: true },
  { id: "arc", name: "Arc", app: "Arc.app" },
  { id: "dia", name: "Dia", app: "Dia.app" },
  { id: "brave", name: "Brave", app: "Brave Browser.app" },
  { id: "edge", name: "Microsoft Edge", app: "Microsoft Edge.app", ownProfile: true },
  { id: "vivaldi", name: "Vivaldi", app: "Vivaldi.app" },
  { id: "opera", name: "Opera", app: "Opera.app" },
  { id: "comet", name: "Comet", app: "Comet.app" },
  { id: "chromium", name: "Chromium", app: "Chromium.app" },
];

const PROFILE_ROOT = path.join(os.homedir(), ".voice-browser", "profiles");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// `open` passes our environment on; never leak Electron's run-as-node switch into a browser.
const cleanEnv = () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
};

function run(cmd, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, env: cleanEnv() }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) }));
  });
}

function installedBrowsers() {
  if (process.platform !== "darwin") return []; // attaching to Dia/Arc/Chrome is macOS-only for now
  const dirs = ["/Applications", path.join(os.homedir(), "Applications")];
  const out = [];
  for (const b of KNOWN) {
    const dir = dirs.find((d) => fs.existsSync(path.join(d, b.app)));
    if (dir) out.push({ ...b, path: path.join(dir, b.app) });
  }
  return out;
}

/** PIDs of the browser's main process (helpers live under Contents/Frameworks, not MacOS). */
async function mainPids(b) {
  const r = await run("pgrep", ["-f", `^${b.path.replace(/[.+]/g, "\\$&")}/Contents/MacOS/`]);
  return r.stdout.split("\n").map(Number).filter(Boolean);
}

async function isRunning(b) {
  return (await mainPids(b)).length > 0;
}

async function waitFor(fn, ms, every = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(every);
  }
  return false;
}

/** Graceful quit (AppleScript, like ⌘Q, so the session is saved); SIGTERM if that is refused. */
async function quit(b) {
  if (!(await isRunning(b))) return;
  await run("osascript", ["-e", `tell application "${b.path}" to quit`], 8000);
  if (await waitFor(async () => !(await isRunning(b)), 12000)) return;
  for (const pid of await mainPids(b)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  if (!(await waitFor(async () => !(await isRunning(b)), 8000))) throw new Error(`${b.name} didn't quit. Close it yourself and try again.`);
}

function launch(b, args, { newInstance = false } = {}) {
  const child = spawn("open", [...(newInstance ? ["-n"] : []), "-a", b.path, "--args", ...args], { env: cleanEnv(), stdio: "ignore", detached: true });
  child.unref();
}

async function debugReady(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

function portTaken(port, host) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
    s.setTimeout(400, () => (s.destroy(), resolve(false)));
  });
}

/** A port nothing listens on, on IPv4 or IPv6 (a busy 127.0.0.1 makes Chrome bind ::1 only). */
async function freePort(start = 9333) {
  for (let p = start; p < start + 50; p++) {
    if (!(await portTaken(p, "127.0.0.1")) && !(await portTaken(p, "::1"))) return p;
  }
  throw new Error("No free port for remote debugging");
}

/**
 * Connect to browser `b`. `prev` is what we remembered last time ({ port, separate }).
 * `allowRestart`: may quit a running instance (only when the user chose this explicitly).
 * Resolves { cdpUrl, port, separate } or throws.
 */
async function connect(b, { prev = null, allowRestart = false, onProgress = () => {} } = {}) {
  if (prev?.port && (await debugReady(prev.port))) return { cdpUrl: `http://127.0.0.1:${prev.port}`, port: prev.port, separate: Boolean(prev.separate) };

  const port = await freePort();
  const profileDir = path.join(PROFILE_ROOT, b.id);
  const startSeparate = async () => {
    fs.mkdirSync(profileDir, { recursive: true });
    onProgress(`Opening ${b.name} with a separate Voice Browser profile…`);
    launch(b, [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check"], { newInstance: true });
    if (!(await waitFor(() => debugReady(port), 15000, 400))) throw new Error(`${b.name} didn't accept remote control`);
    return { cdpUrl: `http://127.0.0.1:${port}`, port, separate: true };
  };

  if (prev?.separate || b.ownProfile) return startSeparate();

  if (await isRunning(b)) {
    if (!allowRestart) throw new Error(`${b.name} is open without remote control. Pick it again in the browser menu to restart it.`);
    onProgress(`Quitting ${b.name}…`);
    await quit(b);
    await sleep(600);
  }
  onProgress(`Starting ${b.name} with remote control…`);
  launch(b, [`--remote-debugging-port=${port}`]);
  if (await waitFor(() => debugReady(port), 12000, 400)) return { cdpUrl: `http://127.0.0.1:${port}`, port, separate: false };

  // The browser is up but ignored the flag on its main profile (Chrome 136+ policy).
  onProgress(`${b.name} blocks remote control of your main profile…`);
  return startSeparate();
}

module.exports = { installedBrowsers, connect, isRunning };
