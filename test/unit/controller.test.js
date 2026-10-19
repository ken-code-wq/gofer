/**
 * Controller flow with a mocked Jev and a fake browser: debounce, one action per utterance,
 * stale-request handling, candidate picking by number, chaining commands in one breath.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Controller } from "../../src/controller.js";
import { DEBOUNCE_MS, MAX_FINAL_WAITS } from "../../src/constants.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeBrowser() {
  return {
    url: "https://example.com/",
    onChange() {
      return () => {};
    },
    tabInfo() {
      return [{ index: 0, url: this.url, active: true }];
    },
    async snapshot() {
      return {
        url: this.url,
        title: "Example",
        site: "example_com",
        searchBoxId: null,
        elements: [
          { id: "e01", role: "link", text: "More information" },
          { id: "e02", role: "link", text: "Other link" },
        ],
        tabs: this.tabInfo(),
      };
    },
    overlayCalls: [],
    async overlay(fn, ...args) {
      this.overlayCalls.push([fn, ...args]);
    },
  };
}

/** Mock Jev: keyword-driven answers, with configurable latency. */
function mockDecide({ latency = 20, complete = (t) => (t.split(" ").length >= 2 ? 0.9 : 0.1) } = {}) {
  const calls = [];
  const fn = async ({ transcript }, { signal } = {}) => {
    calls.push(transcript);
    await sleep(latency);
    if (signal?.aborted) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    const t = transcript.toLowerCase();
    const ch = (c, conf = 0.95, extra = {}) => ({ type: "choice", choice: c, confidence: conf, probabilities: { [c]: conf, ...extra } });
    let intent = ch("none", 0.9);
    let target = ch("none", 0.9);
    if (t.startsWith("vague")) intent = ch("search_web", 0.4);
    else if (t.startsWith("go back")) intent = ch("go_back");
    else if (t.startsWith("scroll")) intent = ch("scroll_down");
    else if (t.startsWith("click ambiguous")) {
      intent = ch("click_element");
      target = ch("e01", 0.2, { e02: 0.4, none: 0.2 });
    } else if (t.startsWith("click")) {
      intent = ch("click_element");
      target = ch("e01", 0.95);
    }
    return {
      answers: {
        intent,
        target,
        site: ch("none"),
        complete: { noul: complete(t) },
        is_command: { noul: intent.choice === "none" || t.startsWith("chit chat") ? 0.1 : 0.95 },
        destructive: { noul: 0.02 },
        scroll_amount: { score: 1, confidence: 0.9, probabilities: {} },
        tab_direction: ch("none"),
      },
      latencyMs: latency,
      usage: { input_tokens: 1000, output_tokens: 10 },
      costUsd: 0.000042,
      model: "jev-1.13.0",
      requestId: "req",
      candidates: { text: [], url: [] },
      state: {},
      questionCount: 8,
    };
  };
  fn.calls = calls;
  return fn;
}

function setup(opts = {}) {
  const browser = fakeBrowser();
  const executed = [];
  const decideFn = mockDecide(opts);
  const executeFn = async (action) => {
    executed.push(action);
    await sleep(opts.execMs ?? 10);
    return { ok: true, detail: "ok" };
  };
  const c = new Controller({ browser, decideFn, executeFn, persist: false });
  return { c, browser, executed, decideFn };
}

test("debounces partials into one request and acts once per utterance", async () => {
  const { c, executed, decideFn } = setup();
  await c.start();
  c.handleTranscript({ text: "go", final: false, utteranceId: "u1" });
  await sleep(50);
  c.handleTranscript({ text: "go back", final: false, utteranceId: "u1" });
  await sleep(DEBOUNCE_MS + 150);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].type, "go_back");
  assert.equal(decideFn.calls.length, 1, "first partial was debounced away");
  // the rest of the same utterance is ignored
  c.handleTranscript({ text: "go back please", final: true, utteranceId: "u1" });
  await sleep(DEBOUNCE_MS + 100);
  assert.equal(executed.length, 1);
  assert.equal(c.uiState().stats.calls, 1);
  assert.ok(c.uiState().stats.costUsd > 0);
  await c.close();
});

test("waits on an incomplete partial, then acts when the recognizer marks it final", async () => {
  const { c, executed } = setup();
  await c.start();
  c.handleTranscript({ text: "scroll", final: false, utteranceId: "u2" });
  await sleep(DEBOUNCE_MS + 100);
  assert.equal(executed.length, 0);
  assert.equal(c.lastDecision.policy.decision, "wait");
  c.handleTranscript({ text: "scroll", final: true, utteranceId: "u2" });
  await sleep(150);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].type, "scroll_down");
  await c.close();
});

