import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stepFromAction, stepFromFill, finalizeRecipe, recipeSlots, bindSlots, findElement, describeStep } from "../../src/recipe.js";
import { parseTableRequest, toTSV, toCSV } from "../../src/table.js";

const snap = {
  elements: [
    { id: "e1", role: "button", text: "New bill" },
    { id: "e2", role: "textbox", text: "Vendor" },
    { id: "e3", role: "textbox", text: "Password" },
    { id: "e4", role: "button", text: "Delete bill" },
  ],
};

test("recipe: steps recorded by what elements look like; secrets and passwords never stored", () => {
  assert.deepEqual(stepFromAction({ type: "click_element", targetId: "e1" }, snap), { kind: "click", match: { role: "button", text: "New bill", placeholder: "" }, label: "New bill", risky: false });
  assert.equal(stepFromAction({ type: "click_element", targetId: "e4" }, snap).risky, true, "delete asks again on replay");
  const vendor = stepFromAction({ type: "type_into_field", targetId: "e2", text: "Acme" }, snap);
  assert.equal(vendor.value, "Acme");
  const pw = stepFromAction({ type: "type_into_field", targetId: "e3", text: "hunter2" }, snap);
  assert.equal(pw.value, "", "a literal password is dropped");
  assert.equal(stepFromAction({ type: "type_into_field", targetId: "e3", text: "{{dev-pass}}" }, snap).value, "{{dev-pass}}");
  const fill = stepFromFill([{ label: "Amount", type: "number", value: "120" }, { label: "Pin", type: "password", value: "••••" }, { label: "Bad", value: "x", error: "nope" }]);
  assert.deepEqual(fill.fields.map((f) => [f.label, f.value]), [["Amount", "120"], ["Pin", ""]]);
});

test("recipe: slots get defaults and take positional or named values", () => {
  const steps = finalizeRecipe([
    stepFromAction({ type: "click_element", targetId: "e1" }, snap),
    stepFromAction({ type: "type_into_field", targetId: "e2", text: "Acme" }, snap),
    stepFromFill([{ label: "Amount", type: "number", value: "120" }]),
  ]);
  assert.deepEqual(recipeSlots(steps).map((s) => [s.name, s.default]), [["vendor", "Acme"], ["amount", "120"]]);
  assert.deepEqual(bindSlots(steps, "").values, { vendor: "Acme", amount: "120" });
  assert.deepEqual(bindSlots(steps, "Globex, 99").values, { vendor: "Globex", amount: "99" });
  assert.deepEqual(bindSlots(steps, "amount=5").values, { vendor: "Acme", amount: "5" });
  assert.equal(describeStep(steps[1], { vendor: "Globex" }), "type Globex into Vendor");
  const pw = finalizeRecipe([stepFromAction({ type: "type_into_field", targetId: "e3", text: "hunter2" }, snap)]);
  assert.deepEqual(bindSlots(pw, "").missing, ["password"]);
});

test("recipe: finds the element again on a changed page", () => {
  const live = [{ id: "x9", role: "button", text: "new bill" }, { id: "x1", role: "link", text: "New bill help" }];
  assert.equal(findElement(live, { role: "button", text: "New bill" }).id, "x9");
  assert.equal(findElement(live, { role: "button", text: "Save" }), null);
});

test("saved recipes: run by name with values", async () => {
  process.env.VB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vb-recipe-"));
  const { saveCommand, resolveSaved } = await import(`../../src/store.js?recipe`);
  saveCommand("new-bill", "create a bill", finalizeRecipe([stepFromAction({ type: "type_into_field", targetId: "e2", text: "Acme" }, snap)]));
  assert.deepEqual(resolveSaved("new-bill").values, { vendor: "Acme" });
  assert.deepEqual(resolveSaved("new-bill Globex").values, { vendor: "Globex" });
});

test("table requests", () => {
  assert.deepEqual(parseTableRequest("copy the table"), { plain: true, what: "the table", file: false });
  assert.deepEqual(parseTableRequest("export the table as csv"), { plain: true, what: "the table", file: true });
  assert.deepEqual(parseTableRequest("copy all invoice numbers as a table"), { plain: false, what: "all invoice numbers", file: false });
  assert.deepEqual(parseTableRequest("copy all invoice numbers"), { plain: false, what: "all invoice numbers", file: false });
  assert.equal(parseTableRequest("copy url"), null);
  assert.equal(parseTableRequest("click the table header"), null);
  const t = { columns: ["Vendor", "Amount"], rows: [["Acme, Inc", "1\t20"]] };
  assert.equal(toTSV(t), "Vendor\tAmount\nAcme, Inc\t1 20");
  assert.equal(toCSV(t), 'Vendor,Amount\n"Acme, Inc",1\t20');
});

test("usage: costs add up per day and the limit blocks calls", async () => {
  process.env.VB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vb-usage-"));
  const u = await import(`../../src/usage.js?usage`);
  assert.ok(Math.abs(u.brainCost("gemini-3.5-flash-lite", { promptTokenCount: 1e6, candidatesTokenCount: 0 }).usd - 0.1) < 1e-9);
  u.record({ source: "brain", model: "m", usd: 0.3 });
  u.record({ source: "snap", model: "s", usd: 0.2 });
  assert.equal(u.summary().calls, 2);
  assert.ok(Math.abs(u.summary().todayUsd - 0.5) < 1e-9);
  u.checkLimit();
  u.setLimit(0.5);
  assert.throws(() => u.checkLimit(), /limit/);
  u.setLimit(null);
  u.checkLimit();
});
