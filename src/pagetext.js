/**
 * Page reading: what the brain gets to read when it answers about a page. Better than raw
 * innerText where it can be:
 *   YouTube watch pages  -> the video's captions, with [m:ss] timestamps (no API key: fetched from inside the page)
 *   PDFs in a tab        -> the PDF's text, with [Page n] markers (bytes fetched with the page's cookies, parsed in Node)
 *   Google Docs/Sheets/Slides -> the export (txt / csv), fetched with the user's session
 *   other pages          -> the main content (article/main), boilerplate dropped
 * Too long for the model? The chunks most relevant to the question are kept, not the first N chars.
 *
 * Pure helpers are exported for tests; `readPage(page, opts)` is the entry point.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// ── detection ──────────────────────────────────────────────────

/** YouTube video id from a watch / shorts / youtu.be / embed URL, or "". */
export function youtubeId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(?:www\.|m\.|music\.)/, "");
    if (host === "youtu.be") return u.pathname.slice(1, 12);
    if (host !== "youtube.com" && host !== "youtube-nocookie.com") return "";
    if (u.pathname === "/watch") return u.searchParams.get("v") || "";
    const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

/** Google Docs / Sheets / Slides: { type, id, gid } or null. Published (/d/e/…) docs read fine as HTML. */
export function googleDoc(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== "docs.google.com") return null;
    const m = u.pathname.match(/^\/(document|spreadsheets|presentation)\/(?:u\/\d+\/)?d\/([\w-]{20,})/);
    if (!m) return null;
    const gid = (u.hash.match(/gid=(\d+)/) || u.search.match(/gid=(\d+)/) || [])[1] || "";
    return { type: m[1], id: m[2], gid };
  } catch {
    return null;
  }
}

/** The export URL that gives a Google file as plain text (docs, slides) or CSV (sheets). */
export function googleExportUrl(g) {
  const base = `https://docs.google.com/${g.type}/d/${g.id}`;
  if (g.type === "spreadsheets") return `${base}/export?format=csv${g.gid ? `&gid=${g.gid}` : ""}`;
  return `${base}/export?format=txt`;
}

/** Which reader suits a page. `contentType` is document.contentType (application/pdf in Chromium's PDF viewer). */
export function detectKind(url, contentType = "") {
  if (/pdf/i.test(contentType)) return "pdf";
  if (youtubeId(url)) return "youtube";
  const g = googleDoc(url);
  if (g) return g.type === "document" ? "gdoc" : g.type === "spreadsheets" ? "gsheet" : "gslides";
  try {
    if (/\.pdf$/i.test(new URL(url).pathname)) return "pdf";
  } catch {}
  return "html";
}

// ── times ──────────────────────────────────────────────────────

/** 83 -> "1:23", 3725 -> "1:02:05" */
export function fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

