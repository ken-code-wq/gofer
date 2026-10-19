/**
 * Page reading (pagetext.js): kind detection, caption parsing, main-content choice, chunk
 * selection, citations; compare.js table shaping; and routing of "compare …" to the comparison.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  youtubeId, googleDoc, googleExportUrl, detectKind, fmtTime, parseTime,
  parseJson3, parseTimedTextXml, parseCaptions, pickTrack, transcriptText, youtubeLink,
  chooseMainText, keywords, chunkText, selectChunks, pdfPagesText, citeNote, readingText, readPage,
} from "../../src/pagetext.js";
import { isCompareRequest, toCompareTable } from "../../src/compare.js";
import { isTabsQuestion } from "../../src/smart.js";
import { Controller } from "../../src/controller.js";

test("detects videos, PDFs and Google files from the URL and content type", () => {
  assert.equal(youtubeId("https://www.youtube.com/watch?v=8S0FDjFBj8o&t=10s"), "8S0FDjFBj8o");
  assert.equal(youtubeId("https://youtu.be/8S0FDjFBj8o?si=x"), "8S0FDjFBj8o");
  assert.equal(youtubeId("https://m.youtube.com/shorts/abcdefghijk"), "abcdefghijk");
  assert.equal(youtubeId("https://www.youtube.com/@channel"), "");
  assert.equal(detectKind("https://www.youtube.com/watch?v=8S0FDjFBj8o"), "youtube");
  assert.equal(detectKind("https://www.w3.org/TR/WCAG21/wcag.pdf"), "pdf");
  assert.equal(detectKind("https://arxiv.org/pdf/1706.03762", "application/pdf"), "pdf");
  assert.equal(detectKind("https://arxiv.org/abs/1706.03762", "text/html"), "html");
  const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  assert.equal(detectKind(`https://docs.google.com/document/d/${id}/edit`), "gdoc");
  assert.equal(detectKind(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=42`), "gsheet");
  assert.equal(detectKind("https://docs.google.com/document/d/e/2PACX-1vabc/pub"), "html", "published docs read fine as HTML");
  assert.equal(googleExportUrl(googleDoc(`https://docs.google.com/document/u/0/d/${id}/edit`)), `https://docs.google.com/document/d/${id}/export?format=txt`);
  assert.equal(googleExportUrl(googleDoc(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=42`)), `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=42`);
});

test("times format and parse", () => {
  assert.equal(fmtTime(83), "1:23");
  assert.equal(fmtTime(3725), "1:02:05");
  assert.equal(parseTime("around 2:03 in the video"), 123);
  assert.equal(parseTime("1:02:05"), 3725);
  assert.equal(parseTime("page 3"), null);
  assert.equal(youtubeLink("8S0FDjFBj8o", 123.7), "https://www.youtube.com/watch?v=8S0FDjFBj8o&t=123s");
});

test("parses YouTube captions: json3, classic XML and srv3", () => {
  const json3 = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: "Hello" }, { utf8: " there" }] }, { tStartMs: 1500 }, { tStartMs: 61000, dDurationMs: 2000, segs: [{ utf8: "\n" }] }, { tStartMs: 62000, dDurationMs: 2000, segs: [{ utf8: "a minute in" }] }] });
  assert.deepEqual(parseJson3(json3), [{ start: 0, dur: 1.5, text: "Hello there" }, { start: 62, dur: 2, text: "a minute in" }]);
  const xml = `<?xml version="1.0"?><transcript><text start="0.5" dur="2.1">It&#39;s &amp; fine</text><text start="3" dur="1">next &lt;line&gt;</text></transcript>`;
  assert.deepEqual(parseTimedTextXml(xml), [{ start: 0.5, dur: 2.1, text: "It's & fine" }, { start: 3, dur: 1, text: "next <line>" }]);
  const srv3 = `<timedtext format="3"><body><p t="1000" d="900">first <s>word</s></p><p t="4000" d="500">second</p></body></timedtext>`;
  assert.deepEqual(parseCaptions(srv3).map((s) => [s.start, s.text]), [[1, "first word"], [4, "second"]]);
  assert.deepEqual(parseCaptions(""), [], "an empty body (a blocked caption URL) is no captions");
});

test("picks hand-made English captions over auto-generated ones", () => {
  const tracks = [{ languageCode: "fr", baseUrl: "f" }, { languageCode: "en", kind: "asr", baseUrl: "a" }, { languageCode: "en-GB", baseUrl: "e" }];
  assert.equal(pickTrack(tracks).baseUrl, "e");
  assert.equal(pickTrack(tracks.slice(0, 2)).baseUrl, "a");
  assert.equal(pickTrack([{ languageCode: "de", kind: "asr", baseUrl: "d" }, { languageCode: "fr", baseUrl: "f" }]).baseUrl, "f");
  assert.equal(pickTrack([]), null);
});

test("transcript paragraphs start with their time", () => {
  const segs = [0, 5, 10, 22, 30, 65].map((s) => ({ start: s, dur: 4, text: `at ${s}` }));
  assert.equal(transcriptText(segs), "[0:00] at 0 at 5 at 10\n[0:22] at 22 at 30\n[1:05] at 65");
});

test("main content: the article wins over the whole page, navigation is dropped", () => {
  const article = "Title of the story\n" + "The real content of the article goes here. ".repeat(20);
  const nav = "Home | News | Sport | Weather | Sign in";
  const footer = "© 2026 Example Corp. Terms. Privacy. Cookies. Contact us.";
  const r = chooseMainText({ body: `${nav}\n${article}\n${footer}`, candidates: [article], boiler: [nav, footer] });
  assert.ok(r.main);
  assert.ok(r.text.startsWith("Title of the story"));
  assert.ok(!r.text.includes("Sign in") && !r.text.includes("Privacy"));
  // no usable container: the body without the boilerplate
  const r2 = chooseMainText({ body: `${nav}\nShort page body text that is the content.\n${footer}`, candidates: ["tiny"], boiler: [nav, footer] });
  assert.equal(r2.main, false);
  assert.equal(r2.text, "Short page body text that is the content.");
});

test("keywords drop stop words and stem", () => {
  assert.deepEqual(keywords("What does he say about the pricing of GPUs in 2024?"), ["pric", "gpu", "2024"]);
  assert.deepEqual(keywords("summarize this video"), []);
});

test("chunks keep their PDF page", () => {
  const text = pdfPagesText(["a ".repeat(400), "b ".repeat(900)]);
  const chunks = chunkText(text, 500);
  assert.ok(chunks[0].startsWith("[Page 1]"));
  assert.ok(chunks.some((c) => c.startsWith("[Page 2] (continued)")), "a page split over chunks keeps its marker");
});

test("long text: keeps the chunks about the question, not the first N chars", () => {
  const filler = (i) => `Paragraph ${i} talks about nothing in particular, just general filler words.`;
  const lines = Array.from({ length: 400 }, (_, i) => filler(i));
  lines[310] = "The warranty covers accidental damage for three years in the premium plan.";
  const text = lines.join("\n");
  const r = selectChunks(text, "How long is the warranty?", 4000);
  assert.ok(r.truncated && r.text.length <= 4000 + 50);
  assert.ok(r.text.includes("accidental damage for three years"), "the matching chunk is kept");
  assert.ok(r.text.startsWith("Paragraph 0"), "the opening is kept");
  assert.ok(r.text.includes("[…]"));
  // short text is returned as is
  assert.deepEqual(selectChunks("short", "x", 100), { text: "short", truncated: false });
  // no keywords (a summary): evenly spread, so the end of the text is represented too
  const s = selectChunks(text, "summarize this", 4000);
  assert.ok(s.text.includes("Paragraph 399"));
});

test("citations: video time with a link, PDF pages, failed reads", () => {
  const video = { kind: "youtube", meta: { id: "8S0FDjFBj8o", captions: true } };
  assert.deepEqual(citeNote(video, "2:03"), { cite: "From the video's transcript, at 2:03.", link: "https://www.youtube.com/watch?v=8S0FDjFBj8o&t=123s" });
  assert.equal(citeNote(video, "").cite, "From the video's transcript.");
  assert.equal(citeNote(video, "2:03", "general").cite, "", "general knowledge isn't cited to the video");
  assert.match(citeNote({ kind: "youtube", meta: { captions: false } }, "").cite, /no captions/);
  assert.equal(citeNote({ kind: "pdf", meta: {} }, "page 3").cite, "From page 3 of the PDF.");
  assert.equal(citeNote({ kind: "pdf", meta: {} }, "pages 3-4").cite, "From pages 3–4 of the PDF.");
  assert.equal(citeNote({ kind: "pdf", meta: {} }, "").cite, "From the PDF.");
  assert.equal(citeNote({ kind: "gdoc", meta: {} }, "").cite, "From the Google Doc.");
  assert.equal(citeNote({ kind: "html", meta: {} }, "").cite, "");
  assert.match(citeNote({ kind: "html", meta: { error: "HTTP 403", wanted: "pdf" } }, "").cite, /Couldn't read the PDF itself \(HTTP 403\)/);
});

test("readPage falls back to the page text when a special reader fails", async () => {
  // a fake page: a "PDF" URL whose bytes aren't a PDF, so the PDF reader throws
  const page = {
    url: () => "https://example.com/report.pdf",
    context: () => ({ request: { get: async () => ({ ok: () => true, body: async () => Buffer.from("<html>nope</html>"), headers: () => ({ "content-type": "text/html" }) }) } }),
    evaluate: async (fn) => (fn.name === "collectPage" ? { body: "Fallback text", candidates: [], boiler: [] } : "application/pdf"),
  };
  const r = await readPage(page, { question: "what is this" });
  assert.equal(r.kind, "html");
  assert.equal(r.text, "Fallback text");
  assert.equal(r.meta.wanted, "pdf");
  assert.match(readingText(r), /^Page text:\nFallback text$/);
});

test("Google Doc export is read with the user's session; a sign-in page is refused", async () => {
  const fake = (body, type) => ({
    url: () => "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit",
    context: () => ({ request: { get: async (u) => (fake.asked = u, { ok: () => true, body: async () => Buffer.from(body), headers: () => ({ "content-type": type }) }) } }),
    evaluate: async (fn) => (fn.name === "collectPage" ? { body: "canvas page", candidates: [], boiler: [] } : "text/html"),
  });
  const ok = await readPage(fake("﻿Meeting notes\r\n\r\nShip on Friday.", "text/plain; charset=utf-8"));
  assert.equal(ok.kind, "gdoc");
  assert.match(fake.asked, /\/export\?format=txt$/);
  assert.match(ok.text, /^Meeting notes\n+Ship on Friday\.$/);
  const denied = await readPage(fake("<!DOCTYPE html><title>Sign in</title>", "text/html"));
  assert.equal(denied.kind, "html");
  assert.match(denied.meta.error, /sign-in or permission/);
});

test("compare: which questions want a table, and how the table is shaped", () => {
  assert.ok(isCompareRequest("compare @[Laptop A] @[Laptop B]"));
  assert.ok(isCompareRequest("which of my tabs is cheapest"));
  assert.ok(isCompareRequest("what's the difference between these tabs"));
  assert.ok(!isCompareRequest("which of my tabs mentions Kubernetes"));
  assert.ok(!isCompareRequest("summarize @[Best Laptops 2026] and @[Other]"), "words inside @mentions don't count");
  assert.ok(isTabsQuestion("compare these two tabs"));
  assert.ok(isTabsQuestion("compare both tabs"));
  const tabs = [{ n: 1, title: "A page" }, { n: 2, title: "B page" }, { n: 3, title: "C page" }];
  const t = toCompareTable({ attributes: ["Price", "Rating"], rows: [{ tab: 2, name: "Bee", values: ["$5"] }, { tab: 1, name: "Ay", values: ["$9", "4.5"] }] }, tabs);
  assert.deepEqual(t.columns, ["Tab", "Price", "Rating"]);
  assert.deepEqual(t.rows, [["Ay", "$9", "4.5"], ["Bee", "$5", "—"], ["C page", "—", "—"]]);
});

test("routing: 'compare' with two @tabs or 'these tabs' goes to the comparison, other tab questions don't", async () => {
  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = saved || "test-key"; // hasBrain(); no call is made
  try {
    const c = new Controller({ browser: { onChange: () => () => {}, pages: [] }, decideFn: async () => ({}), executeFn: async () => ({ ok: true }), persist: false });
    const compared = [];
    const asked = [];
    c._compareTabs = async (q, titles) => compared.push([q, titles]);
    const realAskTabs = c._askTabs.bind(c);
    c._askTabs = async (q, titles) => (asked.push(q), realAskTabs(q, titles));
    c.on("smart-error", () => {});
    await c.handleCommand("compare @[Laptop A] and @[Laptop B]", { chat: true });
    await c.handleCommand("compare these tabs on price", { chat: true });
    await c.handleCommand("which of my tabs mentions Kubernetes?", { chat: true });
    await c.handleCommand("compare @[Laptop A] @[Laptop B]", { ask: true });
    assert.deepEqual(compared.map(([q, t]) => [q, t]), [
      ["compare @[Laptop A] and @[Laptop B]", ["Laptop A", "Laptop B"]],
      ["compare these tabs on price", null],
      ["compare @[Laptop A] @[Laptop B]", ["Laptop A", "Laptop B"]],
    ]);
    assert.equal(asked.length, 4, "all four went through the tabs path; one of them stayed a plain answer");
  } finally {
    if (saved === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved;
  }
});
