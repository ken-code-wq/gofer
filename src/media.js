/**
 * Video and audio controls without the AI: "move back 10 seconds and play", "skip 30s", "pause",
 * "go to 2:15", "speed 1.5x", "mute". They act on the page's main <video>/<audio> directly, so
 * they're instant, exact and checkable (the reply says where the video is now).
 *
 * The agent also gets this as a tool (video_control), and every goal step on a page with a video
 * reports the video's state, so "did J work?" is no longer a guess.
 */

const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90 };
const num = (s) => (s in NUM_WORDS ? NUM_WORDS[s] : Number(s));
const UNIT = String.raw`(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|sixty|ninety)\s*(s|sec|secs|seconds?|m|min|mins|minutes?)\b`;
const toSec = (n, unit) => num(n) * (/^m/i.test(unit) ? 60 : 1);

/** "2:15", "1:02:03" -> seconds. */
const clock = (s) => s.split(":").map(Number).reduce((a, b) => a * 60 + b, 0);

/**
 * One clause -> a media action, or null. Actions: { op: "seek_by", seconds } | { op: "seek_to", seconds }
 * | { op: "play" } | { op: "pause" } | { op: "restart" } | { op: "speed", rate } | { op: "mute" } | { op: "unmute" }
 */
function parseClause(c) {
  let m;
  if ((m = c.match(new RegExp(String.raw`^(?:go|move|jump|skip|rewind|seek)?\s*(?:it\s+)?(?:back(?:wards?)?|rewind)\s*(?:by\s+)?${UNIT}`, "i")))) return { op: "seek_by", seconds: -toSec(m[1], m[2]) };
  if ((m = c.match(new RegExp(String.raw`^(?:rewind|go back|back)\s+(?:by\s+)?${UNIT}`, "i")))) return { op: "seek_by", seconds: -toSec(m[1], m[2]) };
  if ((m = c.match(new RegExp(String.raw`^(?:go|move|jump|skip|fast[- ]?forward|seek)\s*(?:it\s+)?(?:forward|ahead|on)?\s*(?:by\s+)?${UNIT}(?:\s+(?:forward|ahead))?$`, "i")))) return { op: "seek_by", seconds: toSec(m[1], m[2]) };
  if ((m = c.match(new RegExp(String.raw`^${UNIT}\s+(back(?:wards?)?|forward|ahead)$`, "i")))) return { op: "seek_by", seconds: toSec(m[1], m[2]) * (/^back/i.test(m[3]) ? -1 : 1) };
  if ((m = c.match(/^(?:go|jump|skip|seek|move)?\s*(?:to|at)\s+(\d{1,2}(?::\d{2}){1,2})$/i))) return { op: "seek_to", seconds: clock(m[1]) };
  if (/^(?:start (?:it )?(?:over|again|from the (?:start|beginning))|restart(?: (?:it|the video))?|from the (?:start|beginning)|go to the (?:start|beginning))$/i.test(c)) return { op: "restart" };
  if (/^(?:play|resume|unpause|continue|continue playing|keep playing|start playing)(?: (?:it|the video|the song|playback))?$/i.test(c)) return { op: "play" };
  if (/^(?:pause|stop)(?: (?:it|the video|the song|playback))?$/i.test(c)) return { op: "pause" };
  if ((m = c.match(/^(?:set (?:the )?)?(?:speed|playback speed|play(?:back)? rate)\s*(?:to\s+)?(\d+(?:\.\d+)?)\s*x?$/i)) || (m = c.match(/^(?:play (?:it )?at\s+)?(\d+(?:\.\d+)?)\s*x(?: speed)?$/i))) return { op: "speed", rate: Number(m[1]) };
  if (/^(?:normal speed|speed (?:back )?to normal)$/i.test(c)) return { op: "speed", rate: 1 };
  if (/^mute(?: (?:it|the video|the sound))?$/i.test(c)) return { op: "mute" };
  if (/^(?:unmute|sound on)(?: (?:it|the video))?$/i.test(c)) return { op: "unmute" };
  return null;
}

// Names the video or song, so "play" or "stop" can only mean the player.
/**
 * A whole request -> [actions], or null if any part isn't a media control (then the agent handles
 * it). "move back 10 seconds and play" -> [{ seek_by -10 }, { play }]. Direct mode only: Chat gives
 * these to the AI, which sees the conversation and has the same controls as a tool.
 */
