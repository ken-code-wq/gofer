/**
 * Site notes: short, reusable know-how per site ("On YouTube, Shift+N plays the next video"), so the
 * goal agent doesn't have to rediscover a site every time. Stored in ~/.voice-browser/site-notes.json
 * (DATA_DIR, so VB_DATA_DIR works in tests):
 *
 *   { version, starters, sites: { "youtube.com": { label, aliases, notes: [{ id, text, source, created, used, hits }] } } }
 *
 * Notes come from three places: "starter" (shipped below, verified against the sites' help pages),
 * "learned" (the brain's lessons after a goal, see learnFromGoal) and "user" ("remember that on
 * workbook bills are under sales", or the Site notes view).
 */
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { DATA_DIR } from "./store.js";

const FILE = () => path.join(DATA_DIR, "site-notes.json");
export const MAX_NOTES_PER_SITE = 12;
export const MAX_NOTE_CHARS = 200;
/** Bump when STARTERS change, so existing installs get the new ones (deleted ones stay deleted). */
const STARTER_VERSION = 1;

/** Fires "change" whenever notes are added or removed (the server broadcasts the list). */
export const siteNoteEvents = new EventEmitter();

// Shortcuts checked against support.google.com/youtube/answer/7631406, mail/answer/6594 + 7190,
// calendar/answer/37034, docs/answer/179738 and docs.github.com keyboard-shortcuts.
export const STARTERS = {
  "youtube.com": {
    label: "YouTube",
    notes: [
      "Keyboard shortcuts (press_key) work after the player has focus: K play/pause, M mute, J/L back/forward 10 s, F fullscreen, C captions.",
      "Shift+N plays the next video (Shift+P the previous one, in a playlist). Buttons named 'Next' under a video usually just scroll a topic list.",
      "/ jumps to the search box; or open youtube.com/results?search_query=… directly.",
      "A video that just opened is already playing; don't press K unless asked to pause or play.",
    ],
  },
  "mail.google.com": {
    label: "Gmail",
    aliases: ["gmail", "google mail"],
    notes: [
      "Keyboard shortcuts only work once turned on in Settings → See all settings → Keyboard shortcuts on; otherwise use the buttons.",
      "The Compose button is at the top left; with shortcuts on, c composes, r replies, e archives, / focuses search.",
      "Search operators: from:, to:, subject:, has:attachment, is:unread, label:, in:anywhere, after:/before: YYYY/MM/DD, newer_than:2d, older_than:1y.",
    ],
  },
  "calendar.google.com": {
    label: "Google Calendar",
    aliases: ["google calendar", "gcal"],
    notes: [
      "Shortcuts (Settings → Enable keyboard shortcuts): c creates an event, / search, t today, d/w/m day/week/month view, j or n next range.",
      "The Create button at the top left also makes a new event.",
    ],
  },
  "docs.google.com": {
    label: "Google Docs",
    aliases: ["google docs", "google doc", "google sheets", "google slides"],
    notes: [
      "Option+/ searches the menus for any command; Cmd+/ lists every shortcut.",
      "Cmd+F finds, Cmd+Shift+H finds and replaces, Cmd+K inserts a link, Cmd+Option+M adds a comment.",
    ],
  },
  "github.com": {
    label: "GitHub",
    notes: [
      "S or / focuses search; ? shows the shortcuts for the current page.",
      "In a repository: t opens the file finder, G then C / I / P goes to Code / Issues / Pull requests, . opens github.dev.",
    ],
  },
};

// ── keys ───────────────────────────────────────────────────────

// Two-part public suffixes common enough to matter ("bbc.co.uk" is the site, not "co.uk").
const SECOND_LEVEL = /^(?:co|com|org|net|gov|ac|edu|ne|or)\.[a-z]{2}$/;
// Parents whose subdomains are separate apps (Gmail and Docs share nothing worth sharing).
const APP_PARENTS = new Set(["google.com"]);

/**
 * The key a site's notes live under: the registrable host ("www.youtube.com/watch" -> "youtube.com"),
 * with the port for local apps ("localhost:3000"). Google's apps keep their subdomain.
 */
