/**
 * Recipes: the steps a finished goal actually took, saved so it can be run again without a model.
 * Elements are stored by what they look like (role + text), not by the page-specific id, and are
 * found again on the live page when replaying. Typed values become slots, with what the goal typed
 * as the default: saved "new-bill" runs as-is, or as "new-bill Globex, 99" / "new-bill amount=99".
 */

const SECRET = /^\{\{[\w.-]+\}\}$/;
const RISKY = /\b(delete|remove|pay|purchase|buy|order|transfer|send|submit|approve|reject|publish|deploy|archive|cancel)\b/i;
const SENSITIVE = /pass(word|code)?|\bpin\b|secret|token|card number|cvc|cvv/i;

export const slotName = (label, used) => {
  let base = String(label || "value").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "value";
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}-${i}`;
  used.add(name);
  return name;
};

/** One recorded step from an executed goal action and the snapshot it was chosen from. */
export function stepFromAction(action, snap, risky = false) {
  const el = (snap?.elements || []).find((e) => e.id === action.targetId);
  const match = el ? { role: el.role, text: el.text || "", placeholder: el.placeholder || "" } : null;
  const label = el ? el.text || el.placeholder || el.role : action.label || "";
  risky = Boolean(risky) || (action.type === "click_element" && RISKY.test(label));
  switch (action.type) {
    case "click_element":
      return match && { kind: "click", match, label, risky };
    case "type_into_field":
    case "select_option": {
      if (!match) return null;
      const value = String(action.text ?? "");
      const sensitive = SENSITIVE.test(`${label} ${match.placeholder}`) && !SECRET.test(value);
      return { kind: action.type === "select_option" ? "select" : "type", match, label, value: sensitive ? "" : value, sensitive, submit: Boolean(action.submit), risky };
    }
    case "press_enter":
      return { kind: "enter", label: "press Enter", risky };
    case "navigate_url":
      return { kind: "navigate", url: action.url, label: action.url };
    case "scroll_down":
    case "scroll_up":
      return { kind: action.type, label: action.type.replace("_", " ") };
    case "go_back":
      return { kind: "back", label: "go back" };
    case "wait_ms":
      return { kind: "wait", ms: action.ms || 1500, label: "wait" };
    case "take_screenshot":
      return { kind: "screenshot", fullPage: Boolean(action.fullPage), label: action.label || "screenshot" };
    case "open_new_tab":
      return { kind: "new_tab", url: action.url || "", label: action.label || "new tab" };
    case "close_tab":
      return { kind: "close_tab", label: "close this tab" };
    case "switch_tab":
      return action.title ? { kind: "switch_tab", title: action.title, label: action.label } : null;
    default:
      return null;
  }
}

/** A recorded form fill: [{ label, type, value }] */
export function stepFromFill(filled) {
  const fields = filled
    .filter((f) => !f.error)
    .map((f) => {
      const sensitive = (f.type === "password" || SENSITIVE.test(f.label)) && !SECRET.test(String(f.raw ?? f.value));
      return { label: f.label, type: f.type || "text", value: sensitive ? "" : String(f.raw ?? f.value), sensitive };
    });
  return fields.length ? { kind: "fill", fields, label: `fill ${fields.map((f) => f.label).join(", ")}` } : null;
}

/** Give every typed value a slot name (secrets and blanks too: blanks must be given). */
export function finalizeRecipe(steps) {
  const used = new Set();
  for (const s of steps) {
    if (s.kind === "type" || s.kind === "select") {
      if (!SECRET.test(s.value)) s.slot = slotName(s.label, used);
    } else if (s.kind === "fill") {
      for (const f of s.fields) if (!SECRET.test(f.value) && f.type !== "checkbox" && f.type !== "radio") f.slot = slotName(f.label, used);
    }
  }
  return steps;
}

/** [{ name, default, required }] in step order. */
export function recipeSlots(steps = []) {
  const out = [];
  for (const s of steps) {
    if (s.slot) out.push({ name: s.slot, default: s.value, required: !s.value });
    for (const f of s.fields || []) if (f.slot) out.push({ name: f.slot, default: f.value, required: !f.value });
  }
  return out;
}

/**
 * Values for a run: "Globex, 99" fills slots in order, "amount=99, vendor=Globex" by name;
 * anything not given keeps the recorded default. Returns { values } or { missing }.
 */
export function bindSlots(steps, arg = "") {
  const slots = recipeSlots(steps);
  const values = Object.fromEntries(slots.map((s) => [s.name, s.default]));
  const parts = String(arg || "").trim() ? String(arg).split(/\s*,\s*/) : [];
  const named = parts.length && parts.every((p) => /^[\w-]+\s*[=:]/.test(p));
  if (named) {
    for (const p of parts) {
      const [, k, v] = p.match(/^([\w-]+)\s*[=:]\s*(.*)$/);
      const slot = slots.find((s) => s.name === k.toLowerCase()) || slots.find((s) => s.name.startsWith(k.toLowerCase()));
      if (slot) values[slot.name] = v;
    }
  } else {
    parts.forEach((v, i) => slots[i] && (values[slots[i].name] = v));
  }
  const missing = slots.filter((s) => !values[s.name]).map((s) => s.name);
  return missing.length ? { missing } : { values };
}

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

/** The live element that best matches a recorded one, or null. */
export function findElement(elements, match) {
  if (!match) return null;
  const same = (e) => e.role === match.role;
  const want = norm(match.text || match.placeholder);
  const tests = [
    (e) => same(e) && norm(e.text) === norm(match.text) && (!match.placeholder || norm(e.placeholder) === norm(match.placeholder)),
    (e) => same(e) && norm(e.text || e.placeholder) === want,
    (e) => same(e) && match.placeholder && norm(e.placeholder) === norm(match.placeholder),
    (e) => norm(e.text || e.placeholder) === want,
    (e) => same(e) && want.length > 2 && norm(e.text).includes(want),
  ];
  for (const t of tests) {
    const hit = elements.find(t);
    if (hit && want) return hit;
  }
  return null;
}

/** What a step does, for the step list ("type Acme into Vendor"). */
export function describeStep(s, values = {}) {
  const v = (x) => (x.slot ? values[x.slot] ?? x.value : x.value);
  switch (s.kind) {
    case "click": return `click ${s.label}`;
    case "type": return `type ${v(s)} into ${s.label}`;
    case "select": return `choose ${v(s)} in ${s.label}`;
    case "fill": return `fill ${s.fields.map((f) => `${f.label}: ${f.type === "password" ? "••••" : v(f)}`).join(", ")}`;
    case "navigate": return `go to ${String(s.url).replace(/^https?:\/\/(www\.)?/, "")}`;
    default: return s.label;
  }
}
