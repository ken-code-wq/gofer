/**
 * The "brain": the models for the jobs SubQ Snap can't do (it only picks options): planning goals
 * step by step, answering questions, filling forms, rewriting follow-ups.
 *
 * Several providers at once, each with its own key in .env:
 *   GROQ_API_KEY        Groq: GPT-OSS 120B / 20B (text, very fast), Qwen 3.8 27B (reads screenshots)
 *   GEMINI_API_KEY      Google Gemini Flash-Lite (reads screenshots; BRAIN_MODELS sets the order)
 *   ZAI_API_KEY         Z.ai GLM 5.3 Flash (reads screenshots)
 *   DEEPSEEK_API_KEY    DeepSeek (text)
 *   OPENROUTER_API_KEY  OpenRouter (OPENROUTER_MODEL, default z-ai/glm-5.3-flash)
 *   BRAIN_PROVIDER + BRAIN_API_KEY (+ BRAIN_MODEL / BRAIN_BASE_URL / BRAIN_VISION): the older single
 *   provider setting, still honoured and tried first.
 *
 * "Auto" picks per job: with a screenshot, models that can read it come first; text-only jobs go
 * to the fastest text model. You can pin one model instead (setPreferred); the rest stay as
 * fallbacks. A model that hits a rate limit rests for as long as the provider says (Retry-After),
 * so a busy model hands the next request to another one instead of failing.
 * Every answer is a JSON object matching the caller's schema.
 */

import fs from "node:fs";
import path from "node:path";
import { brainCost, record, checkLimit } from "./usage.js";
import { DATA_DIR } from "./store.js";

const TIMEOUT_MS = Number(process.env.BRAIN_TIMEOUT_MS) || 12000; // per attempt; a healthy call takes ~0.5-3 s

export const GEMINI_MODELS = (process.env.BRAIN_MODELS || "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-2.5-flash-lite")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const BRAIN_MODELS = GEMINI_MODELS; // (older name)

// Groq's reasoning models think a little ("low"); Qwen answers straight away ("none").
const GROQ = "https://api.groq.com/openai/v1";
export const PROVIDERS = {
  groq: {
    label: "Groq",
    env: "GROQ_API_KEY",
    keyUrl: "https://console.groq.com/keys",
    models: () => [
      { model: "openai/gpt-oss-120b", label: "GPT-OSS 120B", baseURL: GROQ, fast: true, vision: false, json: "json_object", extra: { reasoning_effort: "low" } },
      { model: "qwen/qwen3.8-27b", label: "Qwen 3.8 27B", baseURL: GROQ, fast: true, vision: true, json: "json_object", extra: { reasoning_effort: "none" } },
      { model: "openai/gpt-oss-20b", label: "GPT-OSS 20B", baseURL: GROQ, fast: true, vision: false, json: "json_object", extra: { reasoning_effort: "low" } },
    ],
  },
  gemini: {
    label: "Google Gemini",
    env: "GEMINI_API_KEY",
    keyUrl: "https://aistudio.google.com/apikey",
    models: () => GEMINI_MODELS.map((m) => ({ kind: "gemini", model: m, label: m.replace(/^gemini-/, "Gemini ").replace(/-flash-lite$/, " Flash-Lite").replace(/-flash$/, " Flash"), vision: true })),
  },
  zai: {
    label: "Z.ai",
    env: "ZAI_API_KEY",
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
    // GLM 5.3 Flash is a vision model: Z.ai only offers response_format for text models, so JSON is asked for in the prompt.
    models: () => [{ model: "glm-5.3-flash", label: "GLM 5.3 Flash", baseURL: "https://api.z.ai/api/paas/v4", vision: true, json: "prompt", extra: { thinking: { type: "disabled" } } }],
  },
  deepseek: {
    label: "DeepSeek",
    env: "DEEPSEEK_API_KEY",
    keyUrl: "https://platform.deepseek.com/api_keys",
    models: () => [{ model: "deepseek-chat", label: "DeepSeek", baseURL: "https://api.deepseek.com", vision: false, json: "json_object" }],
  },
  openrouter: {
    label: "OpenRouter",
    env: "OPENROUTER_API_KEY",
    keyUrl: "https://openrouter.ai/settings/keys",
    models: () => {
      const m = process.env.OPENROUTER_MODEL || "z-ai/glm-5.3-flash";
      return [{ model: m, label: m.split("/").pop(), baseURL: "https://openrouter.ai/api/v1", vision: process.env.OPENROUTER_VISION ? process.env.OPENROUTER_VISION === "1" : true, json: "json_schema" }];
    },
  },
};

