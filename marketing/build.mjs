#!/usr/bin/env node
/**
 * index.src.html -> index.html: inlines the panel's own icons and provider logos (taken from
 * desktop/bar.html, so the site always matches the app) wherever the source says %icon:name%,
 * %logo:name%, %mic% or %dl%. No other processing.
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
  mic: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M128,176a48.05,48.05,0,0,0,48-48V64a48,48,0,0,0-96,0v64A48.05,48.05,0,0,0,128,176ZM96,64a32,32,0,0,1,64,0v64a32,32,0,0,1-64,0Zm40,143.6V232a8,8,0,0,1-16,0V207.6A80.11,80.11,0,0,1,48,128a8,8,0,0,1,16,0,64,64,0,0,0,128,0,8,8,0,0,1,16,0A80.11,80.11,0,0,1,136,207.6Z"/></svg>',
  dl: '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M224,144v64a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V144a8,8,0,0,1,16,0v56H208V144a8,8,0,0,1,16,0Zm-101.66,5.66a8,8,0,0,0,11.32,0l40-40a8,8,0,0,0-11.32-11.32L136,124.69V32a8,8,0,0,0-16,0v92.69L93.66,98.34a8,8,0,0,0-11.32,11.32Z"/></svg>',
};

let missing = [];
const out = fs.readFileSync(path.join(here, "index.src.html"), "utf8").replace(/%(icon|logo):(\w+)%|%(mic|dl)%/g, (m, kind, name, x) => {
  const svg = x ? extra[x] : (kind === "icon" ? ICON : LOGO)[name];
  if (!svg) missing.push(m);
  // logos carry a <title>; the text next to them already names the provider
  return (svg || "").replace(/<title>.*?<\/title>/, "");
});
if (missing.length) throw new Error(`unknown: ${missing.join(", ")}`);
fs.writeFileSync(path.join(here, "index.html"), out);
console.log("wrote marketing/index.html");
