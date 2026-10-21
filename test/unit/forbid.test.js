import { test } from "node:test";
import assert from "node:assert/strict";
import { forbiddenClicks, isForbidden, DISCARDS } from "../../src/forbid.js";

test("what the user said not to click", () => {
  assert.deepEqual(forbiddenClicks("fully fill the waybill manually no autofill. dont press any save button after. DO NOT CLICK AUTOFILL"), ["autofill", "save"]);
  assert.deepEqual(forbiddenClicks("fill the form but don't click on the Submit button"), ["submit"]);
  assert.deepEqual(forbiddenClicks("never press Issue Waybill"), ["issue waybill"]);
  for (const t of ["add 3 items, no more than 3", "no need to log in", "fill the form", "do it without asking me"]) assert.deepEqual(forbiddenClicks(t), [], t);
});

test("matching elements, and buttons that throw work away", () => {
  const f = ["autofill", "save"];
  assert.equal(isForbidden({ role: "button", text: "Autofill" }, f), "autofill");
  assert.equal(isForbidden({ role: "button", text: "Save Draft" }, f), "save");
  assert.equal(isForbidden({ role: "button", text: "Fill shipper with Jay and Joe Co." }, f), null);
  assert.equal(isForbidden({ role: "button", text: "Unsaved" }, f), null);
  for (const t of ["Close anyway", "Discard changes", "Leave without saving"]) assert.ok(DISCARDS.test(t), t);
  assert.ok(!DISCARDS.test("Close"));
});
