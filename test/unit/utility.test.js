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
