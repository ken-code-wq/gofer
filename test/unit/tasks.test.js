/**
 * Messages while a task runs (controller.enqueue): queued in order, removable, "stop, …" interrupts,
 * replies go straight through; take over; undo after Stop; background-tab placement. A fake browser
 * and a scripted handleCommand stand in for Playwright and the AI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Controller } from "../../src/controller.js";
import { resultOf, isReply, isSideQuestion } from "../../src/tasks.js";
import { placeAction, isBlankUrl, isPinnedToTab } from "../../src/background.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeTab(url) {
  return {
    _url: url,
    closed: false,
    fronted: 0,
    url() { return this._url; },
    isClosed() { return this.closed; },
    async title() { return ""; },
    async goto(u) { this._url = u; },
    async close() { this.closed = true; },
    async bringToFront() { this.fronted++; },
  };
}

function fakeBrowser() {
  const first = fakeTab("https://mail.example.com/");
  const b = {
    pages: [first],
    active: first,
    shown: first,
    get page() { return this.active; },
    onChange(fn) { (this.fns ||= []).push(fn); return () => {}; },
    _emit() { for (const f of this.fns || []) f(this); },
    tabInfo() { return this.pages.map((p, i) => ({ index: i, url: p.url(), active: p === this.active })); },
    currentUrl() { return this.active.url(); },
    async snapshot() { return { url: this.active.url(), title: "", site: "", searchBoxId: null, elements: [], tabs: this.tabInfo() }; },
    async overlay() {},
    async setActive(p, { show = false } = {}) { this.active = p; if (show) await this.show(p); this._emit(); },
    async show(p = this.active) { await p.bringToFront(); this.shown = p; this._emit(); },
    isShown(p = this.active) { return p === this.shown; },
    async visiblePage() { return this.shown; },
    async newTab() { const t = fakeTab("about:blank"); this.pages.push(t); return t; },
  };
  return b;
}

/** A controller whose handleCommand is scripted: each text maps to what the "task" does. */
function setup(script = {}) {
  const browser = fakeBrowser();
  const c = new Controller({ browser, persist: false, decideFn: async () => ({}), executeFn: async () => ({ ok: true }) });
  c.tasks.idleMs = 40;
  c.tasks.pollMs = 10;
  const calls = [];
  c.handleCommand = (text, opts) => {
    calls.push(text);
    const fn = script[text];
    if (fn) return fn(c, opts);
    // default: a goal that finishes after 30 ms unless stopped
    const g = { goal: text, steps: [], done: [], cancelled: false, at: Date.now() };
    c.goal = g;
    c.emit("goal", { status: "running", goal: text, steps: [] });
    setTimeout(() => !g.ended && c._endGoal(g, "done", "ok"), 30);
  };
  const states = [];
  c.tasks.on("change", (s) => states.push(s));
  return { c, browser, calls, states };
}

test("messages sent while a task runs wait, in order, and can be removed", async () => {
  const { c, calls, states } = setup();
  assert.equal(c.enqueue({ id: "m1", text: "open youtube", thread: "t" }).kind, "run");
  assert.equal(c.enqueue({ id: "m2", text: "open gmail", thread: "t" }).kind, "queued");
  assert.equal(c.enqueue({ id: "m3", text: "open maps", thread: "t" }).kind, "queued");
  await sleep(1);
  let s = c.tasks.state();
  assert.equal(s.running.id, "m1");
  assert.deepEqual(s.queued.map((x) => x.id), ["m2", "m3"]);
  assert.deepEqual(s.position, { n: 1, of: 3 });
  assert.equal(c.tasks.remove("m2"), true);
  await sleep(150);
  assert.deepEqual(calls, ["open youtube", "open maps"]);
  assert.ok(c.tasks.queue.idle);
  assert.ok(states.some((x) => x.position?.of === 3), "queue state was broadcast");
});

test("'stop, …' interrupts the running task and runs next; a bare 'stop' drops the queue too", async () => {
  const { c, calls } = setup({ slow: (c) => { const g = { goal: "slow", steps: [], done: [], at: Date.now() }; c.goal = g; } });
  c.enqueue({ id: "a", text: "slow" });
  c.enqueue({ id: "b", text: "queued one" });
  await sleep(1);
  const r = c.enqueue({ id: "c", text: "stop, open the news instead" });
  assert.equal(r.kind, "interrupt");
  await sleep(20);
  assert.deepEqual(calls.slice(0, 2), ["slow", "open the news"], "the interrupting message runs before the queued one");
  assert.deepEqual(c.tasks.state().queued.map((x) => x.id), ["b"]);
  const stop = c.enqueue({ text: "stop" });
  assert.equal(stop.kind, "stop");
  await sleep(20);
  assert.ok(c.tasks.queue.idle, "nothing left");
  assert.ok(!calls.includes("queued one"));
});

