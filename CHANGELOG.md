# Changelog

## Unreleased

### Fixed
- "Play the next video" (and other "move on" requests) no longer report success on the same page. Each
  step records whether the page changed (waiting up to 2.5 s for slow sites like YouTube); a control that
  changes nothing isn't repeated; the final check compares with where the task started. Tasks stay in the
  current tab, stop as soon as they're done, and can press keyboard shortcuts (YouTube: Shift+N next video).
- The agent no longer jumps to one of your tabs when the browser wakes it up from sleep mid-task, and a click
  only follows a new tab that the clicked page opened.

### Changed
- **The bar is now a chat.** A taller panel with your messages on the right and the agent's replies on the
  left, live steps while it works, and a send / stop button. Every message runs as a goal that sees the
  whole conversation, so "no please, another one" redoes the last request with a different result, and
  "now delete them" knows what "them" is.
- The old instant command mode is now **Direct** mode (<kbd>Tab</kbd> switches). Ask mode is gone: Chat answers
  questions itself.
- Saved commands, passwords and past chats moved to the ⋯ menu (<kbd>⌘</kbd><kbd>2</kbd>–<kbd>4</kbd>).

### Added
- **Screenshots in the chat**: "send me a screenshot" (or "… of the whole page") replies with the image;
  a task can end with one too ("find the cheapest flight and send me a screenshot"). Click it to open the
  PNG (also saved in Downloads), or Copy / Show in Finder.
- **Browser picker in the panel**, with each browser's own app icon (replaces the native menu).
- **Several AI providers at once**: Groq (GPT-OSS 120B / 20B, Qwen 3.8 27B), Gemini, Z.ai, DeepSeek and
  OpenRouter, each with its own key. **Auto** sends each request to the fastest suitable model and moves
  to the next one when a model is rate limited (honouring Retry-After). The model picker in the composer (an in-panel list with
  each provider's logo) pins one or adds a provider's key. Replies show which models handled them. A two-turn chat went from about
  80 s + 18 s (Gemini only) to 7 s + 9 s.
- **Liquid Glass** on macOS 26: the panel sits on Apple's native glass (`electron-liquid-glass`); older
  systems keep the blur.
- **Memory**: chats are kept between launches (also on the server, so follow-ups still work after a
  restart), and "remember that …" saves a fact for every chat ("what do you remember?", "forget …").
- **Current tab**: the header shows the tab commands run in, follows the tab you switch to in an attached
  browser, and opens a picker on click. "In the current / active / open tab, …" runs a command there.
- **Goals use other tabs**: a goal can open a new tab (with an address), switch to any open tab, or close
  one, instead of working only in the current tab. Saved goals replay these steps too.

## 0.3.1

### Fixed
- "Can't reach the browser service" when attached to Dia, Arc or Chrome with sleeping tabs: tabs that don't
  answer are skipped while connecting and added once they wake up.
- The browser service restarts itself if it stops, and logs to `~/.voice-browser/server.log`.

## 0.3.0

### Added
- Downloadable builds for macOS (Apple silicon and Intel), Windows and Linux, attached to each GitHub release.
  Packaged apps keep keys in `~/.voice-browser/.env` and download Chromium on first run.
  Attaching to Dia, Arc, Chrome, Brave or Edge is macOS-only for now; other systems use the built-in Chromium.
- **Ask mode** (Tab, or the Ask switch): whatever you type is a question, never an action.
- Questions across tabs: "which of my tabs …", "across my tabs", or two or more `@` tabs; answers name
  the tabs they used, without switching tabs.
- General questions are answered from the AI's own knowledge when the page doesn't cover them, and
  marked as such.
- **Save a finished goal as a command**: its steps replay without the AI, typed values become changeable
  values (`new-bill Globex, 99`), risky steps still ask.
- **Spend meter** in the footer with per-command cost, weekly total and an optional daily limit.
- **Table copy**: `copy the table` (no AI) and `copy all … as a table` (AI), to the clipboard as
  spreadsheet-ready text, or CSV in Downloads with `export … as csv`.
- Saved commands with values: `{}` or `{name}` slots, filled from what you type after the name.
- **New** button in *Saved* to write a saved command directly.
- Instant `screenshot` (visible or whole page, saved to Downloads) and `copy url` / `copy title`.
- Copy button (and `C` key) for results and answers.
- macOS notification when long work finishes while the bar is in the background.

### Fixed
- `@` tab list shows instantly: titles arrive first and icons follow, the list refreshes when the bar opens
  and when tabs change, and a sleeping tab can no longer hold it up.
- The bar no longer gives up after 30 s when the browser service starts slowly; it waits and retries.

## 0.2.0 — 2026-10-13

First release of **Voice Browser** (fork of [jev-voice-browser](https://github.com/moritzkremb/jev-voice-browser)).

### Added
- macOS command bar (Electron): ⌘⇧Space (changeable), menu-bar icon, start at login, resizable, light/dark.
- SubQ Snap support (`SUBQ_API_KEY`) alongside TypeSafe Jev.
- Chains (`a, b, then c`), verbless "find it" steps, click-then-type merging.
- Waits and checks run in code, with failure screenshots.
- Goals, page questions and form filling via a "brain" model: Gemini Flash-Lite (free) or any
  OpenAI-compatible provider (GLM 5.3 Flash via Z.ai, DeepSeek, OpenRouter), with fallback and cooldown.
- Goal verification before "done", Allow / Allow all / Stop for risky steps.
- Follow-up threads: replies run in the same tab with the conversation, rewritten to name exact items.
- `@` tab mentions with favicon chips coloured from the icon.
- Connect your own browser (Dia, Arc, Brave, Chrome, Edge) with its real icon; Chrome/Edge use a separate profile.
- Saved commands; passwords in the macOS Keychain as `{{name}}`.
- Local / dev URLs (`localhost:3000/…`, IPs) and form-label reading; password values never read.

### Fixed
- Endless retries on unclear typed commands (now gives up after 3).
- Search suggestion dropdowns being clicked instead of results.
- Attached browsers' tabs being closed on quit (now only disconnects).