// The older single-provider setting (BRAIN_PROVIDER + BRAIN_API_KEY).
const PRESETS = {
  zai: { baseURL: "https://api.z.ai/api/paas/v4", model: "glm-5.3-flash", vision: true, json: "prompt", extra: { thinking: { type: "disabled" } } },
  deepseek: { baseURL: "https://api.deepseek.com", model: "deepseek-chat", vision: false, json: "json_object" },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", model: "z-ai/glm-5.3-flash", vision: true, json: "json_schema" },
  groq: { baseURL: GROQ, model: "openai/gpt-oss-120b", vision: false, json: "json_object", extra: { reasoning_effort: "low" } },
  custom: { baseURL: "", model: "", vision: false, json: "json_object" },
};

/** The provider set with BRAIN_PROVIDER / BRAIN_API_KEY, or null. */
export function primaryProvider() {
  const name = (process.env.BRAIN_PROVIDER || "").toLowerCase();
  const key = process.env.BRAIN_API_KEY;
  if (!name || !key || !PRESETS[name]) return null;
  const p = PRESETS[name];
  const vision = process.env.BRAIN_VISION ? process.env.BRAIN_VISION === "1" : p.vision;
  const baseURL = (process.env.BRAIN_BASE_URL || p.baseURL).replace(/\/+$/, "");
  const model = process.env.BRAIN_MODEL || p.model;
  if (!baseURL || !model) return null;
  return { kind: "openai", provider: name, name, id: `${name}:${model}`, label: model, baseURL, model, key, vision, json: process.env.BRAIN_JSON || p.json, extra: p.extra || {} };
}

/** Every model there's a key for, in Auto order. */
export function allModels() {
  const out = [];
  const p = primaryProvider();
  if (p) out.push(p);
  for (const [name, prov] of Object.entries(PROVIDERS)) {
    const key = process.env[prov.env];
    if (!key) continue;
    for (const m of prov.models()) {
      const id = `${name}:${m.model}`;
      if (out.some((c) => c.id === id)) continue;
      out.push({ kind: "openai", extra: {}, ...m, provider: name, id, key });
    }
  }
  return out;
}

export function hasBrain() {
  return allModels().length > 0;
}

// ── the model you picked ("auto" = choose per job) ─────────────

const PREFS = () => path.join(DATA_DIR, "brain.json");
let preferred = null;
export function getPreferred() {
  if (preferred === null) {
    try {
      preferred = JSON.parse(fs.readFileSync(PREFS(), "utf8")).preferred || "auto";
    } catch {
      preferred = "auto";
    }
  }
  return preferred;
}
export function setPreferred(id) {
  preferred = id && id !== "auto" && allModels().some((c) => c.id === id) ? id : "auto";
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PREFS(), JSON.stringify({ preferred }));
  } catch {}
  return preferred;
}

// ── resting models: rate limited, timed out, failing ────────────

const resting = new Map(); // id -> { until, reason }
function rest(id, ms, reason) {
  resting.set(id, { until: Date.now() + ms, reason });
}
const isResting = (id) => (resting.get(id)?.until || 0) > Date.now();

/**
 * Models to try for one request, best first. Fast models (Groq, under a second) come before slow
 * ones; with a screenshot, a fast model that can read it goes first, then the other fast models
 * (they still get the page text), then the slower ones that read screenshots. Groq's free tier
 * allows few tokens a minute per model, so spreading requests over its models keeps things quick.
 * The picked model, if any, always goes first.
 */
