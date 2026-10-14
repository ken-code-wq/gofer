# Changelog

## Unreleased

### Added
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
