/**
 * Orchestrator: transcript updates -> (debounce, cancel stale) -> one Jev request ->
 * policy -> Playwright action -> fresh snapshot. Emits events for the UI / demo / tests.
 */
import { EventEmitter } from "node:events";
import { DEBOUNCE_MS, SILENCE_COMPLETE_MS, CANDIDATE_TTL_MS, MAX_INFLIGHT, MAX_CONTEXT_ACTIONS, MAX_FINAL_WAITS, CHAIN_SETTLE_MS, MODEL, T } from "./constants.js";
import { decide, isAbortError } from "./jev.js";
import { evaluatePolicy, describe } from "./policy.js";
import { execute } from "./executor.js";
import { parseCandidatePick, cleanTranscript } from "./spans.js";
import { approxTokens } from "./snapshot.js";
import { planChain } from "./chain.js";
import { parseCheck } from "./checks.js";
import { resolveSaved } from "./store.js";
import { routeSmart, answerQuestion, fillForm, nextGoalStep, verifyGoal, resolveFollowUp, toAction, MAX_GOAL_STEPS } from "./smart.js";
import { hasBrain } from "./brain.js";
import { parseUtility, runUtility, copyToClipboard } from "./utility.js";
import { parseTableRequest, domTable, toTSV, saveCSV } from "./table.js";
import { extractTable, replayFill, answerAcrossTabs, isTabsQuestion } from "./smart.js";
import { LimitError } from "./usage.js";
import { stepFromAction, stepFromFill, finalizeRecipe, findElement, describeStep } from "./recipe.js";
import { parseTabMention, matchTab } from "./tabs.js";
import { fillForm as fillFormFn } from "./smart.js";

const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

export class Controller extends EventEmitter {
  /**
   * @param {{browser: import('./browser.js').BrowserManager, decideFn?: Function, executeFn?: Function}} opts
   *   decideFn / executeFn are injectable for tests (default: real Jev + Playwright).
   */
  constructor({ browser, decideFn = decide, executeFn = execute }) {
    super();
    this.browser = browser;
    this._decide = decideFn;
    this._execute = executeFn;
    this.snapshot = null;
    this.snapshotAt = 0;
    this.utterance = null; // { id, physicalId, prefix, gen, text, final, startedAt, updatedAt, actedOn, actedText }
    this.consumed = null; // { id: physical utterance id, prefix: executed text (lowercase), gen }
    this.pending = null; // destructive action awaiting "confirm"
    this.candidates = null; // { list: [{n,id,label}], intent: {type,text}, at }
    this.lastDecision = null;
    this.chain = null; // { id, text, steps, i, awaiting } — multi-step typed command in progress
    this.goal = null; // { goal, steps, done, awaiting, cancelled } — brain-driven goal in progress
    // Conversation threads from the bar: a follow-up ("delete the first 10") runs with what happened
    // earlier in its thread, in the tab that thread was using.
    this.threads = new Map(); // id -> { turns: [{ role: "user"|"result", text }], page }
    this.thread = null; // thread of the command being handled
    this.debounceTimer = null;
    this.silenceTimer = null;
    this.inflight = []; // [{ac, text, at}] requests currently awaiting Jev
    this.busy = false;
    this.log = [];
    this.stats = { calls: 0, inputTokens: 0, costUsd: 0, latencies: [], actions: 0, model: MODEL, commandToActionMs: [], decisionMs: [] };
    this.history = [];
    // Conversation context sent to Jev with every request (see jev.encodeContext):
    // the page before the last navigation and the last few executed actions.
    this.context = { previousPage: null, recentActions: [] };
    browser.onChange(() => this.emit("tabs", browser.tabInfo()));
  }

  async start() {
    await this.refreshSnapshot();
    this._log("info", `ready: model ${MODEL}, ${this.snapshot.elements.length} elements on ${this.snapshot.url}`);
  }

  _log(level, msg, extra = {}) {
    const entry = { t: Date.now(), level, msg, ...extra };
    this.log.push(entry);
    if (this.log.length > 200) this.log.shift();
    this.emit("log", entry);
  }

  async refreshSnapshot() {
    this.snapshot = await this.browser.snapshot();
    this.snapshotAt = Date.now();
    this.emit("snapshot", this.snapshot);
    return this.snapshot;
  }

  /**
   * Typed command: behaves like a final utterance. "open youtube, theo t3.gg's channel" becomes a
   * chain of steps (see chain.js) run one after another.
   */
  handleCommand(text, opts = {}) {
    if (!opts.inner) this._enterThread(text, opts);
    // Questions: Ask mode in the bar, or worded as a question. Two or more @tabs, or "my tabs",
    // means read those tabs together; otherwise the current page (or general knowledge).
    const isAsk = opts.ask || routeSmart(text)?.kind === "ask";
    if (isAsk && !opts.inner) {
      const mentions = [...text.matchAll(/@\[([^\]]+)\]/g)].map((m) => m[1]);
      if (mentions.length >= 2 || isTabsQuestion(text)) return this._askTabs(text, mentions.length >= 2 ? mentions : null);
    }
    if (opts.ask && !parseTabMention(text)) {
      if (!hasBrain()) return this.emit("smart-error", { kind: "ask", text, error: "Questions need an AI model in .env (BRAIN_PROVIDER + BRAIN_API_KEY, or a free GEMINI_API_KEY)" });
      if (this.goal) this._endGoal(this.goal, "cancelled", "new command");
      return this._ask(text.replace(/^(?:ask|q)\s*:\s*/i, ""), opts.followUp ? this._threadContext(this.thread) : "");
    }
    const saved = resolveSaved(text);
    if (saved?.missing) {
      this.emit("smart-error", { kind: "saved", text, error: `"${saved.name}" needs ${saved.missing.map((m) => (m === "value" ? "a value" : m)).join(", ")}. Type it after the name, like: ${saved.name} ${saved.missing.map((m) => `<${m}>`).join(", ")}` });
      return;
    }
    if (saved?.recipe) return this._replay(saved);
    if (saved) {
      this._log("info", `saved command "${saved.name}" → ${saved.text}`);
      this.emit("expanded", { name: saved.name, text: saved.text });
      text = saved.text;
    }
    // "screenshot", "copy url": instant, no model.
    const util = parseUtility(text);
    if (util) return this._utility(util);
    // "copy the table", "copy all invoice numbers as a table"
    const tableReq = parseTableRequest(text);
    if (tableReq) return this._table(tableReq);
    // "go to @[Bills - Acme Books] and create a new bill": switch tabs first, then run the rest there.
    const mention = parseTabMention(text);
    if (mention) return this._inTab(mention, opts);

