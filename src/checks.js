/**
 * Built-in wait / check steps, handled by code (no model call):
 *   wait 2 seconds · wait until "Purchase requests" appears · wait for the dashboard to load
 *   check that the page says "Approved" · check the page doesn't say "Error"
 *   check that the url contains /dashboard
 * Returns an action for the executor, or null when the text isn't one of these.
 */
const strip = (s) => String(s || "").trim().replace(/^["“'](.*)["”']$/, "$1").trim();
const DEFAULT_WAIT_MS = 15000;

export function parseCheck(text) {
  const t = String(text || "").trim().replace(/[.!]+$/, "");
  let m;

  if ((m = t.match(/^wait\s+(?:for\s+)?(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|ms|milliseconds?)$/i))) {
    const n = Number(m[1]);
    const ms = /^m/i.test(m[2]) ? n : n * 1000;
    return { type: "wait_ms", ms: Math.min(ms, 60000), label: `wait ${m[1]}${/^m/i.test(m[2]) ? "ms" : "s"}` };
  }
  if (/^wait\s+(?:for\s+|until\s+)?(?:the\s+)?(?:page|it|everything)\s+(?:to\s+)?(?:load|loads|finish(?:es)?\s+loading|is\s+loaded)$/i.test(t)) {
    return { type: "wait_load", label: "wait for the page to load" };
  }
  if ((m = t.match(/^wait\s+(?:until|for|till)\s+(.+?)\s+(?:disappears|goes away|is gone|is hidden)$/i))) {
    return { type: "wait_text_gone", text: strip(m[1]), timeoutMs: DEFAULT_WAIT_MS, label: `wait until "${strip(m[1])}" is gone` };
  }
  if ((m = t.match(/^wait\s+(?:until|for|till)\s+(?:the\s+(?:url|address)\s+(?:contains|has|includes)\s+)(.+)$/i))) {
    return { type: "wait_url", text: strip(m[1]), timeoutMs: DEFAULT_WAIT_MS, label: `wait until the URL contains "${strip(m[1])}"` };
  }
  if ((m = t.match(/^wait\s+(?:until|for|till)\s+(?:the\s+page\s+(?:says|shows|contains)\s+)?(.+?)(?:\s+(?:appears|shows up|is visible|loads|is shown|shows|to (?:load|appear|show(?: up)?|be visible|be shown)))?$/i))) {
    const what = strip(m[1].replace(/^(?:the\s+)?(?:text\s+)?/i, ""));
    if (what) return { type: "wait_text", text: what, timeoutMs: DEFAULT_WAIT_MS, label: `wait until "${what}" appears` };
  }

  const CHECK = "^(?:check|verify|assert|expect|make sure|confirm that|ensure)\\s+(?:that\\s+)?";
  if ((m = t.match(new RegExp(`${CHECK}(?:the\\s+)?(?:url|address)\\s+(?:contains|has|includes|is)\\s+(.+)$`, "i")))) {
    return { type: "assert_url", text: strip(m[1]), label: `check the URL contains "${strip(m[1])}"` };
  }
  if ((m = t.match(new RegExp(`${CHECK}(?:the\\s+)?(?:page|screen|it)\\s+(?:does\\s*n[o']?t|doesn't|does not|never)\\s+(?:say|show|contain|have)s?\\s+(.+)$`, "i")))) {
    return { type: "assert_no_text", text: strip(m[1]), label: `check the page doesn't say "${strip(m[1])}"` };
  }
  if ((m = t.match(new RegExp(`${CHECK}(?:the\\s+)?(?:page|screen|it)\\s+(?:says|shows|contains|has|displays)\\s+(.+)$`, "i")))) {
    return { type: "assert_text", text: strip(m[1]), label: `check the page says "${strip(m[1])}"` };
  }
  if ((m = t.match(new RegExp(`${CHECK}["“'](.+)["”']\\s+(?:is\\s+)?(?:visible|shown|on the page|appears)$`, "i")))) {
    return { type: "assert_text", text: strip(m[1]), label: `check the page says "${strip(m[1])}"` };
  }
  return null;
}

export const CHECK_TYPES = new Set(["wait_ms", "wait_load", "wait_text", "wait_text_gone", "wait_url", "assert_text", "assert_no_text", "assert_url"]);
