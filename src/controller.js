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
import { loadChats, saveChats, listFacts, rememberFact, forgetFacts, parseMemoryCommand } from "./memory.js";
import { routeSmart, answerQuestion, nextGoalStep, verifyGoal, resolveFollowUp, toAction, MAX_GOAL_STEPS, CHECKPOINT_STEPS, stuckOn, mayHaveItems, goalItems } from "./smart.js";
import { hasBrain, ask as brainAsk } from "./brain.js";
import { parseSiteCommand, resolveSite, siteKey, addNote, notesFor, learnFromGoal, markUsed } from "./sitenotes.js";
import { parseUtility, runUtility, copyToClipboard } from "./utility.js";
import { parseTableRequest, domTable, toTSV, saveCSV } from "./table.js";
import { extractTable, replayFill, answerAcrossTabs, isTabsQuestion } from "./smart.js";
import { compareTabs, isCompareRequest } from "./compare.js";
import { LimitError } from "./usage.js";
import { stepFromAction, stepFromFill, finalizeRecipe, findElement, describeStep } from "./recipe.js";
import { parseTabMention, parseCurrentTab, matchTab } from "./tabs.js";
import { fillForm as fillFormFn } from "./smart.js";
import { TaskRunner } from "./tasks.js";
import { HANDBACK_NOTE } from "./takeover.js";
import { logLine, TaskTrace } from "./tracelog.js";
import { parseMedia, runMedia, mediaState, stateText } from "./media.js";
import { forbiddenClicks, isForbidden, forbidNote, DISCARDS } from "./forbid.js";
import { botCheckInPage, classifyBlock, noteBlocked, blockedSites, isBlocked, namedIn, blockNote, blockedHint } from "./blocked.js";

/**
 * Runs in the page: a short fingerprint of what's on screen (visible buttons, links, menu items,
 * dialogs, alerts and toasts), so a step that only opens a menu or shows a toast still counts as a change.
 */
function pageSignature() {
  const sel = 'button, a[href], [role="menuitem"], [role="option"], [role="dialog"], [role="alert"], [role="status"], [aria-expanded="true"], [aria-checked], dialog[open], input, select, textarea';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    if (out.length > 400) break;
    if (el.closest('[class*="__vb"]')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) continue;
    // ticked or not counts too: ticking a checkbox changes the page even though nothing else moves
    const ticked = el.type === "checkbox" || el.type === "radio" ? String(el.checked) : el.getAttribute("aria-checked") || "";
    out.push(`${el.getAttribute("role") || el.tagName}:${(el.getAttribute("aria-label") || el.textContent || el.value || "").trim().slice(0, 40)}:${el.getAttribute("aria-expanded") || ""}:${el.getAttribute("aria-pressed") || ""}:${ticked}`);
  }
  let h = 0;
  const str = out.join("|");
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return `${out.length}:${h}`;
}

/** page.evaluate that gives up after `ms` (a busy or frozen page must never hang a task). */
const evalIn = (page, fn, fallback, ms = 1500) =>
  Promise.race([page.evaluate(fn).catch(() => fallback), new Promise((r) => setTimeout(() => r(fallback), ms))]);

/** Runs in the page: is this element (a checkbox, its label, an ARIA checkbox) ticked? null if it can't tell. */
function checkedState(id) {
  const el = document.querySelector(`[data-vb-id="${id}"]`);
  if (!el) return null;
  const input = el.tagName === "INPUT" ? el : el.control || el.querySelector?.("input[type=checkbox], input[type=radio]");
  if (input && "checked" in input) return input.checked;
  const aria = el.getAttribute("aria-checked");
  return aria ? aria === "true" : null;
}

/** Runs in the page: the text of visible messages (toasts, alerts, status lines), e.g. "Added to queue". */
function pageMessages() {
  const sel = '[role="alert"], [role="status"], [aria-live="polite"], [aria-live="assertive"], tp-yt-paper-toast, yt-notification-action-renderer, .toast, [class*="snackbar" i], [class*="toast" i]';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    if (el.closest('[class*="__vb"]')) continue; // Gofer's own overlay
    const r = el.getBoundingClientRect();
    const t = (el.innerText || "").replace(/\s+/g, " ").trim();
    if (r.width && r.height && t && t.length < 160 && !out.includes(t)) out.push(t);
    if (out.length >= 4) break;
  }
  return out;
}

const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/** "try again", "retry", "do it again", "again please" */
export const isRetry = (t) => /^(?:(?:ok|okay|no|hmm)[,.!]?\s*)?(?:please\s+)?(?:try(?:\s+(?:it|that))?\s+again|retry|do\s+(?:it|that)\s+again|one more time|again)(?:[,!]?\s*please)?[.!]?$/i.test(String(t || "").trim());

/** "another one", "no, a different one", "something else", "next one", "try another" */
export const isAnotherOne = (t) =>
  /^(?:(?:no|nah|nope|ok|okay|hmm|great|nice|thanks)\b[,.!]?\s*)?(?:please[,!]?\s*)?(?:(?:give me|show me|play|find|try|get|do|pick|tell me|suggest)\s+)?(?:another(?:\s+(?!tab\b|window\b)\w+)?|a different(?:\s+\w+)?|different one|something else|(?:the\s+)?next one|not (?:that|this) one|one more|a new one)(?:[,!]?\s*please)?[.!]?$/i.test(String(t || "").trim());

