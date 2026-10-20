#!/usr/bin/env node
/**
 * The README screenshots: the real panel (desktop/bar.html) in headless Chromium, talking to a
 * scripted stand-in for the server. No browser is driven and no model is called, so the shots
 * are the same every time and cost nothing.
 *
 *   node scripts/readme-shots.mjs            # writes docs/images/*.png
 *
 * macOS only: browser icons come from /Applications, site icons are fetched once with curl.
 * Liquid Glass is the window's own material, so it isn't in these shots (the panel's solid look).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "docs", "images");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vb-shots-"));

// ── icons ────────────────────────────────────────────────
function appIcon(app, px = 64) {
  try {
    const dir = `/Applications/${app}.app/Contents`;
    let file = execFileSync("/usr/bin/defaults", ["read", `${dir}/Info`, "CFBundleIconFile"], { encoding: "utf8" }).trim();
    if (!file.endsWith(".icns")) file += ".icns";
    const png = path.join(tmp, `${app}.png`);
    execFileSync("/usr/bin/sips", ["-s", "format", "png", "-Z", String(px), `${dir}/Resources/${file}`, "--out", png], { stdio: "ignore" });
    return `data:image/png;base64,${fs.readFileSync(png).toString("base64")}`;
  } catch {
    return null;
  }
}
function favicon(domain) {
  try {
    const buf = execFileSync("/usr/bin/curl", ["-sfL", "--max-time", "8", `https://www.google.com/s2/favicons?domain=${domain}&sz=64`]);
    return buf.length > 100 ? `data:image/png;base64,${buf.toString("base64")}` : null;
  } catch {
    return null;
  }
}

const ICONS = {
  youtube: favicon("youtube.com"),
  kayak: favicon("kayak.com"),
  google: favicon("google.com"),
  wiki: favicon("wikipedia.org"),
  github: favicon("github.com"),
};
const BROWSERS = [
  { id: "builtin", name: "Built-in Chromium", note: "Its own window and profile", icon: appIcon("Google Chrome") },
  { id: "dia", name: "Dia", note: "Your tabs and sign-ins", icon: appIcon("Dia") },
  { id: "arc", name: "Arc", note: "Your tabs and sign-ins", icon: appIcon("Arc") },
  { id: "chrome", name: "Google Chrome", note: "Uses a separate profile", icon: appIcon("Google Chrome") },
];

// ── the stand-in server ──────────────────────────────────
const TABS = [
  { title: "When You Believe - The Prince of Egypt", url: "https://www.youtube.com/watch?v=LKaXY4IdZ40", icon: ICONS.youtube, active: true, shown: true },
  { title: "Flights to Lisbon · KAYAK", url: "https://www.kayak.com/flights/LON-LIS/2026-11-14", icon: ICONS.kayak },
  { title: "Lisbon flights - Google Flights", url: "https://www.google.com/travel/flights", icon: ICONS.google },
  { title: "The Prince of Egypt - Wikipedia", url: "https://en.wikipedia.org/wiki/The_Prince_of_Egypt", icon: ICONS.wiki },
  { title: "ken-code-wq/voice-browser", url: "https://github.com/ken-code-wq/voice-browser", icon: ICONS.github },
].map((t, index) => ({ index, active: false, shown: false, ...t }));

const MODELS = {
  preferred: null,
  last: null,
  models: [
    { id: "groq:openai/gpt-oss-120b", label: "GPT-OSS 120B", provider: "Groq", providerId: "groq", vision: false, fast: true, resting: null },
    { id: "groq:qwen/qwen3.8-27b", label: "Qwen 3.8 27B", provider: "Groq", providerId: "groq", vision: true, fast: true, resting: null },
    { id: "groq:openai/gpt-oss-20b", label: "GPT-OSS 20B", provider: "Groq", providerId: "groq", vision: false, fast: true, resting: null },
    { id: "gemini:gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", provider: "Google Gemini", providerId: "gemini", vision: true, fast: false, resting: null },
    { id: "zai:glm-5.3-flash", label: "GLM 5.3 Flash", provider: "Z.ai", providerId: "zai", vision: true, fast: false, resting: null },
  ],
  missing: [
    { name: "deepseek", label: "DeepSeek", env: "DEEPSEEK_API_KEY", keyUrl: "https://platform.deepseek.com/api_keys" },
    { name: "openrouter", label: "OpenRouter", env: "OPENROUTER_API_KEY", keyUrl: "https://openrouter.ai/keys" },
  ],
};
const USAGE = { todayUsd: 0.0021, weekUsd: 0.013, calls: 14, limitUsd: null, byModel: {} };
const idle = { running: null, queued: [], side: [], paused: null, canTakeOver: false, background: false, undo: null };
const G = ["groq:openai/gpt-oss-120b", "groq:qwen/qwen3.8-27b"];

const step = (text, status = "ok", detail) => ({ text, status, ...(detail ? { detail } : {}) });
/** text -> [[wait ms, type, payload]] played back when the panel sends that message */
const SCRIPTS = {
  "open youtube and play a prince of egypt song": [
    [300, "goal", { status: "running", steps: [step("Open youtube.com", "running")] }],
    [500, "goal", { status: "running", steps: [step("Open youtube.com", "ok", "youtube.com"), step("Search for “prince of egypt song”", "running")] }],
    [500, "goal", {
      status: "done", models: G,
      steps: [step("Open youtube.com", "ok", "youtube.com"), step("Search for “prince of egypt song”"), step("Click “When You Believe (From The Prince of Egypt)”"), step("Play the video", "ok", "Playing · 0:03 of 4:52")],
      summary: "I opened YouTube and played “When You Believe” by Whitney Houston and Mariah Carey.",
    }],
  ],
  "no, another one": [
    [300, "goal", { status: "running", steps: [step("Search for “prince of egypt song”", "running")] }],
    [600, "goal", {
      status: "done", models: G,
      steps: [step("Search for “prince of egypt song”"), step("Click “Deliver Us (From The Prince of Egypt)”"), step("Play the video", "ok", "Playing · 0:01 of 5:01")],
      summary: "Now playing “Deliver Us”, the opening song. I skipped “When You Believe” since you just heard it.",
    }],
  ],
  "what is this song about?": [
    [700, "answer", {
      answer: "It's the film's opening number. The Hebrew slaves in Egypt sing about their hard labour and pray to be delivered, and Moses's mother, Yochabel, sets him adrift on the Nile in a basket, hoping he'll be spared.",
      source: "page", cite: "From the video's transcript, 0:40 to 2:15", link: "https://www.youtube.com/watch?v=0bb5dvcvoqk&t=40s",
      model: "GPT-OSS 120B",
    }],
  ],
  "@[Flights to Lisbon · KAYAK] @[Lisbon flights - Google Flights] which is cheaper for the 14th?": [
    [800, "table", {
      scope: "compare", total: 3, model: "GPT-OSS 120B",
      columns: ["", "KAYAK", "Google Flights"],
      rows: [["Cheapest", "£48 · easyJet", "£52 · TAP"], ["Departs", "06:10 LGW", "07:25 LHR"], ["Nonstop", "Yes · 2h 45m", "Yes · 2h 40m"]],
      detail: "KAYAK is £4 cheaper: £48 on easyJet from Gatwick at 06:10. Google Flights' cheapest is £52 on TAP from Heathrow at 07:25.",
    }],
  ],
  "clear out my inbox's newsletters older than a month": [
    [300, "goal", { status: "running", steps: [step("Open mail.google.com", "ok", "mail.google.com"), step("Search for “category:promotions older_than:30d”", "ok", "212 conversations")] }],
    [200, "goal", { status: "awaiting", steps: [step("Open mail.google.com", "ok", "mail.google.com"), step("Search for “category:promotions older_than:30d”", "ok", "212 conversations"), step("Select all 212 conversations"), step("Delete them", "awaiting")] }],
    [100, "goal-confirm", { description: "delete 212 promotional emails older than 30 days" }],
  ],
};

