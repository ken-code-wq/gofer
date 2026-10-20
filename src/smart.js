/**
 * Smart commands, powered by the brain (brain.js) rather than SubQ Snap:
 *   goal: approve all pending requests under $500   -> look, act, repeat until done (max 15 steps)
 *   how many requests are pending?                    -> answer from the page text + screenshot
 *   fill the form with name Alex, role admin, ...   -> every field in one go (never submits)
 *
 * The brain only ever sees {{secret}} placeholders; values are filled in when typing.
 */
import { ask, askTools } from "./brain.js";
import { webSearch, searchText, readUrl } from "./websearch.js";
import { LimitError } from "./usage.js";
import { encodeElement } from "./jev.js";
import { toHttpUrl } from "./spans.js";
import { resolveSecrets } from "./secrets.js";
import { notesForPrompt } from "./sitenotes.js";
import { readPage, readingText, citeHint, citeNote, readTabs, tabsText, kindName } from "./pagetext.js";

export const MAX_GOAL_STEPS = 25; // browser steps (web searches and page reads don't count)
const PAGE_TEXT_CHARS = 30000;

/** Which smart feature a typed command asks for, if any. Runs before chain splitting (forms have commas). */
export function routeSmart(text) {
  const t = String(text || "").trim();
  let m;
  if ((m = t.match(/^(?:goal|task|do)\s*:\s*(.+)$/is))) return { kind: "goal", goal: m[1].trim() };
  if ((m = t.match(/^(?:figure out how to|try to|help me|find a way to)\s+(.+)$/is))) return { kind: "goal", goal: m[1].trim() };
  // Multi-step tasks phrased as an outcome: "create a new bill with dummy data", "add a supplier called Acme"
  if (/^(?:please\s+)?(?:create|add|make|register|set up|draft|invite|record|log|book|duplicate)\s+(?:a|an|the|new|another|some|\d+)\b/i.test(t)) return { kind: "goal", goal: t };
  if ((m = t.match(/^fill(?:\s+(?:in|out))?\s+(?:the\s+|this\s+)?form\b(?:\s+(?:with|using))?[\s:,]*(.*)$/is))) return { kind: "fill", spec: m[1].trim() };
  if ((m = t.match(/^(?:ask|q)\s*:\s*(.+)$/is))) return { kind: "ask", question: m[1].trim() };
  if (
    /\?\s*$/.test(t) ||
    /^(?:what|what's|whats|how many|how much|which|who|when|where|why|is there|are there|does|do i|tell me|summari[sz]e|explain|compare|read me|list all|list the)\b/i.test(t)
  ) {
    return { kind: "ask", question: t };
  }
  return null;
}

const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

async function screenshot(page) {
  return page.screenshot({ type: "jpeg", quality: 60, timeout: 5000 }).catch(() => null);
}

/**
 * What the brain sees: URL, title, numbered elements, the page's text, and a screenshot. The text
 * comes from pagetext.js: a video's transcript, a PDF's pages, a Google Doc's export, or the main
 * content, cut to the parts that matter for `question` when it's long. `video: false` skips
 * fetching a video's captions (goals like "play the next one" don't need them).
 */
async function pageContext(controller, { textChars = 6000, question = "", video = true, page: only = null } = {}) {
  // `only`: read that tab without touching the agent's own snapshot (a question asked while a task runs)
  const snap = only ? await controller.browser.snapshot(only) : await controller.refreshSnapshot();
  const page = only || (await controller.browser.ensurePage());
  const reading = await readPage(page, { question, budget: textChars, video }).catch(() => null);
  const shot = await screenshot(page);
  const host = hostOf(snap.url);
  const lines = [
    `URL: ${snap.url}`,
    `Title: ${snap.title || ""}`,
    `Elements (id role "text"):`,
    ...snap.elements.map((e) => `  ${encodeElement(e, host)}`),
    reading ? readingText(reading) : "Visible text:\n(couldn't read the page)",
  ];
  return { snap, page, reading, description: lines.join("\n"), images: shot ? [shot] : [] };
}

// ── page questions ─────────────────────────────────────────────

const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", description: "The reply, in full sentences. Plain text, no markdown; use line breaks and • for lists." },
    source: { type: "string", enum: ["page", "general", "none"], description: "page: from the page. general: the page doesn't cover it, answered from your own knowledge. none: can't answer." },
    where: { type: "string", description: "Where in the content the answer is: a video time like '2:03' or a PDF page like 'page 3'. Empty if not marked." },
    search: {
      type: "string",
      description: "Only when the page doesn't answer it and you'd be guessing (recent events, prices, specific facts, something half-remembered): a web search query to look it up. Empty otherwise.",
    },
  },
  required: ["answer", "source"],
};

const withContext = (context) => (context ? `Conversation so far (earlier requests and what happened):\n${context}\n\n` : "");

/** Site notes for the page and any site the request names, as a prompt block ("" if none). */
function siteNotes(controller, url, goal) {
  const n = notesForPrompt({ url, goal });
  if (n.sites.length) controller._log?.("debug", `site notes in prompt: ${n.sites.join(", ")} (${n.text.split("\n- ").length - 1} notes)`);
  return n;
}
const withNotes = (n) => (n.text ? `${n.text}\n\n` : "");

/** Models don't know the date and their knowledge stops at some point: say so, so they search for recent things. */
export const today = () =>
  `Today is ${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}. ` +
  "Your own knowledge stops before today, so for recent events, current facts, prices or anything you aren't sure about, look it up instead of guessing.";

