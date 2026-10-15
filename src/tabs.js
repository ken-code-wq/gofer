/**
 * Tab mentions: "go to @[Bills - Acme Books] and create a new bill" -> switch to the tab whose title
 * matches, then run "create a new bill" there. `@[multi word title]` or `@word` both work; the bar
 * offers open tabs as soon as you type "@".
 */

// "@" must start a word, so emails (alex@example.com) are never mentions.
const MENTION_RE = /(?<=^|[\s(,;])(?:@\[([^\]]+)\]|@([^\s,;\]]+))/;
// Phrases around a leading mention that only mean "go there": "go to @[X] and ...", "in @[X], ..."
const LEAD_RE = /^(?:please\s+)?(?:(?:go|switch|jump|move|change)\s+(?:over\s+)?(?:back\s+)?to|open|use|in|on|at)?\s*(?:the\s+)?$/i;
const JOIN_RE = /^\s*(?:tab\b)?\s*(?:,|;|\band then\b|\bthen\b|\band\b)?\s*/i;
const INLINE_RE = /\s*\b(?:in|on|at|from|inside)\s+(?:the\s+)?$/i;

/** -> { query, rest } (rest = the command to run in that tab, may be "") or null. */
export function parseTabMention(text) {
  const t = String(text || "").trim();
  const m = t.match(MENTION_RE);
  if (!m) return null;
  const query = (m[1] ?? m[2]).trim();
  const before = t.slice(0, m.index);
  let after = t.slice(m.index + m[0].length);
  let rest;
  if (LEAD_RE.test(before.trim())) {
    // "go to @[X] and create a bill" -> "create a bill"
    rest = after.replace(JOIN_RE, "").trim();
  } else {
    // "create a bill in @[X] tab" -> "create a bill"
    after = after.replace(/^\s*tab\b/i, "");
    rest = `${before.replace(INLINE_RE, "")}${after}`.replace(/\s+/g, " ").replace(/\s+([,.;!?])/g, "$1").trim();
  }
  return { query, rest };
}

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const host = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** Best tab for `query` among [{ title, url, ... }]: exact title, then prefix, then contains, then words, then host. */
export function matchTab(tabs, query) {
  const q = norm(query);
  if (!q) return null;
  const tests = [
    (t) => norm(t.title) === q,
    (t) => norm(t.title).startsWith(q),
    (t) => norm(t.title).includes(q),
    (t) => q.split(" ").every((w) => norm(t.title).includes(w)),
    (t) => host(t.url).includes(q.replace(/\s+/g, "")),
    (t) => norm(t.url).includes(q),
  ];
  for (const test of tests) {
    const hit = tabs.find(test);
    if (hit) return hit;
  }
  return null;
}

// "in the current tab", "on the active page", "in this tab", "in the tab I'm on", "in my open tab", "here"
const CURRENT_WORDS = "current|active|open|opened|focused|selected|front|frontmost|visible|this|same|present";
const CURRENT_RE = new RegExp(
  String.raw`\b(?:in|on|inside|within|from|for|using|at|of)\s+(?:(?:the|my|this|that)\s+)?` +
    String.raw`(?:(?:${CURRENT_WORDS})(?:ly)?\s+(?:open\s+)?(?:tab|window|page|site)|(?:tab|window|page)\s+(?:i(?:'m| am)\s+(?:on|in|at|looking at|viewing|using)|(?:that\s+)?(?:is|that's)\s+(?:open|active|focused|showing)))\b`,
  "i",
);
const CURRENT_LEAD_RE = new RegExp(String.raw`^(?:please\s+)?(?:(?:use|stay\s+(?:in|on))\s+(?:the\s+)?(?:${CURRENT_WORDS})\s+(?:tab|page)\b\s*[,:;-]?|here\s*[,:;-])\s*(?:and\s+(?:then\s+)?|then\s+)?`, "i");

/**
 * "in the current tab, play the next video" -> { rest: "play the next video" }. Only phrases that
 * name the tab you're on; returns null otherwise. `rest` can be "" ("use the current tab").
 */
export function parseCurrentTab(text) {
  const t = String(text || "").trim();
  let m = t.match(CURRENT_LEAD_RE);
  if (m && m[0].trim()) return { rest: t.slice(m[0].length).trim() };
  m = t.match(CURRENT_RE);
  if (!m) return null;
  const rest = `${t.slice(0, m.index)} ${t.slice(m.index + m[0].length)}`
    .replace(/^\s*[,:;-]\s*/, "")
    .replace(/\s*[,:;-]\s*$/, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .trim();
  // "what's on this page" is still a question about the page: keep it whole.
  if (/\bpage\b|\bsite\b/i.test(m[0]) && rest.split(" ").length < 2) return { rest: t, keep: true };
  return { rest };
}
