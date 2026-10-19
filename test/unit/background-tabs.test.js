/**
 * BrowserManager: switching the agent's tab never brings it to the front (only show() does), new
 * tabs open in the background over CDP, the background tab is the one kept rendering, and focus
 * reported by the agent's own emulated tab isn't mistaken for you looking at it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserManager } from "../../src/browser.js";

function fakePage(id, url = "https://example.com/") {
  return { id, fronted: 0, closed: false, url: () => url, isClosed() { return this.closed; }, async bringToFront() { this.fronted++; }, on() {} };
}

function manager() {
  const b = new BrowserManager();
  const a = fakePage("A", "https://mail.example.com/");
  const rendering = [];
  b.proxy = { keepRendering: (id) => rendering.push(id) };
  b.context = { newCDPSession: async (p) => ({ send: async () => ({ targetInfo: { targetId: p.id } }), detach: async () => {} }) };
  b.pages = [a];
  b.active = a;
  b.shown = a;
  return { b, a, rendering };
}

test("the agent switches tabs without changing what you see; Show brings its tab to the front", async () => {
  const { b, a, rendering } = manager();
  const bg = fakePage("B");
  b.pages.push(bg);
  await b.setActive(bg);
  assert.equal(b.active, bg);
  assert.equal(bg.fronted + a.fronted, 0, "nothing brought to the front");
  assert.equal(b.shown, a);
  assert.equal(b.isShown(), false);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(rendering.at(-1), "B", "the background tab is the one kept rendering");
  await b.show(bg);
  assert.equal(bg.fronted, 1);
  assert.equal(b.shown, bg);
  await b.setActive(a, { show: true });
  assert.equal(a.fronted, 1);
});

test("focus from the agent's emulated tab isn't you looking at it; a click or it becoming visible is", async () => {
  const { b, a } = manager();
  const bg = fakePage("B");
  b.pages.push(bg);
  b.canFollow = () => false; // a task is running
  await b.setActive(bg);
  await new Promise((r) => setTimeout(r, 5));
  b._focused(bg, "focus");
  assert.equal(b.shown, a);
  b._focused(bg, "pointerdown");
  assert.equal(b.shown, bg);
  b._focused(a, "visibilitychange");
  assert.equal(b.shown, a);
  assert.equal(b.active, bg, "the agent stays on its tab while it works");
});

test("new tabs open in the background over CDP; built-in Chromium: what you see is what was shown", async () => {
  const { b } = manager();
  const sent = [];
  const created = fakePage("NEW", "about:blank");
  b.browser = {
    newBrowserCDPSession: async () => ({
      send: async (method, params) => {
        sent.push([method, params]);
        setTimeout(() => b.pages.push(created), 10); // the page event arrives a moment later
        return { targetId: "NEW" };
      },
    }),
  };
  const p = await b.newTab();
  assert.equal(p, created);
  assert.deepEqual(sent, [["Target.createTarget", { url: "about:blank", background: true }]]);
  b.proxy = null;
  assert.equal(await b.visiblePage(), b.shown);
  // no CDP browser session (another engine): a plain new page
  b.browser = null;
  b.context.browser = () => null;
  b.context.newPage = async () => "plain";
  assert.equal(await b.newTab(), "plain");
});