export class Controller extends EventEmitter {
  /**
   * @param {{browser: import('./browser.js').BrowserManager, decideFn?: Function, executeFn?: Function}} opts
   *   decideFn / executeFn are injectable for tests (default: real Jev + Playwright).
   */
  constructor({ browser, decideFn = decide, executeFn = execute, persist = true }) {
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
    // chats from earlier sessions, so a conversation picks up where it left off after a restart
    for (const [id, turns] of Object.entries(persist ? loadChats() : {})) this.threads.set(id, { turns, page: null });
    this.persist = persist;
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
    // Messages sent while a task runs wait their turn (see tasks.js); take over, undo, background tabs.
    this.tasks = new TaskRunner(this);
    // Follow the tab you switch to in the browser, except while a task is working in its own tab.
    browser.canFollow = () => !this.goal && this.tasks.queue.idle;
  }

  /** A message from the panel (or a scheduler): runs now, or after the running task. See tasks.js. */
  enqueue(task) {
    return this.tasks.enqueue(task);
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
    logLine(entry);
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
    // "in the current tab, …": make sure we're on the tab the browser is showing, then run the rest.
    const current = !opts.inner && parseCurrentTab(text);
    if (current) return this._inCurrentTab(current, opts);
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
    // Direct mode: "move back 10 seconds and play", "pause", "speed 1.5x" work the video instantly,
    // no model. Chat sends them to the AI with the conversation (it has a video tool). No video on the
    // page: the AI gets the request after all.
    const media = !opts.noMedia && !opts.chat && parseMedia(text);
    if (media) return this._media(media, text, () => this.handleCommand(text, { ...opts, inner: true, noMedia: true }));
    // "copy the table", "copy all invoice numbers as a table"
    const tableReq = parseTableRequest(text);
    if (tableReq) return this._table(tableReq);
    // "go to @[Bills - Acme Books] and create a new bill": switch tabs first, then run the rest there.
    const mention = parseTabMention(text);
    if (mention) return this._inTab(mention, opts);

    // Chat: every message is a goal (or a question) that sees the whole conversation.
    if (opts.chat) return this._chat(text);

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
    this.threads.delete(id); // most recently used last, so the oldest chats are dropped first
    this.threads.set(id, t);
    if (this.persist) saveChats(this.threads);
  }

  /** Record what a command led to, in the thread it belongs to. */
  _note(thread, text) {
    if (!thread) return;
    thread.turns.push({ role: "result", text: String(text).slice(0, 600) });
    if (thread.turns.length > 40) thread.turns.splice(0, thread.turns.length - 40);
    if (this.persist) saveChats(this.threads);
    const page = this.browser.page;
    if (page && !page.isClosed?.()) thread.page = page;
  }