/** "1:23" -> 83, "1:02:05" -> 3725; the first time found in a string, or null. */
export function parseTime(s) {
  const m = String(s || "").match(/\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/);
  if (!m) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// ── captions ───────────────────────────────────────────────────

const decodeEntities = (s) =>
  String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

const tidy = (s) => String(s).replace(/\s+/g, " ").trim();

/** YouTube json3 captions -> [{ start, dur, text }] (seconds). */
export function parseJson3(json) {
  const j = typeof json === "string" ? JSON.parse(json) : json;
  const out = [];
  for (const e of j?.events || []) {
    if (!e.segs) continue;
    const text = tidy(e.segs.map((s) => s.utf8 || "").join(""));
    if (text) out.push({ start: (e.tStartMs || 0) / 1000, dur: (e.dDurationMs || 0) / 1000, text });
  }
  return out;
}

/** YouTube XML captions, both the classic <text start dur> and the srv3 <p t d> (ms) forms. */
export function parseTimedTextXml(xml) {
  const out = [];
  const s = String(xml || "");
  for (const m of s.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    const start = Number((m[1].match(/start="([\d.]+)"/) || [])[1] || 0);
    const dur = Number((m[1].match(/dur="([\d.]+)"/) || [])[1] || 0);
    const text = tidy(decodeEntities(m[2].replace(/<[^>]+>/g, "")));
    if (text) out.push({ start, dur, text });
  }
  if (out.length) return out;
  for (const m of s.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const t = Number((m[1].match(/\bt="(\d+)"/) || [])[1] || 0);
    const d = Number((m[1].match(/\bd="(\d+)"/) || [])[1] || 0);
    const text = tidy(decodeEntities(m[2].replace(/<[^>]+>/g, "")));
    if (text) out.push({ start: t / 1000, dur: d / 1000, text });
  }
  return out;
}

/** Captions in whichever format came back. */
export function parseCaptions(body) {
  const s = String(body || "").trim();
  if (!s) return [];
  if (s.startsWith("{")) {
    try {
      return parseJson3(s);
    } catch {
      return [];
    }
  }
  return parseTimedTextXml(s);
}

/** Best caption track: hand-made in the wanted language, then auto-generated, then any hand-made, then any. */
export function pickTrack(tracks, lang = "en") {
  const list = (tracks || []).filter((t) => t?.baseUrl);
  const is = (t) => String(t.languageCode || "").toLowerCase().split("-")[0] === lang;
  const asr = (t) => t.kind === "asr";
  return list.find((t) => is(t) && !asr(t)) || list.find(is) || list.find((t) => !asr(t)) || list[0] || null;
}

/** Captions as readable paragraphs, each starting with its time: "[1:23] …". */
export function transcriptText(segments, { span = 20, maxChars = 320 } = {}) {
  const lines = [];
  let cur = null;
  for (const s of segments) {
    if (!cur || s.start - cur.start >= span || cur.text.length >= maxChars) {
      if (cur) lines.push(`[${fmtTime(cur.start)}] ${cur.text}`);
      cur = { start: s.start, text: s.text };
    } else cur.text += ` ${s.text}`;
  }
  if (cur) lines.push(`[${fmtTime(cur.start)}] ${cur.text}`);
  return lines.join("\n");
}

/** Link to a moment in a video. */
export const youtubeLink = (id, sec) => `https://www.youtube.com/watch?v=${id}${sec ? `&t=${Math.floor(sec)}s` : ""}`;

// ── main content of ordinary pages ─────────────────────────────

/** Collapse whitespace runs but keep paragraph breaks. */
export const cleanText = (s) =>
  String(s || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * From what `collectPage` found in the DOM, the text worth reading: the biggest main-content
 * container (article / main / role=main …) if it holds a fair share of the page, else the whole
 * body; either way minus navigation, header, footer and sidebar blocks.
 * raw = { body, candidates: [text], boiler: [text] }
 */
export function chooseMainText(raw) {
  const body = cleanText(raw?.body);
  const cands = (raw?.candidates || []).map(cleanText).filter(Boolean).sort((a, b) => b.length - a.length);
  const best = cands.find((c) => c.length >= Math.max(400, body.length * 0.25));
  let text = best || body;
  let dropped = 0;
  const whole = text.length;
  for (const b of (raw?.boiler || []).map(cleanText)) {
    // a "header" that wraps half the page is layout, not boilerplate
    if (b.length < 30 || b.length > whole * 0.5) continue;
    const i = text.indexOf(b);
    if (i === -1) continue;
    text = text.slice(0, i) + "\n" + text.slice(i + b.length);
    dropped += b.length;
  }
  return { text: cleanText(text), main: Boolean(best), dropped };
}

/** Runs in the page: body text, main-content candidates and boilerplate blocks. */
function collectPage() {
  const vis = (el) => el.offsetParent !== null || el === document.body || getComputedStyle(el).position === "fixed";
  const textOf = (el) => (el.innerText || "").trim();
  const cands = [...document.querySelectorAll('article, main, [role="main"], #content, #main, .content, .post, .article, .entry-content, #mw-content-text')]
    .filter(vis).slice(0, 12).map(textOf).filter((t) => t.length > 200);
  const boiler = [...document.querySelectorAll('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [aria-modal="true"], [id*="cookie" i], [class*="cookie" i]')]
    // an article's own <header> holds its title: keep it
    .filter((el) => !(el.tagName === "HEADER" && el.parentElement?.closest("article, main")))
    .slice(0, 40).map(textOf).filter(Boolean);
  return { body: document.body?.innerText || "", candidates: cands, boiler };
}

// ── chunk selection ────────────────────────────────────────────

const STOP = new Set(
  ("the a an and or but of to in on at for with from by about as is are was were be been being it its this that these those there here what whats which who whom whose when where why how " +
    "does do did done can could should would will shall may might must not no yes you your yours me my mine we our us they them their he she him her his hers i " +
    "tell say says said please page tab tabs video pdf doc document site summarize summarise summary explain give show list all any some more most into than then so if " +
    "just also very much many get got make like want need know think one two out up down over under again off").split(" "),
);

const stem = (w) => w.replace(/(?:ing|ed|es|s)$/, "") || w;

/** The question's content words (lower case, stemmed, no stop words). */
export function keywords(question) {
  const words = String(question || "").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'.-]*/gu) || [];
  const out = new Set();
  for (let w of words) {
    w = w.replace(/^'+|['.-]+$/g, "");
    if (w.length < 2 || STOP.has(w) || (w.length < 3 && !/\d/.test(w))) continue;
    out.add(stem(w));
  }
  return [...out];
}

const MARKER = /^\[(Page \d+|Sheet[^\]]*|\d{1,2}:\d{2}(?::\d{2})?)\]/;

