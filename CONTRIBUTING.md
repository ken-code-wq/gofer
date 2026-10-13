# Contributing to Voice Browser

Thanks for helping! Bug reports, ideas and pull requests are all welcome.

## Getting set up

```bash
git clone https://github.com/ken-code-wq/voice-browser.git
cd voice-browser
npm install
npx playwright install chromium
cp .env.example .env        # add your own keys; never commit this file
npm test                    # unit tests — no keys or network needed
```

Run the desktop bar without installing it: `cd desktop && npm install && npm start`.
After changing anything in `desktop/`, `./desktop/install-mac.sh` rebuilds `/Applications/Voice Browser.app`.
Changes in `src/` only need the app (or `./run.sh`) restarted.

## Making a change

1. Open an issue first for anything larger than a small fix, so we can agree on the approach.
2. Keep pull requests focused — one feature or fix each.
3. Add or update unit tests in `test/unit/` (they mock the models and the browser, so they're fast and free).
4. `npm test` must pass. CI runs it on every pull request.
5. Match the surrounding style: small modules, plain JavaScript (ES modules in `src/`, CommonJS in
   `desktop/*.cjs`), comments that explain *why*.

## Ground rules

* **Never commit secrets.** `.env`, browser profiles and `node_modules` are git-ignored; keep it that way.
  Use `{{name}}` Keychain placeholders in examples, never real passwords or keys.
* Models must not see secret values, and password fields must never be read from pages.
* Anything that can submit, pay, send or delete must go through the confirm / Allow flow.
* Screenshots in docs should use neutral demo data, not real accounts or tabs.

## Reporting bugs

Use the bug report template. Helpful details: macOS version, which browser you control, which model
providers are configured (not the keys!), the command you typed, and what happened. The control page
(<http://localhost:8787>) shows each decision and the log — a screenshot of it often explains the bug.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind.
