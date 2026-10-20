/**
 * Voice: speech to text and text to speech through Groq's OpenAI-compatible audio API, with the
 * user's GROQ_API_KEY. The panel records with MediaRecorder and POSTs the bytes here; the key never
 * leaves this process.
 *
 *   POST /api/transcribe   raw audio body (webm/opus, wav, ...)  -> { text }
 *   POST /api/speak        { text }                              -> audio/wav bytes
 *
 * Groq's free tier allows very little speech (about 10 requests and 1.2K tokens a minute), so the
 * panel only speaks replies to spoken requests and we keep what we send short.
 */
import express from "express";

export const GROQ_AUDIO = "https://api.groq.com/openai/v1/audio";
export const STT_MODEL = "whisper-large-v3-turbo";
export const TTS_MODEL = "canopylabs/orpheus-v1-english";
/** Orpheus English voices: autumn, diana, hannah, austin, daniel, troy. */
export const TTS_VOICES = ["autumn", "diana", "hannah", "austin", "daniel", "troy"];
export const TTS_VOICE = "hannah";
/** Orpheus rejects input over 200 characters. */
export const TTS_MAX = 200;
/** Whisper's upload limit on Groq's free tier. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export class VoiceError extends Error {
  /** code: no_key | rate_limited | terms | bad_audio | too_large | empty | upstream; status: what our route answers with. */
  constructor(code, message, { status = 502, retryAfter = null, url = null } = {}) {
    super(message);
    this.url = url;
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export const hasVoiceKey = (env = process.env) => Boolean(String(env.GROQ_API_KEY || "").trim());

const EXT = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/m4a": "m4a", "audio/x-m4a": "m4a", "audio/flac": "flac", "audio/x-flac": "flac" };
/** Whisper picks the decoder from the file name, so give the upload the right extension. */
export function audioFilename(mime) {
  const base = String(mime || "").split(";")[0].trim().toLowerCase();
  return `speech.${EXT[base] || "webm"}`;
}

/** The multipart body for /audio/transcriptions. */
export function buildTranscribeForm(audio, mime, { model = STT_MODEL, language = null } = {}) {
  const form = new FormData();
  const type = String(mime || "audio/webm").split(";")[0].trim() || "audio/webm";
  form.append("file", new Blob([audio], { type }), audioFilename(type));
  form.append("model", model);
  form.append("response_format", "json");
  form.append("temperature", "0");
  if (language) form.append("language", language);
  return form;
}

/**
 * What to say out loud for a reply: plain words only, no links, tab mentions as their title, and
 * at most a sentence or two that fit in `max` characters (cut at a word, never mid-word).
 */
export function speakableText(text, max = TTS_MAX) {
  let s = String(text ?? "")
    .replace(/@\[([^\]]+)\]/g, "$1") // tab mentions
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1") // markdown links
    .replace(/https?:\/\/\S+/g, "") // bare urls
    .replace(/`{1,3}[^`]*`{1,3}/g, (m) => m.replace(/`/g, ""))
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "") // list markers
    .replace(/[*_#>|~]+/g, " ")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\[[^\]]*\]/g, "") // Orpheus reads [brackets] as vocal directions
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
  if (s.length <= max) return s;
  // whole sentences while they fit (one or two), else the first sentence cut at a word
  const sentences = s.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) || [s];
  let out = "";
  for (const raw of sentences) {
    const t = raw.trim();
    const next = out ? `${out} ${t}` : t;
    if (next.length > max) break;
    out = next;
  }
  if (out) return out;
  const cut = s.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.5 ? cut.slice(0, at) : cut).replace(/[\s,;:–—-]+$/, "")}…`;
}

/** The JSON body for /audio/speech. */
export function buildSpeakBody(text, { voice = process.env.VB_TTS_VOICE || TTS_VOICE, model = TTS_MODEL } = {}) {
  return { model, input: speakableText(text), voice: TTS_VOICES.includes(voice) ? voice : TTS_VOICE, response_format: "wav" };
}

/** A failed Groq response -> VoiceError with words fit for the status line. */
export function groqError(status, bodyText = "", retryAfterHeader = null) {
  let detail = "";
  try { detail = JSON.parse(bodyText)?.error?.message || ""; } catch { detail = String(bodyText || "").slice(0, 200); }
  // Orpheus needs its terms accepted once in the Groq console before the key can use it
  if (/terms acceptance/i.test(detail)) {
    const url = detail.match(/https:\/\/console\.groq\.com\/\S+/)?.[0] || "https://console.groq.com/playground";
    return new VoiceError("terms", "Groq needs you to accept the voice model's terms once.", { status: 403, url });
  }
  if (status === 401 || status === 403) return new VoiceError("no_key", "Groq didn't accept the API key. Add a working Groq key in the model picker.", { status: 401 });
  if (status === 429) {
    const secs = Number(retryAfterHeader);
    const retryAfter = Number.isFinite(secs) && secs > 0 ? Math.ceil(secs) : null;
    return new VoiceError("rate_limited", `Groq's free voice limit is used up for now${retryAfter ? `; try again in ${retryAfter} s` : ""}.`, { status: 429, retryAfter });
  }
  if (status === 413) return new VoiceError("too_large", "That recording is too long. Keep it under a few minutes.", { status: 413 });
  if (status === 400 || status === 422) return new VoiceError("bad_audio", `Groq couldn't use that${detail ? `: ${detail}` : "."}`, { status: 400 });
  return new VoiceError("upstream", `Groq's audio service failed (${status})${detail ? `: ${detail}` : ""}.`, { status: 502 });
}