const ANSWER_RULES =
  "You are the assistant inside Voice Browser, which controls the user's browser (tabs, clicks, typing, screenshots). " +
  "Never say you are an AI that cannot see the page or act; you can see the page you're given. " +
  "Answer in full sentences like a helpful person in a chat: usually one to three sentences, more only when asked for a list or detail. " +
  "Be exact with numbers. If the question is about what's on screen, answer only from the page. " +
  "If the page doesn't cover it but it's a general question (facts, advice, wording, maths), answer from your own knowledge and set source to general. " +
  "Never present general knowledge as something the page says.";

/** `page`: answer about that tab (the one you're looking at) instead of the agent's. */
export async function answerQuestion(controller, question, context = "", { page = null } = {}) {
  const ctx = await pageContext(controller, { textChars: PAGE_TEXT_CHARS, question, page });
  const system = `You answer the user's questions while they browse. You can see the web page they're on (text and screenshot). ${ANSWER_RULES} ${today()} ${citeHint(ctx.reading?.kind)}`.trim();
  const text = `${withContext(context)}${withNotes(siteNotes(controller, ctx.snap.url, question))}${ctx.description}\n\nQuestion: ${question}`;
  let r = await ask({ system, text, images: ctx.images, schema: ANSWER_SCHEMA });
  let ms = r.ms;
  const query = String(r.data.search || "").trim();
  let web = null;
  if (query && r.data.source !== "page") {
    // look it up, read the best result, and answer again with what was found
    web = await webLookup(query, question).catch((err) => (controller._log?.("info", `web search failed: ${err.message || err}`), null));
    if (web) {
      r = await ask({
        system: `${system} Web search results are included: answer from them when the page doesn't cover it, set source to web, and name the site you got it from. Leave search empty.`,
        text: `${text}\n\nWeb search for "${web.query}":\n${web.text}`,
        images: ctx.images,
        schema: { ...ANSWER_SCHEMA, properties: { ...ANSWER_SCHEMA.properties, source: { type: "string", enum: ["page", "web", "general", "none"] } } },
      });
      ms += r.ms;
    }
  }
  const source = r.data.source || "page";
  const out = { answer: String(r.data.answer || "").trim(), source, ...citeNote(ctx.reading, r.data.where, source === "web" ? "general" : source), model: r.modelLabel || r.model, ms };
  if (web) out.sources = web.sources;
  return out;
}

/** Search, then read the top result or two: { query, text, sources: [{ title, url }] } for a prompt. */
async function webLookup(query, question) {
  const r = await webSearch(query, { context: question });
  const top = r.results.filter((x) => /^https?:/.test(x.url)).slice(0, 2);
  const pages = await Promise.all(top.map((x) => readUrl(x.url, { question, budget: 2500 }).catch(() => null)));
  const read = pages.filter(Boolean).map((p) => `From ${p.url} ("${p.title}"):\n${p.text}`).join("\n\n");
  return { query: r.query, text: `${searchText(r)}${read ? `\n\n${read}` : ""}`, sources: r.results.slice(0, 4).map(({ title, url }) => ({ title, url })) };
}

// ── questions across tabs ──────────────────────────────────────

const TABS_ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", description: "Direct, concise answer. Plain text, no markdown. Name tabs by their title when it helps." },
    source: { type: "string", enum: ["tabs", "general", "none"] },
    tabs: { type: "array", items: { type: "integer" }, description: "Numbers of the tabs the answer came from." },
  },
  required: ["answer", "source", "tabs"],
};

/**
 * Answer from several open tabs at once, without switching to them. `titles` limits it to the
 * mentioned tabs; otherwise every open tab (up to 15) is read. Sleeping tabs that don't answer
 * within 2 s are listed by title only.
 */
export async function answerAcrossTabs(controller, question, titles = null, context = "") {
  const tabs = await readTabs(controller.browser.pages, { titles, question, total: 45000 });
  if (!tabs.length) throw new Error(titles?.length ? "None of those tabs are open" : "No web pages are open");
  const body = tabsText(tabs);
  const r = await ask({
    system: `You answer the user's questions using the text of their open browser tabs. ${ANSWER_RULES} Here "page" means the tabs: set source to tabs when the answer comes from them, and list which tab numbers you used.`,
    text: `${withContext(context)}Open tabs:\n\n${body}\n\nQuestion: ${question}`,
    schema: TABS_ANSWER_SCHEMA,
  });
  const usedTabs = [...new Set((r.data.tabs || []).map((n) => tabs[n - 1]).filter(Boolean))];
  const used = usedTabs.map((t) => t.title).filter(Boolean);
  // "From “Talk” (video transcript), “Spec” (PDF)" when a tab was read by a special reader
  const cite = usedTabs.some((t) => kindName(t.reading?.kind))
    ? `From ${usedTabs.map((t) => `“${t.title}”${kindName(t.reading?.kind) ? ` (${kindName(t.reading.kind)})` : ""}`).join(", ")}`
    : "";
  return { answer: String(r.data.answer || "").trim(), source: r.data.source || "tabs", tabs: used, cite, read: tabs.length, model: r.modelLabel || r.model, ms: r.ms };
}

/** "which of my tabs …", "across my tabs", "in all tabs": a question about every open tab. */
export const isTabsQuestion = (t) => /\b(?:(?:my|open|all|these|those|both|other|the)\s+(?:(?:two|three|four|five|\d+)\s+)?(?:open\s+)?tabs|across\s+(?:my\s+)?tabs|which\s+tab|every\s+tab|each\s+tab)\b/i.test(String(t || ""));

// ── form filling ───────────────────────────────────────────────

