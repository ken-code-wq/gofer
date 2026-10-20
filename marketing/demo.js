// The hero: a scripted run of the real thing. Plays once when it scrolls into view; "Play again" replays.
// With reduced motion it shows the finished conversation straight away.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const desk = $("#desk");
  if (!desk) return;
  const chat = $("#p-chat"), input = $("#p-in"), send = $("#p-send");
  const tabTitle = $("#bw-tab-title"), url = $("#bw-url"), pTab = $("#p-tab"), tray = $("#tray");
  const cursor = $("#agent-cursor"), replay = $("#replay"), page = $("#bw-page");
  const ICON = window.VB_ICONS;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let run = 0;
  const sleep = (ms, id) => new Promise((ok, no) => setTimeout(() => (id === run ? ok() : no(new Error("stale"))), ms));
  const el = (tag, cls, html) => Object.assign(document.createElement(tag), { className: cls || "", innerHTML: html || "" });

  const SONGS = {
    believe: { title: "When You Believe (From The Prince of Egypt)", by: "Whitney Houston, Mariah Carey", art: "dusk", len: "4:52", tab: "When You Believe - The Prince of Egypt" },
    deliver: { title: "Deliver Us (From The Prince of Egypt)", by: "Ofra Haza, Eden Riegel", art: "dawn", len: "5:01", tab: "Deliver Us - The Prince of Egypt" },
  };

  function showPage(name) {
    for (const p of page.querySelectorAll(".pg")) p.classList.toggle("on", p.dataset.pg === name);
  }
  function setTab(title, href, yt = true) {
    tabTitle.textContent = title;
    url.textContent = href;
    $("#bw-fav").className = `fav${yt ? " yt" : ""}`;
    pTab.querySelector("span").textContent = title;
    pTab.querySelector(".fav").className = `fav${yt ? " yt" : ""}`;
  }
  function playVideo(song) {
    const v = $(".pg-video");
    v.querySelector(".art use").setAttribute("href", `#scene-${song.art}`);
    v.querySelector("h3").textContent = song.title;
    v.querySelector("p").textContent = `${song.by} · ${song.len}`;
    v.querySelector(".player").classList.remove("playing");
    void v.offsetWidth;
    v.querySelector(".player").classList.add("playing");
  }
  async function pointAt(target, id) {
    const r = target.getBoundingClientRect(), base = page.getBoundingClientRect();
    cursor.classList.add("on");
    cursor.style.transform = `translate(${r.left - base.left + 60}px, ${r.top - base.top + r.height / 2}px)`;
    await sleep(750, id);
    cursor.classList.remove("tap"); void cursor.offsetWidth; cursor.classList.add("tap");
    target.classList.add("hit");
    await sleep(500, id);
  }

  async function type(text, id, ms = 38) {
    input.classList.add("caret");
    for (const ch of text) { input.textContent += ch; send.classList.add("ready"); await sleep(ms, id); }
    await sleep(350, id);
  }
  function sendMine(text) {
    const me = el("div", "me", "");
    me.textContent = text;
    chat.append(me);
    input.textContent = ""; input.classList.remove("caret"); send.classList.remove("ready");
    $(".empty", chat)?.remove();
  }
  /** A reply in progress: steps tick off; finish() turns it into the answer. */
  function reply() {
    const it = el("div", "it", '<ol class="steps"></ol>');
    chat.append(it);
    const steps = it.querySelector(".steps");
    let cur = null;
    return {
      step(text) {
        if (cur) cur.done();
        const li = el("li", "step", `<span class="mk"><span class="spin"></span></span><span class="t"></span>`);
        li.querySelector(".t").textContent = text;
        steps.append(li);
        cur = { li, done: (detail) => { li.querySelector(".mk").innerHTML = ICON.check; if (detail) li.querySelector(".t").append(el("small", "", detail)); } };
        return cur;
      },
      finish(text, n, secs) {
        if (cur) cur.done();
        it.innerHTML = "";
        it.append(document.createTextNode(text));
        it.append(el("div", "meta", `<span class="tog">${ICON.chevron}${n} steps</span><span>Worked for ${secs} s · gpt-oss-120b +1</span>`));
      },
    };
  }

  function reset() {
    chat.innerHTML = '<p class="empty"><b>What should it do?</b>Ask about the page, or hand it a task.</p>';
    input.textContent = ""; input.classList.remove("caret"); send.classList.remove("ready");
    setTab("New Tab", "Search or type a URL", false);
    showPage("new");
    cursor.classList.remove("on");
    for (const r of page.querySelectorAll(".hit")) r.classList.remove("hit");
    replay.classList.remove("on");
    tray.classList.remove("on");
  }

  async function play() {
    const id = ++run;
    reset();
    try {
      await sleep(900, id);
      // 1. the request
      await type("open youtube and play a prince of egypt song", id, 34);
      sendMine("open youtube and play a prince of egypt song");
      tray.classList.add("on");
      const a = reply();
      await sleep(500, id);
      a.step("Open youtube.com");
      await sleep(700, id);
      setTab("YouTube", "youtube.com");
      showPage("home");
      await sleep(700, id);
      a.step("Search for “prince of egypt song”");
      await sleep(900, id);
      setTab("prince of egypt song - YouTube", "youtube.com/results?search_query=prince+of+egypt+song");
      showPage("results");
      await sleep(800, id);
      a.step("Click “When You Believe (From The Prince of Egypt)”");
      await pointAt(page.querySelector('[data-song="believe"]'), id);
      setTab(SONGS.believe.tab, "youtube.com/watch?v=LKaXY4IdZ40");
      playVideo(SONGS.believe);
      showPage("video");
      cursor.classList.remove("on");
      await sleep(600, id);
      a.step("Play the video").done("Playing · 0:03 of 4:52");
      await sleep(900, id);
      a.finish("I opened YouTube and played “When You Believe” by Whitney Houston and Mariah Carey.", 4, 6);
      tray.classList.remove("on");
      await sleep(2000, id);

      // 2. the follow-up
      await type("no, another one", id, 55);
      sendMine("no, another one");
      tray.classList.add("on");
      const b = reply();
      await sleep(500, id);
      b.step("Search for “prince of egypt song”");
      await sleep(700, id);
      for (const r of page.querySelectorAll(".hit")) r.classList.remove("hit");
      setTab("prince of egypt song - YouTube", "youtube.com/results?search_query=prince+of+egypt+song");
      showPage("results");
      await sleep(800, id);
      b.step("Click “Deliver Us (From The Prince of Egypt)”");
      await pointAt(page.querySelector('[data-song="deliver"]'), id);
      setTab(SONGS.deliver.tab, "youtube.com/watch?v=0bb5dvcvoqk");
      playVideo(SONGS.deliver);
      showPage("video");
      cursor.classList.remove("on");
      await sleep(600, id);
      b.step("Play the video").done("Playing · 0:01 of 5:01");
      await sleep(900, id);
      b.finish("Now playing “Deliver Us”, the opening song. I skipped “When You Believe” since you just heard it.", 3, 4);
      tray.classList.remove("on");
      await sleep(1200, id);
      replay.classList.add("on");
    } catch {}
  }

  function finished() {
    reset();
    run++;
    $(".empty", chat)?.remove();
    sendMine("open youtube and play a prince of egypt song");
    reply().finish("I opened YouTube and played “When You Believe” by Whitney Houston and Mariah Carey.", 4, 6);
    sendMine("no, another one");
    reply().finish("Now playing “Deliver Us”, the opening song. I skipped “When You Believe” since you just heard it.", 3, 4);
    setTab(SONGS.deliver.tab, "youtube.com/watch?v=0bb5dvcvoqk");
    playVideo(SONGS.deliver);
    showPage("video");
    replay.classList.add("on");
  }

  replay.addEventListener("click", () => play());
  if (reduce) return finished();
  reset();
  let started = false;
  new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting && !started) { started = true; play(); }
      if (!e.isIntersecting && started && !replay.classList.contains("on")) { run++; replay.classList.add("on"); } // stop when scrolled away
    }
  }, { threshold: .35 }).observe(desk);
})();
