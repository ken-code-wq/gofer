# Changelog

## Unreleased

### Added
- **Live view.** The eye button in the header shows a live picture of the agent's tab (it follows the agent to
  other tabs), or any tab you pick, so you can watch a background task without switching to it. It streams with
  the browser's own screencast, a few frames a second and only when the page changes, and only while the panel is
  open. Click the picture or Show to bring that tab to the front.
- **Bot checks are recognised.** "You have been blocked", "Access is temporarily restricted", "Verify you are human"
  and Cloudflare's "Just a moment…" pages are spotted before the next step. The agent stops retrying the page and
  answers from its web search results or another site, instead of saying it can't help. The site is skipped
  for 6 hours unless a request names it (`~/.gofer/blocked.json`).

### Fixed
- **Styled checkboxes were invisible to the agent.** Material UI and similar libraries make the real checkbox
  see-through (or shrink it beside its label), and the page scan dropped anything see-through. So on forms like
  Built POS, "I sell this Product" never reached the model, and it clicked a nearby "Product" option instead.
  They're listed now, by their label, with whether they're ticked ("[checked]" / "[not checked]"). A step that
  says "checkbox" but picks something else is sent back to the model.
- **"continue", "stop", "play", "resume" and "pause" in Chat go to the AI with the conversation.** The video
  shortcut used to take them, so "continue" after a stopped task answered "There's no video or audio playing on
  this page." In Chat, the shortcut now only takes requests that can only mean the video ("go back 10 seconds",
  "go to 2:15", "speed 1.5x", "pause the video"), and even those go to the AI when the page has no video.
  Direct mode keeps the short forms.
- Site notes are no longer "learned" from a site that only showed a block page (they were guesses).
- A web search limited to the site you're on is allowed when that site is blocking you.
- Pages in your browser kept dark mode only until Gofer attached: Playwright forced every page to light mode.
  Your own color scheme now stays.

## 0.5.0 — 2026-10-21

### Added
- **A website**, https://ken-code-wq.github.io/gofer/, with the real panel running beside a scripted task.

### Changed
- **Voice Browser is now Gofer**, with a new icon: a white pointer with a black outline on an indigo gradient that fades to black. The app installs as
  `/Applications/Gofer.app` and the old Voice Browser.app is removed. On first launch your data moves from
  `~/.voice-browser` to `~/.gofer`, and the panel's chats and window settings come along. Passwords stay in
  the Keychain under the old service name, so nothing needs re-entering. Because the app's identity changed,
  macOS asks again for microphone access and for permission to control your browser, and *Start at login*
  needs turning on again from the menu-bar icon.
- Screenshots are saved as `Gofer <date>.png`.
- The GitHub repository is now `ken-code-wq/gofer` (old links redirect), and downloads are named `Gofer-<version>-…`.

## 0.4.0 — 2026-10-20

### Added
- **Background tabs, a task queue and take over.** When a task would take the tab you're looking at to another
  site, it opens a background tab instead (Show brings it forward; a task that finished there says so, with
  Show it). Messages sent while a task runs wait their turn, and questions are answered alongside it. Take over
  pauses the task after its current step so you can log in or solve a captcha, then Hand back; the agent asks
  for this itself when a page needs you. Go back to where I was puts back the tabs a request changed.
- **Video controls without the AI**: "move back 10 seconds and play", "skip ahead 1 minute", "go to 2:15", "pause",
  "speed 1.5x", "mute" act on the page's video directly — instant, exact, and the reply says where it is now
  ("Went back 10 s, playing: now at 1:13 / 10:02"). The agent gets the same as a `video_control` tool, and each step
  on a page with a video reports its time and whether it's playing, so it can tell whether a control worked.
- **Activity logs on disk**, to see what the agent did and fix its mistakes: `~/.voice-browser/logs/agent-<date>.log`
  (every activity line) and `~/.voice-browser/logs/tasks/<time>-<goal>.json` (per task: what the model was shown,
  what it chose, what happened, whether the page changed, confirmations the page showed, the final check). Kept 7
  days, only on this Mac; `VB_TRACE=0` turns it off.
- **Checklists for multi-item tasks** ("add videos by A, B and C to the queue"): split into items up front and
  ticked off as they're done, so the agent and the final check don't re-guess progress (or redo items) every step.
- **Web search and background reading.** The agent can search the web and read pages or PDFs without
  opening a tab or touching your tabs ("who won …?", "find that ad whose jingle went …", "find the
  official site and open it"). Questions the page can't answer are looked up and cite their sources
  ("From the web: …", with a link). Search uses Tavily or the Brave Search API when you add a key (⋯ → AI
  models → Better web search), otherwise Brave's public results, then Gemini's Google Search, then Groq's
  search — so it doesn't depend on one provider. Models are told today's date, so recent events get looked
  up instead of answered from stale knowledge.
- **Tool calls.** The agent now picks its steps with the models' native tool calling (click, type_text,
  press_key, new_tab, web_search, read_url, finish, …) on every provider, falling back to the JSON step
  format when no model can. Searches asked for together run in parallel; a repeated search isn't run again.

### Added (subagent work, merged)
- **Voice**: click the mic in the composer or hold ⌥ Option and speak; Groq Whisper transcribes it, shows
  it briefly and sends it. Replies to spoken requests are read aloud (Groq Orpheus once its terms are
  accepted in the Groq console, the Mac's voice until then); every reply has Read aloud. Esc stops.
- **Site notes**: the agent keeps short know-how per site. After a task it may learn a lesson ("Learned: …"
  under the reply, with Undo); teach it with "remember that on workbook bills are under sales"; ask "what
  do you know about this site?". Starter notes for YouTube, Gmail, Google Calendar, Google Docs, GitHub.
  Never stores what you typed, emails, amounts or passwords. Site notes view: ⌘5 or ⋯ → Site notes.
- **Reading pages properly**: YouTube questions use the video's captions (answers cite the time, with
  "Play from m:ss"); PDFs are read page by page (answers cite the page); Google Docs / Sheets / Slides via
  their export; long pages keep the main content and the parts relevant to the question. "Compare these
  tabs" / "compare @A @B" answers with a table and a one-line verdict.

### Fixed
- The header's Show button was always visible (and squeezed the browser name to one letter); it now only
  appears while a task works in a background tab.
- The agent couldn't see menus that sites add at the end of the page (YouTube's ⋮ menu: "Add to queue") because
  the element scan stopped first; open menus, dialogs and popups are now read first and marked "[in open menu]".
- Opening a menu or a step that only shows a toast was taken for "the page didn't change" (only the URL and title
  were compared), so the agent abandoned the right control; it now compares what's on screen too, and passes on
  confirmations the page flashes ("Added to Queue").
- Single-page sites: the next look waits until the page holds still, so it doesn't see the old results and
  search again. A step that hangs fails after 45 s instead of blocking the queue. The same click repeated over
  and over is pointed out, then stopped. Web searches for the site it's already on use the site's own search.
- Tasks may take up to 25 browser steps (searches and page reads don't count).
- One model's odd error (e.g. Groq's "Tool choice is none, but model called a tool") no longer ends the task:
  the next model answers, and a failed step is retried up to 3 times.
- The chat no longer scrolls sideways; long words wrap.
- Direct mode failed on pages with emoji in the title (text cut mid-emoji was rejected with a 422).
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
