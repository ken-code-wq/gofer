/**
 * A first-in, first-out task queue: one task runs at a time; messages that arrive meanwhile wait
 * their turn instead of cancelling it. It knows nothing about browsers: `run(item, signal)` does
 * the work and resolves (with "done" | "failed" | "stopped") when the task is finished. A
 * scheduler can push work through the same `enqueue()` the panel uses.
 *
 *   const q = new TaskQueue({ run: async (item, signal) => "done" });
 *   q.enqueue({ text: "open youtube" });      // runs now
 *   q.enqueue({ text: "then open gmail" });   // waits
 *   q.on("change", () => broadcast("queue", q.state()));
 */
import { EventEmitter } from "node:events";

let seq = 0;
const newId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

/** What the panel (and a scheduler) gets to see of an item. */
const pub = (it) => it && { id: it.id, text: it.text, thread: it.thread ?? null, source: it.source ?? null, at: it.at, ...(it.startedAt ? { startedAt: it.startedAt } : {}) };

export class TaskQueue extends EventEmitter {
  /** @param {{ run: (item: object, signal: AbortSignal) => Promise<string|void> }} opts */
  constructor({ run }) {
    super();
    this._run = run;
    this.items = []; // waiting, in order
    this.running = null;
    this.batch = 0; // tasks finished since the queue was last empty: "working on 2 of 3"
  }

  /**
   * Add a task. `front` puts it ahead of everything waiting (an interrupting message).
   * -> the item ({ id, text, thread, opts, status: "queued" | "running" }).
   */
  enqueue({ id, text, thread = null, opts = {}, source = null } = {}, { front = false } = {}) {
    if (this.running?.id === id || this.items.some((x) => x.id === id)) id = undefined; // ids are unique
    const item = { id: id || newId(), text: String(text ?? ""), thread, opts, source, status: "queued", at: Date.now() };
    front ? this.items.unshift(item) : this.items.push(item);
    this._changed();
    this._pump();
    return item;
  }

  /** Take a waiting task out. The running one can't be removed (cancel it). -> true if removed. */
  remove(id) {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    const [it] = this.items.splice(i, 1);
    it.status = "removed";
    this.emit("removed", it);
    this._changed();
    return true;
  }

  /** Drop every waiting task (Stop). -> the dropped items. */
  clear() {
    const gone = this.items.splice(0);
    for (const it of gone) (it.status = "removed"), this.emit("removed", it);
    if (gone.length) this._changed();
    return gone;
  }

  /** Ask the running task to stop (its signal aborts). The next one starts once it has. */
  cancel(reason = "stopped") {
    const r = this.running;
    if (!r || r.ac.signal.aborted) return false;
    r.cancelReason = reason;
    r.ac.abort(reason);
    return true;
  }

  get idle() {
    return !this.running && !this.items.length;
  }

  state() {
    const n = this.running ? this.batch + 1 : 0;
    return {
      running: pub(this.running),
      queued: this.items.map(pub),
      // "working on n of total"
      position: this.running ? { n, of: n + this.items.length } : null,
    };
  }

  _changed() {
    this.emit("change", this.state());
  }

  async _pump() {
    if (this.running || !this.items.length) return;
    const item = this.items.shift();
    item.status = "running";
    item.startedAt = Date.now();
    item.ac = new AbortController();
    this.running = item;
    this.emit("start", item);
    this._changed();
    let status;
    try {
      status = (await this._run(item, item.ac.signal)) || "done";
    } catch (err) {
      status = "failed";
      item.error = String(err?.message || err);
    }
    if (item.ac.signal.aborted && status === "done") status = "stopped";
    item.status = status;
    item.endedAt = Date.now();
    this.running = null;
    this.batch = this.items.length ? this.batch + 1 : 0;
    this.emit("end", item);
    this._changed();
    this._pump();
  }
}

// ── what a message sent during a task means ──────────────────────────

// "stop", "cancel", "wait!", "stop that, open gmail instead", "never mind, …", "scratch that …".
// "stop the video" or "wait for the page to load" are ordinary requests, so the word must stand alone.
const INTERRUPT_RE = /^(?:(?:no|nah|ok|okay)[,.!]?\s+)?(?:stop(?:\s+(?:it|that|this|now))?|cancel(?:\s+(?:it|that|this))?|halt|abort|wait|hold on|never\s?mind|forget (?:it|that)|scratch that)(?:\s*[,.!;:—–-]+\s*|\s*$)(.*)$/is;

/**
 * Is this message meant to interrupt the running task? -> { rest } ("" for a bare "stop") or null.
 * "…, instead" / "actually, …" replaces the running task with the message itself.
 */
export function parseInterrupt(text) {
  const t = String(text || "").trim();
  const m = t.match(INTERRUPT_RE);
  const tidy = (s) => s.trim().replace(/^(?:and\s+|then\s+)/i, "").replace(/[\s,]+instead[.!]?$/i, "").trim();
  if (m) return { rest: tidy(m[1]) };
  if (/^actually\s*[,:;—–-]\s*\S/i.test(t)) return { rest: tidy(t.replace(/^actually\s*[,:;—–-]\s*/i, "")) };
  if (/[\s,]instead[.!]?$/i.test(t) && t.split(/\s+/).length > 1) return { rest: tidy(t) };
  return null;
}