/** Split text into ~size-char chunks on line breaks; page markers carry over into chunks that start mid-page. */
export function chunkText(text, size = 1500) {
  const chunks = [];
  let cur = "";
  let page = "";
  const flush = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = "";
  };
  for (const line of String(text).split("\n")) {
    const m = line.match(MARKER);
    if (m && /^Page|^Sheet/.test(m[1])) {
      flush();
      page = `[${m[1]}]`;
    }
    if (cur.length + line.length > size && cur) {
      flush();
      if (page && !MARKER.test(line)) cur = `${page} (continued)\n`;
    }
    if (line.length > size * 1.5) {
      // one huge line (minified text, a long paragraph): hard-split it
      for (let i = 0; i < line.length; i += size) {
        cur += line.slice(i, i + size);
        flush();
      }
      continue;
    }
    cur += `${line}\n`;
  }
  flush();
  return chunks;
}

/**
 * Fit text into `budget` chars, keeping what matters for the question: the opening chunk plus the
 * chunks that score best on the question's keywords (rarer words count more), in page order with
 * "[…]" where parts were skipped. With no useful keywords (e.g. "summarize this") it samples evenly.
 */
export function selectChunks(text, question, budget = 30000) {
  const t = String(text || "");
  if (t.length <= budget) return { text: t, truncated: false };
  const chunks = chunkText(t, Math.min(1500, Math.max(400, Math.floor(budget / 6))));
  const keys = keywords(question);
  const lower = chunks.map((c) => c.toLowerCase());
  const df = keys.map((k) => lower.filter((c) => c.includes(k)).length);
  const scores = lower.map((c) =>
    keys.reduce((sum, k, i) => {
      if (!df[i]) return sum;
      const n = c.split(k).length - 1;
      return sum + (n ? (1 + Math.log(n)) * Math.log(1 + chunks.length / df[i]) : 0);
    }, 0),
  );
  const anyHit = scores.some((s) => s > 0);
  let order;
  if (anyHit) {
    order = [0, ...scores.map((s, i) => [s, i]).filter(([s, i]) => i && s > 0).sort((a, b) => b[0] - a[0]).map(([, i]) => i)];
    // then neighbours of the hits, then the rest evenly, so leftover budget still adds context
    const extra = order.slice(1).flatMap((i) => [i + 1, i - 1]).filter((i) => i > 0 && i < chunks.length);
    order = [...new Set([...order, ...extra, ...evenly(chunks.length)])];
  } else order = evenly(chunks.length);
  const keep = new Set();
  let used = 0;
  for (const i of order) {
    const len = chunks[i].length + 6;
    if (used + len > budget) continue;
    keep.add(i);
    used += len;
  }
  const parts = [];
  let last = -1;
  for (let i = 0; i < chunks.length; i++) {
    if (!keep.has(i)) continue;
    if (i !== last + 1) parts.push("[…]");
    parts.push(chunks[i]);
    last = i;
  }
  if (last !== chunks.length - 1) parts.push("[…]");
  return { text: parts.join("\n"), truncated: true, kept: keep.size, total: chunks.length, matched: anyHit };
}

