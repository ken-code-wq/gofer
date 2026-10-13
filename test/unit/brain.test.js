import { test } from "node:test";
import assert from "node:assert/strict";

const KEYS = ["BRAIN_PROVIDER", "BRAIN_API_KEY", "BRAIN_MODEL", "BRAIN_BASE_URL", "BRAIN_VISION", "GEMINI_API_KEY"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const reset = () => KEYS.forEach((k) => delete process.env[k]);
const { parseJsonReply, primaryProvider, modelsToTry, hasBrain } = await import("../../src/brain.js");

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