    // Follow-up in a thread: back to that thread's tab, and let the brain use the conversation so far.
    if (opts.followUp && !opts.inner && this.thread?.turns.length > 1) return this._followUp(text);

    // A goal waiting for "confirm": typed yes/no answers it; anything else cancels the goal.
    if (this.goal?.awaiting && /^(?:confirm|yes|ok|go ahead|do it)$/i.test(text.trim())) return this.goalAnswer(true);
    if (this.goal?.awaiting && /^(?:cancel|no|stop|don'?t)$/i.test(text.trim())) return this.goalAnswer(false);
    if (this.goal) this._endGoal(this.goal, "cancelled", "new command");

    // Questions, goals and forms go to the brain (before chain splitting: forms contain commas).
    const smart = routeSmart(text);
    if (smart) {
      if (this.chain) this._endChain("cancelled", "new command");
      if (!hasBrain()) {
        this._log("error", "Smart commands need an AI model: set BRAIN_PROVIDER + BRAIN_API_KEY, or GEMINI_API_KEY, in .env");
        this.emit("smart-error", { kind: smart.kind, text, error: "Add an AI model to .env (BRAIN_PROVIDER + BRAIN_API_KEY, or a free GEMINI_API_KEY) to use questions, goals and forms" });
        return;
      }
      if (smart.kind === "ask") return this._ask(smart.question);
      if (smart.kind === "fill") return this._fill(smart.spec);
      return this._startGoal(smart.goal);
    }

    const steps = planChain(text);
    if (steps.length) return this._startChain(text, steps);
    // While a chain waits for "confirm" / a number, the reply belongs to it; anything else cancels it.
    if (this.chain && !this.chain.awaiting) this._endChain("cancelled", "new command");
    const check = parseCheck(text);
    if (check) return this._runAction(check, { via: "check", said: text });
    return this.handleTranscript({ text, final: true, utteranceId: `typed-${Date.now()}` });
  }

  _startChain(text, steps) {
    if (this.chain) this._endChain("cancelled", "new chain");
    this.chain = { id: `chain-${Date.now()}`, text, steps, i: 0, awaiting: false, thread: this.thread };
    this._log("info", `chain of ${steps.length} steps: ${steps.map((s, i) => `${i + 1}. ${s}`).join(" · ")}`);
    this._runChainStep();
  }

  _runChainStep() {
    const c = this.chain;
    if (!c) return;
    c.awaiting = false;
    this._emitChain("running");
    // wait / check steps are handled in code, without a model call
    const check = parseCheck(c.steps[c.i]);
    if (check) return void this._runAction(check, { via: "check", said: c.steps[c.i] });
    this.handleTranscript({ text: c.steps[c.i], final: true, utteranceId: `${c.id}-s${c.i}` });
  }

  /** Called after every executed action: move a running chain on once the page has settled. */
  async _advanceChain(ok, res = {}) {
    const c = this.chain;
    if (!c) return;
    if (!ok) return this._endChain("failed", `step ${c.i + 1} failed: ${res.detail || c.steps[c.i]}`, { screenshot: res.screenshot });
    c.i += 1;
    if (c.i >= c.steps.length) return this._endChain("done");
    // Let the new page render (search results, SPAs) before the next step looks at it.
    await this.browser.active?.waitForLoadState("load", { timeout: 4000 }).catch(() => {});
    await this.browser.active?.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
    await new Promise((r) => setTimeout(r, CHAIN_SETTLE_MS));
    if (this.chain !== c) return; // cancelled meanwhile
    await this.refreshSnapshot().catch(() => {});
    this._runChainStep();
  }

  _endChain(status, reason = "", extra = {}) {
    const c = this.chain;
    if (!c) return;
    this.chain = null;
    this._log(status === "done" ? "act" : "warn", `chain ${status}${reason ? `: ${reason}` : ""}`);
    this.emit("chain", { status, reason, steps: c.steps, index: Math.min(c.i, c.steps.length - 1), text: c.text, ...extra });
    this._note(c.thread, `${status === "done" ? "completed" : status} steps: ${c.steps.slice(0, c.i + 1).join("; ")}${reason ? `: ${reason}` : ""}`);
  }

  _emitChain(status) {
    const c = this.chain;
    if (c) this.emit("chain", { status, steps: c.steps, index: c.i, text: c.text });
  }

  // ── threads ─────────────────────────────────────────────────

  _enterThread(text, { thread: id, followUp = false } = {}) {
    if (!id) {
      this.thread = null;
      return;
    }
    let t = this.threads.get(id);
    if (!t) {
      t = { turns: [], page: null };
      this.threads.set(id, t);
      if (this.threads.size > 50) this.threads.delete(this.threads.keys().next().value);
    }
    t.turns.push({ role: "user", text: String(text).slice(0, 400) });
    this.thread = t;
  }

  /** Record what a command led to, in the thread it belongs to. */
  _note(thread, text) {
    if (!thread) return;
    thread.turns.push({ role: "result", text: String(text).slice(0, 600) });
    if (thread.turns.length > 24) thread.turns.splice(0, thread.turns.length - 24);
    const page = this.browser.page;
    if (page && !page.isClosed?.()) thread.page = page;
  }

  _threadContext(thread) {
    if (!thread) return "";
    // everything before the message being handled now
    const turns = thread.turns.slice(0, -1).slice(-12);
    return turns.map((t) => `${t.role === "user" ? "User" : "Result"}: ${t.text}`).join("\n").slice(-3500);
  }

  async _followUp(text) {
    const t = this.thread;
    if (t.page && !t.page.isClosed() && t.page !== this.browser.page) {
      await this.browser.setActive(t.page);
      await this.refreshSnapshot().catch(() => {});
      this._log("info", "follow-up: back to the thread's tab");
    }
    if (this.goal) this._endGoal(this.goal, "cancelled", "new command");
    if (this.chain) this._endChain("cancelled", "new command");
    if (!hasBrain()) {
      this.emit("smart-error", { kind: "goal", text, error: "Follow-ups need an AI model in .env (BRAIN_PROVIDER + BRAIN_API_KEY, or GEMINI_API_KEY)" });
      return;
    }
    const context = this._threadContext(t) +
      "\n\n(The new request below follows up on this conversation: references such as 'them', 'the first 2' or 'those' mean the items named above.)";
    const smart = routeSmart(text) || { kind: "goal", goal: text };
    this._log("info", `follow-up (${smart.kind}) with ${t.turns.length - 1} earlier turn(s)`);
    if (smart.kind === "ask") return this._ask(smart.question, context);
    if (smart.kind === "fill") return this._fill(smart.spec, context);
    let goal = smart.goal;
    try {
      goal = await resolveFollowUp(context, smart.goal);
      if (goal !== smart.goal) {
        this._log("info", `follow-up understood as: ${goal}`);
        this.emit("resolved", { text: smart.goal, goal });
      }
    } catch (err) {
      this._log("warn", `couldn't rewrite the follow-up (${err.message}); using it as written`);
    }
    return this._startGoal(goal, context);
  }

  async _inTab({ query, rest }, opts = {}) {
    const live = this.browser.pages.filter((p) => !p.isClosed());
    const tabs = await this.browser.tabList();
    const hit = matchTab(tabs, query);
    if (!hit) {
      const names = tabs.map((t) => t.title || t.url).slice(0, 8).join(" · ");
      this._log("warn", `no open tab matches "${query}"`);
      this.emit("tab-error", { query, error: `No open tab matches “${query}”. Open tabs: ${names || "none"}` });
      return;
    }
    await this.browser.setActive(live[hit.index]);
    await this.refreshSnapshot().catch(() => {});
    this._log("act", `switched to tab "${hit.title}"`);
    this.emit("tab-switched", { title: hit.title, url: hit.url, rest });
    if (rest) return this.handleCommand(rest, { ...opts, inner: true });
    this._note(this.thread, `switched to tab "${hit.title}"`);
  }

  async _utility(util) {
    const thread = this.thread;
    try {
      const r = await runUtility(this.browser, util);
      this._note(thread, r.detail);
      this._log("act", r.detail);
      this.emit("utility", { kind: util.kind, ...r });
    } catch (err) {
      this.emit("smart-error", { kind: "utility", text: util.kind, error: String(err.message || err) });
    }
  }

  async _table(req) {
    const thread = this.thread;
    try {
      const page = await this.browser.ensurePage();
      let table = req.plain ? await domTable(page) : null;
      let via = "page";
      if (!table) {
        if (!hasBrain()) throw new Error(req.plain ? "There's no table on this page" : "Copying specific items needs an AI model in .env");
        table = await extractTable(this, req.what, this._threadContext?.(thread) || "");
        via = table.model;
      }
      if (!table.rows.length) throw new Error(table.note || `Couldn't find ${req.what} on this page`);
      const copied = await copyToClipboard(toTSV(table));
      const file = req.file ? saveCSV(table, (await page.title().catch(() => "")) || "table") : null;
      const n = table.rows.length;
      const detail = `${copied ? "Copied" : "Found"} ${n} row${n === 1 ? "" : "s"} × ${table.columns.length} column${table.columns.length === 1 ? "" : "s"}${file ? ", saved as CSV" : ""}`;
      this._note(thread, `${detail}: ${table.columns.join(", ")}`);
      this._log("act", `${detail} (${via})`);
      this.emit("table", { what: req.what, columns: table.columns, rows: table.rows.slice(0, 50), total: n, copied, path: file, via, detail });
    } catch (err) {
      this.emit("smart-error", { kind: "table", text: req.what, error: String(err.message || err) });
    }
  }

  // ── smart commands (brain) ──────────────────────────────────

  async _askTabs(question, titles) {
    if (!hasBrain()) return this.emit("smart-error", { kind: "ask", text: question, error: "Questions need an AI model in .env (BRAIN_PROVIDER + BRAIN_API_KEY, or a free GEMINI_API_KEY)" });
    const thread = this.thread;
    const clean = question.replace(/@\[([^\]]+)\]/g, "“$1”");
    this._log("info", `question across ${titles ? titles.length : "all"} tabs: ${clean}`);
    try {
      const r = await answerAcrossTabs(this, clean, titles, this._threadContext(thread));
      this._note(thread, `answer (from ${r.tabs.join(", ") || "tabs"}): ${r.answer}`);
      this._log("act", `answer (${r.model}, ${r.ms}ms, ${r.read} tabs): ${r.answer}`);
      this.emit("answer", { question, ...r, scope: "tabs" });
    } catch (err) {
      this.emit("smart-error", { kind: "ask", text: question, error: String(err.message || err) });
    }
  }

