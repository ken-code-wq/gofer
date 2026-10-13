/**
 * Instant commands that need no model: "screenshot" (visible part or "full page") and
 * "copy url" / "copy title". Screenshots go to ~/Downloads (VB_SHOTS_DIR overrides).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SHOT = /^(?:take\s+(?:a\s+)?)?(full[\s-]?page\s+)?screen\s?shot(?:\s+(?:of\s+)?(?:the\s+)?(?:(full|whole|entire)\s+)?(?:page|tab))?(?:\s+(full[\s-]?page))?$/i;
const COPY = /^copy\s+(?:the\s+)?(?:(?:page|tab)(?:'s)?\s+)?(url|link|address|title|name)(?:\s+of\s+(?:the|this)\s+(?:page|tab))?$/i;

export function parseUtility(text) {
  const t = String(text || "").trim().replace(/[.!]+$/, "");
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

export async function runUtility(browser, util) {
  const page = browser.page;
  if (!page) throw new Error("No tab is open");
  if (util.kind === "screenshot") {
    const dir = process.env.VB_SHOTS_DIR || path.join(os.homedir(), "Downloads");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `Voice Browser ${stamp()}.png`);
    await page.screenshot({ path: file, fullPage: util.fullPage, timeout: 15000 });
    return { detail: `Saved ${util.fullPage ? "a full-page" : "a"} screenshot to ${path.basename(dir)}`, path: file };
  }
  const value = util.what === "title" ? await page.title() : page.url();
  const copied = await copyToClipboard(value);
  return { detail: copied ? `Copied ${value}` : value, value, copied };
}
