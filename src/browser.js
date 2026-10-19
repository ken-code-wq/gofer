/**
 * Browser management: launch a headed Playwright Chromium with a persistent profile
 * (so it feels like "your browser"), or attach to a running Chrome via --cdp ws://...
 * Tracks tabs and exposes the active page.
 */
import { execFile } from "node:child_process";
import { startCdpProxy } from "./cdp-proxy.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { installOverlay } from "./overlay.js";
import { collectElementsInPage, buildSnapshot } from "./snapshot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Runs in every page: tells the server when this tab is the one you're looking at.
const FOCUS_HOOK = `(() => {
  if (window.top !== window || window.__vbFocusHook) return;
  window.__vbFocusHook = true;
  const ping = () => { if (document.visibilityState === "visible" && document.hasFocus()) window.__vbFocused?.().catch?.(() => {}); };
  addEventListener("focus", ping);
  document.addEventListener("visibilitychange", () => setTimeout(ping, 60)); // switching tabs shows this one
  addEventListener("pointerdown", ping, true);
})()`;

/**
 * The tab the attached browser's front window shows, from AppleScript (Dia, Arc, Chrome, Brave,
 * Edge all support "active tab"). -> { url, name } or null. macOS only; 1.5 s cap.
 */
export function frontTab() {
  const app = process.env.VB_BROWSER_APP;
  if (!app || process.platform !== "darwin") return Promise.resolve(null);
  const script = `tell application "${app.replace(/"/g, "")}"
    if (count of windows) is 0 then return ""
    set t to active tab of front window
    set u to ""
    try
      set u to URL of t
    end try
    if u is missing value then set u to ""
    if u is "" then
      try
        set u to (execute t javascript "location.href")
      end try
      if u is missing value then set u to ""
    end if
    set n to ""
    try
      set n to (name of t)
    on error
      try
        set n to (title of t)
      end try
    end try
    return u & linefeed & n
  end tell`;
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-e", script], { timeout: 4000 }, (err, out) => {
      if (err) {
        if (!frontTab.warned) console.warn(`couldn't ask ${app} for its current tab: ${err.killed ? "timed out" : `${err.code} ${String(err.message).replace(/\s+/g, " ").slice(-200)}`}`);
        frontTab.warned = true;
        return resolve(null);
      }
      const [url = "", name = ""] = String(out).replace(/\n$/, "").split("\n");
      resolve(url || name ? { url, name } : null);
    });
  });
}

// Browser-internal pages (Dia's chat panel, extensions, DevTools) aren't tabs you work in.
const followable = (page) => !/^(?:chrome-extension|chrome-untrusted|devtools):/.test(page.url());

export const DEFAULT_PROFILE_DIR = process.env.BROWSER_PROFILE_DIR || path.join(__dirname, "..", ".browser-profile");

const within = (promise, ms, fallback) =>
  Promise.race([Promise.resolve(promise).catch(() => fallback), new Promise((r) => setTimeout(() => r(fallback), ms))]);