/** Visible form fields with their labels and options (password values never included). */
async function formFields(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const out = [];
    for (const el of document.querySelectorAll("[data-vb-id]")) {
      const tag = el.tagName.toLowerCase();
      if (!["input", "select", "textarea"].includes(tag) || !vis(el) || el.disabled || el.readOnly) continue;
      const type = tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : tag;
      if (["hidden", "submit", "button", "reset", "image", "file"].includes(type)) continue;
      const label =
        clean(el.getAttribute("aria-label")) ||
        clean(el.labels?.[0]?.innerText) ||
        clean(el.closest("label")?.innerText) ||
        clean(el.getAttribute("placeholder")) ||
        clean(el.getAttribute("name")) ||
        clean(el.id);
      const f = { id: el.getAttribute("data-vb-id"), type, label };
      if (type === "radio") f.group = el.getAttribute("name") || "";
      if (type === "checkbox" || type === "radio") f.checked = el.checked;
      else if (type !== "password" && el.value) f.value = clean(el.value);
      if (tag === "select") f.options = [...el.options].map((o) => clean(o.label)).slice(0, 40);
      out.push(f);
    }
    return out;
  });
}

const FILL_SCHEMA = {
  type: "object",
  properties: {
    fills: {
      type: "array",
      items: {
        type: "object",
        properties: {
          element_id: { type: "string" },
          value: { type: "string", description: "Text to enter, or the exact option label for a select. Copy {{placeholders}} unchanged." },
          check: { type: "boolean", description: "For checkbox/radio: true to tick/select it, false to untick." },
        },
        required: ["element_id"],
      },
    },
    missing: { type: "array", items: { type: "string" }, description: "Things the user asked for that have no matching field." },
  },
  required: ["fills", "missing"],
};

export async function fillForm(controller, spec, context = "") {
  await controller.refreshSnapshot(); // tags fields with data-vb-id
  const page = await controller.browser.ensurePage();
  const fields = await formFields(page);
  if (!fields.length) return { filled: [], missing: [], error: "No form fields on this page" };
  const r = await ask({
    system:
      "You fill in web forms. Map what the user asked for onto the given fields by their labels. " +
      "Only use the given element ids. Values: copy the user's text exactly (including {{placeholders}}); for selects use one of the listed option labels; " +
      "for dates use the format the field expects (date inputs: YYYY-MM-DD). Leave out fields the user didn't mention.",
    text: `${withContext(context)}Form fields (JSON):\n${JSON.stringify(fields)}\n\nUser: fill the form with ${spec || "(no details given)"}`,
    schema: FILL_SCHEMA,
  });
  const filled = await applyFills(controller, page, fields, r.data.fills || []);
  return { filled, missing: r.data.missing || [], model: r.modelLabel || r.model, ms: r.ms };
}

// ── tables ─────────────────────────────────────────────────────

const TABLE_SCHEMA = {
  type: "object",
  properties: {
    columns: { type: "array", items: { type: "string" }, description: "Column headings." },
    rows: { type: "array", items: { type: "array", items: { type: "string" } }, description: "One array of cell values per item, in column order." },
    note: { type: "string", description: "Empty, or why nothing (or only part) could be found." },
  },
  required: ["columns", "rows"],
};

/** Pull the items the user asked for out of the page as a table. */
export async function extractTable(controller, what, context = "") {
  const ctx = await pageContext(controller, { textChars: PAGE_TEXT_CHARS });
  const r = await ask({
    system:
      "You turn what is on a web page into a table. Use only values that appear in the page text (copy them exactly, no invented rows). " +
      "Pick sensible columns for what the user asked for; if they asked for one kind of value, one column is fine. Keep page order.",
    text: `${withContext(context)}The user wants: ${what}\n\nPage:\n${ctx.description}`,
    images: ctx.images,
    schema: TABLE_SCHEMA,
  });
  const columns = (r.data.columns || []).map(String);
  const rows = (r.data.rows || []).map((row) => columns.map((_, i) => String(row?.[i] ?? "")));
  return { columns, rows, note: r.data.note || "", model: r.modelLabel || r.model, ms: r.ms, title: ctx.snap.title };
}

/** Fill fields by element id: [{ element_id, value, check }] -> [{ label, type, value, error? }] */
async function applyFills(controller, page, fields, fills) {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const filled = [];
  for (const f of fills) {
    const field = byId.get(f.element_id);
    if (!field) continue;
    const loc = page.locator(`[data-vb-id="${f.element_id}"]`).first();
    await controller.browser.overlay("highlight", f.element_id, 900).catch(() => {});
    try {
      if (field.type === "checkbox" || field.type === "radio") {
        if (f.check === false) await loc.uncheck({ timeout: 3000 });
        else await loc.check({ timeout: 3000 });
        filled.push({ label: field.label, type: field.type, value: f.check === false ? "unticked" : "ticked" });
      } else if (field.type === "select") {
        const want = String(f.value || "");
        await loc.selectOption({ label: want }, { timeout: 3000 }).catch(() => loc.selectOption(want, { timeout: 3000 }));
        filled.push({ label: field.label, type: field.type, value: want });
      } else {
        const shown = String(f.value ?? "");
        await loc.fill(await resolveSecrets(shown), { timeout: 3000 });
        const secretRef = /^\{\{[\w.-]+\}\}$/.test(shown);
        filled.push({ label: field.label, type: field.type, value: field.type === "password" && !secretRef ? "••••" : shown });
      }
    } catch (err) {
      filled.push({ label: field.label, type: field.type, value: f.value, error: String(err.message || err).split("\n")[0] });
    }
  }
  return filled;
}

/** Replay a recorded fill: match fields by label on the live page, no model. */
export async function replayFill(controller, recorded) {
  await controller.refreshSnapshot();
  const page = await controller.browser.ensurePage();
  const fields = await formFields(page);
  const norm = (x) => String(x || "").toLowerCase().replace(/\s+/g, " ").trim();
  const fills = [];
  const missing = [];
  for (const r of recorded) {
    const field = fields.find((f) => norm(f.label) === norm(r.label)) || fields.find((f) => norm(f.label).includes(norm(r.label)) && norm(r.label).length > 2);
    if (!field) { missing.push(r.label); continue; }
    fills.push({ element_id: field.id, value: r.value, check: r.value !== "unticked" });
  }
  return { filled: await applyFills(controller, page, fields, fills), missing };
}

