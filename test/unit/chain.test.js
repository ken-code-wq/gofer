import test from "node:test";
import assert from "node:assert/strict";
import { splitChain, planChain } from "../../src/chain.js";

test("comma chain with a verbless step: search, then click the match", () => {
  assert.deepEqual(planChain("open youtube, theo t3.gg's channel"), [
    "open youtube",
    "search for theo t3.gg's channel",
    "click theo t3.gg's channel",
  ]);
});

test("then / and then / and + verb split; plain and does not", () => {
  assert.deepEqual(splitChain("go to wikipedia then search for alan turing and then click the first result"), [
    "go to wikipedia",
    "search for alan turing",
    "click the first result",
  ]);
  assert.deepEqual(splitChain("go to example dot com and click the more information link"), ["go to example dot com", "click the more information link"]);
  assert.deepEqual(splitChain("search youtube for cats and dogs"), ["search youtube for cats and dogs"]);
  assert.deepEqual(splitChain("click save and close"), ["click save and close"]);
});

test("single command is not a chain", () => {
  assert.deepEqual(planChain("search for alan turing"), []);
  assert.deepEqual(planChain("go to example dot com and"), []);
});

test("quoted text is never split; apostrophes are not quotes", () => {
  assert.deepEqual(splitChain(`go to duckduckgo, type "salt, pepper" into the search box, press enter`), [
    "go to duckduckgo",
    `type "salt, pepper" into the search box`,
    "press enter",
  ]);
  assert.deepEqual(splitChain("open bob's page, then click jane's link"), ["open bob's page", "click jane's link"]);
});

test("verbless step that names an element becomes a click", () => {
  assert.deepEqual(planChain("search for lofi beats, the first result"), ["search for lofi beats", "click the first result"]);
  assert.deepEqual(planChain("go to github, the explore link"), ["go to github", "click the explore link"]);
});

test("click on a field + type merges into one targeted type step", () => {
  assert.deepEqual(
    planChain("go to localhost:3000/login, click on email and type alex@example.com, click on Password and type S3cret!pass, press enter"),
    ["go to localhost:3000/login", "type alex@example.com into the email field", "type S3cret!pass into the Password field", "press enter"],
  );
  // an explicit destination is left alone
  assert.deepEqual(planChain("click the search box, type cats into the search box"), ["click the search box", "type cats into the search box"]);
});
