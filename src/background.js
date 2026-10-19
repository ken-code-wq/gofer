/**
 * Background tabs: the agent never takes over the tab you're looking at to go somewhere new.
 *
 * What "the tab I'm on" means:
 *   - Questions ("what's this page about?", "summarize this") and requests that say so ("in the
 *     current tab …", "here, …", "@[Tab] …") are about the tab you are looking at, and run there.
 *   - A task that needs to go somewhere new (its step is "navigate to <url>") opens a background
 *     tab for it instead of navigating your tab away, unless your tab is a blank/new-tab page.
 *   - Once a task has its own tab, everything it does happens there; follow-ups ("another one")
 *     continue in that tab. Nothing is brought to the front unless you press Show / Take over or
 *     pick a tab in the panel.
 */
import { parseCurrentTab, parseTabMention } from "./tabs.js";

/** New-tab pages and blank tabs: fine to use for a task, nobody loses anything. */
export function isBlankUrl(url) {
  const u = String(url || "").trim();
  return !u || /^(?:about:(?:blank|newtab|home)|chrome:\/\/(?:newtab|new-tab-page)|edge:\/\/newtab|arc:\/\/newtab|dia:\/\/newtab|chrome-search:\/\/local-ntp)/i.test(u);
}

/** The request names the tab it should run in (the current one or an @mentioned one). */
export function isPinnedToTab(text) {
  const t = String(text || "");
  return Boolean(parseCurrentTab(t) || parseTabMention(t) || /\b(?:this|the current|my current) (?:page|tab|site)\b/i.test(t));
}

/**
 * Rewrite a goal step so it doesn't navigate the user's own tab away:
 * "navigate to X" in the tab you're looking at becomes "open X in a background tab".
 *
 * @param {object} action  executor action ({ type: "navigate_url", url, label } …)
 * @param {{ onShownTab: boolean, pageUrl: string, pinned?: boolean, ownTab?: boolean }} where
 *   onShownTab: the agent's tab is the one the user is looking at; ownTab: the task opened it.
 */
export function placeAction(action, { onShownTab, pageUrl, pinned = false, ownTab = false } = {}) {
  if (!action || action.type !== "navigate_url") return action;
  if (!onShownTab || pinned || ownTab || isBlankUrl(pageUrl)) return action;
  return { type: "open_new_tab", url: action.url, label: `new tab: ${String(action.label || action.url).replace(/^new tab:\s*/, "")}`, background: true };
}
