/**
 * Take over / hand back state machine, and the undo bookkeeping ("Go back to where I was").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Takeover } from "../../src/takeover.js";
import { UndoLog } from "../../src/undo.js";

test("take over: requested, paused at the next step, resumed by hand back", async () => {
  const t = new Takeover();
  const seen = [];
  t.on("change", (i) => seen.push(i?.state ?? "idle"));
  assert.equal(t.wanted, false);
  assert.equal(t.request("user"), true);
  assert.equal(t.request("user"), false, "one at a time");
  assert.equal(t.wanted, true);
  const p = t.pause();
  assert.equal(t.state, "paused");
  assert.equal(t.pause(), p, "pausing twice waits for the same hand back");
  assert.equal(t.handBack(), true);
  assert.deepEqual(await p, { resumed: true });
  assert.equal(t.state, "idle");
  assert.deepEqual(seen, ["requested", "paused", "idle"]);
  assert.equal(t.handBack(), false);
});

test("take over: hand back before it paused cancels the request; stop cancels a pause", async () => {
  const t = new Takeover();
  t.request("user");
  t.handBack();
  assert.equal(t.state, "idle");
  assert.deepEqual(await t.pause(), { resumed: true }, "nothing to wait for");
  t.request("need_user", "Sign in to GitHub");
  assert.deepEqual(t.info(), { state: "requested", reason: "need_user", message: "Sign in to GitHub" });
  const p = t.pause();
  assert.equal(t.info().state, "paused");
  assert.equal(t.cancel(), true);
  assert.deepEqual(await p, { cancelled: true });
  assert.equal(t.info(), null);
});

/** Fake tabs: url(), goto(), close(), isClosed(). */
function fakeTab(url) {
  return {
    _url: url,
    closed: false,
    url() { return this._url; },
    isClosed() { return this.closed; },
    async goto(u) { this._url = u; },
    async close() { this.closed = true; },
  };
}

test("undo: tabs it navigated go back, tabs it opened close, tabs it closed reopen", async () => {
  const mine = fakeTab("https://mail.example.com/inbox");
  const other = fakeTab("https://docs.example.com/");
  let pages = [mine, other];
  const log = new UndoLog({ active: mine });
  assert.equal(log.changes, 0);

  // step 1: navigate my tab
  let m = log.before(mine, pages);
  mine._url = "https://youtube.com/";
  log.after(m, pages);
  // step 2: in the same tab again: the first URL is kept
  m = log.before(mine, pages);
  mine._url = "https://youtube.com/watch?v=1";
  log.after(m, pages);
  // step 3: opens a tab
  const opened = fakeTab("about:blank");
  m = log.before(mine, pages);
  pages = [...pages, opened];
  opened._url = "https://news.example.com/";
  log.after(m, pages);
  // step 4: acting in the tab it opened isn't recorded as a navigation to undo
  m = log.before(opened, pages);
  opened._url = "https://news.example.com/2";
  log.after(m, pages);
  // step 5: closes the docs tab
  m = log.before(other, pages);
  other.closed = true;
  pages = pages.filter((p) => p !== other);
  log.after(m, pages);

  const plan = log.plan();
  assert.deepEqual(plan.navigate.map((x) => [x.page, x.url]), [[mine, "https://mail.example.com/inbox"]]);
  assert.deepEqual(plan.close, [opened]);
  assert.deepEqual(plan.reopen, [{ url: "https://docs.example.com/" }]);
  assert.equal(log.changes, 3);

  const reopened = [];
  const active = [];
  const browser = {
    async newTab({ background }) { assert.equal(background, true); const t = fakeTab("about:blank"); reopened.push(t); return t; },
    async setActive(p) { active.push(p); },
  };
  const detail = await log.restore(browser);
  assert.equal(mine.url(), "https://mail.example.com/inbox");
  assert.equal(opened.closed, true);
  assert.equal(reopened[0].url(), "https://docs.example.com/");
  assert.equal(active.at(-1), mine, "back on the tab it started in");
  assert.match(detail, /closed 1 tab.*took a tab back.*reopened/);
  assert.equal(log.changes, 0);
});

test("undo: a tab opened and closed by the task leaves nothing to undo; unchanged tabs aren't touched", () => {
  const mine = fakeTab("https://a.example.com/");
  let pages = [mine];
  const log = new UndoLog({ active: mine });
  let m = log.before(mine, pages); // e.g. a scroll: same URL
  log.after(m, pages);
  const t = fakeTab("https://b.example.com/");
  m = log.before(mine, pages);
  pages = [mine, t];
  log.after(m, pages);
  m = log.before(t, pages);
  t.closed = true;
  pages = [mine];
  log.after(m, pages);
  assert.equal(log.changes, 0);
});