// ── goals ──────────────────────────────────────────────────────

const STEP_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["continue", "done", "impossible", "need_user", "item_done"] },
    item: { type: "string", description: "With item_done: the checklist item that's now done." },
    summary: {
      type: "string",
      description: "When done/impossible: your reply to the user, in first person, one or two short friendly sentences saying what you did (naming the specific result, e.g. the song or item) or why it can't be done. When need_user: one short sentence telling the user what to do (e.g. 'Please sign in to GitHub, then hand back.'). Otherwise: what you see.",
    },
    description: { type: "string", description: "The next step in a few words, e.g. 'click Approve on PR-105'." },
    action: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["click", "type", "select", "fill_form", "press_enter", "press_key", "navigate", "new_tab", "switch_tab", "close_tab", "screenshot", "scroll_down", "scroll_up", "go_back", "wait", "web_search", "read_url", "video_control"] },
        op: { type: "string", enum: ["seek_by", "seek_to", "play", "pause", "restart", "speed", "mute", "unmute"], description: "For video_control." },
        seconds: { type: "number", description: "For video_control seek_by (negative = back) / seek_to." },
        rate: { type: "number", description: "For video_control speed." },
        element_id: { type: "string", description: "Id from the element list (click/type/select)." },
        text: {
          type: "string",
          description: "type: the text. select: the option label. fill_form: every value to enter, e.g. 'vendor Acme Ltd, amount 1250.00, due date 2026-11-15, category Utilities'. Copy {{placeholders}} unchanged.",
        },
        url: { type: "string", description: "For navigate and read_url. For new_tab: the address to open in it (optional)." },
        query: { type: "string", description: "For web_search: what to search for." },
        tab: { type: "integer", description: "For switch_tab: the number of the tab in the open tabs list." },
        key: { type: "string", description: "For press_key: a key or shortcut, e.g. 'Shift+N', 'k', 'Space', 'Escape'." },
        full_page: { type: "boolean", description: "For screenshot: capture the whole scrolling page instead of what's visible." },
        submit: { type: "boolean", description: "For type: press Enter afterwards." },
      },
      required: ["type"],
    },
    risky: { type: "boolean", description: "True if the step submits, pays, sends, deletes or otherwise can't be undone." },
  },
  required: ["status", "summary", "description", "risky"],
};

const GOAL_SYSTEM =
  "You are the agent inside Voice Browser and you control the user's real browser: you can open, switch and close tabs, " +
  "navigate, click, type, scroll and take screenshots that are sent to the user. Never say you are an AI that cannot see, " +
  "act or take screenshots; use the actions. " +
  "You operate a web browser to achieve the user's goal, one step at a time. Each turn you get the current page " +
  "(URL, numbered elements, visible text, screenshot) and the steps already taken. Choose exactly ONE next action, " +
  "using only element ids that exist in the list. Prefer the most direct path. " +
  "Work in the current tab (marked '← current') unless the goal names another tab, needs a new one, or the current tab " +
  "clearly isn't where it can be done; never move into one of the user's other tabs just because it looks relevant. " +
  "The user keeps working while you do: never take over the tab they are looking at (marked 'user is looking at this') to go " +
  "somewhere else. If the goal is about that page ('this page', 'here', 'summarize this') work on it; if it needs a different " +
  "site, open it with new_tab (new tabs open in the background, so the user isn't disturbed) and work there. " +
  "When you finish in a tab the user isn't looking at, say it's ready in a background tab (never 'the current tab'). " +
  "You are not limited to the current tab: open a new tab (new_tab, with a url to load in it), switch to any open tab " +
  "(switch_tab with its number) or close the current tab (close_tab) whenever the goal calls for it. Opening a new tab " +
  "leaves the user's other tabs untouched, so prefer it when asked for a new tab. " +
  "When the user wants to see something ('send me a screenshot', 'show me', 'screenshot the results'), get the page into the " +
  "right state, then use the screenshot action (it is sent to them in the chat); after taking it you can finish. " +
  "For a video or audio on the page (seek back/forward, jump to a time, play, pause, speed) use video_control: it's exact " +
  "and tells you where the video is afterwards. Each step on a page with a video reports its state ('video: 1:13 / 10:02, " +
  "playing'), so you can see whether it worked. Keyboard shortcuts (press_key) are often the most reliable control for " +
  "everything else on media sites; site notes list a site's shortcuts. If site notes are given, they are " +
  "tips learned on earlier visits to that site: follow them when they fit, but trust the current page. " +
  "If an action didn't change the page (the step says 'page unchanged'), don't repeat it: try a different control, " +
  "a shortcut or a direct link. " +
  "Stop as soon as the goal is achieved and return 'done': never take extra steps 'to make sure' (each extra 'next' skips " +
  "another item). Don't press play/pause unless asked; a video that just opened is already playing. If the goal is achieved, return status 'done' " +
  "with a short summary of what was done; if it can't be achieved on this site, return 'impossible' and say why. " +
  "If you hit something only the user can do (a login or password you don't have, a captcha, two-factor code, a payment " +
  "confirmation), return status 'need_user' with a one-sentence summary of what they need to do; they'll hand control back " +
  "when done and you continue. Never guess passwords. " +
  "When the goal covers several items (three people, several videos, a list of bills), do them one after another and keep " +
  "count: name the item in each step's description (e.g. 'Kevin Hart: add to queue'), check the steps taken to see which items " +
  "are already done, never redo one, and finish once every item is done. Some steps succeed without changing the URL " +
  "(adding to a queue or list): look for the confirmation the page showed ('the page said: …'). " +
  "When a form is visible, prefer ONE fill_form action with all the values instead of typing field by field. " +
  "When asked for dummy, test or sample data, invent realistic, plausible values (names, amounts, dates in the near future, " +
  "valid-looking emails/phones) and pick sensible options from dropdowns. " +
  "Filling a form does NOT save it: afterwards you must click its save/submit button. Only return 'done' when the CURRENT page " +
  "shows evidence the goal is complete (e.g. the new item appears in a list, or a success message) — never because of steps you merely planned. " +
  "If a conversation is given, the goal is a follow-up. Resolve references like 'them', 'the first 2', 'those' or 'that bill' " +
  "to the items the earlier requests created or touched (named in the conversation), in the order they were created — " +
  "not to whatever happens to be first on the page. Leave items the conversation never mentioned alone. " +
  "Never invent ids. Mark risky=true for anything that submits, pays, sends, approves, deletes or can't be undone, " +
  "unless the user's goal explicitly asks for exactly that action. " +
  "You can also search the web (web_search) and read any web page (read_url) in the background, without opening a tab or " +
  "disturbing the user's tabs; use web_search rather than opening a search engine in a tab, but when you're already on the " +
  "site that has what you need (YouTube, a shop, the app you're working in), use that site's own search box instead. Use them to find facts, identify something the user half-remembers, or find the right page; " +
  "then navigate only if the user wants to go there or something must be done on that site. If the goal is just to find out " +
  "something, answer it from what you found and finish. Don't search for things the current page already shows. " +
  "If a search doesn't find it, don't keep searching with similar words: read the most promising result (read_url), or change the words (drop quotes, add the era, 'TV ad', 'commercial', 'song', " +
  "the place) or read a promising result. Once the searches point to an answer, finish with it (say how sure you are if " +
  "it's a best guess) rather than giving up. Never name an answer that no search result or page you read supports: if " +
  "nothing was found, say so and what you did find. " +
  "If the message needs no browser action (a greeting, thanks, or something you can simply answer), return 'done' right away " +
  "with your reply in summary. If the goal asks for a different result than before ('another one'), pick one that the conversation " +
  "hasn't already used. Never say you did something the steps taken don't show.";

