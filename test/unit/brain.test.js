import { test } from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.VB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vb-brain-"));
const KEYS = ["BRAIN_PROVIDER", "BRAIN_API_KEY", "BRAIN_MODEL", "BRAIN_BASE_URL", "BRAIN_VISION", "GEMINI_API_KEY", "GROQ_API_KEY", "ZAI_API_KEY", "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const reset = () => KEYS.forEach((k) => delete process.env[k]);
const { parseJsonReply, primaryProvider, modelsToTry, hasBrain, setPreferred, listModels } = await import("../../src/brain.js");

test("JSON replies are parsed even with fences or surrounding text", () => {
  assert.deepEqual(parseJsonReply('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonReply('```json\n{"steps":["x"]}\n```'), { steps: ["x"] });
  assert.deepEqual(parseJsonReply('Sure! Here it is: {"answer":"3 pending"} Hope that helps.'), { answer: "3 pending" });
  assert.throws(() => parseJsonReply("no json here"));
});

test("provider presets: GLM via Z.ai first, Gemini as fallback; nothing configured = no brain", () => {
  reset();
  assert.equal(hasBrain(), false);
  process.env.BRAIN_PROVIDER = "zai";
  process.env.BRAIN_API_KEY = "k";
  process.env.GEMINI_API_KEY = "g";
  const p = primaryProvider();
  assert.equal(p.baseURL, "https://api.z.ai/api/paas/v4");
  assert.equal(p.model, "glm-5.3-flash");
  assert.equal(p.vision, true);
  assert.deepEqual(p.extra, { thinking: { type: "disabled" } });
  const order = modelsToTry().map((c) => c.id);
  assert.equal(order[0], "zai:glm-5.3-flash");
  assert.ok(order.slice(1).every((id) => id.startsWith("gemini:")));
  process.env.BRAIN_PROVIDER = "deepseek";
  process.env.BRAIN_MODEL = "deepseek-flash";
  assert.equal(primaryProvider().model, "deepseek-flash");
  assert.equal(primaryProvider().vision, false);
  reset();
  Object.entries(saved).forEach(([k, v]) => v !== undefined && (process.env[k] = v));
});

test("several providers: screenshots go to models that read them, text to the fastest; a picked model goes first", () => {
  reset();
  process.env.GROQ_API_KEY = "gq";
  process.env.GEMINI_API_KEY = "g";
  const text = modelsToTry().map((c) => c.id);
  assert.equal(text[0], "groq:openai/gpt-oss-120b");
  const seeing = modelsToTry({ images: true });
  assert.equal(seeing[0].id, "groq:qwen/qwen3.8-27b");
  // then the other fast (Groq) models, then the slower ones that read screenshots
  assert.deepEqual(seeing.slice(1, 3).map((c) => c.id), ["groq:openai/gpt-oss-120b", "groq:openai/gpt-oss-20b"]);
  assert.ok(seeing.slice(3).every((c) => c.provider === "gemini"));
  assert.equal(setPreferred("gemini:gemini-2.5-flash-lite"), "gemini:gemini-2.5-flash-lite");
  assert.equal(modelsToTry({ images: true })[0].id, "gemini:gemini-2.5-flash-lite");
  assert.equal(modelsToTry()[0].id, "gemini:gemini-2.5-flash-lite");
  assert.equal(setPreferred("nope:missing"), "auto");
  const l = listModels();
  assert.ok(l.models.some((m) => m.provider === "Groq" && m.vision));
  assert.ok(l.missing.some((m) => m.env === "ZAI_API_KEY"));
  reset();
  Object.entries(saved).forEach(([k, v]) => v !== undefined && (process.env[k] = v));
});

test("tool calls: an odd 400 from one model hands the request to the next; tool arguments are parsed", async () => {
  reset();
  process.env.GROQ_API_KEY = "gq";
  setPreferred("auto");
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body.model);
    if (seen.length === 1) return new Response(JSON.stringify({ error: { message: "Tool choice is none, but model called a tool" } }), { status: 400 });
    assert.equal(body.tool_choice, "required");
    assert.equal(body.tools[0].type, "function");
    const tool_calls = [{ function: { name: "web_search", arguments: '{"query":"uncle pete toys jingle","description":"search"}' } }];
    return new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
  };
  try {
    const { askTools } = await import("../../src/brain.js");
    const tools = [{ name: "web_search", description: "search", parameters: { type: "object", properties: { query: { type: "string" } } } }];
    const r = await askTools({ system: "s", text: "t", tools });
    assert.equal(seen.length, 2);
    assert.notEqual(seen[0], seen[1]);
    assert.deepEqual(r.calls, [{ name: "web_search", args: { query: "uncle pete toys jingle", description: "search" } }]);
  } finally {
    globalThis.fetch = realFetch;
    reset();
    Object.entries(saved).forEach(([k, v]) => v !== undefined && (process.env[k] = v));
  }
});