const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
const port = await new Promise((r) => wss.on("listening", () => r(wss.address().port)));
wss.on("connection", (ws) => {
  const send = (type, payload) => ws.readyState === 1 && ws.send(JSON.stringify({ type, payload }));
  send("hello", { model: "" });
  send("queue", idle);
  send("usage", USAGE);
  send("models", MODELS);
  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === "tabs:list") send("tab-list", TABS);
    if (msg.type === "secrets:list") send("secrets", []);
    if (msg.type !== "command") return;
    const plain = (t) => t.replace(/@\[[^\]]+\]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    const script = Object.entries(SCRIPTS).find(([k]) => plain(k) === plain(msg.text))?.[1];
    if (!script) return console.warn(`no script for: ${msg.text}`);
    send("queue", { ...idle, running: { id: msg.id, text: msg.text }, canTakeOver: true });
    for (const [ms, type, payload] of script) {
      await sleep(ms);
      send(type, type === "goal" ? { goal: msg.text, ...payload } : payload);
    }
    if (!script.some(([, t]) => t === "goal-confirm")) send("queue", idle); // a confirm leaves the task running
  });
});

// ── the panel ────────────────────────────────────────────
const browser = await chromium.launch();
const W = 440;

async function panel(scheme, H = 660) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, colorScheme: scheme });
  await ctx.addInitScript(({ browsers }) => {
    const dia = browsers.find((b) => b.id === "dia");
    const ok = (v) => () => Promise.resolve(v);
    const noop = () => {};
    window.bar = {
      ensureServer: ok({ ok: true }), getBrowser: ok({ id: "dia", name: "Dia", icon: dia.icon }), listBrowsers: ok({ current: "dia", busy: false, list: browsers }),
      getAccent: ok("#0a84ff"), getHotkey: ok("CommandOrControl+Shift+Space"), setHotkey: ok(true), switchBrowser: ok(true), copyImage: ok(true),
      hide: noop, toggleSize: noop, browserMenu: noop, onBrowserState: noop, onBrowserConfirm: noop, openPath: noop, appMenu: noop, openUrl: noop,
      revealPath: noop, chooseBrowser: noop, onMenuAction: noop, pauseHotkey: noop, quit: noop, notify: noop, openControlPage: noop, onFocusInput: noop, onServerExit: noop,
    };
  }, { browsers: BROWSERS });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.warn("panel error:", e.message));
  await page.goto(`${pathToFileURL(path.join(root, "desktop", "bar.html")).href}?ws=ws://127.0.0.1:${port}`);
  // the window's rounded corners
  await page.addStyleTag({ content: "html { border-radius: 14px; } *, *::before, *::after { caret-color: transparent !important; }" });
  await page.waitForFunction(() => !document.getElementById("cmd").getAttribute("contenteditable") || document.getElementById("cmd").isContentEditable);
  await sleep(600);
  return { page, ctx };
}