export function parseMedia(text) {
  const t = String(text || "")
    .trim()
    .replace(/[.!?]+$/, "")
    .replace(/^(?:please|can you|could you|now)\s+/i, "")
    .replace(/\b(?:the video|this video|the song)\s+(?=back|forward|ahead)/i, "")
    .replace(/\s+please$/i, "");
  if (!t || t.split(/\s+/).length > 14) return null;
  const parts = t.split(/\s*(?:,\s*(?:and\s+|then\s+)?|\s+and\s+(?:then\s+)?|\s+then\s+)\s*/i).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const a = parseClause(p.trim());
    if (!a) return null;
    out.push(a);
  }
  return out.length ? out : null;
}

const fmt = (sec) => {
  if (!Number.isFinite(sec)) return "?";
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
};

/** A video/audio state as words: "1:13 / 10:02, playing". */
export const stateText = (st) =>
  st ? `${fmt(st.time)} / ${fmt(st.duration)}, ${st.paused ? "paused" : "playing"}${st.rate !== 1 ? `, ${st.rate}x` : ""}${st.muted ? ", muted" : ""}` : "";

/** Runs in the page: the main media element's state, or null. */
export function mediaState() {
  const els = [...document.querySelectorAll("video, audio")].filter((m) => Number.isFinite(m.duration) && m.duration > 0);
  const area = (m) => (m.tagName === "VIDEO" ? m.getBoundingClientRect().width * m.getBoundingClientRect().height : 1);
  const m = els.filter((x) => !x.paused)[0] || els.sort((a, b) => area(b) - area(a))[0];
  return m ? { time: m.currentTime, duration: m.duration, paused: m.paused, rate: m.playbackRate, muted: m.muted } : null;
}

/** Runs in the page: apply the actions to the main media element. */
function applyInPage(actions) {
  const els = [...document.querySelectorAll("video, audio")].filter((m) => Number.isFinite(m.duration) && m.duration > 0);
  const area = (m) => (m.tagName === "VIDEO" ? m.getBoundingClientRect().width * m.getBoundingClientRect().height : 1);
  const m = els.filter((x) => !x.paused)[0] || els.sort((a, b) => area(b) - area(a))[0];
  if (!m) return { error: "There's no video or audio playing on this page." };
  const before = m.currentTime;
  const wants = [];
  for (const a of actions) {
    if (a.op === "seek_by") m.currentTime = Math.min(Math.max(0, m.currentTime + a.seconds), m.duration - 0.5);
    else if (a.op === "seek_to") m.currentTime = Math.min(Math.max(0, a.seconds), m.duration - 0.5);
    else if (a.op === "restart") m.currentTime = 0;
    else if (a.op === "speed") m.playbackRate = Math.min(4, Math.max(0.25, a.rate));
    else if (a.op === "mute") m.muted = true;
    else if (a.op === "unmute") m.muted = false;
    else if (a.op === "pause") m.pause();
    else if (a.op === "play") wants.push("play");
  }
  if (wants.length) m.play().catch(() => {});
  return { before };
}

/**
 * Do the actions on `page`. Returns { ok, detail, state } where detail is the reply
 * ("Went back 10 s and playing: 1:13 / 10:02").
 */
export async function runMedia(page, actions) {
  const r = await Promise.race([page.evaluate(applyInPage, actions).catch((e) => ({ error: e.message })), new Promise((res) => setTimeout(() => res({ error: "the page didn't respond" }), 3000))]);
  if (r.error) return { ok: false, detail: r.error };
  await new Promise((res) => setTimeout(res, 350));
  let st = await page.evaluate(mediaState).catch(() => null);
  // the browser may refuse play() from a script: use the page's own control instead
  if (st?.paused && actions.some((a) => a.op === "play")) {
    if (/youtube\.com/.test(page.url())) await page.keyboard.press("k").catch(() => {});
    else await page.locator("video").first().click({ timeout: 2000 }).catch(() => {});
    await new Promise((res) => setTimeout(res, 400));
    st = await page.evaluate(mediaState).catch(() => null);
  }
  const did = actions
    .map((a) =>
      a.op === "seek_by" ? `${a.seconds < 0 ? "went back" : "skipped ahead"} ${Math.abs(a.seconds) >= 60 && Math.abs(a.seconds) % 60 === 0 ? `${Math.abs(a.seconds) / 60} min` : `${Math.abs(a.seconds)} s`}`
      : a.op === "seek_to" ? `jumped to ${fmt(a.seconds)}`
      : a.op === "restart" ? "started it over"
      : a.op === "speed" ? `set the speed to ${a.rate}x`
      : a.op === "play" ? "playing"
      : a.op === "pause" ? "paused"
      : a.op === "mute" ? "muted"
      : "unmuted",
    )
    .join(", ");
  return { ok: true, detail: `${did[0].toUpperCase()}${did.slice(1)}${st ? `: now at ${stateText(st)}` : ""}.`, state: st };
}
