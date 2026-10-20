import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import {
  audioFilename, buildTranscribeForm, speakableText, buildSpeakBody, groqError, cleanTranscript, transcribe, speak,
  allowedOrigin, mountVoice, VoiceError, TTS_MAX, TTS_VOICE, STT_MODEL, TTS_MODEL,
} from "../../src/voice.js";

test("audioFilename: extension from the mime type", () => {
  assert.equal(audioFilename("audio/webm;codecs=opus"), "speech.webm");
  assert.equal(audioFilename("audio/wav"), "speech.wav");
  assert.equal(audioFilename("audio/x-m4a"), "speech.m4a");
  assert.equal(audioFilename(""), "speech.webm");
});

test("buildTranscribeForm: file, model and json format", async () => {
  const f = buildTranscribeForm(Buffer.from("abc"), "audio/webm;codecs=opus");
  assert.equal(f.get("model"), STT_MODEL);
  assert.equal(f.get("response_format"), "json");
  const file = f.get("file");
  assert.equal(file.name, "speech.webm");
  assert.equal(file.type, "audio/webm");
  assert.equal(await file.text(), "abc");
});

test("speakableText: plain words, no links or markup", () => {
  assert.equal(speakableText("Opened **YouTube** and played https://youtu.be/x jazz."), "Opened YouTube and played jazz.");
  assert.equal(speakableText("Switched to @[Inbox - Gmail]."), "Switched to Inbox - Gmail.");
  assert.equal(speakableText("- one\n- two"), "one two");
  assert.equal(speakableText("Done 🎉 [cheerful]"), "Done");
  assert.equal(speakableText(""), "");
});

test("speakableText: one or two sentences within the limit", () => {
  const long = "The page lists three plans. The cheapest is $5 a month. " + "It also has a long comparison table that goes on and on. ".repeat(5);
  const out = speakableText(long);
  assert.ok(out.length <= TTS_MAX);
  assert.equal(out, "The page lists three plans. The cheapest is $5 a month. It also has a long comparison table that goes on and on. It also has a long comparison table that goes on and on.".slice(0, out.length));
  assert.match(out, /\.$/);
  const run = "word ".repeat(80);
  const cut = speakableText(run);
  assert.ok(cut.length <= TTS_MAX);
  assert.match(cut, /word…$/);
});

test("buildSpeakBody: model, voice, wav, trimmed input", () => {
  const b = buildSpeakBody("Hello there.", { voice: "nobody" });
  assert.deepEqual(b, { model: TTS_MODEL, input: "Hello there.", voice: TTS_VOICE, response_format: "wav" });
  assert.equal(buildSpeakBody("Hi.", { voice: "troy" }).voice, "troy");
});

test("groqError: status codes -> friendly codes", () => {
  const r = groqError(429, '{"error":{"message":"Rate limit reached"}}', "7.2");
  assert.equal(r.code, "rate_limited");
  assert.equal(r.status, 429);
  assert.equal(r.retryAfter, 8);
  assert.match(r.message, /8 s/);
  assert.equal(groqError(401).code, "no_key");
  assert.equal(groqError(400, '{"error":{"message":"file is empty"}}').message, "Groq couldn't use that: file is empty");
  assert.equal(groqError(413).code, "too_large");
  const t = groqError(403, '{"error":{"message":"The model `x` requires terms acceptance. Please have the org admin accept the terms at https://console.groq.com/playground?model=x"}}');
  assert.equal(t.code, "terms");
  assert.equal(t.url, "https://console.groq.com/playground?model=x");
  assert.equal(groqError(500, "oops").status, 502);
});

test("cleanTranscript: Whisper's silence fillers become empty", () => {
  assert.equal(cleanTranscript(" Thank you. "), "");
  assert.equal(cleanTranscript("you"), "");
  assert.equal(cleanTranscript(" open  youtube "), "open youtube");
});

test("transcribe / speak: no key, request shape, errors", async () => {
  await assert.rejects(transcribe(Buffer.from("x"), "audio/webm", { env: {} }), (e) => e instanceof VoiceError && e.code === "no_key");
  await assert.rejects(transcribe(Buffer.alloc(0), "audio/webm", { env: { GROQ_API_KEY: "k" } }), (e) => e.code === "empty");
  let seen;
  const ok = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ text: " open youtube " }), { status: 200 }); };
  assert.equal(await transcribe(Buffer.from("x"), "audio/webm", { env: { GROQ_API_KEY: "k" }, fetch: ok }), "open youtube");
  assert.match(seen.url, /\/audio\/transcriptions$/);
  assert.equal(seen.init.headers.Authorization, "Bearer k");
  const limited = async () => new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { "retry-after": "3" } });
  await assert.rejects(speak("Hello.", { env: { GROQ_API_KEY: "k" }, fetch: limited }), (e) => e.code === "rate_limited" && e.retryAfter === 3);
  const wav = async (url, init) => { seen = { url, body: JSON.parse(init.body) }; return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/wav" } }); };
  const out = await speak("**Done.**", { env: { GROQ_API_KEY: "k" }, fetch: wav });
  assert.deepEqual([...out.audio], [1, 2, 3]);
  assert.equal(seen.body.input, "Done.");
  assert.match(seen.url, /\/audio\/speech$/);
});

test("allowedOrigin: the panel and this server only", () => {
  assert.equal(allowedOrigin(undefined, "127.0.0.1:8787"), true);
  assert.equal(allowedOrigin("null", "127.0.0.1:8787"), true);
  assert.equal(allowedOrigin("file://", "127.0.0.1:8787"), true);
  assert.equal(allowedOrigin("http://127.0.0.1:8787", "127.0.0.1:8787"), true);
  assert.equal(allowedOrigin("https://evil.example", "127.0.0.1:8787"), false);
  assert.equal(allowedOrigin("http://127.0.0.1:3000", "127.0.0.1:8787"), false);
});

test("routes: transcribe raw audio, speak json, refuse other sites", async () => {
  const app = express();
  mountVoice(app, {
    transcribeImpl: async (buf, mime) => `${buf.length} bytes ${mime}`,
    speakImpl: async (text) => { if (text === "limit") throw new VoiceError("rate_limited", "Busy", { status: 429, retryAfter: 5 }); return { audio: Buffer.from("RIFF"), mime: "audio/wav", text }; },
  });
  const server = http.createServer(app).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await fetch(`${base}/api/transcribe`, { method: "POST", headers: { "Content-Type": "audio/webm", Origin: "null" }, body: Buffer.from("abcd") });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), "null");
    assert.deepEqual(await r.json(), { text: "4 bytes audio/webm" });
    r = await fetch(`${base}/api/transcribe`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "abcd" });
    assert.equal(r.status, 415);
    r = await fetch(`${base}/api/transcribe`, { method: "POST", headers: { "Content-Type": "audio/webm", Origin: "https://evil.example" }, body: Buffer.from("abcd") });
    assert.equal(r.status, 403);
    r = await fetch(`${base}/api/transcribe`, { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
    assert.equal(r.status, 403);
    r = await fetch(`${base}/api/speak`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Hi." }) });
    assert.equal(r.headers.get("content-type"), "audio/wav");
    assert.equal(await r.text(), "RIFF");
    r = await fetch(`${base}/api/speak`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "limit" }) });
    assert.equal(r.status, 429);
    assert.equal(r.headers.get("retry-after"), "5");
    assert.equal((await r.json()).code, "rate_limited");
  } finally {
    server.close();
  }
});