// ── the goal agent's tools (native tool calls; STEP_SCHEMA is the JSON fallback) ─────────

const DESC = { description: { type: "string", description: "The step in a few words, e.g. 'click Approve on PR-105'." } };
const RISKY = { risky: { type: "boolean", description: "True if it submits, pays, sends, deletes or otherwise can't be undone." } };
const EL = { element_id: { type: "string", description: "Id from the element list." } };
const tool = (name, description, properties = {}, required = []) => ({
  name,
  description,
  parameters: { type: "object", properties: { ...properties, ...DESC }, required: [...required, "description"] },
});

const BROWSER_TOOLS = [
  tool("click", "Click an element on the current page.", { ...EL, ...RISKY }, ["element_id"]),
  tool("type_text", "Type into a field.", { ...EL, text: { type: "string", description: "The text. Copy {{placeholders}} unchanged." }, submit: { type: "boolean", description: "Press Enter afterwards." }, ...RISKY }, ["element_id", "text"]),
  tool("select_option", "Choose an option in a dropdown.", { ...EL, option: { type: "string", description: "The option's label." } }, ["element_id", "option"]),
  tool("fill_form", "Fill every visible form field in one go (doesn't submit).", { values: { type: "string", description: "Every value, e.g. 'vendor Acme Ltd, amount 1250.00, due date 2026-11-15'." } }, ["values"]),
  tool("press_key", "Press a key or shortcut on the page, e.g. 'Shift+N', 'k', 'Space', 'Escape', 'Enter'.", { key: { type: "string" }, ...RISKY }, ["key"]),
  tool("navigate", "Load an address in the current tab.", { url: { type: "string" } }, ["url"]),
  tool("new_tab", "Open a new tab (leaves the user's other tabs alone), optionally loading an address.", { url: { type: "string" } }),
  tool("switch_tab", "Switch to another open tab.", { tab: { type: "integer", description: "The tab's number in the open tabs list." } }, ["tab"]),
  tool("close_tab", "Close the current tab."),
  tool("screenshot", "Take a screenshot; it is sent to the user in the chat.", { full_page: { type: "boolean", description: "The whole scrolling page instead of what's visible." } }),
  tool("scroll", "Scroll the page.", { direction: { type: "string", enum: ["down", "up"] } }, ["direction"]),
  tool("go_back", "Go back to the previous page."),
  tool(
    "video_control",
    "Control the page's video or audio exactly (more reliable than keyboard shortcuts, and it reports where the video is now).",
    {
      op: { type: "string", enum: ["seek_by", "seek_to", "play", "pause", "restart", "speed", "mute", "unmute"] },
      seconds: { type: "number", description: "seek_by: seconds to move (negative = back). seek_to: the time in seconds." },
      rate: { type: "number", description: "speed: playback rate, e.g. 1.5." },
    },
    ["op"],
  ),
  tool("wait", "Wait a moment for the page to finish loading."),
];
const RESEARCH_TOOLS = [
  tool("web_search", "Search the web in the background (no tab opens). Returns titles, links and snippets.", { query: { type: "string" } }, ["query"]),
  tool("read_url", "Read a web page or PDF in the background (no tab opens). Returns the parts relevant to the goal.", { url: { type: "string" } }, ["url"]),
];
const ITEM_DONE_TOOL = tool(
  "item_done",
  "Tick an item off the checklist once a step really did it (e.g. its 'Add to queue' was clicked). No browser action.",
  { item: { type: "string", description: "The checklist item, as written there." } },
  ["item"],
);
const FINISH_TOOL = {
  name: "finish",
  description: "End the task: the goal is achieved (done), it can't be achieved (impossible), or only the user can do the next part, like signing in or a captcha (need_user).",
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["done", "impossible", "need_user"] },
      summary: { type: "string", description: "Your reply to the user, in first person: one or two short friendly sentences saying what you did or found (naming the specific result) or why it can't be done." },
    },
    required: ["status", "summary"],
  },
};

