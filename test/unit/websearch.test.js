import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBraveHtml, htmlToText, webSearch, searchText, decodeEntities } from "../../src/websearch.js";
import { stepFromCall } from "../../src/smart.js";

test("parseBraveHtml: web results with title, url and snippet; other blocks skipped", () => {
  const html = `
    <div class="snippet svelte-x" data-type="video"><a href="https://v.example/1">vid</a></div>
    <div class="snippet svelte-jmfu5f" data-pos="1" data-type="web"><a href="https://en.wikipedia.org/wiki/The_Reject_Shop" target="_self" class="l1">
      <div class="title search-snippet-title" title="The Reject Shop - Wikipedia">The Reject Shop - Wikipedia</div></a>
      <div class="generic-snippet"><div class="content desktop-default-regular">The <strong>Reject</strong> Shop is an Australian&nbsp;chain</div></div></div>`;
  assert.deepEqual(parseBraveHtml(html), [{ title: "The Reject Shop - Wikipedia", url: "https://en.wikipedia.org/wiki/The_Reject_Shop", snippet: "The Reject Shop is an Australian chain" }]);
  assert.deepEqual(parseBraveHtml("<html>captcha</html>"), []);
});

test("htmlToText: main content without scripts or navigation", () => {
  const { title, text } = htmlToText(`<html><head><title>Ad &amp; jingles</title><script>var x=1</script></head><body>
    <nav>Home | About</nav><article><h1>Uncle Pete's Toys</h1><p>You can get anything at Uncle Pete&#39;s.</p><ul><li>1984</li></ul></article>
    <footer>© 2026</footer></body></html>`);
  assert.equal(title, "Ad & jingles");
  assert.match(text, /Uncle Pete's Toys\nYou can get anything at Uncle Pete's\.\n• 1984/);
  assert.doesNotMatch(text, /Home|var x|2026/);
  assert.equal(decodeEntities("&copy; &#x41;&#66; &bogus;"), "© AB &bogus;");
});

test("webSearch: falls through providers that fail; error only when all do", async () => {
  const bad = { id: "a", label: "A", ready: () => true, run: async () => { throw new Error("429"); } };
  const off = { id: "b", label: "B", ready: () => false, run: async () => assert.fail("not set up") };
  const good = { id: "c", label: "C", ready: () => true, run: async () => ({ results: [{ title: "T", url: "https://t.example", snippet: "s" }] }) };
  const r = await webSearch("  toy   jingle ", { providers: [bad, off, good] });
  assert.equal(r.provider, "C");
  assert.equal(r.query, "toy jingle");
  assert.match(searchText(r), /^1\. T — https:\/\/t\.example\n {3}s$/);
  await assert.rejects(webSearch("x", { providers: [bad] }), /web search failed \(A: 429\)/);
});

test("stepFromCall: tool calls become the same steps as the JSON format", () => {
  assert.deepEqual(stepFromCall({ name: "finish", args: { status: "done", summary: "It's Uncle Pete's." } }), { status: "done", summary: "It's Uncle Pete's.", description: "", risky: false });
  assert.deepEqual(stepFromCall({ name: "type_text", args: { element_id: 12, text: "hi", submit: true, description: "search" } }).action, { type: "type", element_id: "12", text: "hi", submit: true });
  assert.deepEqual(stepFromCall({ name: "select_option", args: { element_id: "e3", option: "Utilities" } }).action, { type: "select", element_id: "e3", text: "Utilities" });
  assert.equal(stepFromCall({ name: "scroll", args: { direction: "up" } }).action.type, "scroll_up");
  assert.deepEqual(stepFromCall({ name: "web_search", args: { query: "q" } }).action, { type: "web_search", query: "q" });
  assert.equal(stepFromCall({ name: "click", args: { element_id: "e1", risky: true } }).risky, true);
});
