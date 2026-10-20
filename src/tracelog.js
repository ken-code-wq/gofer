/**
 * What the agent did, on disk, so its mistakes can be looked at afterwards:
 *
 *   ~/.voice-browser/logs/agent-YYYY-MM-DD.log     every log line (what you'd see in the activity log)
 *   ~/.voice-browser/logs/tasks/<time>-<goal>.json one file per task: each step with what the model was
 *                                                  shown, what it chose, and what happened
 *
 * Kept for 7 days. Only on this Mac; passwords never appear (the models only see {{placeholders}}).
 * VB_TRACE=0 turns it off.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./store.js";

const KEEP_DAYS = 7;
const on = () => process.env.VB_TRACE !== "0";
export const logsDir = () => path.join(DATA_DIR, "logs");
const tasksDir = () => path.join(logsDir(), "tasks");
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const stamp = (t) => new Date(t).toISOString().replace(/[:.]/g, "-").slice(0, 19);

let pruned = false;
function prune() {
  if (pruned) return;
  pruned = true;
  const cutoff = Date.now() - KEEP_DAYS * 86400_000;
  for (const dir of [logsDir(), tasksDir()]) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      const f = path.join(dir, n);
      try {
        const st = fs.statSync(f);
        if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(f);
      } catch {}
    }
  }
}

/** Append one activity-log entry ({ t, level, msg }) to today's file. */
export function logLine(entry) {
  if (!on()) return;
  try {
    fs.mkdirSync(logsDir(), { recursive: true });
    prune();
    const extra = Object.keys(entry).filter((k) => !["t", "level", "msg"].includes(k));
    const tail = extra.length ? ` ${JSON.stringify(Object.fromEntries(extra.map((k) => [k, entry[k]])))}` : "";
    fs.appendFileSync(path.join(logsDir(), `agent-${day(entry.t)}.log`), `${new Date(entry.t).toISOString()} ${String(entry.level).padEnd(5)} ${entry.msg}${tail}\n`);
  } catch {}
}

const slug = (s) => String(s || "task").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "task";

/**
 * One task's trace. `add()` records an event; the file is rewritten after each one (small, and a
 * crash mid-task still leaves the steps so far).
 */
export class TaskTrace {
  constructor(goal, meta = {}) {
    this.data = { goal, started: new Date().toISOString(), ...meta, events: [] };
    this.file = on() ? path.join(tasksDir(), `${stamp(Date.now())}-${slug(goal)}.json`) : null;
    this._save();
  }

  add(type, fields = {}) {
    this.data.events.push({ at: new Date().toISOString(), type, ...fields });
    this._save();
  }

  end(status, summary = "") {
    Object.assign(this.data, { ended: new Date().toISOString(), status, summary });
    this._save();
  }

  _save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(tasksDir(), { recursive: true });
      prune();
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1));
    } catch {}
  }
}
