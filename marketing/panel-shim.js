// Runs the real panel (desktop/bar.html) inside the website. window.bar (the Electron shell) and the
// server connection are stand-ins; the page around it (demo.js) plays the server's side over
// postMessage: it types into the message box, receives the command, and sends back the same events
// the real server would. Injected into marketing/panel.html by build.mjs.
(() => {
  const DIA = "%dia%";
  const ICONS = { yt: "%yt%" };
  const ok = (v) => () => Promise.resolve(v);
  const noop = () => {};
  window.bar = {
    ensureServer: ok({ ok: true }), getBrowser: ok({ id: "dia", name: "Dia", icon: DIA }),
    listBrowsers: ok({ current: "dia", busy: false, list: [{ id: "dia", name: "Dia", note: "Your tabs and sign-ins", icon: DIA }] }),
    getAccent: ok("#0a84ff"), getHotkey: ok("CommandOrControl+Shift+Space"), setHotkey: ok(true), switchBrowser: ok(true), copyImage: ok(true),
    hide: noop, toggleSize: noop, browserMenu: noop, onBrowserState: noop, onBrowserConfirm: noop, openPath: noop, appMenu: noop, openUrl: noop,
    revealPath: noop, chooseBrowser: noop, onMenuAction: noop, pauseHotkey: noop, quit: noop, notify: noop, openControlPage: noop, onFocusInput: noop, onServerExit: noop,
  };
  // The panel focuses its message box a lot; on a web page that would pull focus (and scroll) away
  // from the visitor, so it never takes focus here.
  HTMLElement.prototype.focus = noop;
  try { localStorage.clear(); } catch {}

  const MODELS = {
    preferred: null, last: null, missing: [],
    models: [
      { id: "groq:openai/gpt-oss-120b", label: "GPT-OSS 120B", provider: "Groq", providerId: "groq", vision: false, fast: true, resting: null },
      { id: "groq:qwen/qwen3.8-27b", label: "Qwen 3.8 27B", provider: "Groq", providerId: "groq", vision: true, fast: true, resting: null },
      { id: "gemini:gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", provider: "Google Gemini", providerId: "gemini", vision: true, fast: false, resting: null },
    ],
  };
  const IDLE = { running: null, queued: [], side: [], paused: null, canTakeOver: false, background: false, undo: null };
  let ws = null;
  let tabs = [];
  const up = (msg) => parent.postMessage({ gofer: true, ...msg }, "*");
  class StandInSocket {
    constructor() {
      ws = this;
      this.readyState = 0;
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.();
        this.emit("hello", { model: "" });
        this.emit("queue", IDLE);
        this.emit("models", MODELS);
        this.emit("usage", { todayUsd: 0.0021, weekUsd: 0.013, calls: 14, limitUsd: null, byModel: {} });
        up({ kind: "ready" });
      }, 30);
    }
    send(raw) {
      const m = JSON.parse(raw);
      if (m.type === "tabs:list") this.emit("tab-list", tabs);
      else if (m.type === "secrets:list") this.emit("secrets", []);
      else if (m.type === "command") up({ kind: "command", id: m.id, text: m.text });
    }
    emit(type, payload) { this.onmessage?.({ data: JSON.stringify({ type, payload }) }); }
    close() {}
  }
  window.WebSocket = StandInSocket;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  addEventListener("message", async (e) => {
    const m = e.data;
    if (!m || !m.gofer) return;
    if (m.kind === "emit") ws?.emit(m.type, m.payload);
    if (m.kind === "tabs") { tabs = m.tabs.map((t) => ({ ...t, icon: ICONS[t.icon] || t.icon })); ws?.emit("tab-list", tabs); }
    if (m.kind === "type") {
      const cmd = document.getElementById("cmd");
      for (const ch of m.text) {
        cmd.textContent += ch;
        cmd.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
        if (m.ms) await sleep(m.ms);
      }
      if (m.ms) await sleep(350);
      cmd.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    }
  });
})();
