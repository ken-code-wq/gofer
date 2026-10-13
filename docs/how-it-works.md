# How Voice Browser works

```
 bar / control page / mic           local Node server (owns the API keys)              controlled browser
 ───────────────────────    ws      ─────────────────────────────────────              ──────────────────
 typed command, or partial ───────▶ saved command? tab mention? follow-up?            Playwright: built-in
 voice transcripts                  ├─ question / goal / form  → brain (smart.js)      Chromium (persistent
 "go to" "go to wiki" …             ├─ chain (chain.js) → one step at a time           profile) or your own
                                    ├─ wait / check (checks.js) → code only            browser over CDP
                                    └─ single command → decision model (jev.js)  ───▶  overlay: highlight,
 results, steps, prompts ◀───────── policy (policy.js) → act · wait · ask · ignore      toasts, numbers
```

## Single commands: a decision model that never writes text

Every transcript update produces exactly one request to a *System One* decision model — SubQ Snap
(`subq-snap-preview`) or TypeSafe Jev (`jev-1.13.0`), same API (`src/jev.js`). It answers a dozen typed
questions in parallel with probabilities. It never generates text: search queries, typed text and URLs
are extracted as candidate spans by code (`src/spans.js`) and the model only *picks* one, which is
copied verbatim.

State sent with each request:

```json
{ "transcript": "open the documentation",
  "page": { "url": "https://typesafe.ai/jev", "title": "Jev", "site": "generic" },
  "elements": ["e03 link \"Documentation\" → docs.typesafe.ai", "e07 link \"Read the docs\" → docs.typesafe.ai", "..."],
  "context": {
    "previous_page": { "url": "https://duckduckgo.com/?q=jev+typesafe", "title": "jev typesafe at DuckDuckGo" },
    "recent_actions": [
      { "said": "click the first result", "action": "click_element", "target": "link \"TypeSafe — Jev\"", "outcome": "navigated to typesafe.ai/jev", "seconds_ago": 6 } ] } }
```

`context` is what makes "go back to the results", "no, not that one" and "the other one" resolvable —
the model has no memory between requests, so the memory lives in the state.

Questions (all in `src/constants.js`):

| id | type | answers |
| --- | --- | --- |
| `intent` | Choice | navigate_url · search_web · click_element · type_into_field · select_option · press_enter · scroll_down/up · go_back/forward · reload · open/close/switch tab · confirm · cancel · none |
| `target` | Choice | the element ids on the page + `none` |
| `site` | Choice | google · duckduckgo · youtube · wikipedia · github · amazon · reddit · … · none |
| `complete` | Noul | has the user finished the command? (lets it act on partial speech) |
| `is_command` | Noul | is the user addressing the browser at all? |
| `destructive` | Noul | would it submit / buy / delete / send? |
| `scroll_amount` | Score | a little · one page · to the end |
| `text_span` / `url_span` | Choice | candidate spans extracted by code (+ `none`), only when present |
| `tab_direction` | Choice | next · previous · first · none |
| `is_correction` | Noul | is the user rejecting the most recent action? (only with history) |

Policy (`src/policy.js`, thresholds `T` in `constants.js`):

0. `is_correction ≥ 0.6` → reverse the last action, or exclude the previous target ("the other one")
1. `is_command ≥ 0.5` else **ignore**
2. `intent.confidence ≥ 0.55` and not `none` else **wait**
3. `complete ≥ 0.6`, or 900 ms of silence, or a final transcript — else **wait**
4. free-text intents (search / type) also wait for a final transcript or 600 ms of silence
5. build the action in code: URL templates, search-box fallback, verbatim span copy
6. click/type targets need `target.confidence ≥ 0.45` and top probability ≥ 0.35, else the top
   candidates get numbered overlays and a number picks one (no model call)
7. `destructive ≥ 0.5` on a click → **confirm**

A finished (typed) command that is still unclear after 3 requests is given up instead of retried.

## Chains, waits and checks