export function modelsToTry({ images = false } = {}) {
  const all0 = allModels();
  const tier = (c) => (c.fast ? 0 : 2) + (images && !c.vision ? 1 : 0) - (images && c.fast && c.vision ? 1 : 0);
  let all = all0.map((c, i) => [c, i]).sort((a, b) => tier(a[0]) - tier(b[0]) || a[1] - b[1]).map(([c]) => c);
  const pick = getPreferred();
  const pinned = all.find((c) => c.id === pick);
  if (pinned) all = [pinned, ...all.filter((c) => c !== pinned)];
  const ready = all.filter((c) => !isResting(c.id));
  return ready.length ? ready : all; // everything resting: try them all anyway
}

/** For the model picker: every model there's a key for, plus providers you could add. */
export function listModels() {
  const models = allModels().map((c) => ({
    id: c.id,
    label: c.label || c.model,
    provider: PROVIDERS[c.provider]?.label || c.provider,
    providerId: c.provider,
    vision: Boolean(c.vision),
    fast: Boolean(c.fast),
    resting: isResting(c.id) ? resting.get(c.id).reason : null,
  }));
  const missing = Object.entries(PROVIDERS)
    .filter(([, p]) => !process.env[p.env])
    .map(([name, p]) => ({ name, label: p.label, env: p.env, keyUrl: p.keyUrl }));
  return { preferred: getPreferred(), models, missing, last: lastModel };
}

let lastModel = null;

export class BrainError extends Error {}

/** The JSON object in a model reply (tolerates ```json fences and text around it). */
export function parseJsonReply(txt) {
  const s = String(txt || "").replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(s);
  } catch {}
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(s.slice(start, end + 1));
  throw new Error("no JSON object in the reply");
}

const timeoutSignal = (signal) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS));
const retryAfterMs = (res) => {
  const h = res.headers.get("retry-after");
  const s = Number(h);
  if (Number.isFinite(s) && s > 0) return Math.min(s * 1000, 15 * 60 * 1000);
  const when = h && Date.parse(h);
  return when ? Math.max(1000, when - Date.now()) : null;
};

// ── Gemini ────────────────────────────────────────────────────

// Gemini 2.5 turns thinking off with a zero budget; 3.x models take a level, "minimal" being the lowest.
const thinkingFor = (model) => (model.startsWith("gemini-2.5") ? { thinkingBudget: 0 } : { thinkingLevel: "minimal" });

async function callGemini(c, { system, text, images, schema, signal }) {
  const parts = [...images.map((buf) => ({ inline_data: { mime_type: "image/jpeg", data: buf.toString("base64") } })), { text }];
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${c.model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": c.key, "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema, temperature: 0, thinkingConfig: thinkingFor(c.model) },
    }),
    signal: timeoutSignal(signal),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return { status: res.status, error: d.error?.message?.split("\n")[0] || res.statusText, retryAfter: retryAfterMs(res) };
  return { text: (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join(""), usage: d.usageMetadata || {} };
}

// ── OpenAI-compatible (Groq, Z.ai, DeepSeek, OpenRouter, …) ───