  async _ask(question, context = "") {
    this._log("info", `question: ${question}`);
    const thread = this.thread;
    try {
      const r = await answerQuestion(this, question, context);
      this._note(thread, `answer: ${r.answer}`);
      this._log("act", `answer (${r.model}, ${r.ms}ms): ${r.answer}`);
      this.emit("answer", { question, ...r });
    } catch (err) {
      this._log("error", `question failed: ${err.message || err}`);
      this.emit("smart-error", { kind: "ask", text: question, error: String(err.message || err) });
    }
  }

  async _fill(spec, context = "") {
    this._log("info", `fill form: ${spec}`);
    const thread = this.thread;
    try {
      const r = await fillForm(this, spec, context);
      if (r.error) throw new Error(r.error);
      this._note(thread, `filled form (not submitted): ${r.filled.map((f) => `${f.label}=${f.value}`).join(", ")}`);
      this._log("act", `filled ${r.filled.length} field(s)${r.missing.length ? `; no field for: ${r.missing.join(", ")}` : ""}`);
      this.emit("fill", { spec, ...r });
    } catch (err) {
      this._log("error", `form fill failed: ${err.message || err}`);
      this.emit("smart-error", { kind: "fill", text: spec, error: String(err.message || err) });
    } finally {
      await this.refreshSnapshot().catch(() => {});
    }
  }