/** Indices 0..n-1 in an order that spreads out: 0, n-1, n/2, n/4, 3n/4, … */
function evenly(n) {
  const out = [];
  const seen = new Set();
  const add = (i) => {
    if (i >= 0 && i < n && !seen.has(i)) seen.add(i), out.push(i);
  };
  add(0);
  add(n - 1);
  for (let step = n; out.length < n && step >= 1; step = Math.floor(step / 2)) {
    for (let i = Math.floor(step / 2); i < n; i += step) add(i);
  }
  for (let i = 0; i < n; i++) add(i);
  return out;
}

// ── PDFs ───────────────────────────────────────────────────────

/** ["page 1 text", "page 2 text"] -> "[Page 1]\n…\n\n[Page 2]\n…" */
export const pdfPagesText = (pages) =>
  pages.map((p, i) => `[Page ${i + 1}]\n${cleanText(p)}`).join("\n\n");

/** Text per page, with unpdf (pdf.js). Loaded lazily so the rest works without it. */
export async function extractPdfPages(bytes) {
  let lib;
  try {
    lib = await import("unpdf");
  } catch {
    throw new Error("Reading PDFs needs the unpdf package: run npm install");
  }
  const pdf = await lib.getDocumentProxy(new Uint8Array(bytes));
  const { text } = await lib.extractText(pdf, { mergePages: false });
  return Array.isArray(text) ? text : [String(text || "")];
}

const MAX_BYTES = 40 * 1024 * 1024;

/**
 * The bytes behind a URL, as the user would get them: through the browser context's request API
 * (shares its cookies, follows redirects, no CORS), else fetch() inside the page. Returns { body, type }.
 */
async function fetchAsUser(page, url) {
  if (url.startsWith("file:")) return { body: await readFile(fileURLToPath(url)), type: "" };
  const req = page.context?.()?.request;
  if (req) {
    try {
      const res = await req.get(url, { timeout: 20000, maxRedirects: 10 });
      if (res.ok()) {
        const body = await res.body();
        if (body.length > MAX_BYTES) throw new Error("File is too large to read");
        return { body, type: res.headers()["content-type"] || "" };
      }
    } catch (err) {
      if (/too large/.test(err.message)) throw err;
    }
  }
  const r = await page.evaluate(async ({ url, max }) => {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > max) return { error: "File is too large to read" };
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { b64: btoa(s), type: res.headers.get("content-type") || "" };
  }, { url, max: MAX_BYTES });
  if (r.error) throw new Error(r.error);
  return { body: Buffer.from(r.b64, "base64"), type: r.type };
}

// ── YouTube ────────────────────────────────────────────────────

/**
 * Runs in a YouTube watch page. Captions without an API key, trying in turn:
 *  1. the player's own caption tracks (movie_player / ytInitialPlayerResponse), fetched as json3;
 *  2. the same tracks via the InnerTube player endpoint as the Android client (web track URLs now
 *     often come back empty without a proof-of-origin token; these don't);
 *  3. a captions file the player already loaded (captions switched on);
 *  4. the transcript panel, if it's open.
 * Also returns title, channel, description, length and the current play position.
 */
