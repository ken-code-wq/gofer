/**
 * Tasks: what happens to a message while the agent is busy, bound to the Controller.
 *
 *   controller.enqueue({ id, text, thread, opts })  -> { id, kind }
 *     kind "run"       nothing was running: it starts now
 *          "queued"    it waits for the running task (and any queued before it)
 *          "side"      a question about the page: answered right away from the tab you're looking at,
 *                      next to the running task (reading a page doesn't get in the agent's way)
 *          "interrupt" "stop, …" / "actually, …" / "… instead": the running task stops, this runs next
 *          "stop"      a bare "stop": same as the Stop button (stops the task, drops the queue)
 *          "reply"     an answer the running task is waiting for ("confirm", "2", "yes"): goes straight to it
 *
 * The state ("queue" WebSocket message, see state()) is emitted as "change":
 *   { running, queued, position: { n, of }, side, paused, canTakeOver, background, undo }
 *
 * A task is finished when the controller reports a result for it (the same events the panel shows
 * as the reply), or, for requests that end without one, once nothing has been running for a moment.
 */
import { EventEmitter } from "node:events";
import { TaskQueue, parseInterrupt } from "./queue.js";
import { UndoLog } from "./undo.js";
import { Takeover } from "./takeover.js";
import { placeAction, isPinnedToTab } from "./background.js";
import { routeSmart, answerQuestion, answerAcrossTabs, isTabsQuestion } from "./smart.js";
import { parseMemoryCommand } from "./memory.js";
import { parseCandidatePick } from "./spans.js";
import { hasBrain } from "./brain.js";
import { CANDIDATE_TTL_MS } from "./constants.js";

/** Controller events that can end a task. */
export const RESULT_EVENTS = ["goal", "chain", "answer", "utility", "table", "fill", "smart-error", "tab-error", "gaveup", "tab-switched", "action", "decision", "stopped"];

/**
 * Does this controller event finish the running task? -> "done" | "failed" | "stopped" | null.
 * `busy` = what is still in progress right after it ({ goal, chain }).
 */
export function resultOf(type, p = {}, { goal = null, chain = null } = {}) {
  switch (type) {
    case "goal":
      return p.status === "done" ? "done" : p.status === "failed" ? "failed" : p.status === "cancelled" ? "stopped" : null;
    case "chain":
      return p.status === "done" ? "done" : p.status === "failed" ? "failed" : p.status === "cancelled" ? "stopped" : null;
    case "answer":
    case "utility":
    case "table":
    case "fill":
      return "done";
    case "smart-error":
    case "tab-error":
    case "gaveup":
      return "failed";
    case "tab-switched":
      return p.rest ? null : "done";
    case "action": // a single Direct-mode step; goal and chain steps report through their own events
      return p.via === "goal" || goal || chain ? null : p.ok === false ? "failed" : "done";
    case "decision":
      return p.policy?.decision === "ignore" && !chain ? "done" : null;
    case "stopped":
      return "stopped";
    default:
      return null;
  }
}

