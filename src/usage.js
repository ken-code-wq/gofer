/**
 * Spend meter: every model call (SubQ Snap / Jev and the brain) is added to a daily total in
 * ~/.voice-browser/usage.json. An optional daily limit stops new model calls once reached.
 *
 * Brain prices are list prices per million tokens (input / output) and only an estimate: free
 * tiers (e.g. a free Gemini key) cost nothing. BRAIN_PRICE_IN / BRAIN_PRICE_OUT override them.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./store.js";

const PRICES = [
  [/gemini-[\d.]+-flash-lite/, 0.1, 0.4],
  [/gemini-[\d.]+-flash/, 0.3, 2.5],
  [/glm-[\d.]+-flash/, 0.06, 0.4],
  [/deepseek/, 0.27, 1.1],
  [/gpt-oss-120b/, 0.15, 0.6],
  [/gpt-oss-20b/, 0.075, 0.3],
  [/qwen3\.8-27b/, 0.8, 4.0],
];
const KEEP_DAYS = 60;

export const usageEvents = new EventEmitter();
const FILE = () => path.join(DATA_DIR, "usage.json");
const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

let cache = null;
function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE(), "utf8"));
  } catch {
    cache = {};
  }
  cache.days ??= {};
  cache.limitUsd ??= null;
  return cache;
}
function save() {
  const d = load();
  const keys = Object.keys(d.days).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete d.days[k];
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(`${FILE()}.tmp`, JSON.stringify(d, null, 2));
    fs.renameSync(`${FILE()}.tmp`, FILE());
  } catch {
    /* the meter must never break a command */
  }
}

/** USD for a brain call, from the provider's token counts (Gemini or OpenAI style). */
export function brainCost(model, usage = {}) {
  const inTok = usage.promptTokenCount ?? usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const outTok = (usage.candidatesTokenCount ?? usage.completion_tokens ?? usage.output_tokens ?? 0) + (usage.thoughtsTokenCount ?? 0);
  const envIn = Number(process.env.BRAIN_PRICE_IN), envOut = Number(process.env.BRAIN_PRICE_OUT);
  const hit = PRICES.find(([re]) => re.test(String(model)));
  const pin = Number.isFinite(envIn) && process.env.BRAIN_PRICE_IN ? envIn : hit?.[1] ?? 0;
  const pout = Number.isFinite(envOut) && process.env.BRAIN_PRICE_OUT ? envOut : hit?.[2] ?? 0;
  return { usd: (inTok * pin + outTok * pout) / 1e6, inTok, outTok };
}

export function record({ source, model, usd = 0, inTok = 0, outTok = 0 }) {
  const d = load();
  const day = (d.days[today()] ??= { usd: 0, calls: 0, byModel: {} });
  day.usd += usd;
  day.calls += 1;
  const m = (day.byModel[model || source] ??= { usd: 0, calls: 0, inTok: 0, outTok: 0 });
  m.usd += usd;
  m.calls += 1;
  m.inTok += inTok;
  m.outTok += outTok;
  save();
  usageEvents.emit("change", summary());
}

export function summary() {
  const d = load();
  const day = d.days[today()] || { usd: 0, calls: 0, byModel: {} };
  const week = Object.entries(d.days)
    .filter(([k]) => k > today(new Date(Date.now() - 7 * 864e5)))
    .reduce((a, [, v]) => a + v.usd, 0);
  return { todayUsd: day.usd, calls: day.calls, byModel: day.byModel, weekUsd: week, limitUsd: d.limitUsd };
}

export function setLimit(usd) {
  const n = Number(usd);
  load().limitUsd = Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
  save();
  usageEvents.emit("change", summary());
  return summary();
}

export class LimitError extends Error {}

/** Throws before a model call when today's limit is used up. */
export function checkLimit() {
  const s = summary();
  if (s.limitUsd != null && s.todayUsd >= s.limitUsd) {
    throw new LimitError(`Today's spending limit ($${s.limitUsd.toFixed(2)}) is reached. Raise it from the spend meter at the bottom of the bar.`);
  }
}

/** Tests: forget the in-memory copy. */
export function _reset() {
  cache = null;
}