`src/chain.js` splits typed commands on `,` `;` `then` and `and <verb>` (quoted text is never split),
merges "click on email and type …" into one targeted step, and turns verbless steps into
"search for X" + "click X". Steps run one at a time; the next starts after the page's `load` and a short
network-idle wait. `src/checks.js` recognises waits and checks, which run in code
(`src/executor.js`); a failed check stops the chain and saves a screenshot to `~/.voice-browser/failures/`.

## Goals, questions, forms and follow-ups (the "brain")

`src/smart.js` routes questions (`…?`, "what/how many/summarize…"), goals (`goal:`, "create/add a …",
"help me …") and forms (`fill the form with …`) to a small generative model (`src/brain.js`): an
OpenAI-compatible provider you configure (GLM 5.3 Flash via Z.ai, DeepSeek, OpenRouter, …) and/or Google
Gemini Flash-Lite. Providers that time out, run out of quota or are overloaded are skipped for 5 minutes.

* **Questions** get the URL, element list, visible text (up to 30k chars) and a screenshot.
* **Forms** read the visible fields (labels, types, dropdown options; never password values) and fill
  them in one pass with Playwright — text, selects, dates, checkboxes. Never submits.
* **Goals** loop: look (elements + text + screenshot) → one action (click, type, select, fill_form,
  navigate, scroll, …) → repeat, up to 15 steps. Risky steps (submit, approve, delete, pay) pause for
  Allow / Allow all / Stop. When the model says it's done, a **second call verifies the page**; until it
  agrees, the goal continues (and after 3 disagreements it ends as *not finished*, with the reason).
* **Follow-ups** carry the thread's history (what you asked, what happened, with the values used) and
  run in the thread's tab. A follow-up goal is first **rewritten into a standalone goal** that names the
  items ("now delete the first 2" → "delete the bills Northwind and Acme Corp"), so the planner can't
  drift to "the first rows on the page".

## Tab mentions

`src/tabs.js` parses `@[Title]` / `@word` (never inside emails), matches open tabs by title, prefix,
words or host, switches to the tab and runs the rest of the command there. The bar lists tabs with
favicons fetched through the browser context (so localhost and signed-in sites work), colours chips with
the icon's dominant colour, and stores the icon with each command so history keeps it.

## Project layout

```
src/constants.js   model pin, thresholds, every decision question
src/jev.js         decision request (SubQ Snap / TypeSafe Jev)
src/spans.js       candidate extraction: text payloads, URLs (incl. localhost:port), number words
src/snapshot.js    in-page element collector (tags data-vb-id), labels, compaction, site detection
src/policy.js      answers → act / wait / ignore / confirm / disambiguate, with reasons
src/executor.js    Playwright actions, waits/checks, failure screenshots, overlay feedback
src/browser.js     built-in Chromium (persistent profile) or your browser over CDP; tabs, favicons
src/controller.js  routing, debounce, chains, goals, threads/follow-ups, stats
src/chain.js       command → steps
src/checks.js      wait / check parsing
src/smart.js       questions, forms, goal steps, verification, follow-up rewriting
src/brain.js       model clients: OpenAI-compatible presets + Gemini, fallback and cooldown
src/tabs.js        @tab mentions
src/store.js       saved commands (~/.voice-browser/commands.json)
src/secrets.js     {{secrets}} in the macOS Keychain
src/server.js      Express + WebSocket, control page (src/public/index.html)
desktop/           Electron command bar, browser switching (browsers.cjs), installer
test/unit/         fast tests with mocked models and browser
test/integration/  real decision-model calls on captured page fixtures
```

## Limitations

* macOS only for the desktop bar (Keychain, app icons, browser switching).
* The element snapshot is capped at 100 items (viewport first); elements inside iframes and closed
  shadow roots aren't seen.
* Voice in the control page uses the Web Speech API (Chrome / Edge; audio goes to Google). In the bar,
  use macOS Dictation.
* Small free models are hit-and-miss on long multi-item goals; the verification step makes them honest,
  not perfect. A stronger model (`BRAIN_PROVIDER`) helps.
* Decision thresholds were calibrated on `jev-1.13.0`; run `npm run test:integration` after switching models.
