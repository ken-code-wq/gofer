import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BrowserManager } from "../../src/browser.js";

test("attaching skips a tab that doesn't answer, then adds it once it does", { timeout: 60000 }, async () => {
  const port = 9600 + Math.floor(Math.random() * 300);
  const real = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`] });
  const b = new BrowserManager();
  try {
    const ctx = await real.newContext();
    await (await ctx.newPage()).setContent("<title>Awake</title>");
    const busy = await ctx.newPage();
    await busy.setContent("<title>Busy</title>");
    await busy.evaluate(() => setTimeout(() => { const e = Date.now() + 6000; while (Date.now() < e) {} }, 0));
    await new Promise((r) => setTimeout(r, 300));

    await b.launch({ cdp: `http://127.0.0.1:${port}`, startUrl: null });
    const titles = async () => (await b.tabList()).map((t) => t.title).sort();
    assert.deepEqual(await titles(), ["Awake"]);
    await new Promise((r) => setTimeout(r, 11000));
    assert.deepEqual(await titles(), ["Awake", "Busy"]);
  } finally {
    await b.close();
    await real.close();
  }
});