const YES_NO = /^(?:confirm|yes|yep|ok|okay|go ahead|do it|allow|cancel|no|nope|stop|don'?t)[.!]?$/i;

/** A message that answers what the running task is waiting for (a confirmation, "which one?"). */
export function isReply(c, text) {
  const t = String(text || "").trim();
  if (c.goal?.awaiting && YES_NO.test(t)) return true;
  if (c.pending && YES_NO.test(t)) return true;
  if (c.candidates && Date.now() - c.candidates.at < CANDIDATE_TTL_MS && parseCandidatePick(t, c.candidates.list.length)) return true;
  return false;
}

/** A question that can be answered while a task runs (it only reads the page you're looking at). */
export function isSideQuestion(text, opts = {}) {
  if (!opts.chat && !opts.ask) return false;
  if (parseMemoryCommand(text) || parseInterrupt(text)) return false;
  return Boolean(opts.ask || routeSmart(text)?.kind === "ask");
}

let sideSeq = 0;

export class TaskRunner extends EventEmitter {
  /** @param {import('./controller.js').Controller} controller */
  constructor(controller, { idleMs = 2500, pollMs = 250, pendingMs = 60000 } = {}) {
    super();
    this.c = controller;
    this.idleMs = idleMs;
    this.pollMs = pollMs;
    this.pendingMs = pendingMs; // a forgotten "confirm?" doesn't hold the queue forever
    this.queue = new TaskQueue({ run: (item, signal) => this._run(item, signal) });
    this.takeover = new Takeover();
    this.side = new Map(); // id -> { id, text }: questions being answered next to the running task
    this.log = null; // UndoLog of the running task
    this.undo = null; // { id, text, log }: offered after a task is stopped or fails
    this.lastThread = undefined;
    this._last = "";

    this.queue.on("start", (item) => {
      this.undo = null; // the next task builds on where things are now
      item.pinned = isPinnedToTab(item.text);
      this.log = new UndoLog({ active: controller.browser.page });
    });
    this.queue.on("end", (item) => {
      if ((item.status === "stopped" || item.status === "failed") && this.log?.changes) this.undo = { id: item.id, text: item.text, log: this.log };
      this.log = null;
      this.takeover.cancel();
    });
    this.queue.on("change", () => this._changed());
    this.takeover.on("change", () => this._changed());
    controller.on("goal", (p) => {
      if (p.status !== "running" && p.status !== "awaiting") this.takeover.cancel();
      this._changed();
    });
    controller.on("pending", (p) => (this._pendingAt = p ? Date.now() : 0));
    controller.browser.onChange?.(() => this._changed());
  }

  // ── the API ─────────────────────────────────────────────────

  enqueue({ id, text, thread = null, opts = {}, source = null } = {}) {
    const c = this.c;
    text = String(text ?? "").trim();
    if (!text) return null;
    const busy = !this.queue.idle;
    if (opts.reply || (busy && isReply(c, text))) {
      c.handleCommand(text, { ...opts, thread });
      return { id: id ?? null, kind: "reply" };
    }
    const intr = parseInterrupt(text);
    if (intr && !intr.rest) {
      this.stop();
      return { id: id ?? null, kind: "stop" };
    }
    if (busy && intr) {
      const item = this.queue.enqueue({ id, text: intr.rest, thread, opts, source }, { front: true });
      this.queue.cancel("new message");
      return { id: item.id, kind: "interrupt" };
    }
    if (busy && isSideQuestion(text, opts) && hasBrain()) {
      id ||= `s${Date.now().toString(36)}${(sideSeq++).toString(36)}`;
      this._side({ id, text, thread, opts });
      return { id, kind: "side" };
    }
    const item = this.queue.enqueue({ id, text, thread, opts, source });
    return { id: item.id, kind: busy ? "queued" : "run" };
  }

  /** Take a queued message out before it runs. */
  remove(id) {
    return this.queue.remove(id);
  }

  /** The Stop button: stop the running task and drop everything queued. -> dropped items. */
  stop() {
    const dropped = this.queue.clear();
    if (!this.queue.cancel("stopped")) this.c.stop();
    return dropped;
  }

  /** "Take over": pause the goal after its current step and show its tab. */
  takeOver() {
    if (!this.c.goal || this.c.goal.replay) return false;
    if (!this.takeover.request("user")) return false;
    this.c.browser.show?.(this.c.browser.page);
    return true;
  }

  /** "Hand back": the goal carries on from the page as it is now. */
  handBack() {
    return this.takeover.handBack();
  }

  /** "Go back to where I was": restore what the last stopped/failed task changed. -> summary or null. */
  async undoTask(id = null) {
    const u = this.undo;
    if (!u || (id && u.id !== id) || !this.queue.idle) return null;
    this.undo = null;
    this._changed();
    const detail = await u.log.restore(this.c.browser);
    await this.c.refreshSnapshot().catch(() => {});
    this.c.emit("task-undo", { id: u.id, detail });
    return detail;
  }

  state() {
    const b = this.c.browser;
    return {
      ...this.queue.state(),
      side: [...this.side.values()],
      paused: this.takeover.info(),
      canTakeOver: Boolean(this.queue.running && this.c.goal && !this.c.goal.replay),
      // the agent is working in a tab you're not looking at
      background: Boolean(this.queue.running && b.page && b.shown && b.page !== b.shown),
      undo: this.undo ? { id: this.undo.id, text: this.undo.text, changes: this.undo.log.changes } : null,
    };
  }

  // ── hooks the controller calls ──────────────────────────────

  /** Before every executed action: note where the agent's tab was (for undo). */
  beforeAction() {
    return this.log ? this.log.before(this.c.browser.page, this.c.browser.pages || []) : null;
  }

  afterAction(mark) {
    if (mark) this.log?.after(mark, this.c.browser.pages || []);
  }

  /** A goal step about to run: don't navigate the tab you're looking at away (see background.js). */
  place(action) {
    const b = this.c.browser;
    const page = b.page;
    let url = "";
    try {
      url = page?.url?.() || "";
    } catch {}
    return placeAction(action, { onShownTab: b.isShown ? b.isShown(page) : false, pageUrl: url, pinned: Boolean(this.queue.running?.pinned), ownTab: Boolean(page && this.log?.opened.has(page)) });
  }

  /**
   * The goal loop is about to take a step: if the user took over (or the goal asked them to), wait
   * here until they hand back. -> { resumed } | { cancelled } (or null if nothing to wait for).
   */
  async pauseIfWanted(g) {
    if (this.takeover.state === "idle") return null;
    const c = this.c;
    const need = this.takeover.reason === "need_user";
    const msg = this.takeover.message;
    const entry = { text: need ? `Your turn: ${msg || "the page needs you"}` : "You took over", status: "awaiting" };
    g.steps.push(entry);
    c._emitGoal(g, "running");
    await c.browser.show?.(c.browser.page);
    const r = await this.takeover.pause();
    entry.status = r.cancelled ? "ignored" : "ok";
    if (!r.cancelled) {
      entry.text = need ? `You took care of it: ${msg || "the page needed you"}` : "You took over, then handed back";
      g.done.push({ description: entry.text, outcome: "the user acted in the browser, then handed back" });
      c._emitGoal(g, "running");
      await c.refreshSnapshot().catch(() => {});
    }
    return r;
  }

  /** The goal says only the user can do the next bit (login, captcha). */
  needUser(message) {
    this.takeover.request("need_user", message);
  }

  // ── internals ───────────────────────────────────────────────

  _changed() {
    const s = this.state();
    const json = JSON.stringify(s);
    if (json === this._last) return;
    this._last = json;
    this.emit("change", s);
  }

  _idle() {
    const c = this.c;
    const pending = c.pending && Date.now() - (this._pendingAt || 0) < this.pendingMs;
    const choosing = c.candidates && Date.now() - c.candidates.at < CANDIDATE_TTL_MS;
    return !c.goal && !c.chain && !c.busy && !c.inflight?.length && !pending && !choosing && this.takeover.state === "idle";
  }

  /** Run one queued message to the end. */
  _run(item, signal) {
    const c = this.c;
    return new Promise((resolve) => {
      let finished = false;
      let started = false; // handleCommand has returned: the queue never moves on before that
      let early = null; // a result that came while it was still working out what to do
      let timer = null;
      const handlers = RESULT_EVENTS.map((type) => [
        type,
        (p) => {
          if (p?.task && p.task !== item.id) return; // a side question's answer
          const s = resultOf(type, p || {}, c);
          if (s) finish(s);
        },
      ]);
      const onAbort = () => c.stop(signal.reason === "new message" ? "new message" : "Stopped");
      const finish = (status) => {
        if (finished) return;
        if (!started) return void (early ||= status);
        finished = true;
        for (const [t, h] of handlers) c.off(t, h);
        signal.removeEventListener("abort", onAbort);
        clearInterval(timer);
        // after every other listener of the event that ended it (the panel gets the result first)
        setTimeout(() => resolve(status), 0);
      };
      for (const [t, h] of handlers) c.on(t, h);
      signal.addEventListener("abort", onAbort, { once: true });

      this._prepare(item)
        .then(() => (signal.aborted ? null : c.handleCommand(item.text, { ...item.opts, thread: item.thread })))
        .then(
          () => {
            started = true;
            // stopped while it was still working out what to do: don't let the goal it started run on
            if (signal.aborted) {
              if (c.goal) c._endGoal(c.goal, "cancelled", signal.reason === "new message" ? "new message" : "Stopped");
              return finish("stopped");
            }
            if (early) return finish(early);
            // some requests end without a result (a Direct phrase that wasn't a command): done once idle
            let since = 0;
            timer = setInterval(() => {
              if (!this._idle()) return void (since = 0);
              since ||= Date.now();
              if (Date.now() - since >= this.idleMs) finish("done");
            }, this.pollMs);
          },
          (err) => {
            started = true;
            c.emit("smart-error", { kind: "task", text: item.text, error: String(err?.message || err) });
            finish("failed");
          },
        );
    });
  }

  /** A new chat starts in the tab you're looking at, not wherever the last chat's task left the agent. */
  async _prepare(item) {
    const b = this.c.browser;
    const fresh = this.lastThread !== undefined && item.thread !== this.lastThread;
    this.lastThread = item.thread;
    if (fresh && b.visiblePage && !isPinnedToTab(item.text)) {
      const p = await b.visiblePage().catch(() => null);
      if (p && p !== b.page) await b.setActive(p);
    }
  }

  /** Answer a question about the page you're looking at, next to the running task. */
  async _side({ id, text, thread, opts }) {
    const c = this.c;
    this.side.set(id, { id, text });
    this._changed();
    // record it in its chat without moving the running task's thread
    const prev = c.thread;
    c._enterThread?.(text, { thread });
    const t = c.thread;
    c.thread = prev;
    try {
      const smart = routeSmart(text);
      const question = smart?.kind === "ask" ? smart.question : text.replace(/^(?:ask|q)\s*:\s*/i, "");
      const context = opts.followUp || opts.chat ? c._threadContext?.(t) || "" : "";
      const mentions = [...text.matchAll(/@\[([^\]]+)\]/g)].map((m) => m[1]);
      let r;
      if (mentions.length >= 2 || isTabsQuestion(text)) {
        r = { ...(await answerAcrossTabs(c, question.replace(/@\[([^\]]+)\]/g, "“$1”"), mentions.length >= 2 ? mentions : null, context)), scope: "tabs" };
      } else {
        const page = await c.browser.visiblePage();
        r = await answerQuestion(c, question, context, { page });
      }
      if (t) c._note?.(t, `answer: ${r.answer}`);
      c._log?.("act", `answer next to the running task (${r.model}): ${r.answer}`);
      c.emit("answer", { question: text, ...r, task: id });
    } catch (err) {
      c.emit("smart-error", { kind: "ask", text, error: String(err?.message || err), task: id });
    } finally {
      this.side.delete(id);
      this._changed();
    }
  }
}
