import { test } from "node:test";
import assert from "node:assert/strict";
import { toAction } from "../../src/smart.js";
import { stepFromAction } from "../../src/recipe.js";

const snap = { elements: [] };

test("goals can open a new tab, with or without an address", () => {
  const a = toAction({ action: { type: "new_tab", url: "youtube.com" } }, snap).action;
  assert.equal(a.type, "open_new_tab");
  assert.match(a.url, /^https:\/\/youtube\.com/);
  assert.equal(toAction({ action: { type: "new_tab" } }, snap).action.url, undefined);
  assert.deepEqual(stepFromAction(a, snap), { kind: "new_tab", url: a.url, label: a.label });
});

test("goals can switch to an open tab by its number, and close a tab", () => {
  const page = { fake: true };
  const tabs = [{ n: 1, page, title: "Inbox", url: "https://mail.example.com" }];
  const a = toAction({ action: { type: "switch_tab", tab: 1 } }, snap, tabs).action;
  assert.equal(a.page, page);
  assert.equal(a.title, "Inbox");
  assert.doesNotThrow(() => JSON.stringify(a)); // sent to the bar as JSON
  assert.ok(!("page" in JSON.parse(JSON.stringify(a))));
  assert.match(toAction({ action: { type: "switch_tab", tab: 4 } }, snap, tabs).error, /not open/);
  assert.equal(toAction({ action: { type: "close_tab" } }, snap).action.type, "close_tab");
});