  _threadContext(thread) {
    if (!thread) return "";
    // everything before the message being handled now
    const turns = thread.turns.slice(0, -1).slice(-12);
    // results list every step they took: keep the latest one longer, the older ones short
    const lastResult = turns.map((t) => t.role).lastIndexOf("result");
    const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
    return turns.map((t, i) => (t.role === "user" ? `User: ${t.text}` : `Result: ${cut(t.text, i === lastResult ? 700 : 260)}`)).join("\n").slice(-3500);
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

  /**
   * A chat message. Questions are answered, everything else runs as a goal with the conversation
   * (and remembered facts) as context, so "no, another one" redoes the last request differently.
   */
  async _chat(text) {
    const t = this.thread;
    if (this.goal?.awaiting && /^(?:confirm|yes|ok|okay|go ahead|do it|allow)$/i.test(text.trim())) return this.goalAnswer(true);
    if (this.goal?.awaiting && /^(?:cancel|no|stop|don'?t)$/i.test(text.trim())) return this.goalAnswer(false);
    if (this.goal) this._endGoal(this.goal, "cancelled", "new message");
    if (this.chain) this._endChain("cancelled", "new message");
    const siteCmd = parseSiteCommand(text);
    if (siteCmd && (await this._siteNote(siteCmd, text))) return;
    const mem = parseMemoryCommand(text);
    if (mem) return this._memory(mem);
    // "try again": the previous request, as it was asked
    if (t?.lastAsk && isRetry(text)) {
      this.emit("resolved", { text, goal: t.lastAsk });
      return this._chat(t.lastAsk);
    }
    if (t) t.lastAsk = text;
    if (!hasBrain()) {
      return this.emit("smart-error", { kind: "goal", text, error: "Chat needs an AI model in .env (BRAIN_PROVIDER + BRAIN_API_KEY, or a free GEMINI_API_KEY). Direct mode works without one." });
    }
    const earlier = Boolean(t && t.turns.length > 1);
    const facts = listFacts();
    let context = facts.length ? `Things the user asked you to remember:\n${facts.map((f) => `- ${f}`).join("\n")}\n\n` : "";
    if (earlier) {
      context += `${this._threadContext(t)}\n\n(The new message continues this conversation. "Another one", "a different one" or "no, not that" ` +
        "mean: do the previous request again, but with a different result than the one already given. 'Them', 'those', 'the first 2' mean the items named above.)";
    }
    const smart = routeSmart(text) || { kind: "goal", goal: text };
    this._log("info", `chat (${smart.kind})${earlier ? ` with ${t.turns.length - 1} earlier turn(s)` : ""}`);
    if (earlier && t.base && t.baseKind === "ask" && isAnotherOne(text)) {
      this.emit("resolved", { text, goal: `${t.base}, but a different answer` });
      return this._ask(`${t.base} Give a different answer than: ${t.avoid.join(" | ") || "the one above"}`, context);
    }
    if (smart.kind === "ask") {
      const mentions = [...text.matchAll(/@\[([^\]]+)\]/g)].map((m) => m[1]);
      if (mentions.length >= 2 || isTabsQuestion(text)) return this._askTabs(text, mentions.length >= 2 ? mentions : null);
      if (t) Object.assign(t, { base: smart.question, baseKind: "ask", avoid: [] });
      return this._ask(smart.question, context);
    }
    let goal = smart.goal;
    // "another one" / "a different one": the earlier request again, avoiding every result so far
    if (earlier && t.base && t.baseKind === "goal" && isAnotherOne(text)) {
      goal = `${t.base}. Pick a different result than before; already given: ${t.avoid.join(" | ") || "(see the conversation)"}`;
      this._log("info", `understood as: ${goal}`);
      this.emit("resolved", { text, goal: `${t.base}, but a different one` });
      return this._startGoal(goal, context.trim(), { another: true });
    }
    if (earlier) {
      try {
        goal = await resolveFollowUp(context, smart.goal);
        if (goal !== smart.goal) {
          this._log("info", `understood as: ${goal}`);
          this.emit("resolved", { text: smart.goal, goal });
          const shot2 = parseUtility(goal);
          if (shot2) return this._utility(shot2);
        }
      } catch (err) {
        this._log("warn", `couldn't rewrite the message (${err.message}); using it as written`);
      }
    }
    if (t) Object.assign(t, { base: goal, baseKind: "goal", avoid: [] });
    return this._startGoal(goal, context.trim());
  }

  _memory({ kind, text }) {
    const thread = this.thread;
    let answer;
    try {
      if (kind === "remember") {
        rememberFact(text);
        const you = text.replace(/[.!]+$/, "").replace(/\b(?:I am|I'm|mine|my|me|I)\b/g, (w) => ({ my: "your", mine: "yours", me: "you", I: "you", "I'm": "you're", "I am": "you are" })[w]);
        answer = `Got it. I'll remember that ${you}.`;
      } else if (kind === "forget") {
        const n = forgetFacts(text);
        answer = n ? `Forgotten (${n} thing${n === 1 ? "" : "s"}).` : "I didn't have anything like that saved.";
      } else {
        const facts = listFacts();
        answer = facts.length ? `Here's what I remember:\n${facts.map((f) => `• ${f}`).join("\n")}` : "Nothing yet. Say \"remember that …\" and I'll keep it for every chat.";
      }
    } catch (err) {
      return this.emit("smart-error", { kind: "memory", text, error: `Couldn't update memory: ${err.message || err}` });
    }
    this._note(thread, answer);
    this.emit("answer", { question: text, answer, source: "memory", ms: 0 });
  }

  /**
   * "remember that on workbook bills are under sales" / "what do you know about this site?".
   * Returns false when the named site isn't one we know (then it's an ordinary "remember that …").
   */
  async _siteNote({ kind, site, text }, said) {
    const thread = this.thread;
    const here = siteKey(this.browser.page?.url?.() || "");
    const tabs = site === "here" ? [] : await this.browser.tabList?.().catch(() => []);
    const key = site === "here" ? here : resolveSite(site, { tabs: tabs || [] });
    if (!key) {
      if (kind === "site-remember" && site !== "here") return false;
      const answer = "I can't tell which site you mean. Open it in the browser first, or name it like youtube.com or localhost:3000.";
      this._note(thread, answer);
      this.emit("answer", { question: said, answer, source: "memory", ms: 0 });
      return true;
    }
    let answer;
    try {
      if (kind === "site-remember") {
        const title = key === here ? await this.browser.page?.title?.().catch(() => "") : "";
        const n = addNote(key, text.replace(/^./, (c) => c.toUpperCase()), "user", { label: site !== "here" && !/[.:]/.test(site) ? site.replace(/^./, (c) => c.toUpperCase()) : String(title || "").split(/\s[-–—|·]\s/).pop()?.trim() });
        answer = n.existed ? `I already had that for ${key}.` : `Got it. Next time on ${key}: ${n.text}`;
      } else {
        const notes = notesFor(key);
        answer = notes.length ? `Here's what I know about ${key}:\n${notes.map((n) => `• ${n.text}`).join("\n")}` : `Nothing yet about ${key}. Say “remember that here …”, or I'll pick things up as we go.`;
      }
    } catch (err) {
      return this.emit("smart-error", { kind: "memory", text: said, error: String(err.message || err) }), true;
    }
    this._note(thread, answer);
    this.emit("answer", { question: said, answer, source: "memory", ms: 0 });
    return true;
  }

  /** After a goal, in the background: keep 0–2 lessons about the sites it used (never delays the reply). */
  _learn(g, status) {
    if (!this.persist || g.replay || !g.sites?.size || !hasBrain()) return;
    // a site that only showed a bot check taught nothing (its lessons would be guesses)
    const sites = [...g.sites].filter((s) => s && !g.blocked?.has(s));
    if (!sites.length) return;
    markUsed(sites);
    learnFromGoal({ goal: g.goal, status, done: g.done, sites, typed: g.typed || [], ask: brainAsk })
      .then((notes) => {
        if (!notes.length) return;
        this._log("info", `learned: ${notes.map((n) => `[${n.site}] ${n.text}`).join(" | ")}`);
        this.emit("sitenotes-learned", { goal: g.goal, notes });
      })
      .catch((err) => this._log("debug", `no lessons (${err.message || err})`));
  }

  async _inCurrentTab({ rest }, opts = {}) {
    const page = await this.browser.syncActive().catch(() => this.browser.page);
    const title = page ? await page.title().catch(() => "") : "";
    const url = page?.url() || "";
    this._log("info", `using the current tab "${title || url}"`);
    this.emit("tab-switched", { title: title || url, url, rest, current: true });
    if (rest) return this.handleCommand(rest, { ...opts, inner: true });
    this._note(this.thread, `using the current tab "${title || url}"`);
  }

  /** The bar's tab picker: work in this tab from now on (and show it in the browser if `show`). */
  async selectTab(index, { show = false } = {}) {
    const page = this.browser.pages.filter((p) => !p.isClosed())[index];
    if (!page) return;
    await this.browser.setActive(page, { show });
    await this.refreshSnapshot().catch(() => {});
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
    // "go to @[X]" alone means show it; "… and do something" works there in the background
    await this.browser.setActive(live[hit.index], { show: !rest });
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

  async _media(actions, text, otherwise = null) {
    const thread = this.thread;
    try {
      const page = this.browser.page;
      if (!page) throw new Error("No tab is open");
      // it only looked like a video command: let the AI work out what was meant
      if (otherwise && !(await evalIn(page, mediaState, null))) return otherwise();
      const r = await runMedia(page, actions);
      if (!r.ok) throw new Error(r.detail);
      this._note(thread, `${text} → ${r.detail}`);
      this._log("act", `media: ${r.detail}`);
      this.emit("utility", { kind: "media", detail: r.detail });
    } catch (err) {
      this.emit("smart-error", { kind: "utility", text, error: String(err.message || err) });
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
    if (isCompareRequest(question)) return this._compareTabs(question, titles);
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

  /** "compare these tabs": a table with a row per tab, and a verdict (compare.js). */
  async _compareTabs(question, titles) {
    const thread = this.thread;
    const clean = question.replace(/@\[([^\]]+)\]/g, "“$1”");
    this._log("info", `compare ${titles ? titles.length : "all"} tabs: ${clean}`);
    try {
      const r = await compareTabs(this.browser.pages, clean, titles, this._threadContext(thread));
      this._note(thread, `compared ${r.tabs.map((t) => `“${t}”`).join(", ")} on ${r.columns.slice(1).join(", ")}: ${r.verdict}`);
      this._log("act", `comparison (${r.model}, ${r.ms}ms, ${r.read} tabs): ${r.verdict}`);
      this.emit("table", { what: clean, columns: r.columns, rows: r.rows, total: r.rows.length, copied: false, via: r.model, model: r.model, detail: r.verdict, note: r.note, scope: "compare" });
    } catch (err) {
      this.emit("smart-error", { kind: "ask", text: question, error: String(err.message || err) });
    }
  }

  async _ask(question, context = "") {
    this._log("info", `question: ${question}`);
    const thread = this.thread;
    try {
      // questions are about the tab you're looking at, even while the agent works in another one
      const page = await Promise.resolve(this.browser.visiblePage?.()).catch(() => null);
      const r = await answerQuestion(this, question, context, { page: page && page !== this.browser.page ? page : null });
      this._note(thread, `answer: ${r.answer}`);
      if (thread?.avoid) thread.avoid.push(String(r.answer).slice(0, 200));
      this._log("act", `answer (${r.model}, ${r.ms}ms): ${r.answer}`);
      this.emit("answer", { question, ...r });
    } catch (err) {
      this._log("error", `question failed: ${err.message || err}`);
      this.emit("smart-error", { kind: "ask", text: question, error: String(err.message || err) });
    }
  }

  _startGoal(goal, context = "", { another = false } = {}) {
    if (this.chain) this._endChain("cancelled", "new goal");
    const start = this.browser.page ? { url: this.browser.page.url(), title: "" } : null;
    if (start) this.browser.page.title().then((t) => (start.title = t)).catch(() => {});
    const g = { goal, context, another, start, thread: this.thread, steps: [], done: [], recipe: [], awaiting: null, cancelled: false, autoApprove: false, invalid: 0, at: Date.now() };
    this.goal = g;
    g.trace = new TaskTrace(goal, { context, startUrl: start?.url || "" });
    // sites that blocked us lately are skipped, unless the request names them
    g.hint = blockedHint(blockedSites().filter((s) => !namedIn(`${goal} ${context}`, s))) || null;
    // "DO NOT CLICK AUTOFILL", "don't press any save button": refused in code, said every step. Earlier
    // messages in the chat count too, unless this one names the thing again.
    const earlier = String(context).split("\n").filter((l) => l.startsWith("User: ")).flatMap((l) => forbiddenClicks(l.slice(6)));
    g.forbidden = [...new Set([...forbiddenClicks(goal), ...earlier.filter((f) => !goal.toLowerCase().includes(f))])];
    if (g.forbidden.length) this._log("info", `not to click: ${g.forbidden.join(", ")}`);
    this._log("info", `goal: ${goal}`);
    this._emitGoal(g, "running");
    this._goalLoop(g);
  }

  _emitGoal(g, status, summary = "") {
    // a finished goal hands back the steps it took, so the bar can offer to save them as a command
    const recipe = status === "done" && !g.replay && g.recipe?.length ? finalizeRecipe(g.recipe) : undefined;
    const steps = g.steps.map(({ record, ...s }) => ({ ...s }));
    // screenshots it took go to the chat with the final reply (they're large, so not with every step)
    const images = status === "running" || status === "awaiting" ? undefined : g.images;
    // finished in a tab you're not looking at: the reply says so and offers to show it
    const b = this.browser;
    const background = status !== "running" && status !== "awaiting" && b.active && b.shown && b.active !== b.shown && !b.active.isClosed?.() ? { title: this.snapshot?.title || "" } : undefined;
    this.emit("goal", { status, goal: g.goal, steps, summary, recipe, replay: g.replay ? g.replay.name : undefined, models: g.models || [], images, background });
  }

  _endGoal(g, status, summary = "") {
    if (g.ended) return;
    g.ended = true;
    g.cancelled = true;
    if (this.goal === g) this.goal = null;
    for (const s of g.steps) if (s.status === "running" || s.status === "awaiting") s.status = status === "done" ? "ok" : "ignored";
    this._log(status === "done" ? "act" : "warn", `goal ${status}${summary ? `: ${summary}` : ""}`);
    g.trace?.end(status, summary);
    // what was done, with the values used, so a follow-up can refer to "them" / "the first 2"
    const did = g.steps.filter((s) => s.status === "ok").map((s) => (s.detail && !/^localhost|^[\w.-]+\.\w+\//.test(s.detail) ? `${s.text} [${s.detail}]` : s.text));
    this._note(g.thread, `goal ${status}: ${summary}${did.length ? ` (steps: ${did.join("; ")})` : ""}`);
    // what this chat has already been given, so the next "another one" avoids it
    if (status === "done" && g.thread?.avoid && summary) g.thread.avoid.push(String(summary).slice(0, 200));
    this._emitGoal(g, status, summary);
    if (status === "done" || status === "failed") setImmediate(() => this._learn(g, status));
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
          : s.kind === "new_tab" ? { type: "open_new_tab", url: s.url, label: s.label }
          : s.kind === "close_tab" ? { type: "close_tab", label: s.label }
          : s.kind === "screenshot" ? { type: "take_screenshot", fullPage: s.fullPage, label: s.label }
          : s.kind === "key" ? { type: "press_key", key: s.key, label: s.label }
          : s.kind === "switch_tab" ? { type: "switch_tab", title: s.title, label: s.label }
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
    // a goal with several items gets a checklist, so progress isn't re-guessed from the history every step
    if (!g.items && !g.replay) {
      g.items = [];
      g.itemsDone = [];
      if (mayHaveItems(g.goal)) {
        g.items = await goalItems(g.goal, g.context).catch(() => []);
        if (g.items.length) {
          this._log("info", `checklist: ${g.items.join(" · ")}`);
          g.trace?.add("checklist", { items: g.items });
        }
      }
      if (g.cancelled) return;
    }
    while (!g.cancelled) {
      // Take over / the goal asked for the user: wait for them to hand back
      const turn = await this.tasks.pauseIfWanted(g);
      if (turn?.cancelled || g.cancelled) return;
      if (turn) note = note ? `${note} ${HANDBACK_NOTE}` : HANDBACK_NOTE;
      const stepsDone = g.done.filter((d) => !d.research).length;
      if (stepsDone >= MAX_GOAL_STEPS) return this._endGoal(g, "failed", `stopped after ${MAX_GOAL_STEPS} steps, the most one task may take`);
      // going round in circles: stop and say what it kept doing
      const loop = stuckOn(g.sigs || [], { tickedAt: g.tickedAt ?? -1 });
      if (loop) {
        g.trace?.add("stuck", { steps: loop });
        return this._endGoal(g, "failed", `it kept going round in circles: ${loop.map((x) => x.split("|").filter(Boolean).slice(1).join(" ")).join(" → ").slice(0, 200)}`);
      }
      // a long task checks in now and then, so it can't use up your AI quota without you knowing
      if (!g.noCheckpoint && stepsDone >= (g.checkpoint ??= CHECKPOINT_STEPS)) {
        g.checkpoint = stepsDone + CHECKPOINT_STEPS;
        g.awaiting = { type: "__checkpoint" };
        const did = g.itemsDone?.length ? `; done: ${g.itemsDone.join(", ")}` : "";
        this._emitGoal(g, "awaiting");
        this.emit("goal-confirm", { goal: g.goal, kind: "checkpoint", steps: stepsDone, description: `I've taken ${stepsDone} steps so far${did}. Keep going?` });
        return; // goalAnswer() resumes
      }
      const blocked = await this._botCheck(g);
      if (blocked) note = note ? `${note} ${blocked}` : blocked;
      let r;
      try {
        if (g.hint) {
          note = note ? `${note} ${g.hint}` : g.hint;
          g.hint = null;
        }
        const rules = forbidNote(g.forbidden);
        if (rules) note = note ? `${note} ${rules}` : rules;
        r = await nextGoalStep(this, g.goal, g.done, note, g.context, {
          items: g.items,
          itemsDone: g.itemsDone,
          // background searches and page reads show up as steps, like browser actions
          onResearch: (res) => {
            if (g.cancelled || res.detail === "already done") return; // a repeat the model was told off for: not news to the user
            g.trace?.add("research", { description: res.description, ok: res.ok, outcome: res.outcome });
            g.steps.push({ text: res.description, status: res.ok ? "ok" : "fail", detail: res.detail?.slice(0, 80) });
            this._emitGoal(g, "running");
          },
        });
        g.brainErrors = 0;
      } catch (err) {
        if (g.cancelled) return;
        g.trace?.add("error", { error: String(err.message || err) });
        // A model hiccup shouldn't end the task: wait a little and ask again (another model may take it).
        if (!(err instanceof LimitError) && !isAbortError(err) && (g.brainErrors = (g.brainErrors || 0) + 1) <= 3) {
          this._log("warn", `goal step: model error, retrying (${g.brainErrors}/3): ${err.message || err}`);
          this._emitGoal(g, "running", "Model hiccup, trying again…");
          await new Promise((res) => setTimeout(res, 1500 * g.brainErrors));
          if (g.cancelled) return;
          continue;
        }
        return this._endGoal(g, "failed", String(err.message || err));
      }
      g.trace?.add("model", { models: r.models || [r.model], ms: r.ms, url: r.snap?.url, note: note || undefined, chose: r.step, calls: r.calls, prompt: r.prompt });
      note = "";
      if (g.cancelled) return;
      g.models = [...new Set([...(g.models || []), ...(r.models || [r.model])])];
      (g.sites ||= new Set()).add(siteKey(r.snap?.url || ""));
      const { step } = r;
      if (step.action?.text) (g.typed ||= []).push(String(step.action.text));
      if (step.status === "done" && g.unsavedForm && (g.unsavedChecks = (g.unsavedChecks || 0) + 1) <= 2) {
        // it filled a form and never saved it: not done yet
        note = "You filled a form but have not clicked its save/submit button since. The goal is not complete until it is saved: save it, then check the page.";
        continue;
      }
      if (step.status === "done") {
        // second opinion: does the page really show the goal is complete?
        const v = await verifyGoal(this, g.goal, g.done, g.context, g.start, { items: g.items, itemsDone: g.itemsDone }).catch(() => ({ complete: true }));
        g.trace?.add("verify", v);
        if (g.cancelled) return;
        if (!v.complete) {
          this._log("info", `goal not finished yet: ${v.missing}`);
          if ((g.rejections = (g.rejections || 0) + 1) > 3) return this._endGoal(g, "failed", `Not finished: ${v.missing}`);
          note = `IMPORTANT: the goal is NOT complete yet: ${v.missing}. Do not answer 'done'. Choose the next action that makes progress.`;
          continue;
        }
        // asked for a screenshot but the model never took one: take it now, of where it finished
        if (/\bscreen\s?shots?\b/i.test(g.goal) && !g.images?.length) {
          const entry = { text: "take a screenshot", status: "running" };
          g.steps.push(entry);
          this._emitGoal(g, "running");
          await this._runGoalStep(g, entry, { type: "take_screenshot", fullPage: /\b(?:full|whole|entire)\b/i.test(g.goal), label: "screenshot" });
          if (g.cancelled) return;
        }
        return this._endGoal(g, "done", step.summary);
      }
      if (step.status === "impossible" && g.blocked?.size && !g.blockNudged && g.done.some((d) => d.research && !/^(?:not run|already done|failed)/.test(d.outcome || ""))) {
        // a site blocked us, but the searches already found things: answer from them rather than give up
        g.blockNudged = true;
        note = `Don't give up because ${[...g.blocked].join(" and ")} blocked you: your web searches above found results. Answer from them now (name where they came from), or try a different site or search.`;
        continue;
      }
      if (step.status === "impossible") {
        // models sometimes claim they can't take screenshots; the app can, so do it instead of failing
        if (/\bscreen\s?shots?\b/i.test(g.goal) && !g.images?.length) {
          const entry = { text: "take a screenshot", status: "running" };
          g.steps.push(entry);
          this._emitGoal(g, "running");
          await this._runGoalStep(g, entry, { type: "take_screenshot", fullPage: /\b(?:full|whole|entire)\b/i.test(g.goal), label: "screenshot" });
          if (g.cancelled) return;
          if (entry.status === "ok") return this._endGoal(g, "done", "Here's a screenshot of the page.");
        }
        return this._endGoal(g, "failed", step.summary);
      }
      if (step.status === "item_done") {
        const item = g.items.find((x) => x.toLowerCase() === String(step.item || "").toLowerCase()) || g.items.find((x) => !g.itemsDone.includes(x) && String(step.item || "").toLowerCase().includes(x.toLowerCase().split(" ")[0]));
        if (item && !g.itemsDone.includes(item)) {
          g.itemsDone.push(item);
          g.tickedAt = (g.sigs || []).length - 1; // progress: the loop check starts over
          g.steps.push({ text: `done: ${item}`, status: "ok" });
          this._emitGoal(g, "running");
        }
        g.trace?.add("item_done", { item: step.item, matched: item || null, done: [...g.itemsDone] });
        if ((g.ticks = (g.ticks || 0) + 1) > 3 * Math.max(1, g.items.length)) return this._endGoal(g, "failed", "kept ticking items off without doing them");
        const left = g.items.filter((x) => !g.itemsDone.includes(x));
        note = left.length ? `Ticked off "${item || step.item}". Next: ${left[0]}.` : "Every checklist item is done: finish now.";
        continue;
      }
      if (step.status === "need_user") {
        this.tasks.needUser(step.summary);
        continue;
      }
      let { action, fill, error } = toAction(step, r.snap, r.tabs);
      // the same click or address again and again (a menu button clicked open and shut): say so, then stop
      // (scrolling, waiting and key presses repeat legitimately)
      const sig = action && !["scroll_down", "scroll_up", "wait_ms", "press_key"].includes(action.type) ? `${action.type}:${action.targetId || action.url || action.text || ""}` : "";
      g.repeat = sig && g.repeat?.sig === sig ? { sig, n: g.repeat.n + 1 } : { sig, n: 1 };
      if (g.repeat.n >= 3) {
        g.trace?.add("repeat", { sig, n: g.repeat.n });
        if (g.repeat.n >= 5) return this._endGoal(g, "failed", `kept repeating "${step.description || action?.label}"`);
        note = `You've now chosen "${step.description || action?.label}" ${g.repeat.n} times in a row without moving on. If it opened a menu, the menu's items are in the element list: pick one. Otherwise do something else.`;
        continue;
      }
      if (!error && ["navigate_url", "open_new_tab"].includes(action?.type) && isBlocked(action.url) && !namedIn(`${g.goal} ${g.context}`, siteKey(action.url))) {
        // don't keep knocking on a site that blocked us: that's how a block gets longer
        g.trace?.add("skipped", { url: action.url, why: "blocked site" });
        if ((g.blockedTries = (g.blockedTries || 0) + 1) > 3) return this._endGoal(g, "failed", `the sites that have what you asked for are blocking automated browsing right now (${siteKey(action.url)})`);
        note = `Not opened: ${siteKey(action.url)} blocked automated browsing from this computer recently. Use web_search (its snippets often have the answer) or a different site.`;
        continue;
      }
      // "click the I sell checkbox" on an element that isn't one: the model picked a neighbour by mistake
      const picked = action?.type === "click_element" ? r.snap?.elements?.find((e) => e.id === action.targetId) : null;
      if (!error && picked && /\b(?:check\s?box|tick|radio|toggle|switch)\b/i.test(step.description || "") && !["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes(picked.role)) {
        error = `${picked.id} is ${picked.role} "${picked.text}", not a checkbox. Pick the checkbox from the element list by its label; if it isn't there, scroll to it`;
      }
      const no = !error && isForbidden(picked, g.forbidden);
      if (no) {
        g.trace?.add("forbidden", { element: picked.id, text: picked.text, rule: no });
        g.steps.push({ text: step.description || `click ${picked.text}`, status: "fail", detail: `refused: you said not to click "${no}"` });
        this._emitGoal(g, "running");
        if (++g.invalid > 2) return this._endGoal(g, "failed", `the model kept trying to click "${picked.text}", which you said not to click`);
        note = `Refused: the user said not to click "${no}", and ${picked.id} is ${picked.role} "${picked.text}". Never click it; fill the fields yourself.`;
        continue;
      }
      action = this.tasks.place(action); // never navigate the tab you're looking at away
      if (error) {
        g.trace?.add("invalid", { error });
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
          (g.sigs ||= []).push(`fill|form|${fill}`);
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
      // "Close anyway", "Discard": throws away what was typed, so it asks even when the model thought it safe
      if (picked && DISCARDS.test(picked.text || "")) step.risky = true;
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

  /**
   * Is the agent's tab showing a bot check ("You have been blocked", a captcha)? Then remember the
   * site for a few hours and return what to tell the model; "" otherwise.
   */
  async _botCheck(g) {
    const page = this.browser.active;
    if (!page || page.isClosed()) return "";
    const b = classifyBlock({ ...(await evalIn(page, botCheckInPage, null)), url: page.url() });
    if (!b) return "";
    if (!g.blocked?.has(b.site)) {
      (g.blocked ||= new Set()).add(b.site);
      noteBlocked(b.site, b.kind);
      this._log("warn", `${b.site} showed a bot check (${b.kind}${b.said ? `: "${b.said}"` : ""}); skipping it for a few hours`);
      g.trace?.add("bot-check", b);
      g.steps.push({ text: `${b.site} blocked automated browsing`, status: "fail", detail: b.said?.slice(0, 80) });
      this._emitGoal(g, "running");
    }
    return blockNote(b);
  }

  /** One goal step, with a watchdog: a step that hangs (a frozen page) fails after 45 s instead of blocking everything. */
  async _runGoalStep(g, entry, action) {
    let timer;
    const hung = new Promise((r) => (timer = setTimeout(() => r("hung"), 45_000)));
    const r = await Promise.race([this._runGoalStepInner(g, entry, action), hung]);
    clearTimeout(timer);
    if (r === "hung") {
      this._log("warn", `step hung, moving on: ${entry.text}`);
      g.trace?.add("hung", { step: entry.text });
      entry.status = "fail";
      entry.detail = "the page stopped responding";
      g.done.push({ description: entry.text, outcome: "failed: the page didn't respond in time" });
      this.busy = false;
    }
  }

  async _runGoalStepInner(g, entry, action) {
    if (action.type === "click_element" || action.type === "press_enter") g.unsavedForm = false;
    const page = this.browser.page;
    // what the page looks like, to tell whether a step did anything: URL, title and its elements
    // (a menu opening or a "Added to queue" toast changes the elements but not the URL)
    const look = async (p) => `${p.url()}\n${await p.title().catch(() => "")}\n${await evalIn(p, pageSignature, "")}`;
    const before = page ? { url: page.url(), look: await look(page), tab: page, said: await evalIn(page, pageMessages, []) } : null;
    const { ok, res } = await this._runAction(action, { via: "goal", said: entry.text });
    // did it change anything we can see?
    const after = this.browser.page;
    const same = async () => (await look(after)) === before.look;
    let unchanged = ok && before && after === before.tab && ["click_element", "press_key", "press_enter", "go_back"].includes(action.type) && (await same());
    // sites like YouTube switch pages a moment later: give it up to 2.5 s before calling the step useless
    for (let i = 0; unchanged && i < 10; i++) {
      await new Promise((r) => setTimeout(r, 250));
      unchanged = await same();
    }
    // a confirmation the page flashed ("Added to queue", "Saved"): the next look may come too late to see it
    let said = [];
    if (ok && after && !after.isClosed()) {
      const fresh = async () => (await evalIn(after, pageMessages, [])).filter((t) => !before?.said?.includes(t));
      said = await fresh();
      // clicks that should confirm something get a little longer for the message to appear
      const confirms = /\b(?:add|added|queue|save|send|submit|post|delete|remove|subscribe|like|follow|create|confirm|apply|update|archive|share|copy)\b/i.test(`${action.label || ""} ${entry.text}`);
      const polls = confirms ? 10 : ["click_element", "press_enter", "press_key"].includes(action.type) ? 3 : 0;
      for (let i = 0; !said.length && i < polls; i++) {
        await new Promise((r) => setTimeout(r, 200));
        said = await fresh();
      }
    }
    if (ok && res.image) (g.images ||= []).push({ image: res.image, path: res.path });
    // what this step did, for spotting a task going round in circles (see stuckOn)
    (g.sigs ||= []).push(`${action.type}|${action.label || ""}|${action.text ?? action.key ?? action.url ?? ""}`);
    const url = this.browser.currentUrl?.() || "";
    entry.status = ok ? "ok" : "fail";
    // what was really clicked, next to what the model said it was clicking: they don't always match
    let clicked = action.type === "click_element" && action.label ? `clicked ${action.label}` : "";
    // a checkbox: say whether it's ticked now, so a click that didn't take shows up
    if (ok && clicked && /^(?:checkbox|radio|switch|menuitemcheckbox)\b/.test(action.label) && after && !after.isClosed()) {
      const ticked = await Promise.race([after.evaluate(checkedState, action.targetId).catch(() => null), new Promise((r) => setTimeout(() => r(null), 1500))]);
      if (typeof ticked === "boolean") clicked += ticked ? " (now checked)" : " (now not checked)";
    }
    entry.detail = ok ? clicked.slice(0, 80) || url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 80) : res.detail;
    const title = ok ? await this.browser.page?.title().catch(() => "") : "";
    g.trace?.add("step", { action: { ...action, page: undefined }, ok, unchanged, url, title, said: said.length ? said : undefined, detail: ok ? undefined : res.detail });
    // on a page with a video, where it is now: shows whether a seek / play / "next video" worked
    const media = ok && after && !after.isClosed() ? await evalIn(after, mediaState, null) : null;
    const message = `${said.length ? `; the page said: ${said.map((t) => `"${t}"`).join(", ")}` : ""}${media ? `; video: ${stateText(media)}` : ""}`;
    g.done.push({ description: entry.text, outcome: ok ? (clicked ? `${clicked}; ` : "") + (unchanged ? `done, but the page unchanged (still ${url.slice(0, 120)})${message}` : `done (now at ${url.slice(0, 120)}${title ? ` "${title.slice(0, 80)}"` : ""}${message})`) : `failed: ${res.detail}` });
    if (said.length) entry.detail = `${clicked ? `${clicked} · ` : ""}${said[0]}`.slice(0, 100);
    if (unchanged) {
      const key = `${action.type}:${action.label || action.key || action.targetId || ""}`;
      g.noEffect = { key, n: g.noEffect?.key === key ? g.noEffect.n + 1 : 1 };
      g.hint = g.noEffect.n >= 2
        ? `"${entry.text}" has now changed nothing ${g.noEffect.n} times; it's not the right control. Use a different way: another element, a keyboard shortcut (press_key) or a direct link.`
        : `"${entry.text}" didn't change the page (same URL and title). Don't do it again; if it was meant to move on, use another way (a keyboard shortcut with press_key, another element, or a direct link).`;
    } else g.noEffect = null;
    if (ok && entry.record && g.recipe && !g.replay) g.recipe.push(entry.record);
    this._emitGoal(g, "running");
    // let the page settle before the next look
    await this.browser.active?.waitForLoadState("load", { timeout: 4000 }).catch(() => {});
    await this.browser.active?.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
    // single-page sites (YouTube, Gmail) change the URL first and the content a moment later:
    // wait until what's on screen holds still, so the next look doesn't see the old results
    const p = this.browser.active;
    if (p && !p.isClosed()) {
      let prev = await evalIn(p, pageSignature, "");
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const now = await evalIn(p, pageSignature, "");
        if (now === prev) break;
        prev = now;
      }
    }
  }

  /** The user's answer to a risky goal step. */
  async goalAnswer(ok, all = false) {
    const g = this.goal;
    if (!g?.awaiting) return;
    const action = g.awaiting;
    g.awaiting = null;
    // "Keep going?" after many steps
    if (action.type === "__checkpoint") {
      if (!ok) return this._endGoal(g, "cancelled", `you stopped it after ${g.done.filter((d) => !d.research).length} steps`);
      if (all) g.noCheckpoint = true; // "Don't ask again" for this task
      this._emitGoal(g, "running");
      return this._goalLoop(g);
    }
    if (ok && all) g.autoApprove = true; // "Allow all" for the rest of this goal
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
    const mark = this.tasks.beforeAction(); // what this task changes, for "Go back to where I was"
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
      this.tasks.afterAction(mark);
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
  stop(reason = "Stopped") {
    if (this.goal) this._endGoal(this.goal, "cancelled", reason);
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
      queue: this.tasks.state(),
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
