/**
 * Live view: a tab's picture streamed to the panel, so you can watch the agent work in a
 * background tab (or keep an eye on any tab) without switching to it.
 *
 * Uses the browser's own screencast (CDP Page.startScreencast): JPEG frames arrive only when the
 * page changes, at most FPS a second. A page that doesn't change sends nothing, so it gets a plain
 * screenshot instead (when the view starts, and every few seconds while no frames come).
 *
 * One LiveView per panel window. It follows the agent's tab by default (switching when the agent
 * moves to another tab), or stays on the tab you picked.
 */

const FPS = 5;
const MAX_PX = 1100; // frame size cap (device pixels); the panel shows it at ~400 px wide
const QUALITY = 55;
const STILL_AFTER_MS = 2500;

const within = (p, ms, fallback = null) =>
  Promise.race([Promise.resolve(p).catch(() => fallback), new Promise((r) => setTimeout(() => r(fallback), ms))]);

export class LiveView {
  /**
   * @param {import('./browser.js').BrowserManager} browser
   * @param {(type: string, payload: object) => boolean} send  to this panel window; false if it can't take more now
   * @param {string} slot  unique per panel window
   */
  constructor(browser, send, slot) {
    this.browser = browser;
    this.send = send;
    this.slot = slot;
    this.follow = true;
    this.fixed = null; // the tab you picked (follow = false)
    this.page = null;
    this.session = null;
    this.gen = 0;
    this.lastFrame = 0;
    this.on = false;
  }

  /** Start watching: the agent's tab (`index` null) or open tab number `index` (as in the tab list). */
  async start({ index = null } = {}) {
    const pages = this.browser.pages.filter((p) => !p.isClosed());
    this.fixed = index == null ? null : pages[index] || null;
    this.follow = !this.fixed;
    if (!this.on) {
      this.on = true;
      this.off = this.browser.onChange(() => this._sync());
      this.timer = setInterval(() => this._tick(), 1000);
      this.timer.unref?.();
    }
    await this._sync(true);
  }

  async stop() {
    if (!this.on) return;
    this.on = false;
    this.off?.();
    clearInterval(this.timer);
    await this._detach();
    await this.browser.watchRendering(this.slot, null).catch(() => {});
  }

  _target() {
    if (this.fixed && this.fixed.isClosed()) (this.fixed = null), (this.follow = true); // your tab closed: back to the agent's
    return this.follow ? this.browser.page : this.fixed;
  }

  /** The tab changed (agent moved, tab closed or navigated): re-point the stream, tell the panel. */
  async _sync(force = false) {
    if (!this.on) return;
    const page = this._target();
    if (page !== this.page || force) {
      if (page !== this.page) await this._attach(page);
      else this._still(this.gen);
    }
    this._meta();
  }

  _meta() {
    const p = this.page;
    const b = this.browser;
    const index = p ? b.pages.filter((x) => !x.isClosed()).indexOf(p) : -1;
    let url = "";
    try {
      url = p && !p.isClosed() ? p.url() : "";
    } catch {}
    const info = { follow: this.follow, index, url, agent: Boolean(p) && p === b.active, shown: Boolean(p) && p === b.shown };
    const key = JSON.stringify(info);
    if (key === this.lastMeta) return;
    this.lastMeta = key;
    this.send("live-meta", info);
    // the title arrives a moment after a navigation; send it when it's there
    if (p) within(p.title(), 800, "").then((title) => this.page === p && this.send("live-meta", { ...info, title }));
  }

  async _attach(page) {
    // claim the new tab before waiting on anything, so a second change meanwhile doesn't attach twice
    this.page = page || null;
    this.lastMeta = null;
    const detached = this._detach(); // bumps gen at once
    const gen = this.gen;
    await detached;
    if (gen !== this.gen) return;
    if (!page) return this.browser.watchRendering(this.slot, null).catch(() => {});
    await this.browser.watchRendering(this.slot, page).catch(() => {});
    const s = await within(this.browser.context.newCDPSession(page), 3000);
    if (!s || gen !== this.gen) return s?.detach().catch(() => {});
    this.session = s;
    this.lastFrame = 0;
    s.on("Page.screencastFrame", (f) => this._frame(s, gen, f));
    await within(s.send("Page.startScreencast", { format: "jpeg", quality: QUALITY, maxWidth: MAX_PX, maxHeight: MAX_PX, everyNthFrame: 1 }), 3000);
    // a page that isn't changing sends no frame: show a screenshot right away
    setTimeout(() => gen === this.gen && !this.lastFrame && this._still(gen), 400);
  }

  async _detach() {
    const s = this.session;
    this.session = null;
    this.gen++;
    if (!s) return;
    await within(s.send("Page.stopScreencast"), 1000);
    await within(s.detach(), 1000);
  }

  _frame(s, gen, f) {
    const ack = () => s.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    if (gen !== this.gen) return ack();
    const now = Date.now();
    const m = f.metadata || {};
    this.lastFrame = now;
    this.send("live-frame", { data: f.data, w: m.deviceWidth, h: m.deviceHeight });
    // the browser sends the next frame only after this one is acknowledged: that caps the rate
    setTimeout(ack, Math.max(0, 1000 / FPS - (Date.now() - now)));
  }

  /** One screenshot of what the tab shows now (scaled down like the frames). */
  async _still(gen) {
    const s = this.session;
    if (!s || gen !== this.gen || this.stilling) return;
    this.stilling = true;
    try {
      const m = await within(s.send("Page.getLayoutMetrics"), 1500);
      const vp = m?.cssVisualViewport || m?.layoutViewport;
      const w = vp?.clientWidth || 0;
      const h = vp?.clientHeight || 0;
      const shot = await within(
        s.send("Page.captureScreenshot", {
          format: "jpeg",
          quality: QUALITY,
          ...(w && h ? { clip: { x: vp.pageX || 0, y: vp.pageY || 0, width: w, height: h, scale: Math.min(1, MAX_PX / 2 / w) } } : {}),
        }),
        3000,
      );
      if (shot?.data && gen === this.gen) this.send("live-frame", { data: shot.data, w: Math.round(w), h: Math.round(h), still: true });
      if (shot?.data) this.lastStill = Date.now();
    } finally {
      this.stilling = false;
    }
  }

  _tick() {
    if (!this.on || !this.session) return;
    const quiet = Date.now() - Math.max(this.lastFrame, this.lastStill || 0);
    if (quiet > STILL_AFTER_MS) this._still(this.gen);
    this._meta();
  }
}
