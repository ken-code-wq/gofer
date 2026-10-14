import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserManager } from "../../src/browser.js";

const fakePage = (url, title, { hang = false } = {}) => ({
  url: () => url,
  isClosed: () => false,
  title: () => (hang ? new Promise(() => {}) : Promise.resolve(title)),
});

test("tabList answers at once; a sleeping tab or slow icon can't hold it up", async () => {
  const b = new BrowserManager();
  b.pages = [fakePage("https://a.example/x", "A"), fakePage("https://b.example/", "B", { hang: true })];
  b.active = b.pages[0];
  b.favicon = () => new Promise((r) => setTimeout(() => r("data:image/png;base64,AA"), 200));
  let iconsIn;
  const done = new Promise((r) => (iconsIn = r));
  const t = Date.now();
  const first = await b.tabList({ onIcons: iconsIn });
  assert.ok(Date.now() - t < 700, "returned within the title cap");
  assert.deepEqual(first.map((x) => [x.title, x.icon, x.active]), [["A", null, true], ["", null, false]]);
  await done;
  const second = await b.tabList();
  assert.deepEqual(second.map((x) => x.icon), ["data:image/png;base64,AA", "data:image/png;base64,AA"]);
});
