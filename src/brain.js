/**
 * The "brain": a small, fast model for the jobs SubQ Snap can't do (it only picks options):
 * planning goals step by step, answering questions about a page, filling forms.
 *
 * Providers, tried in order (a provider that times out, runs out of quota or is overloaded is
 * skipped for 5 minutes):
 *   1. BRAIN_PROVIDER (+ BRAIN_API_KEY), any OpenAI-compatible chat API:
 *        zai        GLM 5.3 Flash  (vision; thinking off)          https://api.z.ai/api/paas/v4
 *        deepseek   DeepSeek Flash (text only unless BRAIN_VISION=1) https://api.deepseek.com
 *        openrouter any OpenRouter model (default z-ai/glm-5.3-flash) https://openrouter.ai/api/v1
 *        custom     BRAIN_BASE_URL + BRAIN_MODEL
 *      BRAIN_MODEL / BRAIN_BASE_URL / BRAIN_VISION override a preset.
 *   2. Google Gemini Flash-Lite (free AI Studio key, GEMINI_API_KEY), BRAIN_MODELS order.
 * Every answer is a JSON object matching the caller's schema.
 */

const TIMEOUT_MS = Number(process.env.BRAIN_TIMEOUT_MS) || 12000; // per attempt; a healthy call takes ~1-3 s
const COOLDOWN_MS = 5 * 60 * 1000;

export const GEMINI_MODELS = (process.env.BRAIN_MODELS || "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-2.5-flash-lite")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const BRAIN_MODELS = GEMINI_MODELS; // (older name)

const PRESETS = {
  // GLM 5.3 Flash is a vision model: Z.ai only offers response_format for text models, so JSON is asked for in the prompt.
  zai: { baseURL: "https://api.z.ai/api/paas/v4", model: "glm-5.3-flash", vision: true, json: "prompt", extra: { thinking: { type: "disabled" } } },
  deepseek: { baseURL: "https://api.deepseek.com", model: "deepseek-chat", vision: false, json: "json_object" },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", model: "z-ai/glm-5.3-flash", vision: true, json: "json_schema" },
  custom: { baseURL: "", model: "", vision: false, json: "json_object" },
};

/** The OpenAI-compatible provider configured in the environment, or null. */
export function primaryProvider() {
  const name = (process.env.BRAIN_PROVIDER || "").toLowerCase();
  const key = process.env.BRAIN_API_KEY;
  if (!name || !key || !PRESETS[name]) return null;
  const p = PRESETS[name];
  const vision = process.env.BRAIN_VISION ? process.env.BRAIN_VISION === "1" : p.vision;
  const baseURL = (process.env.BRAIN_BASE_URL || p.baseURL).replace(/\/+$/, "");
  const model = process.env.BRAIN_MODEL || p.model;
  if (!baseURL || !model) return null;
  return { kind: "openai", name, id: `${name}:${model}`, baseURL, model, key, vision, json: process.env.BRAIN_JSON || p.json, extra: p.extra || {} };
}

export function hasBrain() {
  return Boolean(primaryProvider() || process.env.GEMINI_API_KEY);
}

/** Every provider/model to try, in order. */
function candidates() {
  const out = [];
  const p = primaryProvider();
  if (p) out.push(p);
  if (process.env.GEMINI_API_KEY) {
    for (const m of GEMINI_MODELS) out.push({ kind: "gemini", id: `gemini:${m}`, model: m, key: process.env.GEMINI_API_KEY, vision: true });
  }
  return out;
}

// Skip, for a while, whatever just timed out / ran out of quota / was overloaded.
const coolingUntil = new Map();
const cool = (id) => coolingUntil.set(id, Date.now() + COOLDOWN_MS);
export const modelsToTry = () => {
  const all = candidates();
  const ready = all.filter((c) => !(coolingUntil.get(c.id) > Date.now()));
  return ready.length ? ready : all; // all cooling: try them all anyway
};

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
  if (!res.ok) return { status: res.status, error: d.error?.message?.split("\n")[0] || res.statusText };
  return { text: (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join(""), usage: d.usageMetadata || {} };
}

// ── OpenAI-compatible (Z.ai GLM, DeepSeek, OpenRouter, …) ─────

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
  if (!res.ok) return { status: res.status, error: (d.error?.message || d.message || res.statusText || "").toString().split("\n")[0] };
  return { text: d.choices?.[0]?.message?.content || "", usage: d.usage || {} };
}

/**
 * @param {{system: string, text: string, images?: Buffer[], schema: object, signal?: AbortSignal}} req
 * @returns {Promise<{data: any, model: string, ms: number, usage: object}>}
 */
export async function ask({ system, text, images = [], schema, signal }) {
  const list = modelsToTry();
  if (!list.length) throw new BrainError("No AI model is set up. Add BRAIN_PROVIDER and BRAIN_API_KEY, or GEMINI_API_KEY, to .env");
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
      cool(c.id);
      continue;
    }
    if (r.error) {
      lastErr = new BrainError(`${c.id}: ${r.status} ${r.error}`);
      if (r.status === 429 || r.status === 402) quota = true;
      if (r.status === 429 || r.status === 402 || r.status >= 500 || r.status === 404) {
        cool(c.id); // quota / payment / busy / unknown model: next one
        continue;
      }
      if (r.status === 401 || r.status === 403) {
        cool(c.id); // bad key: say so, but still fall back
        continue;
      }
      throw lastErr;
    }
    try {
      return { data: parseJsonReply(r.text), model: c.model, ms: Date.now() - t0, usage: r.usage };
    } catch {
      // one retry with a reminder, for models that wrap or truncate JSON
      if (c.kind === "openai") {
        try {
          const r2 = await callOpenAI(c, { system, text, images, schema, signal }, "\n\n(Your previous reply was not a valid JSON object. Reply with the JSON object only.)");
          if (!r2.error) return { data: parseJsonReply(r2.text), model: c.model, ms: Date.now() - t0, usage: r2.usage };
        } catch {}
      }
      lastErr = new BrainError(`${c.id}: answer wasn't valid JSON`);
    }
  }
  if (quota && /\b(429|402)\b/.test(lastErr?.message || "")) {
    throw new BrainError("The AI model's limit or credit is used up for now. Try again in a minute, or check your key and credit.");
  }
  throw lastErr || new BrainError("No AI model available");
}
