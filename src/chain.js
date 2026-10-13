/**
 * Command chains (code, not Jev): "open youtube, theo t3.gg's channel" -> ordered steps that the
 * controller runs one at a time, each as its own final command, after the previous step's page
 * has loaded.
 *
 * Splits on `,` `;` "then" "and then", and on "and" when a command verb follows. Quoted text is
 * never split ("type 'salt, pepper'"). A step without a verb means "find it": search for it, then
 * click the best match ("theo t3.gg's channel"), unless it already names an element on the page
 * ("the first result" -> "click the first result").
 */

export const MAX_CHAIN_STEPS = 8;

const VERBS = [
  "go", "open", "navigate", "visit", "browse", "load",
  "search", "look", "find", "google",
  "click", "tap", "press", "hit", "select", "choose", "pick", "follow",
  "type", "enter", "write", "fill", "put", "clear",
  "scroll", "back", "forward", "reload", "refresh",
  "close", "switch", "next", "previous", "new",
  "confirm", "cancel", "undo", "play", "pause", "watch", "show",
  "wait", "check", "verify", "assert", "expect", "ensure", "make sure",
];
// "and" only splits before unambiguous action verbs: "click save and close" stays one command.
const AND_VERBS = ["go", "open", "navigate", "visit", "search", "look", "google", "click", "tap", "press", "type", "enter", "scroll", "play", "watch", "wait", "check", "verify"];
const VERB_RE = new RegExp(`^(?:please\\s+)?(?:${VERBS.join("|")})\\b`, "i");

// Verbless steps that name something on the current page: click it instead of searching.
const ELEMENT_RE =
  /^(?:the\s+)?(?:first|second|third|fourth|fifth|last|top|next|previous|\d+(?:st|nd|rd|th)?)\b|\b(?:result|link|button|tab|video|item|option|menu|checkbox|field)s?$/i;

// Quotes only count at a word boundary, so apostrophes ("t3.gg's") are never mistaken for quotes.
const QUOTE_RE = /(?<=^|\s)(?:["“][^"“”]*["”]|'[^']*')(?=\s|$|[,;.])/g;

export function startsWithVerb(step) {
  return VERB_RE.test(step.trim());
}

/** Split a command into raw steps. Returns [text] when there is nothing to chain. */
export function splitChain(text) {
  const src = String(text || "").replace(/\s+/g, " ").trim();
  if (!src) return [];

  // Protect quoted spans so separators inside them survive.
  const quoted = [];
  let masked = src.replace(QUOTE_RE, (m) => {
    quoted.push(m);
    return `\u0000${quoted.length - 1}\u0000`;
  });

  masked = masked
    .replace(/\s*[;,]\s*(?:and\s+)?(?:then\s+)?/gi, "\u0001")
    .replace(/\s+(?:and\s+)?then\s+/gi, "\u0001")
    .replace(new RegExp(`\\s+and\\s+(?=(?:${AND_VERBS.join("|")})\\b)`, "gi"), "\u0001");

  return masked
    .split("\u0001")
    .map((s) => s.replace(/\u0000(\d+)\u0000/g, (_, i) => quoted[Number(i)]).replace(/^(?:and|then)\s+/i, "").replace(/[.!?]+$/, "").trim())
    .filter(Boolean);
}

/**
 * Turn raw steps into executable commands. A verbless step becomes "search for X" + "click X".
 * Returns [] when the input is a single plain command (no chain needed).
 */
// "click on email" + "type alex@example.com" -> "type alex@example.com into the email field"
const CLICK_FIELD_RE = /^(?:click|tap|select|focus)(?:\s+(?:on|into|in))?\s+(?:the\s+)?(.+?)$/i;
const TYPE_RE = /^(?:type|enter|write|fill in|put)\s+(.+)$/i;
const HAS_DEST_RE = /\s(?:into|in|on)\s+(?:the\s+)?\S+/i;

function mergeClickThenType(steps) {
  const out = [];
  for (let i = 0; i < steps.length; i++) {
    const click = steps[i].match(CLICK_FIELD_RE);
    const type = steps[i + 1]?.match(TYPE_RE);
    if (click && type && !HAS_DEST_RE.test(type[1])) {
      const field = click[1].replace(/\s+(?:field|box|input)$/i, "");
      out.push(`type ${type[1]} into the ${field} field`);
      i++;
      continue;
    }
    out.push(steps[i]);
  }
  return out;
}

export function planChain(text) {
  const raw = mergeClickThenType(splitChain(text));
  if (raw.length < 2) return [];
  const steps = [];
  for (const s of raw) {
    if (startsWithVerb(s)) steps.push(s);
    else if (ELEMENT_RE.test(s)) steps.push(`click ${s}`);
    else steps.push(`search for ${s}`, `click ${s}`);
  }
  return steps.slice(0, MAX_CHAIN_STEPS);
}
