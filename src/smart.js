/**
 * Smart commands, powered by the brain (brain.js) rather than SubQ Snap:
 *   goal: approve all pending requests under $500   -> look, act, repeat until done (max 15 steps)
 *   how many requests are pending?                    -> answer from the page text + screenshot
 *   fill the form with name Alex, role admin, ...   -> every field in one go (never submits)
 *
 * The brain only ever sees {{secret}} placeholders; values are filled in when typing.
 */
import { ask } from "./brain.js";
import { encodeElement } from "./jev.js";
import { toHttpUrl } from "./spans.js";
import { resolveSecrets } from "./secrets.js";

export const MAX_GOAL_STEPS = 15;
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
    /^(?:what|what's|whats|how many|how much|which|who|when|where|why|is there|are there|does|do i|tell me|summari[sz]e|explain|read me|list all|list the)\b/i.test(t)
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

/** What the brain sees: URL, title, numbered elements, visible text, and a screenshot. */
async function pageContext(controller, { textChars = 6000 } = {}) {
  const snap = await controller.refreshSnapshot();
  const page = await controller.browser.ensurePage();
  const text = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  const shot = await screenshot(page);
  const host = hostOf(snap.url);
  const lines = [
    `URL: ${snap.url}`,
    `Title: ${snap.title || ""}`,
    `Elements (id role "text"):`,
    ...snap.elements.map((e) => `  ${encodeElement(e, host)}`),
    `Visible text:`,
    text.replace(/\n{3,}/g, "\n\n").slice(0, textChars),
  ];
  return { snap, page, description: lines.join("\n"), images: shot ? [shot] : [] };
}

// ── page questions ─────────────────────────────────────────────

const ANSWER_SCHEMA = {
  type: "object",
  properties: { answer: { type: "string", description: "Direct, concise answer. Plain text, no markdown." } },
  required: ["answer"],
};

const withContext = (context) => (context ? `Conversation so far (earlier requests and what happened):\n${context}\n\n` : "");

export async function answerQuestion(controller, question, context = "") {
  const ctx = await pageContext(controller, { textChars: PAGE_TEXT_CHARS });
  const r = await ask({
    system:
      "You answer questions about the web page the user is looking at, using only the page text and screenshot provided. " +
      "Be concise and exact with numbers. If the page doesn't contain the answer, say so in one sentence.",
    text: `${withContext(context)}${ctx.description}\n\nQuestion: ${question}`,
    images: ctx.images,
    schema: ANSWER_SCHEMA,
  });
  return { answer: String(r.data.answer || "").trim(), model: r.model, ms: r.ms };
}

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
  const byId = new Map(fields.map((f) => [f.id, f]));
  const filled = [];
  for (const f of r.data.fills || []) {
    const field = byId.get(f.element_id);
    if (!field) continue;
    const loc = page.locator(`[data-vb-id="${f.element_id}"]`).first();
    await controller.browser.overlay("highlight", f.element_id, 900).catch(() => {});
    try {
      if (field.type === "checkbox" || field.type === "radio") {
        if (f.check === false) await loc.uncheck({ timeout: 3000 });
        else await loc.check({ timeout: 3000 });
        filled.push({ label: field.label, value: f.check === false ? "unticked" : "ticked" });
      } else if (field.type === "select") {
        const want = String(f.value || "");
        await loc.selectOption({ label: want }, { timeout: 3000 }).catch(() => loc.selectOption(want, { timeout: 3000 }));
        filled.push({ label: field.label, value: want });
      } else {
        const shown = String(f.value ?? "");
        await loc.fill(await resolveSecrets(shown), { timeout: 3000 });
        filled.push({ label: field.label, value: field.type === "password" ? "••••" : shown });
      }
    } catch (err) {
      filled.push({ label: field.label, value: f.value, error: String(err.message || err).split("\n")[0] });
    }
  }
  return { filled, missing: r.data.missing || [], model: r.model, ms: r.ms };
}

// ── goals ──────────────────────────────────────────────────────