export class BrowserManager {
  constructor() {
    this.context = null;
    this.browser = null;
    this.active = null;
    this.pages = [];
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  _emit() {
    if (this.proxy && this.active !== this._rendering) {
      this._rendering = this.active;
      this._keepRendering(this.active);
    }
    for (const fn of this.listeners) fn(this);
  }

  async launch({ headless = false, cdp = null, profileDir = DEFAULT_PROFILE_DIR, startUrl = "about:blank" } = {}) {
    if (cdp) {
      // Sleeping tabs never answer and would stall connectOverCDP forever: go through the relay.
      let endpoint = cdp;
      if (/^https?:/.test(cdp)) {
        this.proxy = await startCdpProxy(cdp, { log: (m) => console.log(m) });
        endpoint = this.proxy.wsUrl;
      }
      this.browser = await chromium.connectOverCDP(endpoint, { timeout: 90000 });
      this.context = this.browser.contexts()[0] || (await this.browser.newContext());
    } else {
      this.context = await chromium.launchPersistentContext(profileDir, {
        headless,
        viewport: headless ? { width: 1280, height: 900 } : null,
        args: headless ? [] : ["--window-size=1280,900", "--window-position=40,40"],
        ignoreDefaultArgs: ["--enable-automation"],
      });
    }
    await this.context.addInitScript(installOverlay);
    // Attached browsers: follow the tab you're looking at (pages report when they get focus). The
    // built-in Chromium makes every tab look focused, so there the agent stays where it is.
    if (this.proxy) {
      await this.context.exposeBinding("__vbFocused", ({ page }) => this._focused(page)).catch(() => {});
      await this.context.addInitScript(FOCUS_HOOK);
    }

    this.context.on("page", (page) => this._track(page));
    for (const p of this.context.pages()) this._track(p);
    if (this.pages.length === 0) await this.context.newPage();
    this.active = this.pages[this.pages.length - 1];
    if (cdp) await this.syncActive().catch(() => {}); // start on the tab you're looking at
    if (startUrl && startUrl !== "about:blank") {
      await this.active.goto(startUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    }
    this._emit();
    return this;
  }

  _track(page) {
    if (this.pages.includes(page)) return;
    this.pages.push(page);
    // A tab that appears isn't necessarily one to work in: attached browsers wake sleeping tabs at any
    // time. Tabs the agent opens are made active by whoever opened them (open_new_tab, a click).
    if (!this.active || this.active.isClosed()) this.active = page;
    if (this.proxy) page.evaluate(FOCUS_HOOK).catch(() => {}); // tabs that were open before we connected
    page.on("close", () => {
      this.pages = this.pages.filter((p) => p !== page);
      if (this.active === page) this.active = this.pages[this.pages.length - 1] || null;
      this._emit();
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this._emit();
    });
    this._emit();
  }

  /** Attached browsers: the agent's tab keeps rendering even if the window is behind other apps. */
  async _keepRendering(page) {
    if (!page || page.isClosed()) return;
    this.targetIds ??= new WeakMap();
    let id = this.targetIds.get(page);
    if (!id) {
      const s = await this.context.newCDPSession(page).catch(() => null);
      id = (await s?.send("Target.getTargetInfo").catch(() => null))?.targetInfo?.targetId;
      s?.detach().catch(() => {});
      if (!id) return;
      this.targetIds.set(page, id);
    }
    if (this.active === page) {
      if (this._renderingPage && this._renderingPage !== page) this._left = { page: this._renderingPage, until: Date.now() + 400 };
      this._renderingPage = page;
      this.proxy.keepRendering(id);
    }
  }

  /** A page reported focus. While a goal runs (canFollow() false) the agent stays on its tab. */
  _focused(page) {
    if (page === this.active || page.isClosed() || !this.pages.includes(page) || !followable(page)) return;
    if (this.canFollow && !this.canFollow()) return;
    // Moving the "keep rendering" emulation off a tab makes it fire focus/visibility events itself;
    // ignore that tab for a moment so two tabs can't keep handing it back and forth.
    if (page === this._left?.page && Date.now() < this._left.until) return;
    this.active = page;
    this._emit();
  }

  /**
   * Make `active` the tab you're on in the browser: the one its front window shows (asked via
   * AppleScript), else another tab that has focus. Sleeping tabs can't hold it up.
   */
  async syncActive() {
    if (this.canFollow && !this.canFollow()) return this.active;
    const live = this.pages.filter((p) => !p.isClosed() && followable(p));
    let next = null;
    const shown = await frontTab();
    if (shown) {
      const titles = shown.url ? [] : await Promise.all(live.map((p) => within(p.title(), 400, "")));
      next = (shown.url && live.find((p) => p.url() === shown.url)) || (shown.name && live.find((_, i) => titles[i] === shown.name));
    }
    if (!next && !shown) {
      // The agent's own tab always looks focused (it's kept rendering), so look for another one.
      const states = await Promise.all(
        live.map((p) => within(p.evaluate(() => document.visibilityState === "visible" && document.hasFocus()), 500, false)),
      );
      next = live.find((p, i) => p !== this.active && states[i]);
    }
    if (next && next !== this.active) {
      this.active = next;
      this._emit();
    }
    return this.active;
  }

  get page() {
    if (!this.active || this.active.isClosed()) this.active = this.pages.find((p) => !p.isClosed()) || null;
    return this.active;
  }

  async ensurePage() {
    if (!this.page) {
      await this.context.newPage();
    }
    return this.page;
  }

  async setActive(page) {
    this.active = page;
    await page.bringToFront().catch(() => {});
    this._emit();
  }

  /**
   * Open tabs for "@" mentions. Returns at once with the icons already known; a sleeping tab can't
   * hold the list up (title capped at 400 ms). Missing icons load in the background and onIcons()
   * is called once they're in, so the picker can repaint.
   */
  async tabList({ onIcons } = {}) {
    const live = this.pages.filter((p) => !p.isClosed());
    this.pageIcons ??= new WeakMap(); // page -> { origin, icon }
    const originOf = (u) => { try { return new URL(u).origin; } catch { return u; } };
    const known = (p) => { const k = this.pageIcons.get(p); return k && k.origin === originOf(p.url()) ? k : null; };
    const tabs = await Promise.all(
      live.map(async (p, i) => ({
        index: i,
        title: await within(p.title(), 400, ""),
        url: p.url(),
        active: p === this.active,
        icon: known(p)?.icon ?? null,
      })),
    );
    const missing = live.filter((p) => !known(p));
    if (missing.length) {
      Promise.all(
        missing.map(async (p) => {
          const origin = originOf(p.url());
          this.pageIcons.set(p, { origin, icon: await within(this.favicon(p), 4000, null) });
        }),
      ).then(() => onIcons?.(), () => {});
    }
    return tabs;
  }

  /**
   * The tab's favicon as a data: URL. Fetched through the browser context (its cookies, so
   * localhost and signed-in sites work), cached per icon URL, ignored if large or slow.
   */
  async favicon(page) {
    const href = await page
      .evaluate(() => {
        if (!/^https?:/.test(location.protocol)) return null;
        const links = [...document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]')];
        const best = links.find((l) => /svg/.test(l.type) || /(^|\s)(16|32)x/.test(l.sizes?.value || "")) || links[0];
        return best ? best.href : `${location.origin}/favicon.ico`;
      })
      .catch(() => null);
    if (!href) return null;
    if (href.startsWith("data:")) return href.length < 150_000 ? href : null;
    this.iconCache ??= new Map();
    if (this.iconCache.has(href)) return this.iconCache.get(href);
    let icon = null;
    try {
      const res = await this.context.request.get(href, { timeout: 2500, failOnStatusCode: false, maxRedirects: 3 });
      const body = await res.body();
      let type = (res.headers()["content-type"] || "").split(";")[0].trim();
      if (!type.startsWith("image/")) type = /\.svg(\?|$)/.test(href) ? "image/svg+xml" : /\.png(\?|$)/.test(href) ? "image/png" : "image/x-icon";
      if (res.ok() && body.length > 0 && body.length < 100_000) icon = `data:${type};base64,${body.toString("base64")}`;
    } catch {
      icon = null;
    }
    this.iconCache.set(href, icon);
    return icon;
  }

  tabInfo() {
    return this.pages.map((p, i) => ({ index: i, url: p.url(), active: p === this.active }));
  }

  /** URL of the active page, or null (sync; used to record what an action led to). */
  currentUrl() {
    try {
      return this.active && !this.active.isClosed() ? this.active.url() : null;
    } catch {
      return null;
    }
  }

  /** Snapshot the active page (URL, title, compact element list, search box, site). */
  async snapshot() {
    const page = await this.ensurePage();
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 1500 }).catch(() => {});
      const data = await page.evaluate(collectElementsInPage);
      return buildSnapshot(data, { tabs: this.tabInfo() });
    } catch (err) {
      // e.g. navigation in progress; return a minimal snapshot
      return buildSnapshot({ url: page.url(), title: "", scrollY: 0, scrollHeight: 0, viewportHeight: 0, elements: [] }, { tabs: this.tabInfo(), error: String(err.message || err) });
    }
  }

  /** Call window.__vb.<fn>(...args) in the active page, swallowing errors. */
  async overlay(fn, ...args) {
    const page = this.page;
    if (!page) return;
    await page.evaluate(installOverlay).catch(() => {}); // no-op if already installed by the init script
    await page
      .evaluate(
        ([fn, args]) => {
          if (!window.__vb) return false;
          return window.__vb[fn](...args);
        },
        [fn, args],
      )
      .catch(() => {});
  }

  async close() {
    if (this.browser) {
      // Attached to the user's own browser: only disconnect. Closing its context would close their tabs.
      await this.browser.close().catch(() => {});
      this.proxy?.close();
      return;
    }
    await this.context?.close().catch(() => {});
  }
}
