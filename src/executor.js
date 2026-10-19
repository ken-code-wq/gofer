/**
 * Execute a policy action on the controlled browser with Playwright.
 * Shows overlay feedback (highlight + toast) on the page.
 */
import { captureScreenshot } from "./utility.js";
import fs from "node:fs";
import path from "node:path";
import { HIGHLIGHT_MS } from "./constants.js";
import { describe } from "./policy.js";
import { resolveSecrets } from "./secrets.js";
import { DATA_DIR } from "./store.js";

const NAV_TIMEOUT = 15000;

function locatorFor(page, id) {
  return page.locator(`[data-vb-id="${id}"]`).first();
}

async function settle(page, ms = 2500) {
  await Promise.race([page.waitForLoadState("domcontentloaded").catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
  await page.waitForTimeout(120);
}

/** "shift+n", "Shift + N", "space", "esc" -> Playwright key names ("Shift+N", "Space", "Escape"). */
export function normalizeKey(k) {
  const NAMES = { esc: "Escape", escape: "Escape", space: "Space", spacebar: "Space", enter: "Enter", return: "Enter", tab: "Tab", backspace: "Backspace", delete: "Delete",
    up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
    home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", shift: "Shift", ctrl: "Control", control: "Control", alt: "Alt", option: "Alt", cmd: "Meta", command: "Meta", meta: "Meta" };
  const parts = String(k || "").split("+").map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out = parts.map((x) => NAMES[x.toLowerCase()] || (/^f\d{1,2}$/i.test(x) ? x.toUpperCase() : x.length === 1 ? (parts.length > 1 ? x.toUpperCase() : x) : null));
  return out.includes(null) ? null : out.join("+");
}

/** Wait for a possible new tab after a click (target=_blank). */
async function maybeNewTab(browser, before, from = browser.page) {
  await new Promise((r) => setTimeout(r, 400));
  // only a tab this page opened, not one of yours that woke up meanwhile
  for (const p of browser.pages.filter((x) => !before.includes(x))) {
    const opener = await Promise.race([p.opener().catch(() => null), new Promise((r) => setTimeout(() => r(null), 300))]);
    if (opener === from) return browser.setActive(p);
  }
}

/**
 * @param {object} action  from policy.evaluatePolicy
 * @param {import('./browser.js').BrowserManager} browser
 * @returns {Promise<{ok: boolean, detail?: string}>}
 */
export async function execute(action, browser) {
  const page = await browser.ensurePage();
  const label = describe(action);

  switch (action.type) {
    case "navigate_url": {
      await browser.overlay("toast", `→ ${label}`);
      const host = new URL(action.url).hostname.replace(/^www\./, "");
      try {
        await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      } catch (e) {
        // Transient network error or a site that never fires load: retry once, then accept if the
        // URL at least moved to the right host.
        await new Promise((r) => setTimeout(r, 500));
        await page.goto(action.url, { waitUntil: "commit", timeout: NAV_TIMEOUT }).catch(() => {});
        if (!page.url().includes(host)) throw e;
      }
      await settle(page, 800);
      return { ok: true, detail: page.url() };
    }

    case "click_element": {
      const before = [...browser.pages];
      await browser.overlay("clearCandidates");
      await browser.overlay("highlight", action.targetId, HIGHLIGHT_MS);
      await browser.overlay("toast", label);
      const loc = locatorFor(page, action.targetId);
      await new Promise((r) => setTimeout(r, 180)); // let the human see the highlight
      try {
        await loc.click({ timeout: 4000 });
      } catch {
        await loc.evaluate((el) => el.click());
      }
      await settle(page);
      await maybeNewTab(browser, before, page);
      return { ok: true, detail: browser.page.url() };
    }

    case "type_into_field": {
      await browser.overlay("clearCandidates");
      await browser.overlay("highlight", action.targetId, HIGHLIGHT_MS + 400);
      await browser.overlay("toast", label);
      const loc = locatorFor(page, action.targetId);
      await loc.click({ timeout: 4000 }).catch(() => loc.focus());
      await loc.fill("").catch(() => {});
      // {{secret}} placeholders become Keychain values only here, at the moment of typing.
      const text = await resolveSecrets(action.text);
      await loc.pressSequentially(text, { delay: 18 }).catch(async () => loc.fill(text));
      if (action.submit) {
        await page.keyboard.press("Enter");
        await settle(page);
        // Leave the field so its autocomplete dropdown closes and isn't mistaken for results.
        await page.evaluate(() => document.activeElement?.blur?.()).catch(() => {});
      }
      return { ok: true, detail: page.url() };
    }

    case "select_option": {
      await browser.overlay("highlight", action.targetId, HIGHLIGHT_MS);
      await browser.overlay("toast", label);
      const loc = locatorFor(page, action.targetId);
      // Match option by (case-insensitive, substring) label in code.
      const picked = await loc.evaluate((sel, wanted) => {
        const w = wanted.toLowerCase();
        const opts = Array.from(sel.options || []);
        const hit = opts.find((o) => o.label.toLowerCase() === w) || opts.find((o) => o.label.toLowerCase().includes(w));
        if (!hit) return null;
        sel.value = hit.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return hit.label;
      }, action.text);
      return { ok: Boolean(picked), detail: picked || "no matching option" };
    }

    case "press_enter":
      await browser.overlay("toast", "⏎ enter");
      await page.keyboard.press("Enter");
      await settle(page);
      return { ok: true, detail: page.url() };

    case "press_key": {
      // shortcuts act on the page, not on a text field that happens to have focus
      const key = normalizeKey(action.key);
      if (!key) return { ok: false, detail: `unknown key "${action.key}"` };
      await page.evaluate(() => {
        const a = document.activeElement;
        if (a && (a.isContentEditable || /^(?:INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) a.blur();
      }).catch(() => {});
      await browser.overlay("toast", `⌨ ${key}`);
      await page.keyboard.press(key);
      await settle(page, 1500);
      return { ok: true, detail: page.url() };
    }

    case "scroll_down":
    case "scroll_up": {
      const dir = action.type === "scroll_down" ? 1 : -1;
      await browser.overlay("toast", label);
      await page.evaluate(
        ([dir, amount]) => {
          const vh = window.innerHeight;
          if (amount === "end") {
            window.scrollTo({ top: dir > 0 ? document.documentElement.scrollHeight : 0, behavior: "smooth" });
          } else {
            const px = amount === "little" ? vh * 0.35 : vh * 0.85;
            window.scrollBy({ top: dir * px, behavior: "smooth" });
          }
        },
        [dir, action.amount || "page"],
      );
      await page.waitForTimeout(350);
      return { ok: true, detail: `scrollY=${await page.evaluate(() => Math.round(window.scrollY))}` };
    }

    case "go_back":
      await browser.overlay("toast", "← back");
      await page.goBack({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => {});
      await settle(page, 800);
      return { ok: true, detail: page.url() };

    case "go_forward":
      await browser.overlay("toast", "→ forward");
      await page.goForward({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => {});
      await settle(page, 800);
      return { ok: true, detail: page.url() };

    case "reload":
      await browser.overlay("toast", "↻ reload");
      await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => {});
      return { ok: true, detail: page.url() };

    case "open_new_tab": {
      const p = await browser.context.newPage();
      await browser.setActive(p);
      if (action.url) {
        await p.goto(action.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => {});
        await settle(p, 800);
      }
      await browser.overlay("toast", "new tab");
      return { ok: true, detail: action.url ? p.url() : `tabs=${browser.pages.length}` };
    }

    case "close_tab": {
      await page.close();
      if (browser.pages.length === 0) await browser.context.newPage();
      await browser.setActive(browser.page);
      return { ok: true, detail: `tabs=${browser.pages.length}` };
    }

    case "switch_tab": {
      // a goal names the tab (a page, or its title when a saved goal replays)
      if (action.page || action.title) {
        let target = action.page && !action.page.isClosed() ? action.page : null;
        if (!target && action.title) {
          for (const p of browser.pages) if (!p.isClosed() && (await p.title().catch(() => "")) === action.title) { target = p; break; }
        }
        if (!target) return { ok: false, detail: `tab "${action.title || "?"}" is not open` };
        await browser.setActive(target);
        await browser.overlay("toast", "switched tab");
        return { ok: true, detail: target.url() };
      }
      const pages = browser.pages;
      if (pages.length < 2) return { ok: false, detail: "only one tab" };
      const i = pages.indexOf(browser.page);
      let next;
      if (action.direction === "previous") next = pages[(i - 1 + pages.length) % pages.length];
      else if (action.direction === "first") next = pages[0];
      else next = pages[(i + 1) % pages.length];
      await browser.setActive(next);
      await browser.overlay("toast", "switched tab");
      return { ok: true, detail: next.url() };
    }

    case "take_screenshot": {
      const shot = await captureScreenshot(page, { fullPage: Boolean(action.fullPage) });
      await browser.overlay("toast", "screenshot");
      return { ok: true, detail: "screenshot taken", path: shot.path, image: shot.image };
    }

    case "wait_ms":
      await browser.overlay("toast", label);
      await page.waitForTimeout(action.ms);
      return { ok: true, detail: label };

    case "wait_load":
      await browser.overlay("toast", label);
      await page.waitForLoadState("load", { timeout: NAV_TIMEOUT }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      return { ok: true, detail: "page loaded" };

    case "wait_text":
    case "wait_text_gone":
    case "wait_url":
    case "assert_text":
    case "assert_no_text":
    case "assert_url":
      return runCheck(action, browser, page, label);

    default:
      return { ok: false, detail: `unknown action ${action.type}` };
  }
}

const pageText = (page) => page.evaluate(() => document.body?.innerText || "").catch(() => "");
const hasText = async (page, text) => (await pageText(page)).toLowerCase().includes(text.toLowerCase());

/** Waits poll until true or timeout; asserts check once. Failures save a screenshot. */
async function runCheck(action, browser, page, label) {
  await browser.overlay("toast", label);
  const want = String(action.text || "");
  const test = {
    wait_text: () => hasText(page, want),
    assert_text: () => hasText(page, want),
    wait_text_gone: async () => !(await hasText(page, want)),
    assert_no_text: async () => !(await hasText(page, want)),
    wait_url: async () => page.url().toLowerCase().includes(want.toLowerCase()),
    assert_url: async () => page.url().toLowerCase().includes(want.toLowerCase()),
  }[action.type];
  const isWait = action.type.startsWith("wait_");
  const end = Date.now() + (isWait ? action.timeoutMs || 15000 : 0);
  do {
    if (await test()) return { ok: true, detail: `✓ ${label}` };
    if (isWait) await page.waitForTimeout(300);
  } while (Date.now() < end);

  const secs = Math.round((action.timeoutMs || 15000) / 1000);
  const why = {
    wait_text: `"${want}" didn't appear within ${secs} s`,
    wait_text_gone: `"${want}" was still on the page after ${secs} s`,
    wait_url: `The address didn't change to include "${want}" within ${secs} s`,
    assert_text: `The page doesn't say "${want}"`,
    assert_no_text: `The page says "${want}"`,
    assert_url: `The address doesn't include "${want}"`,
  }[action.type] || label;
  const screenshot = await saveFailureShot(page);
  await browser.overlay("toast", `✗ ${why}`, 5000);
  return { ok: false, detail: why, screenshot, url: page.url() };
}

async function saveFailureShot(page) {
  try {
    const dir = path.join(DATA_DIR, "failures");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    await page.screenshot({ path: file, timeout: 5000 });
    return file;
  } catch {
    return null;
  }
}