test("cancels stale in-flight requests beyond MAX_INFLIGHT", async () => {
  const { c, executed, decideFn } = setup({ latency: 400 });
  await c.start();
  c.handleTranscript({ text: "go", final: false, utteranceId: "u3" });
  await sleep(DEBOUNCE_MS + 20);
  c.handleTranscript({ text: "go ba", final: false, utteranceId: "u3" });
  await sleep(DEBOUNCE_MS + 20);
  c.handleTranscript({ text: "go back", final: false, utteranceId: "u3" });
  await sleep(DEBOUNCE_MS + 20);
  assert.equal(c.inflight.length, 2, "oldest request aborted, two in flight");
  await sleep(600);
  assert.equal(executed.length, 1);
  assert.equal(decideFn.calls.length, 3);
  await c.close();
});

test("ambiguous target shows numbered candidates; a spoken number picks without a model call", async () => {
  const { c, executed, browser, decideFn } = setup();
  await c.start();
  c.handleTranscript({ text: "click ambiguous thing", final: true, utteranceId: "u4" });
  await sleep(150);
  assert.equal(executed.length, 0);
  assert.ok(c.candidates, "candidates pending");
  assert.deepEqual(
    c.candidates.list.map((x) => x.id),
    ["e02", "e01"],
  );
  assert.ok(browser.overlayCalls.some(([fn]) => fn === "candidates"));
  const callsBefore = decideFn.calls.length;
  c.handleTranscript({ text: "the second one", final: true, utteranceId: "u5" });
  await sleep(100);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].targetId, "e01");
  assert.equal(decideFn.calls.length, callsBefore, "no Jev call for the number");
  await c.close();
});

test("commands spoken in one breath: words after an executed command become a new command", async () => {
  const { c, executed } = setup();
  await c.start();
  c.handleTranscript({ text: "go back", final: false, utteranceId: "u6" });
  await sleep(DEBOUNCE_MS + 150);
  assert.equal(executed.length, 1);
  c.handleTranscript({ text: "go back scroll down", final: false, utteranceId: "u6" });
  await sleep(DEBOUNCE_MS + 150);
  assert.equal(executed.length, 2);
  assert.equal(executed[1].type, "scroll_down");
  // one trailing word is ignored
  c.handleTranscript({ text: "go back scroll down please", final: true, utteranceId: "u6" });
  await sleep(DEBOUNCE_MS + 150);
  assert.equal(executed.length, 2);
  await c.close();
});

test("typed command is treated as a final utterance", async () => {
  const { c, executed } = setup();
  await c.start();
  c.handleCommand("go back");
  await sleep(150);
  assert.equal(executed.length, 1);
  await c.close();
});

test("typed chain runs its steps in order, one after another", async () => {
  const { c, executed } = setup();
  const events = [];
  c.on("chain", (e) => events.push(e.status));
  await c.start();
  c.handleCommand("scroll down, go back, then click the link");
  for (let i = 0; i < 60 && events.at(-1) !== "done"; i++) await sleep(100);
  assert.deepEqual(executed.map((a) => a.type), ["scroll_down", "go_back", "click_element"]);
  assert.deepEqual(events, ["running", "running", "running", "done"]);
  assert.equal(c.chain, null);
  await c.close();
});

test("chain stops at a step that isn't a browser command", async () => {
  const { c, executed } = setup();
  const events = [];
  c.on("chain", (e) => events.push(e));
  await c.start();
  c.handleCommand("scroll down, chit chat about lunch, go back");
  for (let i = 0; i < 40 && events.at(-1)?.status !== "failed"; i++) await sleep(100);
  assert.deepEqual(executed.map((a) => a.type), ["scroll_down"]);
  assert.equal(events.at(-1).status, "failed");
  assert.equal(events.at(-1).index, 1);
  await c.close();
});

test("a finished command that stays unclear is given up instead of retried forever", async () => {
  const { c, executed, decideFn } = setup();
  let gaveUp = null;
  c.on("gaveup", (e) => (gaveUp = e));
  await c.start();
  c.handleCommand("vague thing");
  for (let i = 0; i < 50 && !gaveUp; i++) await sleep(100);
  assert.ok(gaveUp, "gave up");
  assert.equal(decideFn.calls.length, MAX_FINAL_WAITS);
  await sleep(1200);
  assert.equal(decideFn.calls.length, MAX_FINAL_WAITS, "no more requests after giving up");
  assert.equal(executed.length, 0);
  await c.close();
});

test("chain runs wait/check steps in code and stops with the reason when a check fails", async () => {
  const { c, executed, decideFn } = setup();
  c._execute = async (action) => {
    executed.push(action);
    if (action.type === "assert_text") return { ok: false, detail: `check failed: ${action.label}`, screenshot: "/tmp/x.png" };
    return { ok: true, detail: "ok" };
  };
  const events = [];
  c.on("chain", (e) => events.push(e));
  await c.start();
  c.handleCommand(`scroll down, wait 1 ms, check that the page says "Approved", go back`);
  for (let i = 0; i < 60 && !["done", "failed"].includes(events.at(-1)?.status); i++) await sleep(100);
  assert.deepEqual(executed.map((a) => a.type), ["scroll_down", "wait_ms", "assert_text"]);
  const end = events.at(-1);
  assert.equal(end.status, "failed");
  assert.match(end.reason, /Approved/);
  assert.equal(end.screenshot, "/tmp/x.png");
  assert.equal(decideFn.calls.filter((t) => /wait|check/.test(t)).length, 0, "no model call for wait/check");
  await c.close();
});