/** A tool call as a STEP_SCHEMA step, so the rest of the goal loop doesn't care which way the model answered. */
export function stepFromCall({ name, args = {} }) {
  if (name === "item_done") return { status: "item_done", summary: "", description: String(args.description || ""), item: String(args.item || ""), risky: false };
  if (name === "finish") return { status: ["impossible", "need_user"].includes(args.status) ? args.status : "done", summary: String(args.summary || ""), description: "", risky: false };
  const a = { ...args };
  const type = { type_text: "type", select_option: "select", scroll: args.direction === "up" ? "scroll_up" : "scroll_down" }[name] || name;
  const action = { type };
  if (a.element_id != null) action.element_id = String(a.element_id);
  if (name === "select_option") action.text = a.option;
  else if (name === "fill_form") action.text = a.values;
  else if (a.text != null) action.text = a.text;
  for (const k of ["url", "tab", "key", "full_page", "submit", "query", "op", "seconds", "rate"]) if (a[k] != null) action[k] = a[k];
  return { status: "continue", summary: "", description: String(a.description || ""), action, risky: Boolean(a.risky) };
}

const isResearch = (step) => ["web_search", "read_url"].includes(step?.action?.type);
const MAX_RESEARCH = 8; // searches and page reads per goal

/** Run one web_search / read_url step. Returns { description, outcome, ok }. */
async function runResearch(step, goal) {
  const a = step.action;
  try {
    if (a.type === "web_search") {
      const r = await webSearch(a.query || step.description, { context: goal });
      return { ok: true, description: `search the web: ${r.query}`, outcome: `results (${r.provider}):\n${searchText(r)}`, detail: `${r.results.length} results via ${r.provider}` };
    }
    const p = await readUrl(a.url, { question: goal, budget: 3500 });
    return { ok: true, description: `read ${p.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 80)}`, outcome: `page "${p.title}":\n${p.text}`, detail: p.title || p.url };
  } catch (err) {
    return { ok: false, description: a.type === "web_search" ? `search the web: ${a.query}` : `read ${a.url}`, outcome: `failed: ${err.message || err}`, detail: String(err.message || err) };
  }
}

/** Steps taken, for the prompt. Older search results and page reads are cut short to keep the prompt small. */
function historyText(done) {
  if (!done.length) return "(none yet)";
  const research = done.map((d, i) => (d.research ? i : -1)).filter((i) => i >= 0);
  const keepFull = new Set(research.slice(-3));
  return done
    .map((d, i) => `${i + 1}. ${d.description} → ${d.research && !keepFull.has(i) ? `${d.outcome.slice(0, 300)}…` : d.outcome}`)
    .join("\n");
}

/** Turn one brain step into an executor action. Returns { action } or { error }. `tabs` = goalTabs(). */
export function toAction(step, snap, tabs = []) {
  const a = step.action || {};
  const ids = new Set((snap?.elements || []).map((e) => e.id));
  const el = (snap?.elements || []).find((e) => e.id === a.element_id);
  const label = el ? `${el.role} "${el.text || el.placeholder || ""}"` : a.element_id;
  const needsEl = ["click", "type", "select"].includes(a.type);
  if (needsEl && !ids.has(a.element_id)) return { error: `element ${a.element_id || "(none)"} is not on the page` };
  switch (a.type) {
    case "click":
      return { action: { type: "click_element", targetId: a.element_id, label } };
    case "type":
      return { action: { type: "type_into_field", targetId: a.element_id, text: String(a.text ?? ""), submit: Boolean(a.submit), label } };
    case "select":
      return { action: { type: "select_option", targetId: a.element_id, text: String(a.text ?? ""), label } };
    case "fill_form":
      return { fill: String(a.text || "") };
    case "press_enter":
      return { action: { type: "press_enter", label: "press enter" } };
    case "press_key":
      if (!a.key) return { error: "press_key without a key" };
      return { action: { type: "press_key", key: String(a.key), label: `press ${a.key}` } };
    case "navigate":
      if (!a.url) return { error: "navigate without a url" };
      return { action: { type: "navigate_url", url: toHttpUrl(a.url), label: a.url } };
    case "new_tab":
      return a.url
        ? { action: { type: "open_new_tab", url: toHttpUrl(a.url), label: `new tab: ${a.url}` } }
        : { action: { type: "open_new_tab", label: "new tab" } };
    case "switch_tab": {
      const t = tabs.find((x) => x.n === Number(a.tab));
      if (!t) return { error: `tab ${a.tab ?? "(none)"} is not open` };
      const action = { type: "switch_tab", title: t.title, label: `switch to tab "${t.title || t.url}"` };
      Object.defineProperty(action, "page", { value: t.page }); // not enumerable: actions are sent to the bar as JSON
      return { action };
    }
    case "close_tab":
      return { action: { type: "close_tab", label: "close this tab" } };
    case "screenshot":
      return { action: { type: "take_screenshot", fullPage: Boolean(a.full_page), label: a.full_page ? "screenshot of the whole page" : "screenshot" } };
    case "scroll_down":
    case "scroll_up":
      return { action: { type: a.type, amount: "page", label: a.type.replace("_", " ") } };
    case "go_back":
      return { action: { type: "go_back", label: "go back" } };
    case "wait":
      return { action: { type: "wait_ms", ms: 1500, label: "wait 1.5s" } };
    case "video_control": {
      const ops = ["seek_by", "seek_to", "play", "pause", "restart", "speed", "mute", "unmute"];
      if (!ops.includes(a.op)) return { error: `video_control needs op (one of ${ops.join(", ")})` };
      const m = { op: a.op };
      if (a.op === "seek_by" || a.op === "seek_to") m.seconds = Number(a.seconds) || 0;
      if (a.op === "speed") m.rate = Number(a.rate) || 1;
      const label = a.op === "seek_by" ? `video ${m.seconds < 0 ? "back" : "forward"} ${Math.abs(m.seconds)}s` : a.op === "seek_to" ? `video to ${m.seconds}s` : a.op === "speed" ? `video speed ${m.rate}x` : `video ${a.op}`;
      return { action: { type: "media", actions: [m], label } };
    }
    default:
      return { error: `unknown action ${a.type}` };
  }
}

