/**
 * Node server: serves the control page, bridges WebSocket <-> Controller, owns the API key.
 *
 *   node src/server.js [--port 8787] [--host 127.0.0.1] [--headless] [--cdp ws://127.0.0.1:9222/devtools/browser/...] [--start-url https://...]
 */
import { usageEvents, summary as usageSummary, setLimit } from "./usage.js";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { BrowserManager } from "./browser.js";
import { Controller } from "./controller.js";
import { hasApiKey } from "./jev.js";
import { MODEL, PROVIDER, QUESTIONS, T } from "./constants.js";
import { listCommands, saveCommand, deleteCommand } from "./store.js";
import { listSecrets, setSecret, deleteSecret } from "./secrets.js";
import { deleteChat } from "./memory.js";
import { listModels, setPreferred, PROVIDERS } from "./brain.js";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Set KEY=value in the .env the app reads (replacing an existing line), so a key added in the panel survives restarts. */
function saveEnvKey(name, value) {
  const file = process.env.VB_ENV_FILE || path.join(__dirname, "..", ".env");
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : [];
  const at = lines.findIndex((l) => new RegExp(`^\\s*#?\\s*${name}\\s*=`).test(l));
  if (at >= 0) lines[at] = `${name}=${value}`;
  else lines.push(`${name}=${value}`);
  fs.writeFileSync(file, lines.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
}

export function parseArgs(argv) {
  const out = {
    port: Number(process.env.PORT) || 8787,
    // Bind to loopback only by default: anyone who can reach this port can drive the browser
    // and spend your API credits. Use --host 0.0.0.0 deliberately if you need LAN access.
    host: process.env.HOST || "127.0.0.1",
    headless: false,
    cdp: process.env.CDP_URL || null, // attach to your own Chrome instead of launching Chromium
    startUrl: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--headless") out.headless = true;
    else if (a === "--cdp") out.cdp = argv[++i];
    else if (a === "--start-url") out.startUrl = argv[++i];
  }
  // Don't navigate away from whatever tab is open in an attached browser unless asked to.
  out.startUrl ??= out.cdp ? null : "https://example.com/";
  return out;
}

export async function startServer(opts = {}) {
  if (!hasApiKey()) {
    console.error("Missing SUBQ_API_KEY or TYPESAFE_API_KEY. Use ./run.sh or export it first.");
    process.exit(1);
  }
  const browser = new BrowserManager();
  await browser.launch({ headless: opts.headless, cdp: opts.cdp, startUrl: opts.startUrl });
  const controller = new Controller({ browser });
  await controller.start();

  const app = express();
  app.use(express.static(path.join(__dirname, "public")));
  app.get("/api/state", (_req, res) => res.json(controller.uiState()));
  app.get("/api/questions", (_req, res) => res.json({ model: MODEL, thresholds: T, questions: QUESTIONS }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  const broadcast = (type, payload) => {
    const msg = JSON.stringify({ type, payload });
    for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
  };

  controller.on("transcript", (p) => broadcast("transcript", p));
  controller.on("decision", (p) => broadcast("decision", p));
  controller.on("action", (p) => broadcast("action", { ...p, ui: controller.uiState() }));
  controller.on("snapshot", () => broadcast("snapshot", controller.uiState().snapshot));
  controller.on("log", (p) => broadcast("log", p));
  controller.on("candidates", (p) => broadcast("candidates", p));
  controller.on("pending", (p) => broadcast("pending", p));
  controller.on("tabs", (p) => broadcast("tabs", p));
  // Keep every bar's "@" list warm: push it whenever tabs open, close or navigate.
  let tabTimer = null;
  // At most one tab-list every 300 ms, and never starved by a stream of changes.
  const pushTabs = () => {
    if (tabTimer) return;
    tabTimer = setTimeout(async () => {
      tabTimer = null;
      broadcast("tab-list", await browser.tabList({ onIcons: pushTabs }).catch(() => []));
    }, 300);
  };
  controller.on("tabs", pushTabs);
  usageEvents.on("change", (u) => broadcast("usage", u));
  controller.on("chain", (p) => broadcast("chain", p));
  controller.on("gaveup", (p) => broadcast("gaveup", p));
  controller.on("expanded", (p) => broadcast("expanded", p));
  for (const ev of ["goal", "goal-confirm", "answer", "utility", "table", "fill", "smart-error", "tab-switched", "tab-error", "resolved", "stopped"]) controller.on(ev, (p) => broadcast(ev, p));

  wss.on("connection", (ws) => {
    const reply = (type, payload) => ws.readyState === 1 && ws.send(JSON.stringify({ type, payload }));
    ws.send(JSON.stringify({ type: "hello", payload: controller.uiState() }));
    reply("commands", listCommands());
    reply("usage", usageSummary());
    reply("models", listModels());
    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (msg.type) {
        case "transcript":
          controller.handleTranscript({ text: msg.text, final: Boolean(msg.final), utteranceId: msg.utteranceId });
          break;
        case "command":
          controller.handleCommand(msg.text, { thread: msg.thread, followUp: Boolean(msg.followUp), ask: Boolean(msg.ask), chat: Boolean(msg.chat) });
          break;
        case "models:list":
          reply("models", listModels());
          break;
        case "models:pick":
          setPreferred(String(msg.id || "auto"));
          broadcast("models", listModels());
          break;
        case "provider:key": {
          const prov = PROVIDERS[String(msg.provider || "")];
          const key = String(msg.key || "").trim();
          if (!prov || !/^[\x21-\x7e]{8,300}$/.test(key)) {
            reply("store-error", "That doesn't look like an API key.");
            break;
          }
          try {
            saveEnvKey(prov.env, key);
            process.env[prov.env] = key;
            broadcast("models", listModels());
          } catch (err) {
            reply("store-error", `Couldn't save the key: ${err.message}`);
          }
          break;
        }
        case "chat:delete":
          controller.threads.delete(String(msg.thread || ""));
          deleteChat(String(msg.thread || ""));
          break;
        case "tab:select":
          await controller.selectTab(Number(msg.index)).catch(() => {});
          break;
        case "tabs:list":
          // the bar just opened: show the tab you were on in the browser
          if (msg.sync) await controller.browser.syncActive().catch(() => {});
          reply("tab-list", await controller.browser.tabList({ onIcons: pushTabs }).catch(() => []));
          break;
        case "stop":
          controller.stop();
          break;
        case "goal:answer":
          controller.goalAnswer(Boolean(msg.ok), Boolean(msg.all));
          break;
        case "undo":
          controller.undo();
          break;
        case "snapshot":
          controller.refreshSnapshot();
          break;
        // Saved commands: shared by every connected window.
        case "commands:save":
          try {
            broadcast("commands", saveCommand(msg.name, msg.text, msg.recipe));
          } catch (err) {
            reply("store-error", String(err.message || err));
          }
          break;
        case "commands:delete":
          broadcast("commands", deleteCommand(msg.name));
          break;
        // Keychain secrets: names go out, values only come in.
        case "secrets:list":
          reply("secrets", await listSecrets());
          break;
        case "secrets:set":
          try {
            await setSecret(msg.name, msg.value);
            broadcast("secrets", await listSecrets());
          } catch (err) {
            reply("store-error", String(err.message || err));
          }
          break;
        case "secrets:delete":
          await deleteSecret(msg.name);
          broadcast("secrets", await listSecrets());
          break;
        case "usage:limit":
          reply("usage", setLimit(msg.usd));
          break;
        case "state":
          ws.send(JSON.stringify({ type: "hello", payload: controller.uiState() }));
          break;
        default:
          break;
      }
    });
  });

  const host = opts.host || "127.0.0.1";
  await new Promise((resolve) => server.listen(opts.port, host, resolve));
  const url = `http://localhost:${opts.port}`;
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.warn(`WARNING: listening on ${host}. Anyone who can reach this port can control the browser and spend API credits.`);
  }
  console.log(`\nvoice-browser ready → open ${url} in Chrome (mic needs Chrome/Edge)`);
  console.log(`${PROVIDER.name} · model ${MODEL} · controlled window: ${opts.cdp ? "attached via CDP" : opts.headless ? "headless" : "headed Chromium"}\n`);

  const shutdown = async () => {
    await controller.close();
    await browser.close();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // A closed tab or a dropped browser connection can reject a stray promise; log it, keep serving.
  process.on("unhandledRejection", (err) => console.error("unhandled rejection:", err?.stack || err));
  process.on("uncaughtException", (err) => console.error("uncaught exception:", err?.stack || err));
  return { app, server, controller, browser, url };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
