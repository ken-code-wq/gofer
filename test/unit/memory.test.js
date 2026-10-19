import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.VB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vb-memory-"));
const { parseMemoryCommand, rememberFact, forgetFacts, listFacts, saveChats, flushChats, loadChats } = await import("../../src/memory.js");

test("memory commands", () => {
  assert.deepEqual(parseMemoryCommand("remember that my work email is ken@acme.com"), { kind: "remember", text: "my work email is ken@acme.com" });
  assert.deepEqual(parseMemoryCommand("what do you remember?"), { kind: "list" });
  assert.deepEqual(parseMemoryCommand("forget my work email"), { kind: "forget", text: "my work email" });
  assert.equal(parseMemoryCommand("open youtube"), null);
  assert.equal(parseMemoryCommand("remembering the titans trailer"), null);
});

test("facts are kept once and can be forgotten", () => {
  rememberFact("my work email is ken@acme.com.");
  rememberFact("My work email is ken@acme.com");
  rememberFact("I prefer dark mode");
  assert.deepEqual(listFacts(), ["My work email is ken@acme.com", "I prefer dark mode"]);
  assert.equal(forgetFacts("my work email"), 1);
  assert.deepEqual(listFacts(), ["I prefer dark mode"]);
});

test("chats survive a restart, without the tab they used", () => {
  const threads = new Map([["c1", { turns: [{ role: "user", text: "play a song" }, { role: "result", text: "goal done: played X" }], page: { fake: true } }]]);
  saveChats(threads);
  flushChats();
  assert.deepEqual(loadChats(), { c1: threads.get("c1").turns });
});

test("'another one' and its variants", async () => {
  const { isAnotherOne } = await import("../../src/controller.js");
  for (const t of ["another one", "no please, another one", "No, another one please", "a different one", "play another song", "something else", "next one", "one more", "not that one", "give me another"])
    assert.equal(isAnotherOne(t), true, t);
  for (const t of ["open another tab", "another tab", "play the next video in the playlist", "open youtube", "another window"])
    assert.equal(isAnotherOne(t), false, t);
});
