import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-store-"));
process.env.VB_DATA_DIR = dir;
const { saveCommand, listCommands, deleteCommand, resolveSaved, normalizeName } = await import("../../src/store.js");

test("save, resolve by name or 'run name', delete", () => {
  saveCommand("Login Dev", "go to localhost:3000/login, type {{dev-email}} into the email field");
  assert.equal(normalizeName("Login Dev"), "login-dev");
  assert.equal(listCommands().length, 1);
  assert.equal(resolveSaved("login-dev").text.startsWith("go to localhost"), true);
  assert.equal(resolveSaved("run login-dev").name, "login-dev");
  assert.equal(resolveSaved("go to login-dev"), null);
  saveCommand("login-dev", "go to example dot com"); // overwrite
  assert.equal(listCommands().length, 1);
  assert.equal(resolveSaved("login-dev").text, "go to example dot com");
  deleteCommand("login-dev");
  assert.equal(listCommands().length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rejects empty names and text", () => {
  assert.throws(() => saveCommand("", "go"), /name/);
  assert.throws(() => saveCommand("x", " "), /Nothing/);
});