const ITEMS_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: { type: "string" },
      description: "The separate things the goal asks to be done, each a few words naming the item (e.g. 'Trevor Noah video', 'Dave Chappelle video'). Empty if it's one thing.",
    },
  },
  required: ["items"],
};

/** Goals that may cover several items: "… X, Y and Z …", "add 3 …", "each of …". */
export const mayHaveItems = (goal) => /,|\b(?:and|each|every|all of)\b|\b(?:[2-9]|two|three|four|five|six|several|some)\s+\w+/i.test(String(goal || ""));

/** Split a goal that covers several items into a checklist (["Trevor Noah video", …]); [] for a single thing. */
export async function goalItems(goal, context = "") {
  const r = await ask({
    system:
      "Split a browser task into the separate items it asks for, so progress can be tracked. 'Add videos by A, B and C to the queue' " +
      "-> one item per person. 'Create 3 bills' -> 'bill 1', 'bill 2', 'bill 3'. 'Play the next video' or 'find the cheapest flight' " +
      "-> [] (one thing). At most 10 items.",
    text: `${withContext(context)}Task: ${goal}`,
    schema: ITEMS_SCHEMA,
  });
  const items = (Array.isArray(r.data.items) ? r.data.items : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 10);
  return items.length > 1 ? items : [];
}

/** The checklist as prompt text. */
export const checklistText = (items = [], done = []) =>
  items.length ? `Checklist (tick each item off with item_done once it's really done; work on the first unticked one):\n${items.map((x) => `  [${done.includes(x) ? "x" : " "}] ${x}`).join("\n")}\n` : "";

const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    complete: { type: "boolean", description: "True only if the current page shows the whole goal has been achieved." },
    missing: { type: "string", description: "If not complete: what is still left to do, concretely (e.g. 'only 2 of the 3 bills are in the list')." },
  },
  required: ["complete", "missing"],
};

const RESOLVE_SCHEMA = {
  type: "object",
  properties: {
    goal: { type: "string", description: "The follow-up rewritten as a self-contained goal that names the exact items, e.g. 'delete the bills Acme Corp ($150) and Globex Corp ($275.50)'." },
  },
  required: ["goal"],
};

/**
 * "now delete the first 2" means nothing without the conversation. Rewrite it once, up front,
 * into a goal that names the items, so the step planner can't drift to "the first rows on the page".
 */
export async function resolveFollowUp(context, text) {
  const r = await ask({
    system:
      "Rewrite a follow-up request into a standalone browser goal. References like 'them', 'those', 'the first 2', 'the last one' " +
      "refer to the items created or changed in the conversation (in the order they were created), never to other items on the page. " +
      "Name those items explicitly with their distinguishing details. Keep the user's intent and wording otherwise. " +
      "'Another one', 'a different one', 'no, not that' or 'something else' mean: the previous request again, but with a different " +
      "result; name the earlier result(s) to avoid (e.g. 'play a different Prince of Egypt song than When You Believe'). " +
      "Say WHAT to achieve, never HOW: don't name buttons, clicks or steps the user didn't mention " +
      "('play the next video', not 'click the Next button'). " +
      "If the request doesn't refer to earlier items, return it unchanged.",
    text: `${withContext(context)}Follow-up request: ${text}`,
    schema: RESOLVE_SCHEMA,
  });
  return String(r.data.goal || text).trim() || text;
}

/** A second opinion before declaring a goal done: does the page actually show it's complete? */
export async function verifyGoal(controller, goal, done, context = "", start = null, { items = [], itemsDone = [] } = {}) {
  const ctx = await pageContext(controller, { question: goal, video: aboutContent(goal) });
  const history = historyText(done);
  const r = await ask({
    system:
      `${today()} ` +
      "You check whether a browser task is really finished. Judge only by the current page (text, elements, screenshot) " +
      "and the steps actually taken. Counts matter: if the goal asks for N items, all N must be done and visible. " +
      "If the goal is to move on to another item (the next video, the next page, a different result), the current page must " +
      "be a different one than where it started; the same URL and title means it is NOT done. " +
      "A filled but unsaved form is not done. If the goal needs no browser action at all (a greeting, thanks, a question answered " +
      "from knowledge), it is complete. If the goal is to find out or identify something, it is complete when the web searches or " +
      "page reads in the steps found the answer, even if the page doesn't show it. " +
      "Some results don't stay on screen (a video added to a queue, an item added to a list on another page, a message sent): " +
      "count an item as done when a step did it and either the page confirmed it (the step says 'the page said: …') or the " +
      "step plainly did it (e.g. clicked 'Add to queue' for that item). Don't ask for items to be redone just because the " +
      "current page doesn't show them. If the goal asks for a different result than before, the page must show a different one than those already given.",
    text: `${withContext(context)}${withNotes(notesForPrompt({ url: ctx.snap.url, goal }))}Goal: ${goal}\n\n${checklistText(items, itemsDone)}Started on: ${start ? `${start.url} (${start.title})` : "unknown"}\n\nSteps taken:\n${history}\n\nCurrent page:\n${ctx.description}`,
    images: ctx.images,
    schema: VERIFY_SCHEMA,
  });
  return r.data;
}