const QUERY = { "Lisbon flights - Google Flights": "google" }; // what to type after @ to find that tab

/** Type a message the way a person would, picking "@[Tab]" mentions from the @ list, and wait for the reply. */
async function say(page, text, wait = 2200) {
  await page.click("#cmd");
  for (const part of text.split(/(@\[[^\]]+\])/).filter(Boolean)) {
    const tab = part.match(/^@\[(.+)\]$/);
    if (!tab) { await page.keyboard.type(part, { delay: 2 }); continue; }
    await page.keyboard.type(`@${QUERY[tab[1]] || tab[1].split(" ")[0]}`, { delay: 20 });
    await sleep(250);
    await page.keyboard.press("Enter");
    await sleep(150);
  }
  await page.keyboard.press("Enter");
  await sleep(wait);
}

async function shot(page, name) {
  await page.mouse.move(W - 4, 4);
  await sleep(250);
  await page.screenshot({ path: path.join(out, name), omitBackground: true });
  console.log("wrote", path.relative(root, path.join(out, name)));
}

fs.mkdirSync(out, { recursive: true });
for (const scheme of ["dark", "light"]) {
  const { page, ctx } = await panel(scheme);
  await say(page, "open youtube and play a prince of egypt song");
  await say(page, "no, another one");
  await say(page, "what is this song about?");
  await shot(page, `chat-${scheme}.png`);
  if (scheme === "dark") {
    await page.click("#model");
    await sleep(400);
    await shot(page, "model-picker.png");
    await page.keyboard.press("Escape");
    await page.click("#browser");
    await sleep(400);
    await shot(page, "browser-picker.png");
    await page.keyboard.press("Escape");
  }
  await ctx.close();
}

{
  const { page, ctx } = await panel("dark");
  await page.click("#cmd");
  await page.keyboard.type("@", { delay: 2 });
  await sleep(500);
  await shot(page, "tab-picker.png");
  await ctx.close();
}
{
  const { page, ctx } = await panel("dark", 470);
  await say(page, "@[Flights to Lisbon · KAYAK] @[Lisbon flights - Google Flights] which is cheaper for the 14th?", 1600);
  await shot(page, "compare-tabs.png");
  await ctx.close();
}
{
  const { page, ctx } = await panel("dark", 480);
  await say(page, "clear out my inbox's newsletters older than a month", 1200);
  await shot(page, "allow.png");
  await ctx.close();
}

await browser.close();
wss.close();
fs.rmSync(tmp, { recursive: true, force: true });
