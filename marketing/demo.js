// The hero: the real panel (panel.html, built from desktop/bar.html) next to real YouTube pages.
// This file plays the server's side: it types into the panel, receives the command, and sends back
// the events the real server sends during that task, while the browser window shows each page.
// Plays once when the desktop scrolls into view; "Play again" replays. Reduced motion: no animation.
(() => {
  const $ = (s) => document.querySelector(s);
  const desk = $("#desk"), frame = $("#panel-frame");
  if (!desk || !frame) return;
  const page = $("#bw-page"), cursor = $("#agent-cursor"), ring = $("#ring"), replay = $("#replay"), tray = $("#tray");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const HITS = { size: [1440, 900], results: [264, 112, 1152, 281], results2: [264, 250, 1152, 281] }; // from the captures (assets/demo)
  const MODELS = ["groq:openai/gpt-oss-120b", "groq:qwen/qwen3.8-27b"];

  let run = 0;
  const PACE = 1.3; // a little slower than a real run, so each step can be read
  const sleep = (ms, id) => new Promise((ok, no) => setTimeout(() => (id === run ? ok() : no(new Error("stale"))), reduce ? 0 : ms * PACE));
  const post = (m) => frame.contentWindow?.postMessage({ gofer: true, ...m }, "*");
  const emit = (type, payload) => post({ kind: "emit", type, payload });
  let waiting = null; // { kind, resolve }
  const next = (kind) => new Promise((resolve) => { waiting = { kind, resolve }; });
  let ready = false;
  addEventListener("message", (e) => {
    const m = e.data;
    if (!m || !m.gofer || e.source !== frame.contentWindow) return;
    if (m.kind === "ready") ready = true;
    if (waiting && waiting.kind === m.kind) { const w = waiting; waiting = null; w.resolve(m); }
  });

  function show(name, title, url) {
    for (const p of page.querySelectorAll(".pg")) p.classList.toggle("on", p.dataset.pg === name);
    $("#bw-tab-title").textContent = title;
    $("#bw-url").textContent = url;
    $("#bw-fav").className = `fav${name === "new" ? "" : " yt"}`;
    post({ kind: "tabs", tabs: [{ index: 0, title, url: name === "new" ? "about:blank" : `https://www.${url}`, active: true, shown: true, icon: name === "new" ? null : "yt" }] });
  }
  /** Move the agent's pointer to a result (in capture coordinates), ring it, click. */
  async function click(rect, id) {
    const k = page.clientWidth / HITS.size[0];
    const [x, y, w, h] = rect.map((v) => v * k);
    Object.assign(ring.style, { left: `${x - 6}px`, top: `${y - 6}px`, width: `${w + 12}px`, height: `${h + 12}px` });
    cursor.classList.add("on");
    cursor.style.transform = `translate(${x + w * .52}px, ${y + 40 * k}px)`;
    await sleep(800, id);
    ring.classList.add("on");
    cursor.classList.remove("tap"); void cursor.offsetWidth; cursor.classList.add("tap");
    await sleep(450, id);
  }
  function unclick() { ring.classList.remove("on"); cursor.classList.remove("on"); }

  const step = (text, status = "ok", detail) => ({ text, status, ...(detail ? { detail } : {}) });
  /** One request: type it, then play the task's events. Each beat: wait, then click / page / steps. */
  async function request(id, text, beats, summary) {
    post({ kind: "type", text, ms: reduce ? 0 : 34 });
    const { id: mid } = await next("command");
    tray.classList.add("on");
    emit("queue", { running: { id: mid, text }, queued: [], side: [], paused: null, canTakeOver: true, background: false, undo: null });
    let steps = [];
    for (const b of beats) {
      await sleep(b.wait ?? 700, id);
      if (b.click) await click(b.click, id);
      if (b.page) { show(...b.page); unclick(); }
      steps = b.steps;
      emit("goal", { status: "running", goal: text, steps, models: MODELS });
    }
    await sleep(800, id);
    emit("goal", { status: "done", goal: text, steps: steps.map((s) => ({ ...s, status: "ok" })), summary, models: MODELS });
    emit("queue", { running: null, queued: [], side: [], paused: null, canTakeOver: false, background: false, undo: null });
    tray.classList.remove("on");
  }

  async function play() {
    const id = ++run;
    replay.classList.remove("on");
    unclick();
    ready = false;
    frame.src = `panel.html?run=${id}`; // a fresh panel each time
    try {
      while (!ready) await sleep(60, id);
      show("new", "New Tab", "Search or type a URL");
      await sleep(900, id);

      const q = "prince of egypt song";
      const results = ["results", `${q} - YouTube`, "youtube.com/results?search_query=prince+of+egypt+song"];
      const a1 = step("Open youtube.com", "ok", "youtube.com"), a2 = step(`Search for “${q}”`), a3 = step("Click “Deliver Us (Opening Song) | The Prince of Egypt”");
      await request(id, "open youtube and play a prince of egypt song", [
        { wait: 500, steps: [step("Open youtube.com", "running")] },
        { wait: 700, page: ["home", "YouTube", "youtube.com"], steps: [a1, { ...a2, status: "running" }] },
        { wait: 900, page: results, steps: [a1, a2, { ...a3, status: "running" }] },
        { wait: 600, click: HITS.results, page: ["watch1", "Deliver Us (Opening Song) | The Prince of Egypt | TUNE - YouTube", "youtube.com/watch?v=fQhcOJHTdb4"], steps: [a1, a2, a3, step("Play the video", "running")] },
        { wait: 700, steps: [a1, a2, a3, step("Play the video", "ok", "Playing · 1:35 of 6:37")] },
      ], "I opened YouTube and played “Deliver Us”, the opening song of The Prince of Egypt.");
      await sleep(1800, id);

      const b1 = step("Go back to the results"), b2 = step("Scroll past the two mofe songs"), b3 = step("Click “Through Heaven's Eyes | The Prince of Egypt”");
      await request(id, "no, another one", [
        { wait: 500, steps: [{ ...b1, status: "running" }] },
        { wait: 700, page: results, steps: [b1, { ...b2, status: "running" }] },
        { wait: 900, page: ["results2", `${q} - YouTube`, "youtube.com/results?search_query=prince+of+egypt+song"], steps: [b1, b2, { ...b3, status: "running" }] },
        { wait: 600, click: HITS.results2, page: ["watch2", "Through Heaven's Eyes | The Prince of Egypt | TUNE - YouTube", "youtube.com/watch?v=bQt2_IQD6J8"], steps: [b1, b2, b3, step("Play the video", "running")] },
        { wait: 700, steps: [b1, b2, b3, step("Play the video", "ok", "Playing · 1:02 of 3:37")] },
      ], "Now playing “Through Heaven's Eyes”. I skipped the two mofe songs, since they aren't from the film.");
      await sleep(600, id);
      replay.classList.add("on");
    } catch {}
  }

  replay.addEventListener("click", () => play());
  let started = false;
  new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting && !started) { started = true; play(); }
      else if (!e.isIntersecting && started && !replay.classList.contains("on")) { run++; replay.classList.add("on"); } // stop when scrolled away
    }
  }, { threshold: .3 }).observe(desk);
})();
