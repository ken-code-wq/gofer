/**
 * Passwords and other secrets live in the macOS Keychain (service "voice-browser": the app's old
 * name, kept so passwords saved before the rename still work). Commands refer
 * to them as {{name}}; the real value is filled in only at the moment of typing, so the model,
 * the logs, the history and the UI only ever see the placeholder.
 */
import { execFile } from "node:child_process";

const SERVICE = "voice-browser";
export const SECRET_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;
const NAME_RE = /^[\w.-]{1,40}$/;

function security(args) {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/security", args, { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(String(stderr || err.message).trim()), { code: err.code }));
      else resolve(String(stdout));
    });
  });
}

export async function setSecret(name, value) {
  if (!NAME_RE.test(name || "")) throw new Error("Name: letters, numbers, - _ . only (max 40)");
  if (!value) throw new Error("Value is empty");
  await security(["add-generic-password", "-U", "-s", SERVICE, "-a", name, "-l", `Gofer: ${name}`, "-w", value]);
}

export async function deleteSecret(name) {
  await security(["delete-generic-password", "-s", SERVICE, "-a", name]).catch(() => {});
}

export async function getSecret(name) {
  try {
    return (await security(["find-generic-password", "-s", SERVICE, "-a", name, "-w"])).replace(/\n$/, "");
  } catch {
    return null;
  }
}

/** Names only — values never leave the Keychain except into a page field. */
export async function listSecrets() {
  let dump = "";
  try {
    dump = await security(["dump-keychain"]);
  } catch {
    return [];
  }
  const names = new Set();
  for (const block of dump.split(/^keychain: /m)) {
    if (!block.includes(`"svce"<blob>="${SERVICE}"`)) continue;
    const acct = block.match(/"acct"<blob>="([^"]*)"/);
    if (acct) names.add(acct[1]);
  }
  return [...names].sort();
}

export const hasSecrets = (text) => /\{\{\s*[\w.-]+\s*\}\}/.test(String(text || ""));

/** Replace {{name}} with Keychain values. Throws naming the first missing secret. */
export async function resolveSecrets(text) {
  const s = String(text ?? "");
  if (!hasSecrets(s)) return s;
  const names = [...new Set([...s.matchAll(SECRET_RE)].map((m) => m[1]))];
  const values = {};
  for (const n of names) {
    const v = await getSecret(n);
    if (v == null) throw new Error(`There's no saved password called "${n}". Add it under Passwords in the bar.`);
    values[n] = v;
  }
  return s.replace(SECRET_RE, (_, n) => values[n]);
}
