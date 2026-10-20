/**
 * Chat memory that survives restarts:
 *  - conversations (~/.gofer/chats.json): what was asked and what happened, per chat, so
 *    "no, another one" still means something after the app restarts;
 *  - facts (~/.gofer/memory.json): things you asked it to remember ("remember that my
 *    work email is …"), given to every chat.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./store.js";

const CHATS = () => path.join(DATA_DIR, "chats.json");
const FACTS = () => path.join(DATA_DIR, "memory.json");
const MAX_CHATS = 50;
const MAX_TURNS = 40;
const MAX_FACTS = 50;

function read(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function write(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

/** { id: [{ role, text }] } for the most recent chats. */
export function loadChats() {
  const data = read(CHATS(), {});
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}

let timer = null;
let pending = null;
/** Save the turns of every chat (debounced; the tab a chat used isn't saved). */
export function saveChats(threads) {
  pending = threads;
  clearTimeout(timer);
  timer = setTimeout(flushChats, 300);
}

export function flushChats() {
  clearTimeout(timer);
  if (!pending) return;
  const out = {};
  for (const [id, t] of [...pending.entries()].slice(-MAX_CHATS)) {
    if (t.turns?.length) out[id] = t.turns.slice(-MAX_TURNS);
  }
  pending = null;
  try {
    write(CHATS(), out);
  } catch {}
}

export function deleteChat(id) {
  const all = loadChats();
  delete all[id];
  try {
    write(CHATS(), all);
  } catch {}
}

export function listFacts() {
  const f = read(FACTS(), []);
  return Array.isArray(f) ? f.filter((x) => typeof x === "string") : [];
}

export function rememberFact(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
  if (!t) return listFacts();
  const facts = listFacts().filter((f) => f.toLowerCase() !== t.toLowerCase());
  facts.push(t.slice(0, 300));
  write(FACTS(), facts.slice(-MAX_FACTS));
  return listFacts();
}

/** Forget facts that mention `what` ("forget my work email"). Returns how many were removed. */
export function forgetFacts(what) {
  const words = String(what || "").toLowerCase().replace(/^(?:that|about|the fact that)\s+/, "").split(/\W+/).filter((w) => w.length > 2 && !/^(?:my|the|that|about|what|you|know)$/.test(w));
  const facts = listFacts();
  const keep = words.length ? facts.filter((f) => !words.every((w) => f.toLowerCase().includes(w))) : facts;
  write(FACTS(), keep);
  return facts.length - keep.length;
}

/** "remember that …" / "forget …" / "what do you remember?" -> { kind, text } or null. */
export function parseMemoryCommand(text) {
  const t = String(text || "").trim();
  let m;
  if ((m = t.match(/^(?:please\s+)?remember(?:\s+that)?\s*[:,]?\s+(.{3,})$/is))) return { kind: "remember", text: m[1] };
  if (/^(?:what do you (?:remember|know about me)|what have you remembered|show (?:your |my )?memory|list (?:your |my )?memor(?:y|ies))\??$/i.test(t)) return { kind: "list" };
  if ((m = t.match(/^(?:please\s+)?forget\s+(?:that\s+|about\s+)?(.{3,})$/is))) return { kind: "forget", text: m[1] };
  return null;
}