async function youtubeInPage({ id, lang }) {
  const out = { id, title: "", channel: "", description: "", length: 0, at: null, track: null, body: "", segments: null, via: "" };
  const mp = document.getElementById("movie_player");
  let pr = null;
  try {
    pr = mp?.getPlayerResponse?.();
  } catch {}
  if (pr?.videoDetails?.videoId !== id) pr = window.ytInitialPlayerResponse?.videoDetails?.videoId === id ? window.ytInitialPlayerResponse : pr;
  if (pr?.videoDetails?.videoId !== id) pr = null;
  try {
    out.at = typeof mp?.getCurrentTime === "function" ? mp.getCurrentTime() : null;
  } catch {}
  const vd = pr?.videoDetails || {};
  Object.assign(out, { title: vd.title || document.title.replace(/ - YouTube$/, ""), channel: vd.author || "", description: vd.shortDescription || "", length: Number(vd.lengthSeconds) || 0 });
  if (!out.description) out.description = document.querySelector("#description-inline-expander, #description")?.innerText?.trim() || "";
  const pick = (tracks) => {
    const list = (tracks || []).filter((t) => t?.baseUrl);
    const is = (t) => String(t.languageCode || "").toLowerCase().split("-")[0] === lang;
    const asr = (t) => t.kind === "asr";
    return list.find((t) => is(t) && !asr(t)) || list.find(is) || list.find((t) => !asr(t)) || list[0] || null;
  };
  const get = async (url) => {
    try {
      const res = await fetch(url, { credentials: "include" });
      return res.ok ? await res.text() : "";
    } catch {
      return "";
    }
  };
  const json3 = (u) => `${u.replace(/&fmt=[^&]*/g, "")}&fmt=json3`;
  const describe = (t) => ({ lang: t.languageCode, name: t.name?.simpleText || t.name?.runs?.map((r) => r.text).join("") || t.languageCode, auto: t.kind === "asr" });
  let hadTracks = false;

  const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  let t = pick(tracks);
  if (t) {
    hadTracks = true;
    out.track = describe(t);
    out.body = await get(json3(t.baseUrl));
    if (out.body.trim()) return ((out.via = "player"), out);
  }
  try {
    const res = await fetch("/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, hl: lang } }, videoId: id }),
    });
    const j = res.ok ? await res.json() : null;
    t = pick(j?.captions?.playerCaptionsTracklistRenderer?.captionTracks);
    if (t) {
      hadTracks = true;
      out.track = describe(t);
      out.body = await get(json3(t.baseUrl));
      if (out.body.trim()) return ((out.via = "innertube"), out);
    }
    if (!out.title && j?.videoDetails) Object.assign(out, { title: j.videoDetails.title, channel: j.videoDetails.author, description: j.videoDetails.shortDescription || "", length: Number(j.videoDetails.lengthSeconds) || 0 });
  } catch {}
  const loaded = performance.getEntriesByType("resource").map((e) => e.name).filter((u) => u.includes("/api/timedtext") && u.includes(`v=${id}`)).pop();
  if (loaded) {
    out.body = await get(json3(loaded));
    if (out.body.trim()) return ((out.via = "loaded"), out);
  }
  const segs = [...document.querySelectorAll("ytd-transcript-segment-renderer")].map((el) => ({
    time: el.querySelector(".segment-timestamp")?.innerText?.trim() || "",
    text: el.querySelector(".segment-text")?.innerText?.trim() || "",
  })).filter((s) => s.text);
  if (segs.length) return ((out.segments = segs), (out.via = "panel"), out);
  out.hadTracks = hadTracks;
  return out;
}

async function readYoutube(page, url) {
  const id = youtubeId(url);
  const y = await page.evaluate(youtubeInPage, { id, lang: "en" });
  let segments = y.segments
    ? y.segments.map((s) => ({ start: (s.time.split(":").reduce((a, n) => a * 60 + Number(n), 0)) || 0, dur: 0, text: s.text }))
    : parseCaptions(y.body);
  const head = [
    `Video: ${y.title}${y.channel ? ` (by ${y.channel})` : ""}`,
    y.length ? `Length: ${fmtTime(y.length)}` : "",
    y.at != null ? `The user is at ${fmtTime(y.at)} in the video.` : "",
  ].filter(Boolean).join("\n");
  const meta = { id, title: y.title, channel: y.channel, length: y.length, at: y.at, track: y.track, via: y.via };
  if (segments.length) {
    const lang = y.track ? ` (${y.track.auto ? "auto-generated " : ""}${y.track.name} captions)` : "";
    return {
      kind: "youtube",
      head: `${head}\nDescription: ${cleanText(y.description).slice(0, 1500)}`,
      body: transcriptText(segments),
      label: `Video transcript${lang}, each line starts with its [m:ss] time`,
      meta: { ...meta, captions: true, segments: segments.length },
    };
  }
  return {
    kind: "youtube",
    head,
    body: `Description:\n${cleanText(y.description) || "(no description)"}`,
    label: "This video has no captions the assistant could read; only its title and description are available",
    meta: { ...meta, captions: false },
  };
}

// ── readers ────────────────────────────────────────────────────