test("threads: results are recorded per thread; follow-ups use the thread and go to the brain", async () => {
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const { c, executed } = setup();
  const errors = [];
  c.on("smart-error", (e) => errors.push(e));
  await c.start();
  c.handleCommand("scroll down", { thread: "t1" });
  for (let i = 0; i < 30 && !executed.length; i++) await sleep(50);
  await sleep(100);
  const t = c.threads.get("t1");
  assert.deepEqual(t.turns.map((x) => x.role), ["user", "result"]);
  assert.match(t.turns[1].text, /scroll/);
  c.handleCommand("delete the first 10", { thread: "t1", followUp: true });
  await sleep(50);
  assert.equal(errors.length, 1, "follow-up was routed to the brain (which is unavailable here)");
  assert.match(c._threadContext(t), /User: scroll down\nResult: did: scroll/);
  // a new command without followUp starts its own thread
  c.handleCommand("scroll down", { thread: "t2" });
  assert.equal(c.threads.get("t2").turns.length, 1);
  if (saved) process.env.GEMINI_API_KEY = saved;
  await c.close();
});

test("saved goals replay their recorded steps without a model, asking before risky ones", async () => {
  const { stepFromAction, finalizeRecipe } = await import("../../src/recipe.js");
  const recorded = { elements: [{ id: "e1", role: "button", text: "New bill" }, { id: "e2", role: "textbox", text: "Vendor" }, { id: "e3", role: "button", text: "Delete bill" }] };
  const recipe = finalizeRecipe([
    stepFromAction({ type: "click_element", targetId: "e1" }, recorded),
    stepFromAction({ type: "type_into_field", targetId: "e2", text: "Acme" }, recorded),
    stepFromAction({ type: "click_element", targetId: "e3" }, recorded),
  ]);
  const browser = fakeBrowser();
  // the live page has different ids
  browser.snapshot = async () => ({ url: browser.url, title: "Bills", site: "x", elements: [{ id: "z7", role: "textbox", text: "Vendor" }, { id: "z8", role: "button", text: "New bill" }, { id: "z9", role: "button", text: "Delete bill" }], tabs: [] });
  const done = [];
  const c = new Controller({
    browser,
    decideFn: async () => { throw new Error("no model calls in a replay"); },
    executeFn: async (a) => { done.push(a); return { ok: true, detail: "ok" }; },
    persist: false,
  });
  const events = [];
  c.on("goal", (g) => events.push(g));
  let confirm = null;
  c.on("goal-confirm", (p) => (confirm = p));
  c._replay({ name: "new-bill", text: "create a bill", recipe, values: { vendor: "Globex" } });
  for (let i = 0; i < 100 && !confirm; i++) await sleep(20);
  assert.deepEqual(done.map((a) => [a.type, a.targetId, a.text]), [["click_element", "z8", undefined], ["type_into_field", "z7", "Globex"]]);
  assert.match(confirm.description, /Delete bill/);
  await c.goalAnswer(true);
  for (let i = 0; i < 100 && events.at(-1)?.status !== "done"; i++) await sleep(20);
  assert.equal(done.at(-1).targetId, "z9");
  assert.equal(events.at(-1).status, "done");
  assert.equal(events.at(-1).recipe, undefined, "a replay doesn't offer to save itself again");
});

test("Ask mode: anything typed is a question, never a browser action", async () => {
  const { isTabsQuestion } = await import("../../src/smart.js");
  assert.ok(isTabsQuestion("which of my tabs has the cheapest flight"));
  assert.ok(isTabsQuestion("compare the prices across my tabs"));
  assert.ok(!isTabsQuestion("open a new tab"));
  const saved = { gemini: process.env.GEMINI_API_KEY, brain: process.env.BRAIN_PROVIDER };
  delete process.env.GEMINI_API_KEY;
  delete process.env.BRAIN_PROVIDER;
  const decide = mockDecide();
  const c = new Controller({ browser: fakeBrowser(), decideFn: decide.fn ?? decide, executeFn: async () => ({ ok: true }), persist: false });
  const errors = [];
  c.on("smart-error", (e) => errors.push(e));
  c.handleCommand("click the delete button", { ask: true });
  c.handleCommand("which of my tabs is cheapest", {});
  await sleep(DEBOUNCE_MS + 100);
  assert.deepEqual(errors.map((e) => e.kind), ["ask", "ask"], "both went to the question path (no AI configured here)");
  assert.equal((decide.calls || []).length, 0, "SubQ was never asked to act");
  if (saved.gemini) process.env.GEMINI_API_KEY = saved.gemini;
  if (saved.brain) process.env.BRAIN_PROVIDER = saved.brain;
});
