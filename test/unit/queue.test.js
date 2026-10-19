/**
 * The task queue: one at a time, in order; queued items can be removed; cancel stops the running
 * one and the next starts; "working on n of total".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskQueue, parseInterrupt } from "../../src/queue.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A run function whose tasks finish when told to (or when cancelled). */
function controllable() {
  const started = [];
  const finishers = new Map();
  const run = (item, signal) =>
    new Promise((resolve) => {
      started.push(item.text);
      finishers.set(item.text, resolve);
      signal.addEventListener("abort", () => resolve("stopped"));
    });
  return { run, started, finish: (text, status = "done") => finishers.get(text)?.(status) };
}

test("runs one task at a time, in the order they came", async () => {
  const f = controllable();
  const q = new TaskQueue({ run: f.run });
  const ended = [];
  q.on("end", (it) => ended.push(`${it.text}:${it.status}`));
  q.enqueue({ text: "a" });
  q.enqueue({ text: "b" });
  q.enqueue({ text: "c" });
  await sleep(5);
  assert.deepEqual(f.started, ["a"]);
  assert.equal(q.state().running.text, "a");
  assert.deepEqual(q.state().queued.map((x) => x.text), ["b", "c"]);
  assert.deepEqual(q.state().position, { n: 1, of: 3 });
  f.finish("a");
  await sleep(5);
  assert.deepEqual(f.started, ["a", "b"]);
  assert.deepEqual(q.state().position, { n: 2, of: 3 });
  f.finish("b", "failed"); // a failure doesn't stop the queue
  await sleep(5);
  f.finish("c");
  await sleep(5);
  assert.deepEqual(ended, ["a:done", "b:failed", "c:done"]);
  assert.ok(q.idle);
  assert.equal(q.state().position, null);
  q.enqueue({ text: "d" });
  await sleep(5);
  assert.deepEqual(q.state().position, { n: 1, of: 1 }, "a new batch counts from 1");
});

test("a queued task can be removed; the running one can't", async () => {
  const f = controllable();
  const q = new TaskQueue({ run: f.run });
  const a = q.enqueue({ text: "a" });
  const b = q.enqueue({ text: "b" });
  q.enqueue({ text: "c" });
  assert.equal(q.remove(a.id), false);
  assert.equal(q.remove(b.id), true);
  assert.equal(q.remove(b.id), false);
  assert.deepEqual(q.state().queued.map((x) => x.text), ["c"]);
  f.finish("a");
  await sleep(5);
  assert.deepEqual(f.started, ["a", "c"]);
});

test("cancel stops the running task, the next one starts; clear drops the queue", async () => {
  const f = controllable();
  const q = new TaskQueue({ run: f.run });
  const ended = [];
  q.on("end", (it) => ended.push(`${it.text}:${it.status}`));
  q.enqueue({ text: "a" });
  q.enqueue({ text: "b" });
  q.enqueue({ text: "c" });
  assert.equal(q.cancel(), true);
  await sleep(5);
  assert.deepEqual(ended, ["a:stopped"]);
  assert.equal(q.state().running.text, "b");
  assert.deepEqual(q.clear().map((x) => x.text), ["c"]);
  q.cancel();
  await sleep(5);
  assert.deepEqual(ended, ["a:stopped", "b:stopped"]);
  assert.ok(q.idle);
  assert.equal(q.cancel(), false, "nothing to cancel");
});

test("an interrupting message goes to the front", async () => {
  const f = controllable();
  const q = new TaskQueue({ run: f.run });
  q.enqueue({ text: "a" });
  q.enqueue({ text: "b" });
  q.enqueue({ text: "now" }, { front: true });
  q.cancel("new message");
  await sleep(5);
  assert.deepEqual(f.started, ["a", "now"]);
});

test("ids: the caller's id is kept (the panel's message id), duplicates get a new one; errors count as failed", async () => {
  const q = new TaskQueue({ run: async (it) => { if (it.text === "boom") throw new Error("x"); } });
  const ends = [];
  q.on("end", (it) => ends.push(it.status));
  const a = q.enqueue({ id: "m1", text: "boom", thread: "c1" });
  assert.equal(a.id, "m1");
  assert.equal(q.state().running.thread, "c1");
  const b = q.enqueue({ id: "m1", text: "ok" });
  assert.notEqual(b.id, "m1");
  await sleep(5);
  assert.deepEqual(ends, ["failed", "done"]);
});

test("messages meant to interrupt", () => {
  assert.deepEqual(parseInterrupt("stop"), { rest: "" });
  assert.deepEqual(parseInterrupt("Stop!"), { rest: "" });
  assert.deepEqual(parseInterrupt("cancel that"), { rest: "" });
  assert.deepEqual(parseInterrupt("stop, open gmail instead"), { rest: "open gmail" });
  assert.deepEqual(parseInterrupt("no, stop. search for cats"), { rest: "search for cats" });
  assert.deepEqual(parseInterrupt("wait, use the second account"), { rest: "use the second account" });
  assert.deepEqual(parseInterrupt("never mind, play jazz"), { rest: "play jazz" });
  assert.deepEqual(parseInterrupt("actually, play jazz"), { rest: "play jazz" });
  assert.deepEqual(parseInterrupt("play jazz instead"), { rest: "play jazz" });
  assert.equal(parseInterrupt("stop the video"), null);
  assert.equal(parseInterrupt("wait for the page to load"), null);
  assert.equal(parseInterrupt("open youtube"), null);
  assert.equal(parseInterrupt("cancel my subscription"), null);
});
