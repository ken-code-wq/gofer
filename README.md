<p align="center">
  <img src="docs/images/icon.png" width="112" alt="Voice Browser icon" />
</p>

<h1 align="center">Voice Browser</h1>

<p align="center">
  <b>Tell a real browser what to do — in plain English, by typing or talking.</b><br/>
  A macOS command bar that drives Chromium, Dia, Arc or Chrome: single clicks in about a second,
  multi-step goals, questions about the page, form filling, and follow-ups.
</p>

<p align="center">
  <a href="https://github.com/ken-code-wq/voice-browser/actions/workflows/ci.yml"><img src="https://github.com/ken-code-wq/voice-browser/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey.svg" alt="macOS" />
  <img src="https://img.shields.io/badge/node-%E2%89%A522-339933.svg" alt="Node 22+" />
</p>

<p align="center">
  <img src="docs/images/bar-dark.png" width="680" alt="The command bar: a goal that created three bills, and a follow-up deleting two of them, waiting for Allow" />
</p>

---

## What it does

Press <kbd>⌘</kbd><kbd>⇧</kbd><kbd>Space</kbd> anywhere, type what you want, and watch the browser do it.

```text
go to wikipedia, search for alan turing, then click the first result
in @[Bills - Acme Books] create 3 bills with dummy data
  ↪ now delete the first 2
how many purchase requests are pending, and what's their total?
fill the form with vendor Northwind, amount 220.50, due next Friday
login-dev                      ← a saved command
```

