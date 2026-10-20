# Gofer website

A static page: `index.html`, `styles.css`, `demo.js` and `assets/`. No framework and no build tools beyond one script.

- Edit `index.src.html`, then run `node marketing/build.mjs` to write `index.html`. The script inlines the panel's own icons and provider logos from `desktop/bar.html` wherever the source says `%icon:name%`, `%logo:name%`, `%mic%`, `%dl%` or `%pointer%`.
- Open `index.html` in a browser to preview it. The hero demo is scripted in `demo.js`; it plays once when scrolled into view, and shows the finished chat with reduced motion turned on.
- Deploy the folder as-is, for example with GitHub Pages or any static host.
- Download links point at the v0.4.0 release assets; update them in `index.src.html` for a new release.
