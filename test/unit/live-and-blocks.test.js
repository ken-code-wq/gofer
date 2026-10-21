/**
 * Live view (a tab's picture streamed to the panel) and bot checks (block pages are recognised,
 * remembered for a few hours, and not opened again unless asked for by name).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.VB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vb-live-"));
const { BrowserManager } = await import("../../src/browser.js");
const { LiveView } = await import("../../src/live.js");
const { classifyBlock, noteBlocked, blockedSites, isBlocked, namedIn, blockNote, blockedHint, _reset } = await import("../../src/blocked.js");

function fakePage(id, url = "https://example.com/") {
  return { id, closed: false, url: () => url, isClosed() { return this.closed; }, async bringToFront() {}, async title() { return `Title ${id}`; }, on() {} };
}

function fakeSession(page, log) {
  const handlers = {};
  return {
    page,
    on: (ev, fn) => (handlers[ev] = fn),
    emit: (ev, d) => handlers[ev]?.(d),
    async send(method, params) {
      log.push([page.id, method, params]);
      if (method === "Target.getTargetInfo") return { targetInfo: { targetId: page.id } };
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1200, clientHeight: 800 } };
      if (method === "Page.captureScreenshot") return { data: `still-${page.id}` };
      return {};
    },
    async detach() {
      log.push([page.id, "detach"]);
    },
  };
}

function setup() {
  const b = new BrowserManager();
  const a = fakePage("A");
  const c = fakePage("C", "https://other.example/");
  const log = [];
  const sessions = [];
  const rendering = [];
  b.proxy = { keepRendering: (id, slot) => rendering.push([slot, id]) };
  b.context = { newCDPSession: async (p) => { const s = fakeSession(p, log); sessions.push(s); return s; } };
  b.pages = [a, c];
  b.active = a;
  b.shown = a;
  const sent = [];
  const live = new LiveView(b, (type, payload) => (sent.push([type, payload]), true), "w1");
  return { b, a, c, log, sessions, rendering, sent, live };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("live view follows the agent's tab, streams frames, and keeps the watched tab rendering", async () => {
  const { b, a, c, log, rendering, sent, live } = setup();
  await live.start();
  assert.ok(log.some(([id, m]) => id === "A" && m === "Page.startScreencast"), "screencast started on the agent's tab");
  const s = live.session;
  assert.equal(s.page, a);
  s.emit("Page.screencastFrame", { data: "frame1", sessionId: 7, metadata: { deviceWidth: 1200, deviceHeight: 800 } });
  assert.deepEqual(sent.find(([t]) => t === "live-frame")[1], { data: "frame1", w: 1200, h: 800 });
  await wait(250);
  assert.ok(log.some(([, m, p]) => m === "Page.screencastFrameAck" && p.sessionId === 7), "frame acknowledged (so the next one comes)");
  assert.ok(sent.some(([t, p]) => t === "live-meta" && p.follow && p.agent && p.index === 0));
  // the agent moves to another tab: the view goes with it
  b.active = c;
  b._emit();
  await wait(30);
  assert.equal(live.page, c);
  assert.ok(log.some(([id, m]) => id === "A" && m === "Page.stopScreencast"), "old tab's stream stopped");
  assert.ok(rendering.some(([slot, id]) => slot === "live:w1" && id === "C"), "watched tab kept rendering");
  await live.stop();
  assert.deepEqual(rendering.at(-1), ["live:w1", null], "stops keeping it rendering");
});

test("a picked tab stays watched while the agent moves; a still page gets a screenshot", async () => {
  const { b, a, c, sent, live } = setup();
  await live.start({ index: 1 });
  assert.equal(live.page, c);
  b.active = fakePage("D");
  b.pages.push(b.active);
  b._emit();
  await wait(500);
  assert.equal(live.page, c, "still on the tab you picked");
  assert.ok(sent.some(([t, p]) => t === "live-frame" && p.data === "still-C" && p.still), "no frames came: a screenshot instead");
  // your tab closes: back to following the agent
  c.closed = true;
  b._emit();
  await wait(30);
  assert.equal(live.follow, true);
  assert.equal(live.page, b.active);
  await live.stop();
  void a;
});

test("a watched background tab looking focused isn't taken for the tab you're on", async () => {
  const { b, c, live } = setup();
  await live.start({ index: 1 });
  b._focused(c, "focus");
  b._focused(c, "visibilitychange"); // turning the emulation on makes it look visible for a moment
  assert.notEqual(b.shown, c);
  assert.notEqual(b.active, c);
  b._focused(c, "pointerdown"); // you clicked in it: now you're on it
  assert.equal(b.shown, c);
  await live.stop();
});

test("block pages are recognised; long pages that mention blocking aren't", () => {
  assert.deepEqual(classifyBlock({ url: "https://www.yelp.com/search?x", title: "yelp.com", text: "You have been blocked.\nWhy? Something about the behaviour of the browser has caught our attention.", len: 300 }), { site: "yelp.com", kind: "blocked", said: "You have been blocked" });
  assert.equal(classifyBlock({ url: "https://www.tripadvisor.com/R", title: "tripadvisor.com", text: "Access is temporarily restricted\nWe detected unusual activity from your device or network.", len: 300 }).kind, "blocked");
  assert.equal(classifyBlock({ url: "https://site.com/", title: "Just a moment...", text: "Verify you are human by completing the action below.", len: 80 }).kind, "check");
  assert.equal(classifyBlock({ url: "https://shop.com/", title: "shop", text: "", len: 0, frames: ["https://geo.captcha-delivery.com/captcha/?x"] }).kind, "check");
  assert.equal(classifyBlock({ url: "https://news.com/a", title: "Why sites block bots", text: "You have been blocked, says the page. ".repeat(200), len: 7000 }), null);
  assert.equal(classifyBlock({ url: "https://news.com/a", title: "Pizza in Accra", text: "Best pizza places", len: 500 }), null);
});

test("blocked sites are remembered for a few hours and skipped unless the request asks for them", () => {
  _reset();
  const now = Date.now();
  noteBlocked("yelp.com", "blocked", now);
  assert.equal(isBlocked("https://www.yelp.com/biz/x", now), true);
  assert.equal(isBlocked("https://www.yelp.com/biz/x", now + 7 * 3600_000), false, "expires");
  assert.deepEqual(blockedSites(now), []); // expired entries are dropped
  noteBlocked("yelp.com", "blocked");
  assert.match(blockedHint(blockedSites()), /yelp\.com/);
  assert.equal(namedIn("find pizza on Yelp", "yelp.com"), true);
  assert.equal(namedIn("find a pizza place without using Yelp", "yelp.com"), false);
  assert.equal(namedIn("pizza near me", "yelp.com"), false);
  assert.match(blockNote({ site: "yelp.com", kind: "blocked", said: "You have been blocked" }), /web_search/);
  assert.match(blockNote({ site: "x.com", kind: "check" }), /need_user/);
});
