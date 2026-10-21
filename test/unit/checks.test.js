import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCheck } from "../../src/checks.js";
import { planChain } from "../../src/chain.js";

test("wait steps", () => {
  assert.deepEqual(parseCheck("wait 2 seconds"), { type: "wait_ms", ms: 2000, label: "wait 2s" });
  assert.equal(parseCheck("wait for the page to load").type, "wait_load");
  assert.equal(parseCheck(`wait until "Purchase requests" appears`).text, "Purchase requests");
  assert.equal(parseCheck("wait for the dashboard to load").text, "dashboard");
  assert.equal(parseCheck("wait until Loading disappears").type, "wait_text_gone");
  assert.equal(parseCheck("wait until the url contains /dashboard").type, "wait_url");
});

test("check steps", () => {
  assert.deepEqual(parseCheck(`check that the page says "Approved"`).text, "Approved");
  assert.equal(parseCheck("check the page doesn't say Error").type, "assert_no_text");
  assert.equal(parseCheck("check that the url contains /dashboard").text, "/dashboard");
  assert.equal(parseCheck(`verify "Welcome" is visible`).type, "assert_text");
});

test("ordinary commands are not checks", () => {
  for (const t of ["click save", "go to wikipedia", "search for wait times", "type check into the box"]) assert.equal(parseCheck(t), null, t);
});

test("waits and checks chain like other steps", () => {
  assert.deepEqual(planChain(`go to localhost:3000/login, wait until "Sign in" appears, type {{dev-email}} into the email field, check that the page says "Welcome"`), [
    "go to localhost:3000/login",
    `wait until "Sign in" appears`,
    "type {{dev-email}} into the email field",
    `check that the page says "Welcome"`,
  ]);
  assert.deepEqual(planChain("click on Password and type {{dev-password}}, click sign in and wait 2 seconds"), [
    "type {{dev-password}} into the Password field",
    "click sign in",
    "wait 2 seconds",
  ]);
});

import { routeSmart, toAction } from "../../src/smart.js";

test("smart routing: questions, goals, forms; ordinary commands untouched", () => {
  assert.deepEqual(routeSmart("how many requests are pending?"), { kind: "ask", question: "how many requests are pending?" });
  assert.equal(routeSmart("summarize this article").kind, "ask");
  assert.deepEqual(routeSmart("goal: approve all pending requests under $500"), { kind: "goal", goal: "approve all pending requests under $500" });
  assert.equal(routeSmart("help me find the cheapest flight").kind, "goal");
  assert.deepEqual(routeSmart("fill the form with name Alex, role admin"), { kind: "fill", spec: "name Alex, role admin" });
  // no values given, or more to do than filling: a task for the agent, not the one-shot fill
  for (const t of ["fill the form and submit for approval", "fill the form", "fill in the form with dummy data", "fill out this form with name Alex then save"])
    assert.deepEqual(routeSmart(t), { kind: "goal", goal: t }, t);
  for (const t of ["go to wikipedia", "click the first result", "search for what is love", "open youtube, theo t3.gg's channel"]) assert.equal(routeSmart(t), null, t);
});

test("goal steps become executor actions; unknown element ids are rejected", () => {
  const snap = { elements: [{ id: "e05", role: "button", text: "Approve" }] };
  assert.deepEqual(toAction({ action: { type: "click", element_id: "e05" } }, snap).action, { type: "click_element", targetId: "e05", label: 'button "Approve"' });
  assert.match(toAction({ action: { type: "click", element_id: "e99" } }, snap).error, /not on the page/);
  assert.equal(toAction({ action: { type: "navigate", url: "localhost:3000/x" } }, snap).action.url, "http://localhost:3000/x");
});

import { parseTabMention, matchTab } from "../../src/tabs.js";

test("tab mentions: switch, then run the rest; emails are not mentions", () => {
  assert.deepEqual(parseTabMention("Go to @[Bills - Acme Books] and create a new bill with dummy data."), { query: "Bills - Acme Books", rest: "create a new bill with dummy data." });
  assert.deepEqual(parseTabMention("switch to @[Bills - Acme Books]"), { query: "Bills - Acme Books", rest: "" });
  assert.equal(parseTabMention("create a new bill in @[Bills - Acme Books] tab with dummy data").rest, "create a new bill with dummy data");
  assert.equal(parseTabMention("in @[Bills - Acme Books], how many bills are overdue?").rest, "how many bills are overdue?");
  assert.equal(parseTabMention("type alex@example.com into the email field"), null);
  const tabs = [{ title: "Purchase requests - Acme Books", url: "http://localhost:3000/p" }, { title: "Bills - Acme Books", url: "http://localhost:3000/bills" }];
  assert.equal(matchTab(tabs, "Bills - Acme Books").title, "Bills - Acme Books");
  assert.equal(matchTab(tabs, "bills").title, "Bills - Acme Books");
  assert.equal(matchTab(tabs, "nope"), null);
});

test("outcome-style tasks route to goals", () => {
  assert.equal(routeSmart("create a new bill with dummy data").kind, "goal");
  assert.equal(routeSmart("add a supplier called Acme").kind, "goal");
  assert.equal(routeSmart("click add"), null);
});