const STEP_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["continue", "done", "impossible"] },
    summary: { type: "string", description: "When done/impossible: what was achieved or why it can't be done. Otherwise: what you see." },
    description: { type: "string", description: "The next step in a few words, e.g. 'click Approve on PR-105'." },
    action: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["click", "type", "select", "fill_form", "press_enter", "navigate", "scroll_down", "scroll_up", "go_back", "wait"] },
        element_id: { type: "string", description: "Id from the element list (click/type/select)." },
        text: {
          type: "string",
          description: "type: the text. select: the option label. fill_form: every value to enter, e.g. 'vendor Acme Ltd, amount 1250.00, due date 2026-11-15, category Utilities'. Copy {{placeholders}} unchanged.",
        },
        url: { type: "string", description: "For navigate." },
        submit: { type: "boolean", description: "For type: press Enter afterwards." },
      },
      required: ["type"],
    },
    risky: { type: "boolean", description: "True if the step submits, pays, sends, deletes or otherwise can't be undone." },
  },
  required: ["status", "summary", "description", "risky"],
};

const GOAL_SYSTEM =
  "You operate a web browser to achieve the user's goal, one step at a time. Each turn you get the current page " +
  "(URL, numbered elements, visible text, screenshot) and the steps already taken. Choose exactly ONE next action, " +
  "using only element ids that exist in the list. Prefer the most direct path. If the goal is achieved, return status 'done' " +
  "with a short summary of what was done; if it can't be achieved on this site, return 'impossible' and say why. " +
  "When a form is visible, prefer ONE fill_form action with all the values instead of typing field by field. " +
  "When asked for dummy, test or sample data, invent realistic, plausible values (names, amounts, dates in the near future, " +
  "valid-looking emails/phones) and pick sensible options from dropdowns. " +
  "Filling a form does NOT save it: afterwards you must click its save/submit button. Only return 'done' when the CURRENT page " +
  "shows evidence the goal is complete (e.g. the new item appears in a list, or a success message) — never because of steps you merely planned. " +
  "If a conversation is given, the goal is a follow-up. Resolve references like 'them', 'the first 2', 'those' or 'that bill' " +
  "to the items the earlier requests created or touched (named in the conversation), in the order they were created — " +
  "not to whatever happens to be first on the page. Leave items the conversation never mentioned alone. " +
  "Never invent ids. Mark risky=true for anything that submits, pays, sends, approves, deletes or can't be undone, " +
  "unless the user's goal explicitly asks for exactly that action.";

/** Turn one brain step into an executor action. Returns { action } or { error }. */
export function toAction(step, snap) {
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
    case "navigate":
      if (!a.url) return { error: "navigate without a url" };
      return { action: { type: "navigate_url", url: toHttpUrl(a.url), label: a.url } };
    case "scroll_down":
    case "scroll_up":
      return { action: { type: a.type, amount: "page", label: a.type.replace("_", " ") } };
    case "go_back":
      return { action: { type: "go_back", label: "go back" } };
    case "wait":
      return { action: { type: "wait_ms", ms: 1500, label: "wait 1.5s" } };
    default:
      return { error: `unknown action ${a.type}` };
  }
}

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
      "If the request doesn't refer to earlier items, return it unchanged.",
    text: `${withContext(context)}Follow-up request: ${text}`,
    schema: RESOLVE_SCHEMA,
  });
  return String(r.data.goal || text).trim() || text;
}

/** A second opinion before declaring a goal done: does the page actually show it's complete? */
export async function verifyGoal(controller, goal, done, context = "") {
  const ctx = await pageContext(controller);
  const history = done.map((d, i) => `${i + 1}. ${d.description} → ${d.outcome}`).join("\n") || "(none)";
  const r = await ask({
    system:
      "You check whether a browser task is really finished. Judge only by the current page (text, elements, screenshot) " +
      "and the steps actually taken. Counts matter: if the goal asks for N items, all N must be done and visible. " +
      "A filled but unsaved form is not done.",
    text: `${withContext(context)}Goal: ${goal}\n\nSteps taken:\n${history}\n\nCurrent page:\n${ctx.description}`,
    images: ctx.images,
    schema: VERIFY_SCHEMA,
  });
  return r.data;
}

/** Ask the brain for the next step of a goal. `done` = [{ description, outcome }]. */
export async function nextGoalStep(controller, goal, done, note = "", context = "") {
  const ctx = await pageContext(controller);
  const history = done.length ? done.map((d, i) => `${i + 1}. ${d.description} → ${d.outcome}`).join("\n") : "(none yet)";
  const r = await ask({
    system: GOAL_SYSTEM,
    text: `${withContext(context)}Goal: ${goal}\n\nSteps taken so far:\n${history}\n${note ? `\nNote: ${note}\n` : ""}\nCurrent page:\n${ctx.description}`,
    images: ctx.images,
    schema: STEP_SCHEMA,
  });
  return { step: r.data, snap: ctx.snap, model: r.model, ms: r.ms };
}
