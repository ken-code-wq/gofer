import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { parseCurrentTab } from "../../src/tabs.js";
import { BrowserManager } from "../../src/browser.js";

test("phrases that mean the tab you're on", () => {
  const rest = (t) => parseCurrentTab(t)?.rest;
  assert.equal(rest("in the current tab, play the next video"), "play the next video");
  assert.equal(rest("pause the video in the active tab"), "pause the video");
  assert.equal(rest("in this tab click subscribe"), "click subscribe");
  assert.equal(rest("search for lofi on the tab I'm on"), "search for lofi");
  assert.equal(rest("in my open tab scroll down"), "scroll down");
  assert.equal(rest("summarize the page in the currently open tab"), "summarize the page");
  assert.equal(rest("copy the url of the active tab"), "copy the url");
  assert.equal(rest("in the focused window click play"), "click play");
  assert.equal(rest("use the current tab and like it"), "like it");
  assert.equal(rest("here, like this video"), "like this video");
  assert.equal(rest("use the current tab"), "");
  assert.equal(rest("what's on this page"), "what's on this page");
  assert.equal(parseCurrentTab("open the youtube tab"), null);
  assert.equal(parseCurrentTab("here is my note"), null);
  assert.equal(parseCurrentTab("click login"), null);
});

// Needs a real window (headless tabs never get focus), so it runs on a Mac, not in CI.
test("follows the tab you switch to, but not while a goal runs", { timeout: 60000, skip: process.env.CI || process.platform !== "darwin" }, async () => {
  const port = 9900 + Math.floor(Math.random() * 90);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-follow-"));
  const proc = spawn(chromium.executablePath(), [`--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "--window-position=-3000,-3000", "about:blank"], { stdio: "ignore" });
  const J = (p, method = "GET") => fetch(`http://127.0.0.1:${port}${p}`, { method }).then((r) => r.json());
  const b = new BrowserManager();
  try {
    for (let i = 0; i < 50; i++) { try { await J("/json/version"); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
    const open = (title) => J("/json/new?" + encodeURIComponent(`data:text/html,<title>${title}</title>`), "PUT");
    const yt = await open("YouTube");
    const bills = await open("Bills");
    const sw = async (t) => { await fetch(`http://127.0.0.1:${port}/json/activate/${t.id}`); await new Promise((r) => setTimeout(r, 800)); };
    await sw(yt);
    await b.launch({ cdp: `http://127.0.0.1:${port}`, startUrl: null });
    const cur = () => b.page.title();
    await sw(bills);
    assert.equal(await cur(), "Bills");
    await sw(yt);
    assert.equal(await cur(), "YouTube");
    b.canFollow = () => false;
    await sw(bills);
    assert.equal(await cur(), "YouTube");
  } finally {
    await b.close();
    proc.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