| | |
|---|---|
| **Fast single actions** | "click new bill", "scroll down", "go back" — decided by [SubQ Snap](https://subq.ai) (or TypeSafe Jev), a model that *picks* options instead of writing text: typically 0.5–1 s to decide. |
| **Chains** | Steps separated by commas, `then` or `and …` run one after another, each after the page has loaded. |
| **Goals** | `goal: approve every pending request under $500` — a small multimodal model looks at the page + a screenshot, acts, and repeats until a second check agrees it's done. |
| **Questions** | Anything ending in `?` is answered from the current page. |
| **Forms** | `fill the form with …` fills text fields, dropdowns, dates and checkboxes in one go — and never submits by itself. |
| **Follow-ups** | ↩ on a finished command continues the conversation in the same tab: "now delete the first 2" is rewritten to name the exact items first. |
| **@ tabs** | Type `@` to pick any open tab; it becomes a chip with the site's icon and colour. |
| **Your browser** | Drive the built-in Chromium, or connect Dia, Arc, Brave, Chrome or Edge — it shows their real icon. |
| **Safe by default** | Anything that saves, pays, sends or deletes asks **Allow / Allow all / Stop**. Passwords live in the macOS Keychain as `{{name}}` and never reach a model. |
| **Waits & checks** | `wait until "Saved" appears`, `check that the page says "Approved"` — run in code; a failed check stops and saves a screenshot. |

<p align="center">
  <img src="docs/images/tab-picker.png" width="49%" alt="Typing @ lists open tabs with their icons" />
  <img src="docs/images/question.png" width="49%" alt="A question about the page, answered" />
</p>

## Quick start

**Requirements:** macOS (built and tested on Apple Silicon, macOS 26), [Node.js](https://nodejs.org) 22+, and a free API key
for at least one model (see [Configuration](#configuration)).

```bash
git clone https://github.com/ken-code-wq/voice-browser.git
cd voice-browser
npm install
npx playwright install chromium
cp .env.example .env            # then add your keys — .env is git-ignored and never leaves your Mac

# the desktop app
cd desktop && npm install
./install-mac.sh                # builds /Applications/Voice Browser.app
open "/Applications/Voice Browser.app"
```

Voice Browser lives in the menu bar. <kbd>⌘</kbd><kbd>⇧</kbd><kbd>Space</kbd> shows or hides the bar
(click the shortcut in the footer to change it), <kbd>Esc</kbd> hides it, and the menu-bar icon has
**Start at login**.

> **Prefer the terminal?** `./run.sh` starts the server and opens a control page at
> <http://localhost:8787> with live decision details and a microphone button (Chrome / Edge).

## Using it

### Commands

| Type | What happens |
|---|---|
| `go to example dot com` · `open youtube` · `go to localhost:3000/dashboard` | navigate |
| `search for alan turing` · `search youtube for lofi beats` | the site's own search box, a site search, or DuckDuckGo |
| `click the first result` · `click new bill` | click — ambiguous targets show numbered choices |
| `type hello into the search box` · `click on email and type {{dev-email}}` | type (verbatim) |
| `scroll down a bit` · `go back` · `reload` · `open a new tab` · `next tab` | scroll, history, tabs |
| `open youtube, theo t3.gg's channel` | a chain; a step with no verb means *find it* (search, then click) |
| `wait until "Dashboard" appears` · `check that the url contains /bills` | code-only waits and checks |
| `goal: …` · `create a new bill with dummy data` · `help me …` | a goal (multi-step, model-planned) |
| `… ?` · `what's the total due?` · `summarize this` | a question about the current page |
| `fill the form with …` | fill every matching field, without submitting |
| `in @[Tab] …` · `go to @[Tab] and …` | switch to that tab first |

### Saved commands & passwords

* **Save** any command from *Recent* with ☆, then run it by typing its name (`login-dev`).
* **Passwords** tab → stored in your macOS Keychain. Write `{{dev-password}}` in a command; the real
  value is typed into the page at the last moment. Models, history and logs only ever see `{{dev-password}}`,
  and password fields are never read back from pages.

### Your own browser

Click the browser button in the bar (or the menu-bar icon → *Browser*) and pick Dia, Arc, Brave, Chrome
or Edge. Voice Browser quits it like <kbd>⌘</kbd><kbd>Q</kbd> (tabs are restored), reopens it with remote
debugging and reconnects. Chrome and Edge don't allow that for your main profile, so they get a separate
profile instead. Your choice is remembered.

## Configuration

Everything lives in `.env` (copy `.env.example`). It is in `.gitignore` and is only read by the local
server — the UI never sees your keys.

| Variable | Needed for | Notes |
|---|---|---|
| `SUBQ_API_KEY` | single actions & chains | [SubQ Snap](https://console.subq.ai) — or `TYPESAFE_API_KEY` for [TypeSafe Jev](https://console.typesafe.ai/keys) |
| `GEMINI_API_KEY` | goals, questions, forms | free key from [Google AI Studio](https://aistudio.google.com); also the fallback for the options below |
| `BRAIN_PROVIDER` + `BRAIN_API_KEY` | goals, questions, forms (optional) | `zai` (GLM 5.3 Flash, vision), `deepseek`, `openrouter` or `custom` — tried before Gemini |
| `BRAIN_MODEL`, `BRAIN_BASE_URL`, `BRAIN_VISION` | optional | override a preset / point `custom` at any OpenAI-compatible API |
| `CDP_URL` | optional | attach to a browser you started with `--remote-debugging-port` |
| `PORT` | optional | local server port (default `8787`, bound to `127.0.0.1`) |

Rough costs: a single action is ~3–6k input tokens on SubQ Snap ($0.05 / 1M input, output free). A goal
step is one call to the "brain" model plus a final check; Gemini Flash-Lite's free tier covers casual use.

## Privacy & safety

* The server listens on **127.0.0.1 only**. Anyone who can reach that port can drive your browser.
* Page content (element list, visible text, a screenshot for goals/questions) is sent to the model
  providers you configure. Free tiers may use prompts to improve their models.
* `{{secrets}}` are resolved from the Keychain only at the moment of typing.
* Risky steps (submit, approve, delete, pay) ask first — treat that as a convenience, not a guarantee,
  and don't connect a browser profile holding accounts you wouldn't want an automated click near.

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## How it works

```
 ⌘⇧Space bar (Electron) ──ws──▶ local Node server ──▶ Playwright ──▶ Chromium / Dia / Arc / Chrome
                                 │
                                 ├─ SubQ Snap / Jev: typed questions → act · wait · ask · ignore  (~0.5–1 s)
                                 └─ "brain" (Gemini / GLM / DeepSeek): goals, questions, forms, follow-ups
```

Single commands are decided by a *decision model* answering a dozen typed questions at once (intent,
target element, "is it complete?", "is it destructive?") with probabilities; code turns those into an
action or a "which one?" prompt. Goals, questions and forms go to a small generative model with the page's
elements, text and a screenshot. Details: **[docs/how-it-works.md](docs/how-it-works.md)**.

```
src/        server, controller, decision policy, goals/questions/forms (smart.js), model clients
desktop/    the macOS command bar (Electron): bar.html, main.cjs, install-mac.sh
test/unit/  fast tests with mocked models and browser — no network
```

## Development

```bash
npm test                    # unit tests, no network or keys needed
npm run test:integration    # real decision-model calls on captured pages (needs a key)
cd desktop && npm start     # run the bar without installing it
./desktop/install-mac.sh    # rebuild /Applications/Voice Browser.app after changing desktop/
```

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

Voice Browser started as a fork of **[jev-voice-browser](https://github.com/moritzkremb/jev-voice-browser)**
by [Moritz Kremb](https://github.com/moritzkremb) — the voice pipeline, decision questions and policy are
his. This fork adds the desktop command bar, SubQ Snap support, chains, goals, questions, forms,
follow-ups, tab mentions, Keychain secrets, waits/checks and connecting your own browser.

## License

[MIT](LICENSE)