/** The open tabs a goal can switch to, numbered from 1. Sleeping tabs can't hold it up. */
export async function goalTabs(browser) {
  const live = (browser.pages || []).filter((p) => !p.isClosed() && /^(?:https?:|about:blank)/.test(p.url()));
  const title = (p) => Promise.race([p.title().catch(() => ""), new Promise((r) => setTimeout(() => r(""), 400))]);
  const titles = await Promise.all(live.map(title));
  return live.map((page, i) => ({ n: i + 1, page, title: titles[i], url: page.url(), current: page === browser.active, shown: page === browser.shown }));
}

/** Goals that need what a video says ("skip to where he talks about pricing"), not just its controls. */
const aboutContent = (goal) => /\b(?:say|says|said|talk|talks|talking|mention|mentions|minute|moment|part where|transcript|captions?|summar\w*|quote|explain\w*|discuss\w*)\b/i.test(goal);

/**
 * Ask the brain for the next browser step of a goal. `done` = [{ description, outcome }].
 * The model answers with tool calls (falling back to a JSON step for models that can't). Web
 * searches and page reads happen right here, in the background, and are added to `done`
 * (reported through `onResearch`); this returns once the model picks a browser step or finishes.
 */
export async function nextGoalStep(controller, goal, done, note = "", context = "", { onResearch, items = [], itemsDone = [] } = {}) {
  const ctx = await pageContext(controller, { question: goal, video: aboutContent(goal) });
  const tabs = await goalTabs(controller.browser).catch(() => []);
  const tabLines = tabs.map((t) => `  ${t.n}. ${(t.title || "(untitled)").slice(0, 80)} (${t.url.slice(0, 120)})${t.current ? " ← current" : ""}${t.shown ? " (user is looking at this)" : ""}`);
  const notes = siteNotes(controller, ctx.snap.url, goal);
  const models = [];
  let ms = 0;
  for (let round = 0; ; round++) {
    const researched = done.filter((d) => d.research).length;
    // repeats and failed lookups count against it too: a model stuck on one query gets moved on
    const wasted = done.filter((d) => d.research && d.outcome.startsWith("already done")).length;
    const canResearch = researched < MAX_RESEARCH && round < 4 && wasted < 2;
    const limitNote = canResearch ? "" : "\nNote: no more web searches or page reads for this goal; act on the page or finish.\n";
    const text = `${withContext(context)}${withNotes(notes)}Goal: ${goal}\n\n${checklistText(items, itemsDone)}${items.length ? "\n" : ""}Steps taken so far:\n${historyText(done)}\n${note ? `\nNote: ${note}\n` : ""}${limitNote}\nOpen tabs:\n${tabLines.join("\n") || "  (only this one)"}\n\nCurrent page:\n${ctx.description}`;
    let steps;
    let calls;
    try {
      const r = await askTools({ system: `${GOAL_SYSTEM} ${today()}`, text, images: ctx.images, tools: [...BROWSER_TOOLS, ...(canResearch ? RESEARCH_TOOLS : []), ...(items.length ? [ITEM_DONE_TOOL] : []), FINISH_TOOL] });
      models.push(r.modelLabel || r.model);
      ms += r.ms;
      steps = r.calls.map(stepFromCall);
      calls = r.calls;
    } catch (err) {
      if (err instanceof LimitError || err?.name === "AbortError") throw err;
      // no model could do tool calls: the JSON step format
      controller._log?.("debug", `tool calls failed (${err.message || err}); asking for a JSON step`);
      const r = await ask({ system: `${GOAL_SYSTEM} ${today()}`, text, images: ctx.images, schema: STEP_SCHEMA });
      models.push(r.modelLabel || r.model);
      ms += r.ms;
      steps = [r.data];
    }
    const research = canResearch ? steps.filter(isResearch) : [];
    if (!research.length) {
      const step = steps.find((x) => !isResearch(x)) || { status: "continue", summary: "", description: "", action: { type: "wait" }, risky: false };
      return { step, snap: ctx.snap, tabs, sites: notes.sites, model: models.at(-1), models, ms, calls, prompt: text };
    }
    // searches and reads asked for together run together; one already done isn't run again
    const key = (x) => `${x.action.type}:${String(x.action.query || x.action.url || "").toLowerCase().replace(/["'\s]+/g, " ").trim()}`;
    const doneKeys = new Set(done.filter((d) => d.research).map((d) => d.key));
    const results = await Promise.all(
      research.slice(0, 3).map(async (x) => {
        const k = key(x);
        // "site:youtube.com …" while on YouTube: the site's own search is quicker and gives clickable results
        const here = hostOf(ctx.snap.url);
        const site = String(x.action.query || "").match(/\bsite:([^\s/]+)/i)?.[1]?.replace(/^www\./, "");
        if (x.action.type === "web_search" && here && site && (here === site || here.endsWith(`.${site}`))) {
          return { ok: false, key: k, description: `search the web: ${x.action.query}`, outcome: `not run: you're already on ${here}; use its own search box instead.`, detail: "already done" };
        }
        if (doneKeys.has(k)) return { ok: false, key: k, description: x.action.type === "web_search" ? `search again: ${x.action.query}` : `read again: ${x.action.url}`, outcome: "already done above, with the results shown there. Use different words, read a result, or finish with what you found.", detail: "already done" };
        return { ...(await runResearch(x, goal)), key: k };
      }),
    );
    for (const res of results) {
      done.push({ description: res.description, outcome: res.outcome, research: true, key: res.key });
      onResearch?.(res);
    }
    if (controller.goal?.cancelled) return { step: { status: "continue", action: { type: "wait" } }, snap: ctx.snap, tabs, sites: notes.sites, model: models.at(-1), models, ms };
  }
}