test("answers to what the task is waiting for go straight through", async () => {
  const seen = [];
  const { c } = setup({
    risky: (c) => { c.goal = { goal: "risky", steps: [], done: [], awaiting: { type: "click_element" }, at: Date.now() }; },
  });
  c.enqueue({ id: "a", text: "risky" });
  await sleep(1);
  const orig = c.handleCommand;
  c.handleCommand = (t, o) => { seen.push(t); return orig(t, o); };
  assert.equal(c.enqueue({ text: "yes" }).kind, "reply");
  assert.equal(c.enqueue({ text: "confirm", opts: { reply: true } }).kind, "reply");
  assert.deepEqual(seen, ["yes", "confirm"]);
  assert.equal(isReply({ goal: null, pending: null }, "yes"), false);
  c.tasks.stop();
});

test("results end a task; side answers (tagged with their own id) don't", () => {
  assert.equal(resultOf("goal", { status: "running" }), null);
  assert.equal(resultOf("goal", { status: "done" }), "done");
  assert.equal(resultOf("goal", { status: "cancelled" }), "stopped");
  assert.equal(resultOf("chain", { status: "failed" }), "failed");
  assert.equal(resultOf("action", { via: "goal", ok: true }), null);
  assert.equal(resultOf("action", { via: "jev", ok: true }, { chain: {} }), null, "a chain step");
  assert.equal(resultOf("action", { via: "jev", ok: false }), "failed");
  assert.equal(resultOf("tab-switched", { rest: "click play" }), null);
  assert.equal(resultOf("tab-switched", { rest: "" }), "done");
  assert.equal(resultOf("decision", { policy: { decision: "ignore" } }), "done");
  assert.equal(resultOf("decision", { policy: { decision: "act" } }), null);
  assert.equal(resultOf("answer", {}), "done");
  assert.equal(isSideQuestion("what's this page about?", { chat: true }), true);
  assert.equal(isSideQuestion("open youtube", { chat: true }), false);
  assert.equal(isSideQuestion("what's this page about?", {}), false, "Direct mode queues everything");
  assert.equal(isSideQuestion("remember that I like jazz", { chat: true }), false);
});

test("an answer tagged with another task's id doesn't finish the running one", async () => {
  const { c } = setup({ asks: (c) => { c.goal = { goal: "x", steps: [], done: [], at: Date.now() }; } });
  c.enqueue({ id: "a", text: "asks" });
  await sleep(5);
  c.emit("answer", { answer: "side", task: "other" });
  await sleep(80);
  assert.equal(c.tasks.state().running?.id, "a");
  c.emit("answer", { answer: "mine" });
  c.goal = null;
  await sleep(10);
  assert.ok(c.tasks.queue.idle);
});

test("requests that end without a result are done once nothing runs", async () => {
  const { c } = setup({ quiet: () => {} });
  c.enqueue({ id: "q", text: "quiet" });
  c.enqueue({ id: "r", text: "quiet" });
  await sleep(200);
  assert.ok(c.tasks.queue.idle);
});

test("take over: shows the agent's tab, the goal waits, hand back resumes with a note", async () => {
  const { c, browser } = setup({ long: (c) => { c.goal = { goal: "long", steps: [], done: [], at: Date.now() }; } });
  c.enqueue({ id: "a", text: "long" });
  await sleep(1);
  const bg = await browser.newTab();
  await browser.setActive(bg);
  assert.equal(c.tasks.state().background, true, "working in a tab you're not looking at");
  assert.equal(c.tasks.state().canTakeOver, true);
  assert.equal(c.tasks.takeOver(), true);
  assert.equal(bg.fronted, 1, "its tab comes to the front");
  assert.equal(c.tasks.state().paused.state, "requested");
  const g = c.goal;
  const wait = c.tasks.pauseIfWanted(g); // what the goal loop does before its next step
  await sleep(1);
  assert.equal(c.tasks.state().paused.state, "paused");
  assert.equal(g.steps.at(-1).status, "awaiting");
  c.tasks.handBack();
  assert.deepEqual(await wait, { resumed: true });
  assert.equal(g.steps.at(-1).status, "ok");
  assert.match(g.done.at(-1).outcome, /handed back/);
  // the goal asks for the user itself
  c.tasks.needUser("Please sign in, then hand back.");
  const w2 = c.tasks.pauseIfWanted(g);
  await sleep(1);
  assert.deepEqual(c.tasks.state().paused, { state: "paused", reason: "need_user", message: "Please sign in, then hand back." });
  c.tasks.stop(); // Stop while paused ends it
  assert.deepEqual(await w2, { cancelled: true });
});