async function readPdf(page, url) {
  const { body } = await fetchAsUser(page, url);
  if (!body.subarray(0, 1024).toString("latin1").includes("%PDF")) throw new Error("That isn't a PDF file");
  const pages = await extractPdfPages(body);
  const text = pdfPagesText(pages);
  const empty = !text.replace(/\[Page \d+\]/g, "").trim();
  return {
    kind: "pdf",
    head: `PDF: ${url.split("/").pop()?.split("?")[0] || url} (${pages.length} page${pages.length === 1 ? "" : "s"})`,
    body: empty ? "(This PDF has no text layer; it may be scanned images.)" : text,
    label: "PDF text, each page starts with [Page n]",
    meta: { pages: pages.length, scanned: empty },
  };
}

async function readGoogle(page, url, kind) {
  const g = googleDoc(url);
  const { body, type } = await fetchAsUser(page, googleExportUrl(g));
  const s = body.toString("utf8");
  if (/text\/html/i.test(type) || /^\s*<!doctype html|^\s*<html/i.test(s)) throw new Error("Google didn't allow the export (sign-in or permission needed)");
  const what = kind === "gsheet" ? "Spreadsheet (CSV of the open sheet)" : kind === "gslides" ? "Slides text" : "Document text";
  return { kind, head: "", body: cleanText(s.replace(/^﻿/, "")), label: what, meta: { id: g.id } };
}

async function readHtml(page) {
  const raw = await page.evaluate(collectPage);
  const { text, main, dropped } = chooseMainText(raw);
  return { kind: "html", head: "", body: text, label: main ? "Main page text" : "Page text", meta: { main, dropped } };
}

// Parsed PDFs, so goal steps and follow-up questions on the same PDF don't fetch and parse it again.
const cache = new Map();
const CACHE_MS = 5 * 60_000;

/**
 * Read a page for the brain. opts:
 *   question  - what the text is for (picks the relevant chunks when it's too long)
 *   budget    - max chars of body text
 *   special   - false: only main-content HTML reading (no transcript/PDF/export fetches)
 *   video     - false: don't fetch a video's captions (read the watch page as HTML)
 * Returns { kind, url, label, head, text, truncated, cite, meta }. Falls back to plain page text
 * when a special reader fails, with the reason in meta.error.
 */
export async function readPage(page, { question = "", budget = 30000, special = true, video = true } = {}) {
  const url = page.url();
  const contentType = special ? await page.evaluate(() => document.contentType || "").catch(() => "") : "";
  let kind = detectKind(url, contentType);
  if (kind === "youtube" && !video) kind = "html";
  let r = null;
  let error = "";
  if (kind !== "html" && special) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < CACHE_MS) r = hit.r;
    else {
      try {
        r = kind === "youtube" ? await readYoutube(page, url) : kind === "pdf" ? await readPdf(page, url) : await readGoogle(page, url, kind);
        // PDFs don't change under the same URL; docs are edited live and videos have a play position
        if (kind === "pdf") cache.set(url, { at: Date.now(), r });
        if (cache.size > 20) cache.delete(cache.keys().next().value);
      } catch (err) {
        error = String(err.message || err);
      }
    }
  }
  if (!r) {
    r = await readHtml(page).catch(() => ({ kind: "html", head: "", body: "", label: "Page text", meta: {} }));
    if (kind !== "html" && error) r.meta = { ...r.meta, error, wanted: kind };
    kind = "html";
  }
  const sel = selectChunks(r.body, question, budget);
  const label = sel.truncated ? `${r.label} (too long: the parts most relevant to the question, "[…]" marks skipped parts)` : r.label;
  return { kind: r.kind, url, label, head: r.head, text: sel.text, truncated: sel.truncated, meta: r.meta };
}

/** The reading as prompt text: header lines, then the labelled body. */
export const readingText = (r) => `${r.head ? `${r.head}\n` : ""}${r.label}:\n${r.text}`;

/** Prompt hint for the answer, by kind: how to cite. */
export function citeHint(kind) {
  if (kind === "youtube") return "The content is a video transcript. When the answer comes from a particular moment, give its time (m:ss) in the answer and in `where`.";
  if (kind === "pdf") return "The content is a PDF. Put the page number(s) the answer comes from in `where`, e.g. 'page 3'.";
  return "";
}