export function siteKey(input) {
  let s = String(input || "").trim().toLowerCase();
  if (!s) return "";
  if (!/^[a-z][\w+.-]*:\/\//.test(s)) s = `http://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return "";
  }
  if (!/^https?:$/.test(u.protocol)) return "";
  const host = u.hostname.replace(/^www\./, "").replace(/\.$/, "");
  if (!host) return "";
  const local = host === "localhost" || /^[\d.]+$/.test(host) || host.startsWith("[") || !host.includes(".") || /\.(?:local|localhost|test|internal)$/.test(host);
  if (local) return u.port ? `${host}:${u.port}` : host;
  const parts = host.split(".");
  const take = parts.length > 2 && SECOND_LEVEL.test(parts.slice(-2).join(".")) ? 3 : 2;
  const base = parts.slice(-take).join(".");
  if (APP_PARENTS.has(base) && parts.length > take) {
    const sub = parts[parts.length - take - 1];
    return /^(?:www|m)$/.test(sub) ? base : `${sub}.${base}`;
  }
  return base;
}

// ── storage ────────────────────────────────────────────────────

function read() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE(), "utf8"));
    if (d && typeof d === "object" && d.sites && typeof d.sites === "object") return d;
  } catch {}
  return { version: 1, starters: 0, sites: {} };
}

function write(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, FILE());
}

const newId = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Read, adding the starter notes once per STARTER_VERSION. */
function load() {
  const data = read();
  if ((data.starters || 0) < STARTER_VERSION) {
    for (const [key, s] of Object.entries(STARTERS)) {
      const site = (data.sites[key] ||= { notes: [] });
      site.label ||= s.label;
      if (s.aliases) site.aliases = [...new Set([...(site.aliases || []), ...s.aliases])];
      for (const text of s.notes) insert(site, text, "starter");
    }
    data.starters = STARTER_VERSION;
    try {
      write(data);
    } catch {}
  }
  return data;
}

/** Trim to one line of at most MAX_NOTE_CHARS, cut at a word. */
export function cleanNote(text) {
  let t = String(text || "").replace(/\s+/g, " ").trim().replace(/^[-•*]\s*/, "");
  if (t.length > MAX_NOTE_CHARS) t = `${t.slice(0, MAX_NOTE_CHARS - 1).replace(/\s+\S*$/, "")}…`;
  return t;
}

const words = (t) => new Set(String(t).toLowerCase().replace(/[^\p{L}\p{N}+/]+/gu, " ").split(" ").filter((w) => w.length > 1));

/** Same note in other words? Word overlap of 80%, or one contains the other. */
export function similar(a, b) {
  const x = [...words(a)].join(" "), y = [...words(b)].join(" ");
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const A = words(a), B = words(b);
  const common = [...A].filter((w) => B.has(w)).length;
  return common / Math.max(A.size, B.size) >= 0.8;
}

/** Add to a site object in place. Returns the note (an existing one when it's a near-duplicate). */
function insert(site, text, source) {
  const t = cleanNote(text);
  if (t.length < 8) return null;
  const now = Date.now();
  const dupe = site.notes.find((n) => similar(n.text, t));
  if (dupe) {
    dupe.used = now;
    dupe.hits = (dupe.hits || 0) + 1;
    // what the user says wins over what was learned or shipped
    if (source === "user" && dupe.source !== "user") Object.assign(dupe, { text: t, source });
    return { ...dupe, existed: true };
  }
  const note = { id: newId(), text: t, source, created: now, used: now, hits: 0 };
  site.notes.push(note);
  while (site.notes.length > MAX_NOTES_PER_SITE) {
    // drop the least useful: learned before starter before user, then fewest hits, then least recently used
    const rank = { learned: 0, starter: 1, user: 2 };
    const victim = site.notes
      .filter((n) => n !== note)
      .sort((p, q) => rank[p.source] - rank[q.source] || (p.hits || 0) - (q.hits || 0) || (p.used || 0) - (q.used || 0))[0];
    site.notes.splice(site.notes.indexOf(victim), 1);
  }
  return note;
}

