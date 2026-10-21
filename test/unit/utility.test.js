import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseUtility } from "../../src/utility.js";

test("parseUtility: screenshots and copies", () => {
  assert.deepEqual(parseUtility("screenshot"), { kind: "screenshot", fullPage: false });
  assert.deepEqual(parseUtility("Take a screenshot."), { kind: "screenshot", fullPage: false });
  assert.deepEqual(parseUtility("screenshot the whole page"), { kind: "screenshot", fullPage: true });
  assert.deepEqual(parseUtility("full page screenshot"), { kind: "screenshot", fullPage: true });
  assert.deepEqual(parseUtility("copy url"), { kind: "copy", what: "url" });
  assert.deepEqual(parseUtility("copy the page link"), { kind: "copy", what: "url" });
  assert.deepEqual(parseUtility("copy title"), { kind: "copy", what: "title" });
  assert.equal(parseUtility("click the screenshot button"), null);
  assert.equal(parseUtility("copy the invoice number"), null);
});

test("resolveSaved: slots filled from what follows the name", async () => {
  process.env.VB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vb-slots-"));
  const { saveCommand, resolveSaved } = await import(`../../src/store.js?slots`);
  saveCommand("yt", "open youtube, search for {}");
  saveCommand("login", "type {{dev-pass}} into password");
  saveCommand("bill", "create a bill for {vendor} of {amount}");
  assert.equal(resolveSaved("yt cats on pianos").text, "open youtube, search for cats on pianos");
  assert.deepEqual(resolveSaved("yt").missing, ["value"]);
  assert.equal(resolveSaved("login").text, "type {{dev-pass}} into password");
  assert.equal(resolveSaved("login now"), null);
  assert.equal(resolveSaved("bill Acme, 120").text, "create a bill for Acme of 120");
  assert.deepEqual(resolveSaved("bill Acme").missing, ["amount"]);
});

test("asking for a screenshot in plain words", async () => {
  const { parseUtility } = await import("../../src/utility.js");
  for (const [t, full] of [["send me a screenshot", false], ["can you send me a screenshot of this page?", false], ["show me a screenshot", false], ["give me a full-page screenshot", true], ["screenshot the whole page please", true], ["take a screenshot", false], ["screenshot this", false]])
    assert.deepEqual(parseUtility(t), { kind: "screenshot", fullPage: full }, t);
  for (const t of ["send me the screenshot tool docs", "screenshot of my bills with the totals", "show me the cheapest flight"]) assert.equal(parseUtility(t), null, t);
});

test("goals can take a screenshot, and saved goals keep it", async () => {
  const { toAction } = await import("../../src/smart.js");
  const { stepFromAction } = await import("../../src/recipe.js");
  const a = toAction({ action: { type: "screenshot", full_page: true } }, { elements: [] }).action;
  assert.deepEqual(a, { type: "take_screenshot", fullPage: true, label: "screenshot of the whole page" });
  assert.equal(stepFromAction(a, { elements: [] }).kind, "screenshot");
});

test("'try again'", async () => {
  const { isRetry } = await import("../../src/controller.js");
  for (const t of ["try again", "retry", "ok, try again please", "do it again", "again"]) assert.ok(isRetry(t), t);
  assert.ok(!isRetry("try again to open youtube"));
});