/**
 * Where an answer came from, for the chat: { cite, link }.
 * cite e.g. "From the video's transcript, at 2:03" / "From page 3 of the PDF".
 */
export function citeNote(reading, where = "", source = "page") {
  if (!reading || source !== "page") return { cite: "", link: "" };
  const w = String(where || "");
  if (reading.kind === "youtube") {
    if (!reading.meta?.captions) return { cite: "This video has no captions, so this is from its title and description.", link: "" };
    const sec = parseTime(w);
    return sec == null
      ? { cite: "From the video's transcript.", link: "" }
      : { cite: `From the video's transcript, at ${fmtTime(sec)}.`, link: youtubeLink(reading.meta.id, sec) };
  }
  if (reading.kind === "pdf") {
    const m = w.match(/pages?\s*(\d+(?:\s*(?:-|–|to|and|,|&)\s*\d+)*)/i) || w.match(/^\s*(\d+(?:\s*(?:-|–)\s*\d+)?)\s*$/);
    if (!m) return { cite: "From the PDF.", link: "" };
    const pages = m[1].replace(/\s*(?:-|–|to)\s*/g, "–").replace(/\s*(?:,|&)\s*/g, ", ").replace(/\s+and\s+/g, " and ");
    return { cite: `From page${/\D/.test(pages) ? "s" : ""} ${pages} of the PDF.`, link: "" };
  }
  if (reading.kind === "gdoc") return { cite: "From the Google Doc.", link: "" };
  if (reading.kind === "gsheet") return { cite: "From the spreadsheet.", link: "" };
  if (reading.kind === "gslides") return { cite: "From the slides.", link: "" };
  if (reading.meta?.error && reading.meta?.wanted) return { cite: `Couldn't read the ${reading.meta.wanted === "pdf" ? "PDF" : "file"} itself (${reading.meta.error}), so this is from what's on screen.`, link: "" };
  return { cite: "", link: "" };
}

/** Short name of a reading's kind, for tab lists: "video transcript", "PDF", … */
export const kindName = (k) => ({ youtube: "video transcript", pdf: "PDF", gdoc: "Google Doc", gsheet: "spreadsheet", gslides: "slides" })[k] || "";

// ── several tabs ───────────────────────────────────────────────

const within = (promise, ms, fallback) =>
  Promise.race([Promise.resolve(promise).catch(() => fallback), new Promise((r) => setTimeout(() => r(fallback), ms))]);

/**
 * Read several tabs without switching to them. `titles` limits it to the mentioned tabs; else
 * every open web page (up to `max`). A tab that doesn't answer within 2 s is asleep: title only.
 * Returns [{ n, page, title, url, reading | null }].
 */
export async function readTabs(pages, { titles = null, question = "", total = 45000, max = 15 } = {}) {
  const norm = (x) => String(x || "").toLowerCase().replace(/\s+/g, " ").trim();
  const live = pages.filter((p) => !p.isClosed());
  const all = await Promise.all(live.map(async (p) => ({ page: p, title: await within(p.title(), 800, ""), url: p.url() })));
  let tabs = all.filter((t) => /^(?:https?|file):/.test(t.url));
  if (titles?.length) {
    const wanted = titles.map(norm);
    tabs = all.filter((t) => wanted.some((w) => norm(t.title) === w || norm(t.title).includes(w) || (norm(t.title) && w.includes(norm(t.title)))));
  }
  tabs = tabs.slice(0, max);
  const per = Math.max(1500, Math.floor(total / Math.max(1, tabs.length)));
  await Promise.all(
    tabs.map(async (t, i) => {
      t.n = i + 1;
      const awake = await within(t.page.evaluate(() => 1), 2000, null);
      t.reading = awake == null ? null : await within(readPage(t.page, { question, budget: per }), 20000, null);
    }),
  );
  return tabs;
}

/** Tabs as prompt text: "### Tab 1: title (url), PDF\n…". */
export const tabsText = (tabs) =>
  tabs
    .map((t) => {
      const k = t.reading && kindName(t.reading.kind);
      return `### Tab ${t.n}: ${t.title || "(untitled)"} (${t.url})${k ? `, ${k}` : ""}\n${t.reading ? readingText(t.reading) : "(couldn't read this tab; it may be asleep)"}`;
    })
    .join("\n\n");
