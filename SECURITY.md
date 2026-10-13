# Security policy

Voice Browser can click, type and submit in a real browser that may be signed in to your accounts, so we
take security reports seriously.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Instead, use
[GitHub's private vulnerability reporting](https://github.com/ken-code-wq/voice-browser/security/advisories/new)
for this repository. Include steps to reproduce and the impact you expect. You'll get a reply as soon as
possible; please give us a reasonable time to fix it before disclosing publicly.

## Design notes

* The local server binds to `127.0.0.1` only. Anything that can reach its port can drive the controlled
  browser and spend your API credits — don't expose it with `--host 0.0.0.0` on untrusted networks.
* API keys are read from `.env` by the local server only; the UI never receives them. `.env` is git-ignored.
* Passwords are stored in the macOS Keychain (service `voice-browser`) and referenced as `{{name}}`. Values
  are resolved only when typing into a page, are never sent to model providers, and never written to
  history or logs. Password field values are never read from pages.
* Page content (element list, visible text, screenshots for goals and questions) **is** sent to the model
  providers you configure. Check their data-use terms, especially for free tiers.
* Risky actions ask for confirmation, but that is a safeguard, not a guarantee — prefer a separate browser
  profile for automation.

## Supported versions

Only the latest `main` is supported.
