import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.VB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vb-sitenotes-"));
const sn = await import("../../src/sitenotes.js");
const { siteKey, addNote, deleteNote, notesFor, listSites, notesForPrompt, isSafeLesson, worthLearning, learnFromGoal, parseSiteCommand, resolveSite, MAX_NOTES_PER_SITE, MAX_NOTE_CHARS } = sn;

test("site keys: registrable host, ports for local apps, Google apps apart", () => {
  assert.equal(siteKey("https://www.youtube.com/watch?v=x"), "youtube.com");
  assert.equal(siteKey("https://m.youtube.com/"), "youtube.com");
  assert.equal(siteKey("https://news.bbc.co.uk/sport"), "bbc.co.uk");
  assert.equal(siteKey("http://localhost:3000/bills"), "localhost:3000");
  assert.equal(siteKey("http://localhost:5173/"), "localhost:5173");
  assert.equal(siteKey("http://127.0.0.1:8080/x"), "127.0.0.1:8080");
  assert.equal(siteKey("https://mail.google.com/mail/u/0/#inbox"), "mail.google.com");
  assert.equal(siteKey("https://www.google.com/search?q=x"), "google.com");
  assert.equal(siteKey("github.com"), "github.com");
  assert.equal(siteKey("about:blank"), "");
  assert.equal(siteKey(""), "");
});

test("starters ship once and can be deleted for good", () => {
  const yt = notesFor("youtube.com");
  assert.ok(yt.length >= 3);
  assert.ok(yt.every((n) => n.source === "starter"));
  assert.ok(yt.some((n) => /Shift\+N/.test(n.text)));
  assert.ok(notesFor("mail.google.com").some((n) => /Settings/.test(n.text)));
  deleteNote("github.com", notesFor("github.com")[0].id);
  const left = notesFor("github.com").length;
  assert.equal(notesFor("github.com").length, left, "a deleted starter doesn't come back");
});

test("notes are deduplicated, capped and trimmed", () => {
  const a = addNote("http://localhost:3000/x", "Bills are under Sales → Bills", "learned");
  assert.equal(a.site, "localhost:3000");
  const b = addNote("localhost:3000", "bills are under Sales → Bills.", "learned");
  assert.equal(b.id, a.id);
  assert.ok(b.existed);
  // a user's version of the same note replaces the learned one
  const c = addNote("localhost:3000", "Bills are under Sales → Bills", "user");
  assert.equal(c.id, a.id);
  assert.equal(notesFor("localhost:3000")[0].source, "user");
  assert.equal(notesFor("localhost:3000").length, 1);

  const places = ["Sales", "Purchases", "Reports", "Settings", "Inventory", "Payroll", "Banking", "Contacts", "Projects", "Taxes", "Assets", "Budgets", "Expenses", "Journals", "Quotes", "Orders", "Receipts"];
  for (const [i, p] of places.entries()) addNote("localhost:3000", `Feature${i} lives in the ${p} menu`, "learned");
  const notes = notesFor("localhost:3000");
  assert.equal(notes.length, MAX_NOTES_PER_SITE);
  assert.ok(notes.some((n) => n.source === "user"), "the user's note survives the cap");

  const long = addNote("example.org", "word ".repeat(100), "user");
  assert.ok(long.text.length <= MAX_NOTE_CHARS);
  assert.throws(() => addNote("about:blank", "something useful here"));
});

test("listing puts the current site first", () => {
  const sites = listSites("http://localhost:3000/bills");
  assert.equal(sites[0].key, "localhost:3000");
  assert.equal(sites[0].current, true);
  assert.ok(sites.some((s) => s.key === "youtube.com" && s.label === "YouTube"));
});

test("prompt block: the current site plus sites the goal names", () => {
  const p = notesForPrompt({ url: "https://www.youtube.com/watch?v=1", goal: "then open gmail and search for the invoice" });
  assert.deepEqual(p.sites, ["youtube.com", "mail.google.com"]);
  assert.match(p.text, /YouTube \(youtube\.com\):\n- /);
  assert.match(p.text, /Gmail \(mail\.google\.com\)/);
  assert.deepEqual(notesForPrompt({ url: "https://unknown.example/", goal: "do something" }), { text: "", sites: [] });
  assert.deepEqual(notesForPrompt({ url: "https://example.com/", goal: "play a song on youtube" }).sites, ["youtube.com"]);
});

