import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.VB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vb-trace-"));
const { mayHaveItems, checklistText, stepFromCall } = await import("../../src/smart.js");
const { compactElements } = await import("../../src/snapshot.js");
const { encodeElement } = await import("../../src/jev.js");
const { TaskTrace, logLine, logsDir } = await import("../../src/tracelog.js");

test("multi-item goals get a checklist; single things don't", () => {
  assert.equal(mayHaveItems("Add videos by Trevor Noah, Dave Chappelle and Kevin Hart to the queue"), true);
  assert.equal(mayHaveItems("create 3 bills with dummy data"), true);
  assert.equal(mayHaveItems("play the next video"), false);
  assert.equal(checklistText([], []), "");
  assert.match(checklistText(["Trevor Noah video", "Kevin Hart video"], ["Kevin Hart video"]), /\[ \] Trevor Noah video\n {2}\[x\] Kevin Hart video/);
  assert.deepEqual(stepFromCall({ name: "item_done", args: { item: "Kevin Hart video", description: "tick" } }), { status: "item_done", summary: "", description: "tick", item: "Kevin Hart video", risky: false });
});

test("an open menu's items come first in the element list, marked", () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ id: `e${i}`, role: "link", text: `video ${i}`, inViewport: true, top: i * 10, left: 0 }));
  const menu = { id: "e999", role: "menuitem", text: "Add to queue", inViewport: true, popup: true, top: 5000, left: 0 };
  const out = compactElements([...many, menu], { maxElements: 100 });
  assert.equal(out[0].id, "e999");
  assert.equal(out[0].in_menu, true);
  assert.equal(encodeElement(out[0]), 'e999 menuitem "Add to queue" [in open menu]');
});

test("traces: one JSON file per task, a daily log of every line", () => {
  const t = new TaskTrace("Add Kevin Hart to the queue", { startUrl: "https://example.com" });
  t.add("step", { ok: true, said: ["Added to Queue"] });
  t.end("done", "Added it.");
  const files = fs.readdirSync(path.join(logsDir(), "tasks"));
  assert.equal(files.length, 1);
  assert.match(files[0], /add-kevin-hart-to-the-queue\.json$/);
  const d = JSON.parse(fs.readFileSync(path.join(logsDir(), "tasks", files[0]), "utf8"));
  assert.equal(d.status, "done");
  assert.deepEqual(d.events[0].said, ["Added to Queue"]);
  logLine({ t: Date.now(), level: "act", msg: "✓ click", url: "x" });
  const log = fs.readdirSync(logsDir()).find((f) => f.startsWith("agent-"));
  assert.match(fs.readFileSync(path.join(logsDir(), log), "utf8"), /act {3}✓ click {"url":"x"}/);
});

test("video commands run without the AI; anything else goes to the agent", async () => {
  const { parseMedia, stateText } = await import("../../src/media.js");
  const { toAction } = await import("../../src/smart.js");
  assert.deepEqual(parseMedia("move back 10 seconds and play"), [{ op: "seek_by", seconds: -10 }, { op: "play" }]);
  assert.deepEqual(parseMedia("skip ahead 1 minute"), [{ op: "seek_by", seconds: 60 }]);
  assert.deepEqual(parseMedia("go to 2:15"), [{ op: "seek_to", seconds: 135 }]);
  assert.deepEqual(parseMedia("speed 1.5x"), [{ op: "speed", rate: 1.5 }]);
  assert.deepEqual(parseMedia("go back 10 seconds, then pause"), [{ op: "seek_by", seconds: -10 }, { op: "pause" }]);
  for (const t of ["play the next video", "move back to the previous page", "skip this ad", "play despacito"]) assert.equal(parseMedia(t), null, t);
  // Chat: bare words belong to the conversation ("continue" after a stopped task), not the video
  for (const t of ["continue", "Continue.", "stop", "play", "resume", "pause", "please continue"]) assert.equal(parseMedia(t, { strict: true }), null, t);
  for (const t of ["go back 10 seconds", "go to 2:15", "speed 1.5x", "pause the video", "continue playing the song", "mute"]) assert.ok(parseMedia(t, { strict: true }), t);
  assert.deepEqual(parseMedia("continue"), [{ op: "play" }], "Direct mode keeps the short form");
  assert.equal(stateText({ time: 73, duration: 602, paused: false, rate: 1, muted: false }), "1:13 / 10:02, playing");
  assert.deepEqual(toAction(stepFromCall({ name: "video_control", args: { op: "seek_by", seconds: -10 } })).action, { type: "media", actions: [{ op: "seek_by", seconds: -10 }], label: "video back 10s" });
});
