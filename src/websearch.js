/**
 * Web search and page reading for the agent, without touching the user's browser: no tab opens,
 * nothing gets focus. Used when a goal or question needs facts that aren't on the current page.
 *
 * Search tries, in order, whatever is set up (a provider that fails rests for a minute):
 *   TAVILY_API_KEY          Tavily search API
 *   BRAVE_SEARCH_API_KEY    Brave Search API
 *   (no key)                Brave's public results page
 *   GEMINI_API_KEY          Gemini with Google Search grounding
 *   GROQ_API_KEY            Groq's built-in browser search
 * So it never depends on one provider: with no keys at all it still works.
 */
import { execFile } from "node:child_process";
import { cleanText, selectChunks, extractPdfPages, pdfPagesText } from "./pagetext.js";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const TIMEOUT_MS = 12000;
const MAX_RESULTS = 6;

const signalFor = (signal, ms = TIMEOUT_MS) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»", middot: "·", bull: "•", eacute: "é" };
export const decodeEntities = (s) =>
  String(s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

const stripTags = (s) => decodeEntities(String(s || "").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

// ── search providers ───────────────────────────────────────────

async function tavily(query, signal) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.TAVILY_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ query, max_results: MAX_RESULTS, include_answer: true }),
    signal: signalFor(signal),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}`);
  const d = await res.json();
  return { answer: d.answer || "", results: (d.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })) };
}

async function braveApi(query, signal) {
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?count=${MAX_RESULTS}&q=${encodeURIComponent(query)}`, {
    headers: { "x-subscription-token": process.env.BRAVE_SEARCH_API_KEY, accept: "application/json" },
    signal: signalFor(signal),
  });
  if (!res.ok) throw new Error(`Brave API ${res.status}`);
  const d = await res.json();
  return { results: (d.web?.results || []).map((r) => ({ title: stripTags(r.title), url: r.url, snippet: stripTags(r.description) })) };
}

/** Results from Brave's public results page (web results only). */
export function parseBraveHtml(html) {
  const out = [];
  const blocks = String(html || "").split(/<div class="snippet\b[^"]*"/).slice(1);
  for (const b of blocks) {
    if (!/^[^>]*data-type="web"/.test(b)) continue;
    const url = b.match(/<a href="(https?:\/\/[^"]+)"/)?.[1];
    const title = b.match(/class="title[^"]*"[^>]*title="([^"]*)"/)?.[1] || stripTags(b.match(/class="title[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1]);
    const snippet = stripTags(b.match(/class="content[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] || "");
    if (url && title && !out.some((r) => r.url === url)) out.push({ title: decodeEntities(title), url: decodeEntities(url), snippet });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

/** GET with the system's curl: Brave turns away Node's own fetch (by its TLS fingerprint) but not curl. */
function curlGet(url, signal) {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/curl",
      ["-sS", "--compressed", "-m", String(TIMEOUT_MS / 1000), "-A", UA, "-H", "accept: text/html", "-H", "accept-language: en-US,en;q=0.9", "-w", "\n%{http_code}", url],
      { maxBuffer: 8 * 1024 * 1024, signal },
      (err, stdout) => {
        if (err) return reject(new Error(err.name === "AbortError" ? "cancelled" : `curl: ${err.message.split("\n")[0]}`));
        const i = stdout.lastIndexOf("\n");
        resolve({ status: Number(stdout.slice(i + 1)), body: stdout.slice(0, i) });
      },
    );
  });
}

// Brave's public page turns away quick bursts: keep its searches a couple of seconds apart.
let braveNext = 0;
async function braveHtml(query, signal) {
  const wait = braveNext - Date.now();
  braveNext = Math.max(Date.now(), braveNext) + 2500;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const res = await curlGet(`https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`, signal);
  if (res.status !== 200) throw new Error(`Brave ${res.status}`);
  const results = parseBraveHtml(res.body);
  if (!results.length) throw new Error("Brave returned no results");
  return { results };
}

/** Gemini's sources are long Google redirect links: find where they lead (or keep the link). */
async function unredirect(url, signal) {
  if (!/grounding-api-redirect/.test(url || "")) return url;
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "manual", signal: signalFor(signal, 3000) });
    return res.headers.get("location") || url;
  } catch {
    return url;
  }
}

async function geminiSearch(query, signal, context = "") {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent", {
    method: "POST",
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: `Search the web for: ${query}${context ? `\n(The question behind it: ${context})` : ""}\nReport what the top sources say, briefly and factually; name the specific answer if the sources give one.` }] }],
      tools: [{ google_search: {} }],
    }),
    signal: signalFor(signal, 20000),
  });
  if (!res.ok) throw new Error(`Gemini search ${res.status}`);
  const d = await res.json();
  const c = d.candidates?.[0] || {};
  const answer = (c.content?.parts || []).map((p) => p.text || "").join("").trim();
  const chunks = (c.groundingMetadata?.groundingChunks || []).map((g) => g.web).filter(Boolean).slice(0, MAX_RESULTS);
  const results = await Promise.all(chunks.map(async (w) => ({ title: w.title, url: await unredirect(w.uri, signal), snippet: "" })));
  if (!answer && !results.length) throw new Error("Gemini search found nothing");
  return { answer, results };
}