/** Add a note for a site (URL, host or key). `label` names the site for later ("Workbook"). */
export function addNote(site, text, source = "user", { label } = {}) {
  const key = siteKey(site);
  if (!key) throw new Error("Which site? Give a web address like youtube.com or localhost:3000");
  const data = load();
  const s = (data.sites[key] ||= { notes: [] });
  if (label && !s.label) s.label = String(label).slice(0, 60);
  const note = insert(s, text, source);
  if (!note) throw new Error("That note is too short");
  write(data);
  siteNoteEvents.emit("change");
  return { site: key, ...note };
}

export function deleteNote(site, id) {
  const key = siteKey(site) || site;
  const data = load();
  const s = data.sites[key];
  if (!s) return false;
  const before = s.notes.length;
  s.notes = s.notes.filter((n) => n.id !== id);
  if (!s.notes.length && !STARTERS[key]) delete data.sites[key];
  write(data);
  siteNoteEvents.emit("change");
  return s.notes.length < before;
}

export function notesFor(site) {
  return load().sites[siteKey(site) || site]?.notes || [];
}

/** Every site with notes, the `current` one first, then most recently used. */
export function listSites(current = "") {
  const cur = siteKey(current);
  const sites = Object.entries(load().sites)
    .filter(([, s]) => s.notes?.length)
    .map(([key, s]) => ({ key, label: s.label || "", current: key === cur, notes: s.notes, used: Math.max(0, ...s.notes.map((n) => n.used || 0)) }));
  return sites.sort((a, b) => b.current - a.current || b.used - a.used);
}

/** Notes for these sites were just put to use in a task: they rank higher and are kept longer. */
export function markUsed(keys) {
  const data = load();
  let changed = false;
  for (const k of new Set(keys)) {
    for (const n of data.sites[k]?.notes || []) {
      n.used = Date.now();
      n.hits = (n.hits || 0) + 1;
      changed = true;
    }
  }
  if (changed) {
    try {
      write(data);
    } catch {}
  }
}

const names = (key, s) => {
  const base = key.split(":")[0];
  const first = base.startsWith("localhost") ? "" : base.split(".").slice(0, base.split(".").length > 2 ? -2 : -1).join(".");
  return [key, base, first, s.label, ...(s.aliases || [])].filter((x) => x && x.length > 2).map((x) => x.toLowerCase());
};

/**
 * "youtube", "workbook", "localhost:3000" -> a site key. Known sites match by key, label or alias;
 * then open tabs by title or host (`tabs` = [{ title, url }]); a host-looking name is used as is.
 * Returns "" when nothing fits (so "remember that on mondays …" stays a plain fact).
 */
export function resolveSite(name, { tabs = [] } = {}) {
  const n = String(name || "").trim().toLowerCase().replace(/^(?:the|my)\s+/, "").replace(/\s+(?:site|app|website|page)$/, "");
  if (!n) return "";
  if (/^(?:localhost|[\d.]+)(?::\d+)?$|^[\w-]+(?:\.[\w-]+)+(?::\d+)?$/.test(n)) return siteKey(n);
  for (const [key, s] of Object.entries(load().sites)) if (names(key, s).includes(n)) return key;
  const norm = (x) => String(x || "").toLowerCase();
  const tab = tabs.find((t) => /^https?:/.test(t.url || "") && (norm(t.title).split(/[^\p{L}\p{N}]+/u).includes(n) || norm(t.title).startsWith(n) || siteKey(t.url).split(/[.:]/)[0] === n));
  return tab ? siteKey(tab.url) : "";
}

/** Sites a goal names ("play lo-fi on youtube", "check my gmail"), among the ones there are notes for. */
export function sitesNamedIn(text) {
  const t = ` ${String(text || "").toLowerCase()} `;
  const out = [];
  for (const [key, s] of Object.entries(load().sites)) {
    if (!s.notes?.length) continue;
    if (names(key, s).some((x) => new RegExp(`[^\\p{L}\\p{N}]${x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\p{L}\\p{N}]`, "u").test(t))) out.push(key);
  }
  return out;
}

/**
 * The prompt block for a step: notes for the current page's site and any site the goal names.
 * Returns { text, sites } (text is "" when there's nothing to say).
 */