async function callOpenAI(c, { system, text, images, schema, signal }, retryNote = "") {
  const sys = `${system}\n\nReply with ONLY a JSON object (no prose, no code fences) that matches this JSON Schema:\n${JSON.stringify(schema)}`;
  const useImages = c.vision && images.length;
  const userContent = useImages
    ? [{ type: "text", text: text + retryNote }, ...images.map((buf) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${buf.toString("base64")}` } }))]
    : text + retryNote;
  const body = { model: c.model, messages: [{ role: "system", content: sys }, { role: "user", content: userContent }], temperature: 0, max_tokens: 2048, ...c.extra };
  if (c.json === "json_object") body.response_format = { type: "json_object" };
  if (c.json === "json_schema") body.response_format = { type: "json_schema", json_schema: { name: "answer", schema, strict: false } };
  const res = await fetch(`${c.baseURL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${c.key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: timeoutSignal(signal),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return { status: res.status, error: (d.error?.message || d.message || res.statusText || "").toString().split("\n")[0], retryAfter: retryAfterMs(res) };
  return { text: d.choices?.[0]?.message?.content || "", usage: d.usage || {} };
}

/**
 * @param {{system: string, text: string, images?: Buffer[], schema: object, signal?: AbortSignal}} req
 * @returns {Promise<{data: any, model: string, modelId: string, ms: number, usage: object}>}
 */
export async function ask(req) {
  checkLimit();
  const r = await askAny(req);
  const cost = brainCost(r.model, r.usage);
  record({ source: "brain", model: r.model, ...cost });
  return { ...r, costUsd: cost.usd };
}

async function askAny({ system, text, images = [], schema, signal }) {
  const list = modelsToTry({ images: images.length > 0 });
  if (!list.length) throw new BrainError("No AI model is set up. Add a key (GROQ_API_KEY, GEMINI_API_KEY, …) to .env, or use ⋯ → AI models in the panel.");
  let lastErr = null;
  let quota = false;
  for (const c of list) {
    const t0 = Date.now();
    const call = c.kind === "gemini" ? callGemini : callOpenAI;
    let r;
    try {
      r = await call(c, { system, text, images, schema, signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = new BrainError(`${c.id}: ${err.name === "TimeoutError" ? "timed out" : err.message}`);
      console.warn(`brain: ${c.id} ${err.name === "TimeoutError" ? "timed out" : err.message} after ${Date.now() - t0}ms`);
      rest(c.id, 60_000, err.name === "TimeoutError" ? "slow to answer" : "unreachable");
      continue;
    }
    if (r.error) {
      lastErr = new BrainError(`${c.id}: ${r.status} ${r.error}`);
      console.warn(`brain: ${c.id} ${r.status} after ${Date.now() - t0}ms: ${String(r.error).slice(0, 160)}${r.retryAfter ? ` (retry in ${Math.round(r.retryAfter / 1000)}s)` : ""}`);
      if (r.status === 429 || r.status === 402) {
        quota = true;
        rest(c.id, r.retryAfter ?? (r.status === 402 ? 30 * 60_000 : 30_000), r.status === 402 ? "out of credit" : "rate limited");
        continue;
      }
      if (r.status === 401 || r.status === 403) {
        rest(c.id, 30 * 60_000, "key not accepted");
        continue;
      }
      if (r.status === 404) {
        rest(c.id, 30 * 60_000, "model not available");
        continue;
      }
      if (r.status === 413 || (r.status === 400 && /too large|context|tokens/i.test(r.error))) continue; // too big for this one; try the next
      if (r.status >= 500) {
        rest(c.id, 60_000, "provider busy");
        continue;
      }
      throw lastErr;
    }
    try {
      const data = parseJsonReply(r.text);
      if (process.env.VB_BRAIN_LOG !== "0") console.log(`brain: ${c.id} ok in ${Date.now() - t0}ms (${r.usage?.prompt_tokens ?? r.usage?.promptTokenCount ?? "?"} in)`);
      lastModel = { id: c.id, label: c.label || c.model };
      return { data, model: c.model, modelId: c.id, modelLabel: c.label || c.model, ms: Date.now() - t0, usage: r.usage };
    } catch {
      // one retry with a reminder, for models that wrap or truncate JSON
      if (c.kind !== "gemini") {
        try {
          const r2 = await callOpenAI(c, { system, text, images, schema, signal }, "\n\n(Your previous reply was not a valid JSON object. Reply with the JSON object only.)");
          if (!r2.error) {
            const data = parseJsonReply(r2.text);
            lastModel = { id: c.id, label: c.label || c.model };
            return { data, model: c.model, modelId: c.id, modelLabel: c.label || c.model, ms: Date.now() - t0, usage: r2.usage };
          }
        } catch {}
      }
      lastErr = new BrainError(`${c.id}: answer wasn't valid JSON`);
    }
  }
  if (quota && /\b(429|402)\b/.test(lastErr?.message || "")) {
    throw new BrainError("Every AI model is at its limit right now. Try again in a minute, or add another provider's key (⋯ → AI models).");
  }
  throw lastErr || new BrainError("No AI model available");
}