async function groqSearch(query, signal, context = "") {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-oss-20b",
      messages: [{ role: "user", content: `Search the web for: ${query}${context ? `\n(The question behind it: ${context})` : ""}\nReport what the top sources say, briefly and factually, with their URLs; name the specific answer if the sources give one.` }],
      tools: [{ type: "browser_search" }],
      reasoning_effort: "low",
    }),
    signal: signalFor(signal, 30000),
  });
  if (!res.ok) throw new Error(`Groq search ${res.status}`);
  const d = await res.json();
  const answer = String(d.choices?.[0]?.message?.content || "").trim();
  if (!answer) throw new Error("Groq search found nothing");
  const urls = [...new Set(answer.match(/https?:\/\/[^\s)\]>"']+/g) || [])].slice(0, MAX_RESULTS);
  return { answer, results: urls.map((url) => ({ title: url.replace(/^https?:\/\/(?:www\.)?/, "").split("/")[0], url, snippet: "" })) };
}

export const SEARCH_PROVIDERS = [
  { id: "tavily", label: "Tavily", ready: () => Boolean(process.env.TAVILY_API_KEY), run: tavily },
  { id: "brave-api", label: "Brave Search", ready: () => Boolean(process.env.BRAVE_SEARCH_API_KEY), run: braveApi },
  { id: "brave", label: "Brave", ready: () => process.env.VB_KEYLESS_SEARCH !== "0", run: braveHtml },
  { id: "gemini", label: "Google (Gemini)", ready: () => Boolean(process.env.GEMINI_API_KEY), run: geminiSearch },
  { id: "groq", label: "Groq search", ready: () => Boolean(process.env.GROQ_API_KEY), run: groqSearch },
];

/** Search providers you can add a key for in the panel (⋯ → AI models). */
export const SEARCH_KEYS = {
  tavily: { label: "Tavily search", env: "TAVILY_API_KEY", keyUrl: "https://app.tavily.com/home" },
  "brave-search": { label: "Brave Search API", env: "BRAVE_SEARCH_API_KEY", keyUrl: "https://api-dashboard.search.brave.com/app/keys" },
};
export const missingSearchKeys = () =>
  Object.entries(SEARCH_KEYS)
    .filter(([, p]) => !process.env[p.env])
    .map(([name, p]) => ({ name, ...p, search: true }));

const resting = new Map(); // id -> until

/**
 * Search the web (`context`: the question behind the query, for providers that use a model). Returns { query, provider, answer, results: [{ title, url, snippet }] }.
 * Throws only when every provider failed.
 */
export async function webSearch(query, { signal, context = "", providers = SEARCH_PROVIDERS } = {}) {
  const q = String(query || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!q) throw new Error("empty search");
  const ready = providers.filter((p) => p.ready());
  const fresh = ready.filter((p) => (resting.get(p.id) || 0) < Date.now());
  const errors = [];
  for (const p of fresh.length ? fresh : ready) {
    try {
      const r = await p.run(q, signal, String(context).slice(0, 400));
      if (!r.answer && !r.results?.length) throw new Error("no results");
      return { query: q, provider: p.label, answer: r.answer || "", results: (r.results || []).slice(0, MAX_RESULTS) };
    } catch (err) {
      if (signal?.aborted) throw err;
      errors.push(`${p.label}: ${err.message || err}`);
      resting.set(p.id, Date.now() + 60_000);
    }
  }
  throw new Error(`web search failed (${errors.join("; ") || "no search provider"})`);
}

/** Search results as a short text block for a prompt. */
export function searchText(r, maxChars = 1800) {
  const lines = [];
  if (r.answer) lines.push(`Summary (${r.provider}): ${r.answer.slice(0, 700)}`);
  r.results.forEach((x, i) => lines.push(`${i + 1}. ${x.title}${x.url ? ` — ${x.url}` : ""}${x.snippet ? `\n   ${x.snippet.slice(0, 240)}` : ""}`));
  return lines.join("\n").slice(0, maxChars);
}

// ── reading a page without opening it ───────────────────────────

/** The readable text of an HTML document: <article>/<main> if there's a good one, minus scripts and navigation. */
export function htmlToText(html) {
  let s = String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|form|nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, " ");
  const title = stripTags(s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const main = [...s.matchAll(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]).sort((a, b) => b.length - a.length)[0];
  const body = s.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? s;
  if (main && main.length > body.length * 0.2) s = main;
  else s = body;
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|h[1-6]|li|tr|blockquote|pre|table|ul|ol|dd|dt)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<(td|th)\b[^>]*>/gi, " | ")
    .replace(/<[^>]*>/g, "");
  return { title, text: cleanText(decodeEntities(s)) };
}

/**
 * Fetch a URL and return its text (HTML or PDF), cut to the parts that matter for `question`.
 * Returns { url, title, text }.
 */
export async function readUrl(url, { question = "", budget = 6000, signal } = {}) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw new Error(`not a web address: ${url}`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`can't read ${u.protocol} addresses`);
  if (/^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1)/.test(u.hostname)) throw new Error("won't read local network addresses");
  const res = await fetch(u, { headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" }, redirect: "follow", signal: signalFor(signal, 15000) });
  if (!res.ok) throw new Error(`${u.hostname} answered ${res.status}`);
  const type = res.headers.get("content-type") || "";
  let title = "";
  let text = "";
  if (/pdf/i.test(type) || /\.pdf$/i.test(u.pathname)) {
    text = pdfPagesText(await extractPdfPages(new Uint8Array(await res.arrayBuffer())));
    title = decodeURIComponent(u.pathname.split("/").pop() || u.hostname);
  } else if (/html|xml/i.test(type) || !type) {
    const html = (await res.text()).slice(0, 3_000_000);
    ({ title, text } = htmlToText(html));
  } else if (/^text\//i.test(type) || /json/i.test(type)) {
    text = cleanText((await res.text()).slice(0, 500_000));
  } else {
    throw new Error(`can't read ${type.split(";")[0]} files`);
  }
  if (!text) throw new Error(`${u.hostname} had no readable text`);
  return { url: res.url || u.href, title, text: selectChunks(text, question, budget).text };
}
