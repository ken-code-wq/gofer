/**
 * Browser management: launch a headed Playwright Chromium with a persistent profile
 * (so it feels like "your browser"), or attach to a running Chrome via --cdp ws://...
 * Tracks tabs and exposes the active page.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { installOverlay } from "./overlay.js";
import { collectElementsInPage, buildSnapshot } from "./snapshot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROFILE_DIR = process.env.BROWSER_PROFILE_DIR || path.join(__dirname, "..", ".browser-profile");

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
    for (const fn of this.listeners) fn(this);
  }

  async launch({ headless = false, cdp = null, profileDir = DEFAULT_PROFILE_DIR, startUrl = "about:blank" } = {}) {
    if (cdp) {
      this.browser = await chromium.connectOverCDP(cdp);
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

    this.context.on("page", (page) => this._track(page));
    for (const p of this.context.pages()) this._track(p);
    if (this.pages.length === 0) await this.context.newPage();
    this.active = this.pages[this.pages.length - 1];
    if (startUrl && startUrl !== "about:blank") {
      await this.active.goto(startUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    }
    this._emit();
    return this;
  }

  _track(page) {
    if (this.pages.includes(page)) return;
    this.pages.push(page);
    this.active = page;
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

  /** Open tabs with titles and favicons (for "@" mentions). */
  async tabList() {
    const live = this.pages.filter((p) => !p.isClosed());
    return Promise.all(
      live.map(async (p, i) => ({
        index: i,
        title: await p.title().catch(() => ""),
        url: p.url(),
        active: p === this.active,
        icon: await this.favicon(p),
      })),
    );
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
      return;
    }
    await this.context?.close().catch(() => {});
  }
}
