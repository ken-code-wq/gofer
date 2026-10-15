/**
 * A thin relay between Playwright and an attached browser's DevTools port (Dia, Arc, Chrome).
 *
 * Playwright's connectOverCDP waits until every open tab answers. Tabs the browser has put to
 * sleep never do, so with a few sleeping tabs the connection hangs forever. The relay checks each
 * tab first, hides the ones that don't answer from Playwright, and hands each one over as soon as it
 * wakes up (for example when you click it).
 */
import WebSocket, { WebSocketServer } from "ws";

const OWN = 1_000_000_000; // ids above this are the relay's own requests, never forwarded

/** Opens a short-lived DevTools connection and calls fn(send). */
async function withSession(wsUrl, fn) {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  ws.on("message", (m) => {
    const d = JSON.parse(m);
    if (d.id && pending.has(d.id)) pending.get(d.id)(d), pending.delete(d.id);
  });
  await new Promise((resolve, reject) => (ws.once("open", resolve), ws.once("error", reject)));
  const send = (method, params = {}, sessionId, ms = 2000) =>
    new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params, sessionId }));
      setTimeout(() => pending.delete(i) && resolve({ timeout: true }), ms);
    });
  try {
    return await fn(send);
  } finally {
    ws.close();
  }
}

/** Target ids of tabs that don't answer within `ms` (asleep or frozen). */
export async function unresponsiveTabs(wsUrl, { ms = 2000, only = null } = {}) {
  return withSession(wsUrl, async (send) => {
    const r = await send("Target.getTargets");
    const pages = (r.result?.targetInfos || []).filter((t) => t.type === "page" && (!only || only.has(t.targetId)));
    const hung = new Set();
    await Promise.all(
      pages.map(async (t) => {
        const a = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
        const sessionId = a.result?.sessionId;
        if (!sessionId) return; // closed meanwhile
        const e = await send("Runtime.evaluate", { expression: "1" }, sessionId, ms);
        if (e.timeout) hung.add(t.targetId);
        send("Target.detachFromTarget", { sessionId }, undefined, 500);
      })
    );
    return hung;
  });
}

/**
 * Starts the relay for an http://host:port DevTools address; returns the ws:// URL to give
 * Playwright, and close().
 */
export async function startCdpProxy(cdpHttpUrl, { recheckMs = 4000, log = () => {} } = {}) {
  const version = await (await fetch(new URL("/json/version", cdpHttpUrl))).json();
  const upstreamUrl = version.webSocketDebuggerUrl;
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
  await new Promise((resolve) => wss.once("listening", resolve));
  const timers = new Set();

  wss.on("connection", async (client) => {
    // Hold Playwright's first messages while the tabs are checked.
    const queue = [];
    client.on("message", (raw) => {
      const m = raw.toString(); // DevTools only accepts text frames
      upstream?.readyState === 1 ? upstream.send(m) : queue.push(m);
    });
    let upstream = null;
    const hidden = await unresponsiveTabs(upstreamUrl).catch(() => new Set());
    if (hidden.size) log(`${hidden.size} sleeping tab(s) hidden until they wake up`);
    const dropped = new Set(); // session ids we detached on Playwright's behalf
    upstream = new WebSocket(upstreamUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    let ownId = OWN;
    const own = (method, params) => upstream.readyState === 1 && upstream.send(JSON.stringify({ id: ++ownId, method, params }));
    upstream.on("open", () => queue.splice(0).forEach((m) => upstream.send(m)));
    upstream.on("message", (raw) => {
      const d = JSON.parse(raw);
      if (d.id > OWN) return;
      if (d.method === "Target.attachedToTarget" && !d.sessionId && hidden.has(d.params.targetInfo.targetId)) {
        dropped.add(d.params.sessionId);
        own("Target.detachFromTarget", { sessionId: d.params.sessionId });
        return;
      }
      if (d.method === "Target.targetDestroyed") hidden.delete(d.params.targetId);
      if (d.sessionId && dropped.has(d.sessionId)) return;
      if (d.method === "Target.detachedFromTarget" && dropped.has(d.params.sessionId)) return;
      client.send(raw.toString());
    });

    // Hand a hidden tab to Playwright once it answers: the browser announces the new session to us,
    // and Playwright treats it like any other tab.
    const timer = setInterval(async () => {
      if (!hidden.size) return;
      const still = await unresponsiveTabs(upstreamUrl, { only: new Set(hidden), ms: 1000 }).catch(() => null);
      if (!still) return;
      for (const id of [...hidden]) {
        if (still.has(id)) continue;
        hidden.delete(id);
        own("Target.attachToTarget", { targetId: id, flatten: true });
      }
    }, recheckMs);
    timers.add(timer);

    const end = () => {
      clearInterval(timer);
      timers.delete(timer);
      client.close();
      upstream.close();
    };
    client.on("close", end);
    upstream.on("close", (code) => (code !== 1000 && code !== 1005 && log(`browser connection closed (${code})`), end()));
    upstream.on("error", (err) => (log(`browser connection error: ${err.message}`), end()));
    client.on("error", (err) => (log(`relay client error: ${err.message}`), end()));
  });

  return {
    wsUrl: `ws://127.0.0.1:${wss.address().port}/`,
    close: () => {
      for (const t of timers) clearInterval(t);
      for (const c of wss.clients) c.close();
      wss.close();
    },
  };
}