  _startGoal(goal, context = "") {
    if (this.chain) this._endChain("cancelled", "new goal");
    const g = { goal, context, thread: this.thread, steps: [], done: [], recipe: [], awaiting: null, cancelled: false, autoApprove: false, invalid: 0, at: Date.now() };
    this.goal = g;
    this._log("info", `goal: ${goal}`);
    this._emitGoal(g, "running");
    this._goalLoop(g);
  }

  _emitGoal(g, status, summary = "") {
    // a finished goal hands back the steps it took, so the bar can offer to save them as a command
    const recipe = status === "done" && !g.replay && g.recipe?.length ? finalizeRecipe(g.recipe) : undefined;
    const steps = g.steps.map(({ record, ...s }) => ({ ...s }));
    this.emit("goal", { status, goal: g.goal, steps, summary, recipe, replay: g.replay ? g.replay.name : undefined });
  }

  _endGoal(g, status, summary = "") {
    if (g.ended) return;
    g.ended = true;
    g.cancelled = true;
    if (this.goal === g) this.goal = null;
    for (const s of g.steps) if (s.status === "running" || s.status === "awaiting") s.status = status === "done" ? "ok" : "ignored";
    this._log(status === "done" ? "act" : "warn", `goal ${status}${summary ? `: ${summary}` : ""}`);
    // what was done, with the values used, so a follow-up can refer to "them" / "the first 2"
    const did = g.steps.filter((s) => s.status === "ok").map((s) => (s.detail && !/^localhost|^[\w.-]+\.\w+\//.test(s.detail) ? `${s.text} [${s.detail}]` : s.text));
    this._note(g.thread, `goal ${status}: ${summary}${did.length ? ` (steps: ${did.join("; ")})` : ""}`);
    this._emitGoal(g, status, summary);
  }

  // ── saved goals: replay recorded steps, no model ──

  _replay(saved) {
    if (this.chain) this._endChain("cancelled", "new command");
    if (this.goal) this._endGoal(this.goal, "cancelled", "new command");
    const g = { goal: saved.text, replay: saved, values: saved.values || {}, i: 0, context: "", thread: this.thread, steps: [], done: [], awaiting: null, cancelled: false, autoApprove: false, at: Date.now() };
    this.goal = g;
    this._log("info", `replaying "${saved.name}" (${saved.recipe.length} steps, no model)`);
    this._emitGoal(g, "running");
    this._replayLoop(g);
  }

  /** The live element matching a recorded one; waits up to ~6 s for the page to show it. */
  async _findLive(match, g) {
    for (let i = 0; i < 12 && !g.cancelled; i++) {
      await this.refreshSnapshot().catch(() => {});
      const el = findElement(this.snapshot?.elements || [], match);
      if (el) return el;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  async _replayLoop(g) {
    const steps = g.replay.recipe;
    const val = (x) => (x.slot ? g.values[x.slot] ?? x.value : x.value);
    while (!g.cancelled && g.i < steps.length) {
      const s = steps[g.i++];
      const entry = { text: describeStep(s, g.values), status: "running" };
      g.steps.push(entry);
      this._emitGoal(g, "running");
      if (s.kind === "fill") {
        const r = await replayFill(this, s.fields.map((f) => ({ label: f.label, value: val(f) }))).catch((err) => ({ filled: [], missing: [], error: err }));
        if (g.cancelled) return;
        const bad = r.filled.filter((f) => f.error).map((f) => f.label);
        if (r.error || r.missing.length || bad.length) {
          entry.status = "fail";
          return this._endGoal(g, "failed", `Step ${g.i}: couldn't fill ${[...r.missing, ...bad].join(", ") || "the form"}. The page may have changed; run the goal again and save it again.`);
        }
        entry.status = "ok";
        entry.detail = r.filled.map((f) => `${f.label}: ${f.value}`).join(" · ").slice(0, 160);
        g.done.push({ description: entry.text, outcome: "filled" });
        await this.refreshSnapshot().catch(() => {});
        continue;
      }
      let action;
      if (s.match) {
        const el = await this._findLive(s.match, g);
        if (g.cancelled) return;
        if (!el) {
          entry.status = "fail";
          return this._endGoal(g, "failed", `Step ${g.i}: couldn't find "${s.label}" on the page. It may have changed; run the goal again and save it again.`);
        }
        const label = `${el.role} "${el.text || el.placeholder || ""}"`;
        action =
          s.kind === "click" ? { type: "click_element", targetId: el.id, label }
          : s.kind === "select" ? { type: "select_option", targetId: el.id, text: val(s), label }
          : { type: "type_into_field", targetId: el.id, text: val(s), submit: Boolean(s.submit), label };
      } else {
        action =
          s.kind === "navigate" ? { type: "navigate_url", url: s.url, label: s.url }
          : s.kind === "enter" ? { type: "press_enter", label: "press enter" }
          : s.kind === "back" ? { type: "go_back", label: "go back" }
          : s.kind === "wait" ? { type: "wait_ms", ms: s.ms || 1500, label: "wait" }
          : { type: s.kind, amount: "page", label: s.label };
      }
      if (s.risky && !g.autoApprove) {
        g.awaiting = action;
        entry.status = "awaiting";
        this._emitGoal(g, "awaiting");
        this.emit("goal-confirm", { goal: g.goal, description: entry.text });
        return; // goalAnswer() resumes
      }
      await this._runGoalStep(g, entry, action);
      if (g.cancelled) return;
      if (entry.status === "fail") return this._endGoal(g, "failed", `Step ${g.i} didn't work: ${entry.detail}`);
    }
    if (!g.cancelled) this._endGoal(g, "done", `Ran ${steps.length} saved step${steps.length === 1 ? "" : "s"} without the AI.`);
  }

  async _goalLoop(g, note = "") {
    while (!g.cancelled) {
      if (g.done.length >= MAX_GOAL_STEPS) return this._endGoal(g, "failed", `stopped after ${MAX_GOAL_STEPS} steps without finishing`);
      let r;
      try {
        r = await nextGoalStep(this, g.goal, g.done, note, g.context);
      } catch (err) {
        return this._endGoal(g, "failed", String(err.message || err));
      }
      note = "";
      if (g.cancelled) return;
      const { step } = r;
      if (step.status === "done" && g.unsavedForm && (g.unsavedChecks = (g.unsavedChecks || 0) + 1) <= 2) {
        // it filled a form and never saved it: not done yet
        note = "You filled a form but have not clicked its save/submit button since. The goal is not complete until it is saved: save it, then check the page.";
        continue;
      }
      if (step.status === "done") {
        // second opinion: does the page really show the goal is complete?
        const v = await verifyGoal(this, g.goal, g.done, g.context).catch(() => ({ complete: true }));
        if (g.cancelled) return;
        if (!v.complete) {
          this._log("info", `goal not finished yet: ${v.missing}`);
          if ((g.rejections = (g.rejections || 0) + 1) > 3) return this._endGoal(g, "failed", `Not finished: ${v.missing}`);
          note = `IMPORTANT: the goal is NOT complete yet: ${v.missing}. Do not answer 'done'. Choose the next action that makes progress.`;
          continue;
        }
        return this._endGoal(g, "done", step.summary);
      }
      if (step.status === "impossible") return this._endGoal(g, "failed", step.summary);
      const { action, fill, error } = toAction(step, r.snap);
      if (error) {
        if (++g.invalid > 2) return this._endGoal(g, "failed", `the model kept choosing invalid steps (${error})`);
        note = `Your last choice was invalid: ${error}. Choose again from the element list.`;
        continue;
      }
      const entry = { text: step.description || action?.label || "fill the form", status: "running" };
      if (action) entry.record = stepFromAction(action, r.snap, step.risky);
      if (fill !== undefined) {
        // the whole visible form in one step
        g.steps.push(entry);
        this._emitGoal(g, "running");
        try {
          const r2 = await fillFormFn(this, fill, g.context);
          if (r2.error) throw new Error(r2.error);
          const ok = r2.filled.filter((f) => !f.error);
          entry.status = ok.length ? "ok" : "fail";
          g.unsavedForm = ok.length > 0;
          const rec = stepFromFill(r2.filled);
          if (rec) g.recipe.push(rec);
          entry.detail = ok.map((f) => `${f.label}: ${f.value}`).join(" · ").slice(0, 160);
          g.done.push({ description: entry.text, outcome: `filled ${ok.length} field(s): ${entry.detail}${r2.missing.length ? `; no field for ${r2.missing.join(", ")}` : ""}. NOT submitted yet` });
        } catch (err) {
          entry.status = "fail";
          entry.detail = String(err.message || err);
          g.done.push({ description: entry.text, outcome: `failed: ${entry.detail}` });
        }
        this._emitGoal(g, "running");
        await this.refreshSnapshot().catch(() => {});
        continue;
      }
      g.steps.push(entry);
      if (step.risky && !g.autoApprove) {
        g.awaiting = action;
        entry.status = "awaiting";
        this._emitGoal(g, "awaiting");
        this.emit("goal-confirm", { goal: g.goal, description: entry.text });
        return; // goalAnswer() resumes
      }
      this._emitGoal(g, "running");
      await this._runGoalStep(g, entry, action);
    }
  }

  async _runGoalStep(g, entry, action) {
    if (action.type === "click_element" || action.type === "press_enter") g.unsavedForm = false;
    const { ok, res } = await this._runAction(action, { via: "goal", said: entry.text });
    const url = this.browser.currentUrl?.() || "";
    entry.status = ok ? "ok" : "fail";
    entry.detail = ok ? url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 80) : res.detail;
    g.done.push({ description: entry.text, outcome: ok ? `done (now at ${url.slice(0, 120)})` : `failed: ${res.detail}` });
    if (ok && entry.record && g.recipe && !g.replay) g.recipe.push(entry.record);
    this._emitGoal(g, "running");
    // let the page settle before the next look
    await this.browser.active?.waitForLoadState("load", { timeout: 4000 }).catch(() => {});
    await this.browser.active?.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
  }

  /** The user's answer to a risky goal step. */
  async goalAnswer(ok, all = false) {
    const g = this.goal;
    if (!g?.awaiting) return;
    if (ok && all) g.autoApprove = true; // "Allow all" for the rest of this goal
    const action = g.awaiting;
    g.awaiting = null;
    const entry = g.steps[g.steps.length - 1];
    if (!ok) return this._endGoal(g, "cancelled", `you declined: ${entry.text}`);
    entry.status = "running";
    this._emitGoal(g, "running");
    await this._runGoalStep(g, entry, action);
    if (g.replay && entry.status === "fail") return this._endGoal(g, "failed", `Step ${g.i} didn't work: ${entry.detail}`);
    if (!g.cancelled) g.replay ? this._replayLoop(g) : this._goalLoop(g);
  }

  /** The current utterance is a step of the running chain. */
  _isChainStep(utt) {
    return Boolean(this.chain && utt && String(utt.physicalId).startsWith(`${this.chain.id}-`));
  }

  /**
   * Called on every partial transcript from the mic (or the demo replay).
   * @param {{text: string, final?: boolean, utteranceId: string|number}} msg
   */
  handleTranscript({ text, final = false, utteranceId }) {
    // spoken commands aren't part of a typed thread
    if (!/^(typed-|chain-)/.test(String(utteranceId))) this.thread = null;
    let clean = cleanTranscript(text);
    const now = Date.now();

    // One action per utterance — but if the user keeps talking in the same breath
    // ("go to wikipedia ... search for alan turing"), the words after the already-executed
    // command become a fresh virtual utterance (id "<physical>+<n>"). Fewer than two new words
    // ("please") are ignored.
    const consumed = this.consumed;
    let virtualId = utteranceId;
    if (consumed && consumed.id === utteranceId) {
      if (!clean.toLowerCase().startsWith(consumed.prefix)) return; // recognizer revised the executed words; ignore
      clean = clean.slice(consumed.prefix.length).trim();
      if (clean.split(/\s+/).filter(Boolean).length < 2) return;
      virtualId = `${utteranceId}+${consumed.gen}`;
    }

    if (!this.utterance || this.utterance.id !== virtualId) {
      this.utterance = {
        id: virtualId,
        physicalId: utteranceId,
        prefix: consumed && consumed.id === utteranceId ? consumed.prefix : "",
        gen: consumed && consumed.id === utteranceId ? consumed.gen : 0,
        text: clean,
        final,
        startedAt: now,
        updatedAt: now,
        actedOn: false,
        actedText: null,
      };
      if (virtualId !== utteranceId) this._log("debug", `continuing utterance → new command "${clean}"`);
    } else {
      if (clean === this.utterance.text && final === this.utterance.final) return;
      this.utterance.text = clean;
      this.utterance.final = final || this.utterance.final;
      this.utterance.updatedAt = now;
    }
    this.emit("transcript", { text: clean, final, utteranceId: virtualId, actedOn: this.utterance.actedOn });
    if (!clean || this.utterance.actedOn) return;

    // Deterministic shortcut: numbered candidate overlays + a spoken number => no Jev needed.
    if (this.candidates && now - this.candidates.at < CANDIDATE_TTL_MS) {
      const n = parseCandidatePick(clean, this.candidates.list.length);
      if (n) {
        const c = this.candidates.list[n - 1];
        this._consume(this.utterance, clean);
        this._log("info", `picked candidate ${n} (${c.label}) by number (no model call)`);
        const action = { ...this.candidates.intent, targetId: c.id, label: c.label };
        this.candidates = null;
        this._runAction(action, { via: "candidate-pick" });
        return;
      }
    }

    clearTimeout(this.debounceTimer);
    clearTimeout(this.silenceTimer);
    this.debounceTimer = setTimeout(() => this.decideNow("debounce"), final ? 0 : DEBOUNCE_MS);
  }

  /** Mark `text` of this utterance as executed so later words in the same breath start a new command. */
  _consume(utt, text) {
    utt.actedOn = true;
    utt.actedText = text;
    this.consumed = {
      id: utt.physicalId,
      prefix: `${utt.prefix} ${text}`.trim().toLowerCase(),
      gen: (utt.gen || 0) + 1,
    };
  }

  /** Ask Jev about the current utterance. Cancels any in-flight request. */
  async decideNow(trigger = "manual") {
    const utt = this.utterance;
    if (!utt || !utt.text || utt.actedOn) return;
    if (this.busy) {
      // An action is executing; re-evaluate once it finishes.
      this.silenceTimer = setTimeout(() => this.decideNow("after-action"), 150);
      return;
    }
    // Allow up to MAX_INFLIGHT overlapping requests (a request for the previous partial may
    // still be useful — if the words already commit to an action we act on it). Anything older
    // is stale and gets cancelled via AbortSignal.
    while (this.inflight.length >= MAX_INFLIGHT) {
      const old = this.inflight.shift();
      old.ac.abort();
    }
    const ac = new AbortController();
    const req = { ac, text: utt.text, at: Date.now() };
    this.inflight.push(req);

    if (Date.now() - this.snapshotAt > 1500) await this.refreshSnapshot();

    const textAtRequest = utt.text;
    let result;
    try {
      result = await this._decide(
        {
          transcript: textAtRequest,
          snapshot: this.snapshot,
          pendingConfirmation: this.pending ? describe(this.pending) : null,
          tabs: this.browser.tabInfo(),
          context: this.context,
        },
        { signal: ac.signal },
      );
    } catch (err) {
      this.inflight = this.inflight.filter((r) => r !== req);
      if (isAbortError(err) || ac.signal.aborted) {
        this._log("debug", `cancelled stale request for "${textAtRequest}"`);
        return;
      }
      this._log("error", `Jev error: ${err.message || err}`);
      this.emit("error", err);
      const limit = err instanceof LimitError;
      if (this._isChainStep(utt)) this._endChain("failed", limit ? err.message : "model request failed");
      else if (limit) this.emit("smart-error", { kind: "limit", text: textAtRequest, error: err.message });
      return;
    }
    this.inflight = this.inflight.filter((r) => r !== req);
    if (ac.signal.aborted || this.utterance !== utt || utt.actedOn) return;

    this.stats.calls += 1;
    this.stats.inputTokens += result.usage?.input_tokens ?? 0;
    this.stats.costUsd += result.costUsd;
    this.stats.latencies.push(result.latencyMs);
    if (this.stats.latencies.length > 200) this.stats.latencies.shift();
    if (result.model && result.model !== this.stats.model) this.stats.model = result.model;

    // If more words arrived while this request was in flight, its transcript is a prefix of the
    // real one: it may still act on closed-set intents (the words already commit to "go back"),
    // but it must never be treated as final/silent — free-text payloads would be truncated.
    const stale = utt.text !== textAtRequest;
    const silentMs = stale ? 0 : Date.now() - utt.updatedAt;
    const policy = evaluatePolicy({
      answers: result.answers,
      candidates: result.candidates,
      snapshot: this.snapshot,
      silentMs,
      isFinal: utt.final && !stale,
      pending: this.pending,
      context: this.context,
    });

    const decision = {
      transcript: textAtRequest,
      trigger,
      decisionLagMs: Math.max(0, Date.now() - utt.updatedAt), // last spoken word -> decision available
      answers: result.answers,
      candidates: result.candidates,
      latencyMs: result.latencyMs,
      usage: result.usage,
      costUsd: result.costUsd,
      model: result.model,
      requestId: result.requestId,
      questionCount: result.questionCount,
      stateTokens: approxTokens(result.state),
      policy,
      silentMs,
      thresholds: T,
      at: Date.now(),
    };
    this.lastDecision = decision;
    this.emit("decision", decision);
    this._log(
      policy.decision === "act" ? "act" : "info",
      `${result.latencyMs}ms · "${textAtRequest}" → ${policy.decision}: ${policy.summary}`,
    );

    switch (policy.decision) {
      case "act":
        this._consume(utt, textAtRequest);
        if (policy.action.confirmed) this.pending = null;
        this.candidates = null;
        await this._runAction(policy.action, { decision, utterance: utt });
        break;
      case "confirm":
        this._consume(utt, textAtRequest);
        this.pending = policy.action;
        await this.browser.overlay("toast", `Say "confirm" to ${describe(policy.action)}`, 6000);
        this.emit("pending", { action: policy.action, summary: policy.summary });
        if (this._isChainStep(utt)) (this.chain.awaiting = true), this._emitChain("awaiting");
        break;
      case "cancel":
        this._consume(utt, textAtRequest);
        this.pending = null;
        await this.browser.overlay("toast", "cancelled");
        this.emit("pending", null);
        break;
      case "disambiguate": {
        const list = policy.candidates.map((c, i) => ({ n: i + 1, id: c.id, label: c.label, p: c.p }));
        this.candidates = { list, intent: policy.pendingIntent, at: Date.now() };
        await this.browser.overlay("candidates", list, CANDIDATE_TTL_MS);
        await this.browser.overlay("toast", "Which one? Say the number.", 3000);
        this.emit("candidates", list);
        if (this._isChainStep(utt)) (this.chain.awaiting = true), this._emitChain("awaiting");
        this._scheduleSilenceRetry(utt);
        break;
      }
      case "wait":
        // A finished (final / typed) command that stays unclear won't get clearer by asking again.
        if (utt.final && !stale && (utt.finalWaits = (utt.finalWaits || 0) + 1) >= MAX_FINAL_WAITS) {
          utt.actedOn = true;
          this._log("warn", `couldn't understand "${textAtRequest}" (${policy.summary}); try rephrasing`);
          this.emit("gaveup", { transcript: textAtRequest, summary: policy.summary });
          if (this._isChainStep(utt)) this._endChain("failed", `step ${this.chain.i + 1} not understood: ${textAtRequest}`);
          break;
        }
        this._scheduleSilenceRetry(utt, policy.retryInMs);
        break;
      case "ignore":
        if (this._isChainStep(utt)) this._endChain("failed", `step ${this.chain.i + 1} not a browser command: ${textAtRequest}`);
        break;
      default:
        break;
    }
  }

  /** If the user stops talking, re-evaluate with silentMs so `complete` is bypassed. */
  _scheduleSilenceRetry(utt, retryInMs = null) {
    clearTimeout(this.silenceTimer);
    const waitFor = retryInMs ?? Math.max(50, SILENCE_COMPLETE_MS - (Date.now() - utt.updatedAt));
    this.silenceTimer = setTimeout(() => {
      if (this.utterance === utt && !utt.actedOn) this.decideNow("silence");
    }, waitFor);
  }

  async _runAction(action, meta = {}) {
    this.busy = true;
    const t0 = Date.now();
    const utt = meta.utterance || this.utterance;
    const pageBefore = this.snapshot ? { url: this.snapshot.url, title: this.snapshot.title, site: this.snapshot.site } : null;
    let ok = false;
    let res = {};
    try {
      res = await this._execute(action, this.browser);
      ok = res.ok !== false;
      const took = Date.now() - t0;
      const sinceLastWord = utt ? Date.now() - utt.updatedAt : null;
      const sinceUtteranceStart = utt ? Date.now() - utt.startedAt : null;
      this.stats.actions += 1;
      if (sinceLastWord != null) this.stats.commandToActionMs.push(sinceLastWord);
      if (meta.decision?.decisionLagMs != null) this.stats.decisionMs.push(meta.decision.decisionLagMs);
      this.history.push({ action, at: Date.now(), url: res.detail });
      this._recordContext({ action, ok: res.ok, detail: res.detail, said: meta.said || meta.decision?.transcript || utt?.actedText || "", pageBefore });
      const decisionMs = meta.decision?.decisionLagMs ?? null;
      const entry = {
        action,
        ok: res.ok,
        detail: res.detail,
        executeMs: took,
        decisionMs, // last word -> decision
        sinceLastWordMs: sinceLastWord, // last word -> action finished (includes page load)
        sinceUtteranceStartMs: sinceUtteranceStart,
        via: meta.via || "jev",
        screenshot: res.screenshot || null,
      };
      this._log(res.ok ? "act" : "warn", `${res.ok ? "✓" : "✗"} ${describe(action)}: decided ${decisionMs ?? "?"}ms after last word, executed in ${took}ms ${res.detail || ""}`);
      this.emit("action", entry);
      // single commands (not chain/goal steps) are recorded in their thread
      if (!this.chain && meta.via !== "goal") this._note(this.thread, `${res.ok ? "did" : "failed"}: ${describe(action)}${res.detail && !String(res.detail).startsWith("http") ? ` (${res.detail})` : ""}`);
    } catch (err) {
      this._log("error", `action failed: ${describe(action)}: ${err.message || err}`);
      res = { detail: String(err.message || err) };
      this.emit("action", { action, ok: false, detail: res.detail });
    } finally {
      this.busy = false;
      await this.refreshSnapshot().catch(() => {});
    }
    if (meta.via !== "undo" && meta.via !== "goal") await this._advanceChain(ok, res);
    return { ok, res };
  }

  /**
   * Remember what was just done so the next Jev request can resolve "back to the results",
   * "the other one", "not that one". Called after every executed action; the page snapshot is
   * refreshed by the caller right after, so `outcome` is derived from the post-action URL.
   */
  _recordContext({ action, ok, detail, said, pageBefore }) {
    const after = this.browser.currentUrl?.() ?? null;
    const navigated = pageBefore && after && after !== pageBefore.url;
    if (navigated) this.context.previousPage = pageBefore;
    let outcome = ok ? "done" : "failed";
    if (ok && navigated) outcome = `navigated to ${after.replace(/^https?:\/\/(www\.)?/, "").slice(0, 80)}`;
    else if (ok && typeof detail === "string" && detail && !detail.startsWith("http")) outcome = detail.slice(0, 80);
    this.context.recentActions.push({
      type: action.type,
      targetId: action.targetId ?? null,
      targetLabel: action.label ?? null,
      text: action.text ?? null,
      url: action.url ?? null,
      said,
      ok,
      outcome,
      at: Date.now(),
    });
    if (this.context.recentActions.length > MAX_CONTEXT_ACTIONS) this.context.recentActions.shift();
  }

  /** Stop whatever is running (Esc / Stop in the bar): goal, chain, pending confirmation, open requests. */
  stop() {
    if (this.goal) this._endGoal(this.goal, "cancelled", "Stopped");
    if (this.chain) this._endChain("cancelled", "Stopped");
    this.pending = null;
    this.candidates = null;
    if (this.utterance) this.utterance.actedOn = true;
    clearTimeout(this.debounceTimer);
    clearTimeout(this.silenceTimer);
    for (const r of this.inflight) r.ac.abort();
    this.inflight = [];
    this._log("warn", "stopped by the user");
    this.emit("stopped", {});
  }

  /** "Undo" = go back in history. */
  async undo() {
    await this._runAction({ type: "go_back", label: "undo (back)" }, { via: "undo" });
  }

  uiState() {
    const lat = this.stats.latencies;
    const sorted = [...lat].sort((a, b) => a - b);
    const p50 = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    return {
      model: this.stats.model,
      thresholds: T,
      stats: {
        calls: this.stats.calls,
        actions: this.stats.actions,
        inputTokens: this.stats.inputTokens,
        costUsd: this.stats.costUsd,
        lastLatencyMs: lat[lat.length - 1] ?? null,
        p50LatencyMs: p50,
        avgLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
        avgCommandToActionMs: avg(this.stats.commandToActionMs),
        avgDecisionMs: avg(this.stats.decisionMs),
      },
      snapshot: this.snapshot && {
        url: this.snapshot.url,
        title: this.snapshot.title,
        site: this.snapshot.site,
        searchBoxId: this.snapshot.searchBoxId,
        elements: this.snapshot.elements,
        tabs: this.snapshot.tabs,
      },
      lastDecision: this.lastDecision,
      context: this.context,
      pending: this.pending ? { summary: describe(this.pending) } : null,
      candidates: this.candidates?.list ?? null,
      chain: this.chain && { steps: this.chain.steps, index: this.chain.i, awaiting: this.chain.awaiting },
      log: this.log.slice(-60),
    };
  }

  async close() {
    this.chain = null;
    if (this.goal) this.goal.cancelled = true;
    clearTimeout(this.debounceTimer);
    clearTimeout(this.silenceTimer);
    for (const r of this.inflight) r.ac.abort();
    this.inflight = [];
  }
}