test("the hard-coded YouTube hint is gone from the goal prompt", () => {
  const src = fs.readFileSync(new URL("../../src/smart.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /YouTube: Shift\+N/);
  assert.match(src, /site notes/i);
});

test("learning filter rejects user data and secrets", () => {
  assert.equal(isSafeLesson("Bills are under Sales → Bills in the left menu"), true);
  assert.equal(isSafeLesson("The 'Next' buttons under a video scroll a topic list; use Shift+N for the next video"), true);
  assert.equal(isSafeLesson("Log in as ken@acme.com from the top right"), false);
  assert.equal(isSafeLesson("The password field is below the username"), false);
  assert.equal(isSafeLesson("Bills over $500 need approval first"), false);
  assert.equal(isSafeLesson("Totals like 1250.00 appear at the bottom"), false);
  assert.equal(isSafeLesson("Call 0244 123 4567 for support"), false);
  assert.equal(isSafeLesson("Type {{dev-password}} into the second field"), false);
  assert.equal(isSafeLesson("The user prefers the dark theme"), false);
  assert.equal(isSafeLesson("Search results for lo-fi beats load below the search box", ["lo-fi beats"]), false);
  assert.equal(isSafeLesson("Acme Ltd shows up in the vendor dropdown", ["vendor Acme Ltd, amount 12, category Utilities"]), false);
  assert.equal(isSafeLesson("The vendor dropdown searches as you type", ["vendor Acme Ltd, amount 12"]), true);
  assert.equal(isSafeLesson("short"), false);
});

test("short, smooth goals aren't worth a lesson", () => {
  assert.equal(worthLearning([{ description: "open youtube", outcome: "done (now at …)" }], "done"), false);
  assert.equal(worthLearning([{ description: "a", outcome: "done" }, { description: "b", outcome: "done" }], "done"), false);
  assert.equal(worthLearning([{ description: "a", outcome: "done, but the page unchanged" }, { description: "b", outcome: "done" }], "done"), true);
  assert.equal(worthLearning([1, 2, 3].map((i) => ({ description: `s${i}`, outcome: "done" })), "done"), true);
  assert.equal(worthLearning([{ description: "a", outcome: "done" }], "cancelled"), false);
});

test("learnFromGoal: one small text-only call, filtered lessons stored as learned", async () => {
  const calls = [];
  const ask = async (req) => {
    calls.push(req);
    return { data: { lessons: [
      { site: "example.net", text: "Invoices are under Sales → Invoices, not under Reports" },
      { site: "example.net", text: "Use ken@acme.com to sign in" },
      { site: "other.com", text: "Something about a site that wasn't used" },
    ] } };
  };
  const done = [
    { description: "click Reports", outcome: "done (now at example.net/reports)" },
    { description: "click Next", outcome: "done, but the page unchanged (still example.net/reports)" },
    { description: "click Sales", outcome: "done (now at example.net/sales)" },
  ];
  const notes = await learnFromGoal({ goal: "open the invoices", status: "done", done, sites: ["example.net"], typed: [], ask });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].images, undefined);
  assert.match(calls[0].text, /page unchanged/);
  assert.deepEqual(notes.map((n) => n.text), ["Invoices are under Sales → Invoices, not under Reports"]);
  assert.equal(notesFor("example.net")[0].source, "learned");
  // nothing asked for a straightforward goal
  const none = await learnFromGoal({ goal: "x", status: "done", done: done.slice(0, 1), sites: ["example.net"], ask });
  assert.deepEqual(none, []);
  assert.equal(calls.length, 1);
});

test("parsing 'remember that on X …' and 'what do you know about this site?'", () => {
  assert.deepEqual(parseSiteCommand("remember that on workbook bills are under sales"), { kind: "site-remember", site: "workbook", text: "bills are under sales" });
  assert.deepEqual(parseSiteCommand("Remember that on Google Calendar, c creates an event"), { kind: "site-remember", site: "Google Calendar", text: "c creates an event" });
  assert.deepEqual(parseSiteCommand("remember for localhost:3000 the login is at /signin"), { kind: "site-remember", site: "localhost:3000", text: "the login is at /signin" });
  assert.deepEqual(parseSiteCommand("remember that here bills are under sales"), { kind: "site-remember", site: "here", text: "bills are under sales" });
  assert.deepEqual(parseSiteCommand("remember that bills are under sales on this site."), { kind: "site-remember", site: "here", text: "bills are under sales" });
  assert.deepEqual(parseSiteCommand("remember that bills are under sales here"), { kind: "site-remember", site: "here", text: "bills are under sales" });
  assert.deepEqual(parseSiteCommand("what do you know about this site?"), { kind: "site-list", site: "here" });
  assert.deepEqual(parseSiteCommand("what do you know about youtube?"), { kind: "site-list", site: "youtube" });
  assert.equal(parseSiteCommand("what do you know about me?"), null);
  assert.equal(parseSiteCommand("remember that my work email is ken@acme.com"), null);
  assert.equal(parseSiteCommand("open youtube"), null);
});

test("site names resolve to known sites or open tabs, else nothing", () => {
  assert.equal(resolveSite("youtube"), "youtube.com");
  assert.equal(resolveSite("Gmail"), "mail.google.com");
  assert.equal(resolveSite("google calendar"), "calendar.google.com");
  assert.equal(resolveSite("workbook", { tabs: [{ title: "Bills · Workbook", url: "http://localhost:3000/bills" }] }), "localhost:3000");
  assert.equal(resolveSite("localhost:4000"), "localhost:4000");
  assert.equal(resolveSite("mondays"), "", "an unknown word stays a plain fact");
});

test("chat: 'remember that on <site> …' stores a site note; unknown sites stay facts", async () => {
  const { Controller } = await import("../../src/controller.js");
  const memory = await import("../../src/memory.js");
  const browser = {
    page: { url: () => "http://localhost:3000/dashboard", title: async () => "Dashboard — Workbook", isClosed: () => false },
    pages: [],
    onChange() {},
    tabInfo: () => [],
    tabList: async () => [{ title: "Dashboard — Workbook", url: "http://localhost:3000/dashboard" }],
    snapshot: async () => ({ url: "http://localhost:3000/dashboard", title: "Dashboard", elements: [], tabs: [] }),
  };
  const c = new Controller({ browser, persist: false });
  const answers = [];
  c.on("answer", (a) => answers.push(a.answer));
  await c._chat("remember that on workbook suppliers are under Purchases");
  assert.ok(notesFor("localhost:3000").some((n) => n.text === "Suppliers are under Purchases" && n.source === "user"));
  await c._chat("what do you know about this site?");
  assert.match(answers.at(-1), /Suppliers are under Purchases/);
  await c._chat("remember that on mondays the office is closed");
  assert.ok(memory.listFacts().some((f) => /mondays the office is closed/.test(f)));
});