export function notesForPrompt({ url = "", goal = "" } = {}) {
  let keys;
  try {
    keys = [...new Set([siteKey(url), ...sitesNamedIn(goal)].filter(Boolean))].slice(0, 3);
  } catch {
    return { text: "", sites: [] };
  }
  const data = load();
  const blocks = [];
  const sites = [];
  for (const k of keys) {
    const notes = data.sites[k]?.notes || [];
    if (!notes.length) continue;
    sites.push(k);
    const label = data.sites[k].label ? `${data.sites[k].label} (${k})` : k;
    blocks.push(`${label}:\n${notes.map((n) => `- ${n.text}`).join("\n")}`);
  }
  if (!blocks.length) return { text: "", sites: [] };
  return { text: `Site notes (learned on earlier visits; use them when they fit, but trust the current page):\n${blocks.join("\n")}`, sites };
}

// ── learning ───────────────────────────────────────────────────

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const SECRET_WORDS = /\b(?:password|passcode|passphrase|pin|otp|2fa|token|api key|secret|credit card|card number|cvv|iban|ssn)\b/i;
const MONEY = /[$€£¥₦₵]\s?\d|\d[\d,]*\.\d{2}\b|\b\d+(?:[.,]\d+)?\s?(?:usd|eur|gbp|ghs|ngn|dollars?|euros?|pounds?|cedis?)\b/i;
const LONG_NUMBER = /\d[\d\s-]{6,}\d/;
const PERSONAL = /\b(?:I|I'm|my|me|mine)\b|\bthe user(?:'s)?\b|\bthis user\b/i;

/**
 * Is a lesson safe and general enough to keep? Rejects anything that carries the user's data:
 * values typed into fields (`typed`), emails, amounts, long numbers, secrets, or talk about the user.
 */
export function isSafeLesson(text, typed = []) {
  const t = String(text || "");
  if (t.trim().length < 12 || t.length > 400) return false;
  if (EMAIL.test(t) || SECRET_WORDS.test(t) || MONEY.test(t) || LONG_NUMBER.test(t) || /\{\{[^}]*\}\}/.test(t) || PERSONAL.test(t)) return false;
  const low = t.toLowerCase();
  // typed text, and each value of a form spec ("vendor Acme Ltd, amount 12" -> "Acme Ltd", "12")
  for (const v of typed) {
    for (const part of String(v || "").toLowerCase().split(/\s*[,;\n]\s*/)) {
      const p = part.trim();
      const value = p.replace(/^\S+\s+/, "");
      for (const x of [p, value.length >= 4 ? value : ""]) if (x.length >= 3 && !/^\{\{.*\}\}$/.test(x) && low.includes(x)) return false;
    }
  }
  return true;
}

/** Worth asking for lessons? Not for a goal that went straight through in one or two steps. */
export function worthLearning(done = [], status = "done") {
  if (status !== "done" && status !== "failed") return false;
  if (!done.length) return false;
  const bumpy = done.some((d) => /unchanged|failed|invalid|not complete/i.test(d.outcome || ""));
  return done.length > 2 || bumpy || status === "failed";
}

const LESSON_SCHEMA = {
  type: "object",
  properties: {
    lessons: {
      type: "array",
      items: {
        type: "object",
        properties: {
          site: { type: "string", description: "One of the given site keys." },
          text: { type: "string", description: "The lesson, one sentence under 200 characters." },
        },
        required: ["site", "text"],
      },
    },
  },
  required: ["lessons"],
};

const LESSON_SYSTEM =
  "You review a finished browser task and write down 0 to 2 durable lessons about the website, so the next task there takes fewer steps. " +
  "A good lesson is a reusable fact about how the site works: where a feature lives in the navigation ('Bills are under Sales → Bills'), " +
  "which control works or doesn't ('The Next buttons under a video scroll a topic list; Shift+N plays the next video'), a direct URL pattern, " +
  "or a shortcut that worked. Only write a lesson if it would have saved steps or avoided a mistake in this run. " +
  "Never include anything about this particular user or task: no values typed into fields, names, emails, amounts, dates, search terms, " +
  "passwords or item titles. Don't repeat the known notes. If the task went straight through, return an empty list.";