function key(env) {
  const k = String(env.GROQ_API_KEY || "").trim();
  if (!k) throw new VoiceError("no_key", "Voice needs a Groq API key. Add one in the model picker (Groq).", { status: 401 });
  return k;
}

async function call(url, init, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: init.signal || AbortSignal.timeout(30000) });
  } catch (err) {
    throw new VoiceError("upstream", `Couldn't reach Groq: ${err.message || err}`, { status: 502 });
  }
  if (!res.ok) throw groqError(res.status, await res.text().catch(() => ""), res.headers.get("retry-after"));
  return res;
}

/** Audio bytes -> transcript text ("" when nothing was said). */
export async function transcribe(audio, mime, { env = process.env, fetch: fetchImpl = fetch } = {}) {
  if (!audio?.length) throw new VoiceError("empty", "No audio was recorded.", { status: 400 });
  if (audio.length > MAX_AUDIO_BYTES) throw new VoiceError("too_large", "That recording is too long. Keep it under a few minutes.", { status: 413 });
  const res = await call(`${GROQ_AUDIO}/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${key(env)}` }, body: buildTranscribeForm(audio, mime) }, fetchImpl);
  const data = await res.json().catch(() => ({}));
  return cleanTranscript(data.text);
}

/** Whisper's usual output for silence is a stray "Thank you." or "you"; treat those as nothing. */
export function cleanTranscript(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return /^(?:you|thank you\.?|thanks for watching[.!]?|\.+|bye\.?)$/i.test(t) ? "" : t;
}

/** Reply text -> { audio: Buffer (wav), mime, text: what was spoken }. */
export async function speak(text, { env = process.env, fetch: fetchImpl = fetch, voice } = {}) {
  const body = buildSpeakBody(text, voice ? { voice } : undefined);
  if (!body.input) throw new VoiceError("empty", "Nothing to read aloud.", { status: 400 });
  const res = await call(`${GROQ_AUDIO}/speech`, { method: "POST", headers: { Authorization: `Bearer ${key(env)}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }, fetchImpl);
  return { audio: Buffer.from(await res.arrayBuffer()), mime: res.headers.get("content-type") || "audio/wav", text: body.input };
}

/**
 * Only the panel (a file:// page, Origin "null"/"file://") and pages from this server may call the
 * voice routes; a web page in the user's browser must not spend their Groq credits.
 */
export function allowedOrigin(origin, host) {
  if (!origin) return true; // curl, same-origin GET
  if (origin === "null" || origin === "file://") return true;
  try {
    const u = new URL(origin);
    return (u.hostname === "127.0.0.1" || u.hostname === "localhost") && (!host || u.host === host || u.host === host.replace(/^localhost/, "127.0.0.1"));
  } catch {
    return false;
  }
}

/** Adds POST /api/transcribe and POST /api/speak to the Express app. */
export function mountVoice(app, { transcribeImpl = transcribe, speakImpl = speak } = {}) {
  const guard = (req, res, next) => {
    const origin = req.headers.origin;
    if (!allowedOrigin(origin, req.headers.host)) return res.status(403).json({ error: "Not allowed.", code: "forbidden" });
    if (origin) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type");
      res.set("Access-Control-Expose-Headers", "X-Spoken-Text, Retry-After");
      res.set("Vary", "Origin");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  };
  const fail = (res, err) => {
    const e = err instanceof VoiceError ? err : new VoiceError("upstream", String(err?.message || err));
    if (e.retryAfter) res.set("Retry-After", String(e.retryAfter));
    res.status(e.status).json({ error: e.message, code: e.code, retryAfter: e.retryAfter, url: e.url });
  };
  app.options(["/api/transcribe", "/api/speak"], guard);
  app.get("/api/voice", guard, (_req, res) => res.json({ ready: hasVoiceKey(), stt: STT_MODEL, tts: TTS_MODEL }));
  app.post(
    "/api/transcribe",
    guard,
    // audio/* only: a page can't send that cross-site without a preflight, which `guard` refuses
    express.raw({ type: (req) => /^audio\//i.test(req.headers["content-type"] || ""), limit: MAX_AUDIO_BYTES }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body)) return fail(res, new VoiceError("bad_audio", "Send the recording as audio (Content-Type audio/webm).", { status: 415 }));
      try {
        res.json({ text: await transcribeImpl(req.body, req.headers["content-type"]) });
      } catch (err) {
        fail(res, err);
      }
    },
  );
  app.post("/api/speak", guard, express.json({ limit: "64kb" }), async (req, res) => {
    try {
      const out = await speakImpl(String(req.body?.text || ""), { voice: req.body?.voice });
      res.set("Content-Type", out.mime).set("X-Spoken-Text", encodeURIComponent(out.text)).send(out.audio);
    } catch (err) {
      fail(res, err);
    }
  });
  // body too large / malformed JSON on these routes -> the same JSON error shape
  app.use(["/api/transcribe", "/api/speak"], (err, _req, res, _next) => {
    if (err?.type === "entity.too.large") return fail(res, new VoiceError("too_large", "That recording is too long. Keep it under a few minutes.", { status: 413 }));
    fail(res, new VoiceError("bad_audio", "Couldn't read that request.", { status: 400 }));
  });
}
