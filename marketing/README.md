# Gofer website

A static page: `index.html`, `styles.css`, `demo.js` and `assets/`. No framework and no build tools beyond one script.

- Edit `index.src.html`, then run `node marketing/build.mjs` to write `index.html`. The script inlines the panel's own icons and provider logos from `desktop/bar.html` wherever the source says `%icon:name%`, `%logo:name%`, `%mic%`, `%dl%` or `%pointer%`.
- The build also writes `panel.html`: the app's real `desktop/bar.html`, forced into dark mode, with `panel-shim.js` standing in for the Electron shell and the server. The hero shows it in an iframe; `demo.js` plays the server's side of a task (it types into the panel and sends back the same events the real server sends) while the browser window shows real YouTube pages captured at 1440×900, 2× (`assets/demo/`). It plays once when scrolled into view.
- Serve the folder over http to preview it (`python3 -m http.server` in `marketing/`); opening `index.html` from disk works too.
- It's published to https://ken-code-wq.github.io/voice-browser/ by `.github/workflows/pages.yml` on every push to main that touches `marketing/` or `desktop/bar.html`. The workflow rebuilds first, so the panel always matches the app.
- Download links point at the v0.4.0 release assets; update them in `index.src.html` for a new release.
