#!/usr/bin/env node
/**
 * index.src.html -> index.html: inlines the panel's own icons and provider logos (taken from
 * desktop/bar.html, so the site always matches the app) wherever the source says %icon:name%,
 * %logo:name%, %mic%, %dl%, %pointer% or %cursor%.
 *
 * desktop/bar.html -> panel.html: the real panel for the hero, always in dark mode, with
 * panel-shim.js standing in for the Electron shell and the server.
 *
 *   node marketing/build.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bar = fs.readFileSync(path.join(here, "..", "desktop", "bar.html"), "utf8");
const object = (name) => {
  const start = bar.indexOf(`const ${name} = `) + `const ${name} = `.length;
  let depth = 0, i = start, inStr = false;
  for (; i < bar.length; i++) {
    const c = bar[i];
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) break;
  }
  return JSON.parse(bar.slice(start, i + 1));
};
const ICON = object("ICON");
const LOGO = object("LOGO");
const extra = {
  // a mouse pointer, for the agent's clicks
  cursor: '<svg viewBox="-24 -34 350 430" aria-hidden="true"><path d="M0 0 L0 312 C0 330 20 338 32 325 L102 250 L152 360 C158 374 174 380 188 374 L222 358 C236 352 242 336 236 322 L186 214 L290 214 C308 214 316 192 302 180 L28 -10 C16 -20 0 -14 0 0 Z" fill="currentColor" stroke="#fff" stroke-width="24" stroke-linejoin="round"/></svg>',
  // the app's menu-bar glyph: a pointer
  pointer: '<svg viewBox="-70 -60 450 450" aria-hidden="true"><path d="M0 0 L0 312 C0 330 20 338 32 325 L102 250 L152 360 C158 374 174 380 188 374 L222 358 C236 352 242 336 236 322 L186 214 L290 214 C308 214 316 192 302 180 L28 -10 C16 -20 0 -14 0 0 Z" fill="currentColor" stroke="currentColor" stroke-width="20" stroke-linejoin="round"/></svg>',
  mic: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M128,176a48.05,48.05,0,0,0,48-48V64a48,48,0,0,0-96,0v64A48.05,48.05,0,0,0,128,176ZM96,64a32,32,0,0,1,64,0v64a32,32,0,0,1-64,0Zm40,143.6V232a8,8,0,0,1-16,0V207.6A80.11,80.11,0,0,1,48,128a8,8,0,0,1,16,0,64,64,0,0,0,128,0,8,8,0,0,1,16,0A80.11,80.11,0,0,1,136,207.6Z"/></svg>',
  dl: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M224,144v64a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V144a8,8,0,0,1,16,0v56H208V144a8,8,0,0,1,16,0Zm-101.66,5.66a8,8,0,0,0,11.32,0l40-40a8,8,0,0,0-11.32-11.32L136,124.69V32a8,8,0,0,0-16,0v92.69L93.66,98.34a8,8,0,0,0-11.32,11.32Z"/></svg>',
};

let missing = [];
const out = fs.readFileSync(path.join(here, "index.src.html"), "utf8").replace(/%(icon|logo):(\w+)%|%(mic|dl|pointer|cursor)%/g, (m, kind, name, x) => {
  const svg = x ? extra[x] : (kind === "icon" ? ICON : LOGO)[name];
  if (!svg) missing.push(m);
  // logos carry a <title>; the text next to them already names the provider
  return (svg || "").replace(/<title>.*?<\/title>/, "");
});
if (missing.length) throw new Error(`unknown: ${missing.join(", ")}`);
fs.writeFileSync(path.join(here, "index.html"), out);
console.log("wrote marketing/index.html");

const dia = `data:image/png;base64,${fs.readFileSync(path.join(here, "assets", "dia.png")).toString("base64")}`;
const yt = `data:image/png;base64,${fs.readFileSync(path.join(here, "assets", "demo", "youtube.png")).toString("base64")}`;
const shim = fs.readFileSync(path.join(here, "panel-shim.js"), "utf8").replace("%dia%", dia).replace("%yt%", yt);
const darkRules = (bar.match(/@media \(prefers-color-scheme: dark\)/g) || []).length;
if (!darkRules) throw new Error("bar.html has no dark-mode rules to force");
const panel = bar
  .replace(/@media \(prefers-color-scheme: dark\)/g, "@media all")
  .replace("<title>", `<script>${shim}</script>\n<title>`); // after the charset and CSP meta tags
fs.writeFileSync(path.join(here, "panel.html"), panel);
console.log(`wrote marketing/panel.html (${darkRules} dark-mode rules forced)`);
