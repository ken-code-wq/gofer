/**
 * Things the user said not to click: "DO NOT CLICK AUTOFILL", "no autofill", "don't press any save
 * button". A small model can read that and click Autofill anyway, so the goal loop refuses those
 * clicks in code and tells the model why.
 *
 * Also: buttons that throw away what was typed ("Close anyway", "Discard") always ask first.
 */

const STOP = /\s*(?:[.,;:!?()"“”]|\b(?:and|but|or|then|after|afterwards|before|when|unless|until|because|instead|manually|please|at all|ever|again)\b|$)/i;

const clean = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/^(?:on|the|any|a|an|that|this|those|these)\s+/g, "")
    .replace(/^(?:on|the|any|a|an|that|this|those|these)\s+/g, "")
    .replace(/\s+(?:buttons?|links?|options?|tabs?|menu items?|icons?|toggles?)$/i, "")
    .trim();

/** The goal's "don't click X" parts -> ["autofill", "save"] (lower case, as written). */
export function forbiddenClicks(text) {
  const t = String(text || "");
  const out = new Set();
  const lead = /\b(?:do\s+not|don'?t|dont|never|no|without|avoid|stop)\s+(?:(?:ever|again)\s+)?(?:(?:click|press|tap|hit|touch|use|select|choose|open)(?:ing)?\s+(?:on\s+)?)?/gi;
  let m;
  while ((m = lead.exec(t))) {
    const verb = /(?:click|press|tap|hit|touch|use|select|choose|open)/i.test(m[0]);
    const rest = t.slice(m.index + m[0].length);
    const stop = rest.search(STOP);
    const words = clean(rest.slice(0, stop < 0 ? undefined : stop));
    if (!words || words.split(/\s+/).length > 4) continue;
    // "no X" with no verb names a thing only when it's short ("no autofill"), not "no more than 3"
    if (!verb && (words.split(/\s+/).length > 2 || /^(?:more|less|longer|need|one|way|matter|problem|idea|thanks|worries)\b|^\w+ing\b/.test(words))) continue;
    out.add(words);
  }
  return [...out];
}

/** Is this element one of them? Matches its text containing the words ("save" -> "Save Draft"). */
export function isForbidden(el, forbidden) {
  if (!el || !forbidden?.length) return null;
  const text = String(el.text || el.label || "").toLowerCase();
  if (!text) return null;
  return forbidden.find((f) => new RegExp(`\\b${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}`, "i").test(text)) || null;
}

/** For the model, every step: what it must not click. */
export function forbidNote(forbidden) {
  if (!forbidden?.length) return "";
  return `The user said not to click: ${forbidden.map((f) => `"${f}"`).join(", ")}. Those clicks are refused; do it another way (type into the fields yourself).`;
}

/** Buttons that throw away unsaved work: ask first, whatever the model thinks. */
export const DISCARDS = /\b(?:discard|close anyway|leave anyway|leave without saving|don'?t save|without saving|lose (?:changes|your changes)|delete draft)\b/i;
