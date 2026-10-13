/**
 * Saved commands ("login-dev" -> a whole chain). Stored as JSON in ~/.voice-browser/commands.json
 * (outside the project, so reinstalling or updating the code keeps them). VB_DATA_DIR overrides
 * the folder (tests).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DATA_DIR = process.env.VB_DATA_DIR || path.join(os.homedir(), ".voice-browser");
const FILE = () => path.join(DATA_DIR, "commands.json");

export const normalizeName = (name) =>
  String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 40);

export function listCommands() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE(), "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function write(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, FILE());
}

export function saveCommand(name, text) {
  const n = normalizeName(name);
  const t = String(text || "").trim();
  if (!n) throw new Error("Give the command a name (letters, numbers, - or _)");
  if (!t) throw new Error("Nothing to save");
  const list = listCommands().filter((c) => c.name !== n);
  list.push({ name: n, text: t, savedAt: Date.now() });
  list.sort((a, b) => a.name.localeCompare(b.name));
  write(list);
  return list;
}

export function deleteCommand(name) {
  const n = normalizeName(name);
  const list = listCommands().filter((c) => c.name !== n);
  write(list);
  return list;
}

// "{}" or "{query}" in a saved command is a slot filled from what follows the name; "{{name}}" stays a
// Keychain placeholder.
const SLOT = /(?<!\{)\{([\w-]*)\}(?!\})/g;
export const slotsOf = (text) => [...String(text || "").matchAll(SLOT)].map((m) => m[1] || "value");

/**
 * "login-dev" or "run login-dev" -> the saved command. "yt cats" fills the slot of a saved
 * "yt" = "search youtube for {}" (several slots take comma-separated values). A name with
 * missing values returns { missing: [...] }; anything else returns null.
 */
export function resolveSaved(text) {
  const m = String(text || "").trim().match(/^(?:run\s+)?([\w.-]+)(?:\s+([\s\S]+))?$/i);
  if (!m) return null;
  const hit = listCommands().find((c) => c.name === normalizeName(m[1]));
  if (!hit) return null;
  const slots = slotsOf(hit.text);
  const arg = (m[2] || "").trim();
  if (!slots.length) return arg ? null : hit;
  const values = slots.length === 1 ? [arg] : arg.split(/\s*,\s*/);
  if (values.length < slots.length || values.some((v) => !v)) return { ...hit, missing: slots.slice(values.filter(Boolean).length) };
  let i = 0;
  return { ...hit, text: hit.text.replace(SLOT, () => values[i++]) };
}
