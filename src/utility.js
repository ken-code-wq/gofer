/**
 * Instant commands that need no model: "screenshot" (visible part or "full page") and
 * "copy url" / "copy title". Screenshots go to ~/Downloads (VB_SHOTS_DIR overrides).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// "screenshot", "take a full-page screenshot", "send me a screenshot of this page", "can you screenshot the whole page?"
const SHOT = /^(?:(?:please|can you|could you|would you)\s+)?(?:(?:take|send|show|give|get)\s+(?:me\s+)?)?(?:a\s+)?(full[\s-]?page\s+)?screen\s?shot(?:\s+(?:it|this|that))?(?:\s+(?:of\s+)?(?:the\s+|this\s+|my\s+)?(?:(full|whole|entire)\s+)?(?:page|tab|site|screen))?(?:\s+(full[\s-]?page))?(?:\s+please)?$/i;
const COPY = /^copy\s+(?:the\s+)?(?:(?:page|tab)(?:'s)?\s+)?(url|link|address|title|name)(?:\s+of\s+(?:the|this)\s+(?:page|tab))?$/i;

export function parseUtility(text) {
  const t = String(text || "").trim().replace(/[.!?]+$/, "");
  const shot = t.match(SHOT);
  if (shot) return { kind: "screenshot", fullPage: Boolean(shot[1] || shot[2] || shot[3]) };
  const copy = t.match(COPY);
  if (copy) return { kind: "copy", what: /title|name/i.test(copy[1]) ? "title" : "url" };
  return null;
}

const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
};

export function copyToClipboard(text) {
  if (process.platform !== "darwin") return Promise.resolve(false);
  return new Promise((resolve) => {
    const p = spawn("/usr/bin/pbcopy");
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
    p.stdin.end(text);
  });
}

export const shotsDir = () => process.env.VB_SHOTS_DIR || path.join(os.homedir(), "Downloads");

/**
 * Save a PNG of the tab to Downloads and return it with a JPEG preview (data URL) for the chat.
 * Very tall full pages are previewed from their top part only.
 */
export async function captureScreenshot(page, { fullPage = false } = {}) {
  const dir = shotsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `Gofer ${stamp()}.png`);
  await page.screenshot({ path: file, fullPage, timeout: 15000 });
  let image = null;
  try {
    const vp = page.viewportSize() || (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
    const clip = fullPage ? { x: 0, y: 0, width: vp.width, height: Math.min(await page.evaluate(() => document.documentElement.scrollHeight), vp.height * 3) } : undefined;
    const jpg = await page.screenshot({ type: "jpeg", quality: 70, fullPage, clip, timeout: 15000 });
    image = `data:image/jpeg;base64,${jpg.toString("base64")}`;
  } catch {}
  const title = await page.title().catch(() => "");
  return { path: file, image, title };
}

export async function runUtility(browser, util) {
  const page = browser.page;
  if (!page) throw new Error("No tab is open");
  if (util.kind === "screenshot") {
    const shot = await captureScreenshot(page, { fullPage: util.fullPage });
    const where = shot.title ? ` of “${shot.title.slice(0, 80)}”` : "";
    return { detail: `Here's ${util.fullPage ? "the whole page" : "a screenshot"}${where}. It's also saved in ${path.basename(shotsDir())}.`, path: shot.path, image: shot.image };
  }
  const value = util.what === "title" ? await page.title() : page.url();
  const copied = await copyToClipboard(value);
  return { detail: copied ? `Copied ${value}` : value, value, copied };
}