/**
 * After a goal: ask the brain (text only, small prompt) for 0–2 lessons, filter them and store them.
 * `ask` is brain.ask (injectable for tests). Returns the stored notes [{ site, id, text }].
 */
export async function learnFromGoal({ goal, status, done = [], sites = [], typed = [], ask }) {
  sites = [...new Set(sites.filter(Boolean))];
  if (!sites.length || !worthLearning(done, status)) return [];
  const known = sites.map((k) => `${k}:\n${notesFor(k).map((n) => `- ${n.text}`).join("\n") || "- (none)"}`).join("\n");
  const steps = done.map((d, i) => `${i + 1}. ${d.description} → ${String(d.outcome || "").slice(0, 160)}`).join("\n");
  const r = await ask({
    system: LESSON_SYSTEM,
    text: `Sites: ${sites.join(", ")}\n\nKnown notes:\n${known}\n\nTask: ${goal}\nResult: ${status}\n\nSteps:\n${steps}`,
    schema: LESSON_SCHEMA,
  });
  const out = [];
  for (const l of (r?.data?.lessons || []).slice(0, 2)) {
    const site = siteKey(l?.site) || sites[0];
    if (!sites.includes(site) || !isSafeLesson(l?.text, typed)) continue;
    const before = notesFor(site);
    const note = addNote(site, l.text, "learned");
    if (!note.existed && !before.some((n) => n.id === note.id)) out.push({ site, id: note.id, text: note.text });
  }
  return out;
}

// ── chat commands ──────────────────────────────────────────────

/**
 * "remember that on workbook bills are under sales" / "… here" / "what do you know about this site?"
 * -> { kind: "site-remember", site, text } | { kind: "site-list", site } | null. `site` is the name as
 * said ("workbook"), or "here" for the current page; the caller resolves it (see resolveSite).
 */
export function parseSiteCommand(text) {
  const t = String(text || "").trim().replace(/[.!]+$/, "");
  let m;
  const HERE = /^(?:here|this (?:site|page|website|app))$/i;
  const site = (s) => (HERE.test(s.trim()) ? "here" : s.trim());
  if ((m = t.match(/^(?:what do you know|what have you learned|what did you learn|what notes do you have)\s+(?:about|for|on)\s+(.+?)\??$/i))) {
    if (/^(?:me|myself)$/i.test(m[1])) return null;
    return { kind: "site-list", site: site(m[1]) };
  }
  if (/^(?:show|list)\s+(?:the\s+)?site notes\??$/i.test(t)) return { kind: "site-list", site: "here" };
  const r = t.match(/^(?:please\s+)?remember(?:\s+that)?\s*[:,]?\s+(.+)$/is);
  if (!r) return null;
  const body = r[1].trim();
  // "on workbook, bills are …" / "for google calendar: …" / "here bills are …"
  if ((m = body.match(/^(?:on|for|in|at)\s+((?:the\s+)?[\w.:-]+(?:\s+[\w.:-]+){0,2}?)\s*(?:,|:(?=\s))\s*(.{3,})$/is))) return { kind: "site-remember", site: site(m[1]), text: m[2] };
  if ((m = body.match(/^(?:on|for|at)\s+(this (?:site|page|website|app)|localhost:\d+|[\w-]+(?:\.[\w-]+)*(?::\d+)?)\s+(.{3,})$/is))) return { kind: "site-remember", site: site(m[1]), text: m[2] };
  if ((m = body.match(/^here\s*[,:]?\s+(.{3,})$/is))) return { kind: "site-remember", site: "here", text: m[1] };
  if ((m = body.match(/^(.{3,}?)\s*,?\s+(?:on|for|in) (this (?:site|page|website|app))$|^(.{3,}?)\s*,?\s+here$/is))) return { kind: "site-remember", site: "here", text: m[1] || m[3] };
  if ((m = body.match(/^(.{3,}?)\s*,?\s+(?:on|in)\s+(localhost:\d+|[\w-]+\.[\w.-]+|[\w-]+)$/is))) return { kind: "site-remember", site: m[2], text: m[1], loose: true };
  return null;
}
