/**
 * Styled checkboxes: UI libraries keep the real <input> but make it invisible (Material UI lays a
 * see-through input over a drawn box; others shrink it to nothing beside its label). They must still
 * be in the element list, with their label and whether they're ticked, and clicking them must work.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { collectElementsInPage, buildSnapshot } from "../../src/snapshot.js";
import { encodeElement } from "../../src/jev.js";

const PAGE = `
<div role="dialog" aria-modal="true">
  <!-- Material UI: the input is see-through, on top of the drawn box -->
  <label style="display:flex;align-items:center;gap:8px">
    <span style="position:relative;width:24px;height:24px;border:2px solid #555;display:inline-block">
      <input type="checkbox" style="position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer">
    </span>
    <span>I sell this Product</span>
  </label>
  <!-- visually hidden input, its label is what you see and click -->
  <input type="checkbox" id="buy" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">
  <label for="buy" style="display:inline-block;padding:4px">I buy this Product</label>
  <!-- an ARIA checkbox -->
  <div role="checkbox" aria-checked="true" tabindex="0" style="width:120px;height:20px">Track Inventory</div>
  <button>Save</button>
</div>`;

test("see-through and hidden checkboxes are listed with their label and ticked state, and can be clicked", { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(PAGE);
    const snap = async () => buildSnapshot(await page.evaluate(collectElementsInPage));
    const lines = (s) => s.elements.map((e) => encodeElement(e));
    let s = await snap();
    const sell = s.elements.find((e) => e.text === "I sell this Product");
    const buy = s.elements.find((e) => e.text === "I buy this Product");
    assert.ok(sell && buy, lines(s).join("\n"));
    assert.equal(sell.role, "checkbox");
    assert.match(encodeElement(sell), /checkbox "I sell this Product" \[not checked\]/);
    assert.match(lines(s).join("\n"), /checkbox "Track Inventory" \[checked\]/);
    await page.locator(`[data-vb-id="${sell.id}"]`).click({ timeout: 3000 });
    await page.locator(`[data-vb-id="${buy.id}"]`).click({ timeout: 3000 });
    s = await snap();
    assert.equal(s.elements.find((e) => e.text === "I sell this Product").checked, true);
    assert.equal(s.elements.find((e) => e.text === "I buy this Product").checked, true);
    assert.equal(await page.evaluate(() => document.getElementById("buy").checked), true);
  } finally {
    await browser.close();
  }
});

test("a goal step reports what was really clicked, and whether a checkbox is ticked now", { timeout: 60000 }, async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  process.env.VB_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "vb-step-"));
  const { BrowserManager } = await import("../../src/browser.js");
  const { Controller } = await import("../../src/controller.js");
  const b = new BrowserManager();
  await b.launch({ headless: true, profileDir: fs.mkdtempSync(path.join(os.tmpdir(), "vb-prof-")), startUrl: "about:blank" });
  try {
    const c = new Controller({ browser: b, persist: false });
    c._emitGoal = () => {};
    await b.page.setContent(`<div role="listbox"><div role="option" onclick="">Product</div></div>
      <label><span style="position:relative;display:inline-block;width:20px;height:20px"><input type="checkbox" style="position:absolute;inset:0;opacity:0;margin:0;width:100%;height:100%"></span> I sell this Product</label>`);
    const snap = await b.snapshot();
    const g = { goal: "x", steps: [], done: [], recipe: [] };
    const run = async (el) => {
      const entry = { text: "Click I sell this Product checkbox", status: "running" };
      await c._runGoalStep(g, entry, { type: "click_element", targetId: el.id, label: `${el.role} "${el.text}"` });
      return entry.detail;
    };
    // the model said "checkbox" but picked the option: the step says what was clicked
    assert.equal(await run(snap.elements.find((e) => e.role === "option")), 'clicked option "Product"');
    assert.equal(await run(snap.elements.find((e) => e.role === "checkbox")), 'clicked checkbox "I sell this Product" (now checked)');
    assert.match(g.done.at(-1).outcome, /now checked\); done \(now at/, "ticking counts as a change");
  } finally {
    await b.close();
  }
});