test("Stop offers to go back: the tab is navigated back and the tab it opened is closed", async () => {
  const { c, browser } = setup({
    browse: async (c) => {
      c.goal = { goal: "browse", steps: [], done: [], at: Date.now() };
      // an action in your tab, then one that opens a tab
      c._execute = async (action, b) => {
        if (action.type === "navigate_url") b.active._url = action.url;
        if (action.type === "open_new_tab") { const t = await b.newTab(); t._url = action.url; await b.setActive(t); }
        return { ok: true };
      };
      await c._runAction({ type: "navigate_url", url: "https://youtube.com/" }, { via: "goal" });
      await c._runAction({ type: "open_new_tab", url: "https://news.example.com/" }, { via: "goal" });
    },
  });
  const mine = browser.page;
  c.enqueue({ id: "a", text: "browse" });
  await sleep(20);
  assert.equal(mine.url(), "https://youtube.com/");
  c.tasks.stop();
  await sleep(10);
  const s = c.tasks.state();
  assert.deepEqual({ id: s.undo.id, changes: s.undo.changes }, { id: "a", changes: 2 });
  const events = [];
  c.on("task-undo", (p) => events.push(p));
  const detail = await c.tasks.undoTask("a");
  assert.equal(mine.url(), "https://mail.example.com/");
  assert.equal(browser.pages[1].closed, true);
  assert.equal(browser.page, mine);
  assert.match(detail, /closed 1 tab.*took a tab back/);
  assert.equal(events[0].id, "a");
  assert.equal(c.tasks.state().undo, null);
});

test("a task that finishes doesn't offer undo; the next task drops an earlier offer", async () => {
  const { c } = setup({
    nav: async (c) => {
      c._execute = async (a, b) => ((b.active._url = a.url), { ok: true });
      await c._runAction({ type: "navigate_url", url: "https://x.example.com/" }, { via: "check" });
    },
    fail: async (c) => {
      await c._runAction({ type: "navigate_url", url: "https://y.example.com/" }, { via: "goal" });
      c.emit("smart-error", { error: "nope" });
    },
  });
  c.enqueue({ id: "a", text: "nav" });
  await sleep(100);
  assert.equal(c.tasks.state().undo, null);
  c.enqueue({ id: "b", text: "fail" });
  await sleep(30);
  assert.equal(c.tasks.state().undo?.id, "b", "a failure offers it");
  c.enqueue({ id: "c", text: "next thing" });
  await sleep(1);
  assert.equal(c.tasks.state().undo, null);
  c.tasks.stop();
});

test("background tabs: going somewhere new doesn't navigate the tab you're looking at", () => {
  const nav = { type: "navigate_url", url: "https://youtube.com/", label: "youtube.com" };
  const moved = placeAction(nav, { onShownTab: true, pageUrl: "https://mail.example.com/" });
  assert.deepEqual(moved, { type: "open_new_tab", url: "https://youtube.com/", label: "new tab: youtube.com", background: true });
  assert.equal(placeAction(nav, { onShownTab: false, pageUrl: "https://mail.example.com/" }), nav, "already in a background tab");
  assert.equal(placeAction(nav, { onShownTab: true, pageUrl: "about:blank" }), nav, "a blank tab is fine to use");
  assert.equal(placeAction(nav, { onShownTab: true, pageUrl: "chrome://newtab/" }), nav);
  assert.equal(placeAction(nav, { onShownTab: true, pageUrl: "https://a.com/", pinned: true }), nav, "'in the current tab …'");
  assert.equal(placeAction(nav, { onShownTab: true, pageUrl: "https://a.com/", ownTab: true }), nav, "its own tab, shown by you");
  const click = { type: "click_element", targetId: "e1" };
  assert.equal(placeAction(click, { onShownTab: true, pageUrl: "https://a.com/" }), click, "working on this page is fine");
  assert.ok(isBlankUrl("about:blank") && isBlankUrl("") && !isBlankUrl("https://a.com"));
  assert.ok(isPinnedToTab("in the current tab, play the next video"));
  assert.ok(isPinnedToTab("go to @[Inbox] and archive it"));
  assert.ok(isPinnedToTab("summarize this page"));
  assert.ok(!isPinnedToTab("open youtube and play lofi"));
});

test("goal steps are placed by the running task's policy", async () => {
  const { c, browser } = setup({ hold: (c) => { c.goal = { goal: "hold", steps: [], done: [], at: Date.now() }; } });
  c.enqueue({ id: "a", text: "hold" });
  await sleep(1);
  const nav = { type: "navigate_url", url: "https://youtube.com/" };
  assert.equal(c.tasks.place(nav).type, "open_new_tab");
  const t = await browser.newTab();
  await browser.setActive(t);
  assert.equal(c.tasks.place(nav), nav, "in its background tab it navigates normally");
  c.tasks.stop();
  await sleep(1);
  c.enqueue({ id: "b", text: "in the current tab, go to youtube" });
  await sleep(1);
  await browser.setActive(browser.pages[0]);
  assert.equal(c.tasks.place(nav), nav, "you said to use the current tab");
  c.tasks.stop();
});
