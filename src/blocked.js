/**
 * Bot checks: pages a site shows instead of its content when it thinks a robot is browsing
 * ("You have been blocked", "Access is temporarily restricted", "Verify you are human", Cloudflare's
 * "Just a moment…"). Retrying or scrolling them never helps and can make the block last longer, so
 * the agent is told at once, gets its answer another way (web search, another site), and doesn't
 * open that site again for a few hours unless you ask for it by name.
 *
 * The list is kept in <data dir>/blocked.json so it survives restarts.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./store.js";
import { siteKey } from "./sitenotes.js";

const HOURS = 6;
const file = () => path.join(DATA_DIR, "blocked.json");

// Wording of the block pages of DataDome (Yelp, TripAdvisor, Reddit…), Cloudflare, PerimeterX/HUMAN,
// Akamai, Imperva/Distil and Google's "unusual traffic" page.
const HARD = /\byou(?:'ve| have) been blocked\b|\baccess (?:is |has been )?(?:temporarily )?(?:restricted|denied|blocked)\b|\bunusual (?:activity|traffic) from your (?:device|computer|computer network|network)\b|\brequest (?:unsuccessful|blocked)\b|\bpardon our interruption\b|\byour (?:ip(?: address)?|access) has been (?:blocked|banned|restricted)\b|\bblocked (?:by|for) (?:security|bot|automated)\b/i;
const CHECK = /\bverify (?:that )?you(?:'re| are) (?:a )?human\b|\bare you (?:a )?(?:human|robot)\??|\bpress (?:&|and) hold\b|\bchecking (?:if the site connection is secure|your browser)\b|\bcomplete the security check\b|\bprove you(?:'re| are) (?:a )?human\b|\bconfirm you(?:'re| are) (?:a )?human\b|\bi'?m not a robot\b|\bhuman verification\b/i;
const TITLE = /^(?:just a moment|attention required|access denied|security check|are you a robot|robot or human|request blocked|403 forbidden)\b/i;
const FRAMES = /captcha-delivery\.com|challenges\.cloudflare\.com|hcaptcha\.com|perimeterx|px-captcha|arkoselabs|funcaptcha|\/recaptcha\/(?:api2|enterprise)\/bframe/i;

/** Runs in the page: what's needed to recognise a bot check. */
export function botCheckInPage() {
  const all = document.body?.innerText || "";
  return {
    title: document.title || "",
    text: all.slice(0, 3000),
    len: all.length,
    frames: [...document.querySelectorAll("iframe")].map((f) => f.src || "").filter(Boolean).slice(0, 12),
  };
}

/**
 * { url, title, text, len, frames } -> null, or { site, kind: "blocked" | "check", said } where
 * "check" is a challenge a person could pass (a captcha, "press and hold") and "blocked" is not.
 * Block pages are short: a page with lots of text only counts if its title says so, so an article
 * about bot blocking isn't one.
 */
export function classifyBlock(info) {
  if (!info) return null;
  const site = siteKey(info.url || "");
  if (!site) return null;
  const title = String(info.title || "").trim();
  const text = String(info.text || "");
  const short = (info.len ?? text.length) < 2500;
  const frames = (info.frames || []).join(" ");
  const said = (re) => (text.match(re) || title.match(re))?.[0] || "";
  if (TITLE.test(title)) return { site, kind: CHECK.test(text) || FRAMES.test(frames) ? "check" : "blocked", said: title };
  if (!short) return null;
  if (HARD.test(text) || HARD.test(title)) return { site, kind: "blocked", said: said(HARD) };
  if (CHECK.test(text) || FRAMES.test(frames)) return { site, kind: "check", said: said(CHECK) || "a captcha" };
  return null;
}

let cache = null;
function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(file(), "utf8")) || {};
  } catch {
    cache = {};
  }
  return cache;
}
function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(cache, null, 1));
  } catch {}
}

/** Remember that `site` showed a bot check, for HOURS hours. */
export function noteBlocked(site, kind = "blocked", now = Date.now()) {
  if (!site) return;
  load()[site] = { kind, at: new Date(now).toISOString(), until: now + HOURS * 3600_000 };
  save();
}

/** Sites that showed a bot check in the last few hours. */
export function blockedSites(now = Date.now()) {
  const all = load();
  let changed = false;
  for (const [s, v] of Object.entries(all)) if (!(v?.until > now)) delete all[s], (changed = true);
  if (changed) save();
  return Object.keys(all);
}

/** Did this URL's (or site's) site block us recently? */
export function isBlocked(urlOrSite, now = Date.now()) {
  const site = siteKey(urlOrSite || "");
  return Boolean(site) && blockedSites(now).includes(site);
}

/** Does the request ask for the site ("on yelp", "yelp.com")? Then it's opened anyway. "without Yelp" doesn't count. */
export function namedIn(text, site) {
  const name = String(site || "").split(".")[0];
  if (!name) return false;
  const t = String(text || "");
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
  for (const m of t.matchAll(re)) {
    const before = t.slice(Math.max(0, m.index - 30), m.index);
    if (!/\b(?:without|not|no|avoid|except|other than|instead of|don'?t use|never|skip)\b(?:\s+\S+){0,2}\s*$/i.test(before)) return true;
  }
  return false;
}

/** What the agent is told while it's on a bot-check page. */
export function blockNote({ site, kind, said }) {
  const what = said ? ` ("${said}")` : "";
  return kind === "check"
    ? `IMPORTANT: ${site} is showing a bot check${what} instead of its content. Don't reload, scroll or click around it. ` +
        "Get what you need another way: from web_search / read_url results you already have, a new web_search, or a different site. " +
        "If this exact site is essential, use need_user so the user can pass the check themselves. If your results already answer the request, finish now and say where the answer came from."
    : `IMPORTANT: ${site} has blocked automated browsing${what}; it won't load its content for this browser right now. Don't reload, retry, scroll or open it again. ` +
        "Get what you need another way: from web_search / read_url results you already have (search snippets often name the top results), a new web_search, or a different site. " +
        "If your results already answer the request, finish now and say where the answer came from (for example 'from TripAdvisor's list, via search'). Never just give up while you have search results.";
}

/** Told at the start of a task when sites blocked us recently. */
export function blockedHint(sites) {
  return sites.length
    ? `These sites blocked automated browsing from this computer in the last few hours, so don't open them: ${sites.join(", ")}. Get their information through web_search instead.`
    : "";
}

/** For tests. */
export function _reset() {
  cache = {};
}
