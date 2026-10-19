/**
 * "Go back to where I was": what a task changed in the browser, so Stop (or a failure) can put it
 * back. Recorded as the task goes, around every action:
 *   - each tab it acted in -> the URL that tab had before the task first touched it
 *   - tabs it opened (closed again on undo)
 *   - tabs it closed (opened again on undo, in the background)
 * It restores addresses, not data: a form the task submitted stays submitted.
 */

const urlOf = (page) => {
  try {
    return page && !page.isClosed() ? page.url() : null;
  } catch {
    return null;
  }
};

export class UndoLog {
  /** @param {{ active?: object }} start  the agent's tab when the task began (made active again on undo) */
  constructor({ active = null } = {}) {
    this.active = active;
    this.start = new Map(); // page -> URL before the task first acted in it
    this.opened = new Set(); // pages the task opened
    this.closed = []; // [{ url }] tabs the task closed
  }

  /** Before an action: remember where `page` was, the first time only. -> a mark for after(). */
  before(page, pages = []) {
    if (page && !this.opened.has(page) && !this.start.has(page)) {
      const url = urlOf(page);
      if (url) this.start.set(page, url);
    }
    return { pages: [...pages], urls: new Map(pages.map((p) => [p, urlOf(p)])) };
  }

  /** After an action: which tabs appeared or went away since before(). */
  after(mark, pages = []) {
    if (!mark) return;
    for (const p of pages) if (!mark.pages.includes(p)) this.opened.add(p);
    for (const p of mark.pages) {
      if (pages.includes(p) && !p.isClosed?.()) continue;
      if (this.opened.delete(p)) continue; // opened and closed by the task: nothing to undo
      const url = this.start.get(p) || mark.urls.get(p);
      this.start.delete(p);
      if (url && /^https?:/.test(url)) this.closed.push({ url });
    }
  }

  /** What undo would do now: { close: [page], navigate: [{ page, url }], reopen: [{ url }] }. */
  plan() {
    const live = (p) => p && !p.isClosed?.();
    const close = [...this.opened].filter(live);
    const navigate = [...this.start].filter(([p, url]) => live(p) && urlOf(p) !== url).map(([page, url]) => ({ page, url }));
    return { close, navigate, reopen: [...this.closed] };
  }

  /** Number of things undo would change (0 = nothing to offer). */
  get changes() {
    const p = this.plan();
    return p.close.length + p.navigate.length + p.reopen.length;
  }

  /**
   * Put the tabs back. `browser` needs newTab({ background }) and setActive(page); pages need
   * goto() and close(). Never brings a tab to the front. -> a short summary for the chat.
   */
  async restore(browser) {
    const { close, navigate, reopen } = this.plan();
    const done = [];
    for (const { page, url } of navigate) {
      const ok = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }).then(() => true, () => false);
      if (ok) done.push(`took a tab back to ${url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60)}`);
    }
    for (const { url } of reopen) {
      const p = await browser.newTab?.({ background: true }).catch(() => null);
      if (p && (await p.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }).then(() => true, () => false))) done.push(`reopened ${url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60)}`);
    }
    // close last: closing the agent's tab moves it, so make the starting tab active first
    if (this.active && !this.active.isClosed?.()) await browser.setActive?.(this.active);
    let closed = 0;
    for (const p of close) if (await p.close().then(() => true, () => false)) closed++;
    if (closed) done.unshift(`closed ${closed} tab${closed === 1 ? "" : "s"} it opened`);
    if (this.active && !this.active.isClosed?.()) await browser.setActive?.(this.active);
    this.start.clear();
    this.opened.clear();
    this.closed = [];
    return done.length ? `Back where you were: ${done.join(", ")}.` : "Nothing to put back.";
  }
}
