"use strict";
(function () {
  const STORE_KEY = "taxstudy.v1";
  const MODES = [
    ["read", "全文"],
    ["random", "穴埋め"],
    ["write", "書き出し"],
  ];
  const RATES = [
    [0, "もう一度", "今日中に再挑戦"],
    [1, "うろ覚え", "間隔を短めに"],
    [2, "完璧", "間隔を延ばす"],
  ];

  // ---------- 保存 ----------
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function load() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { s = null; }
    return normalize(s);
  }
  function normalize(s) {
    if (!s || !Array.isArray(s.theories)) {
      s = { theories: [], progress: {}, settings: {} };
    }
    s.progress = s.progress || {};
    s.settings = Object.assign({ defaultMode: "random", newPerDay: 10 }, s.settings || {});
    // なくしたモード（キーワード穴埋め・頭文字）が設定に残っていたら穴埋めにする
    if (!["read", "random", "write"].includes(s.settings.defaultMode)) s.settings.defaultMode = "random";
    return s;
  }
  let db = load();
  function writeLocal() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); return true; } catch (e) { return false; }
  }
  function save() {
    db.savedAt = Date.now();
    const ok = writeLocal();
    if (cloud) cloudPush();
    else if (!ok) toast("保存に失敗しました。ブラウザの保存領域が使えません");
  }

  // ---------- claude.ai 版：claude.ai アカウント側（本人だけが読める場所）にも保存 ----------
  // ブラウザの保存領域は、アプリの中で開くと毎回空になることがあるため。
  // 1つの保存単位は 256KB までなので、データを分けて保存する。
  let cloud = null;            // { db, base }
  let cloudState = "local";    // local | loading | synced | error
  const CHUNK_CHARS = 60000;   // 日本語は1文字3バイトなので約180KB
  let pushing = false, pushAgain = false, pushTimer = null;
  function withTimeout(p, ms) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej({ code: "timeout" }), ms))]);
  }
  async function cloudInit() {
    const c = window.claude;
    if (!c || typeof c.use !== "function") return;
    cloudState = "loading";
    try {
      const [cdb, user] = await Promise.all([c.use("db"), c.use("user")]);
      const id = cdb && user ? await user.id() : null;
      if (!id) { cloudState = "local"; return; }
      const base = "data/users/" + id;
      const meta = await withTimeout(cdb.doc(base + "/meta").get(), 10000);
      cloud = { db: cdb, base: base };
      if (meta.exists) {
        const m = meta.data();
        const parts = [];
        for (let i = 0; i < m.chunks; i++) {
          const d = await withTimeout(cdb.doc(base + "/chunk" + i).get(), 10000);
          parts.push(d.exists ? d.data().s : "");
        }
        const remote = JSON.parse(parts.join(""));
        if (remote && Array.isArray(remote.theories) && (!db.theories.length || (m.savedAt || 0) >= (db.savedAt || 0))) {
          db = normalize(remote);
          db.savedAt = m.savedAt || 0;
          writeLocal();
          reviewQueue = null;
          cloudState = "synced";
          route();
          return;
        }
      }
      cloudState = "synced";
      if (db.theories.length) cloudPush(true);
    } catch (e) {
      cloud = null;
      cloudState = "error";
    }
  }
  function cloudPush(now) {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(doPush, now ? 0 : 1200);
  }
  async function doPush() {
    if (!cloud) return;
    if (pushing) { pushAgain = true; return; }
    pushing = true;
    try {
      const text = JSON.stringify(db);
      const n = Math.max(1, Math.ceil(text.length / CHUNK_CHARS));
      const old = await cloud.db.doc(cloud.base + "/meta").get();
      const oldN = old.exists ? old.data().chunks || 0 : 0;
      for (let i = 0; i < n; i++) {
        await cloud.db.doc(cloud.base + "/chunk" + i).set({ s: text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS) });
      }
      await cloud.db.doc(cloud.base + "/meta").set({ chunks: n, savedAt: db.savedAt || Date.now() });
      for (let i = n; i < oldN; i++) await cloud.db.doc(cloud.base + "/chunk" + i).delete();
      cloudState = "synced";
    } catch (e) {
      cloudState = "error";
      toast("claude.ai への保存に失敗しました。このブラウザには保存してあります");
    } finally {
      pushing = false;
      if (pushAgain) { pushAgain = false; cloudPush(true); }
    }
  }

  // ---------- 日付・間隔反復 ----------
  function today() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function addDays(dateStr, n) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const dt = new Date(y, m - 1, d + n);
    return dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0");
  }
  function prog(id) {
    return db.progress[id] || (db.progress[id] = { ease: 2.3, interval: 0, reps: 0, due: null, history: [] });
  }
  function isDue(id) {
    const p = db.progress[id];
    return !p || !p.due || p.due <= today();
  }
  function isNew(id) {
    const p = db.progress[id];
    return !p || !p.history.length;
  }
  function dateOf(t) {
    const d = new Date(t);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  // ---------- 問題と項目 ----------
  // 本文の「〔1〕…」の行で項目に分ける。〔〕がない理論は全体で1項目
  function sectionsOf(t) {
    const secs = []; const pre = [];
    t.body.split("\n").forEach((ln) => {
      // 見出しは行頭の「〔1〕国内取引」。字下げした「〔１〕は、…」のような参照は本文として扱う
      if (/^〔[^〕]+〕(?![はのにをがともでや、。及又若並・〔])/.test(ln)) secs.push({ head: ln.trim(), lines: [] });
      else if (secs.length) secs[secs.length - 1].lines.push(ln);
      else pre.push(ln);
    });
    if (!secs.length) return [{ n: 0, head: "", body: t.body }];
    if (pre.join("").trim()) secs[0].lines = pre.concat(secs[0].lines);
    return secs.map((x, i) => ({ n: i + 1, head: x.head, body: x.lines.join("\n") }));
  }
  // 項目ごとの学習記録は「カードid~番号」で持つ（項目が1つだけの理論はカードidのまま）
  function unitsOf(t) {
    return sectionsOf(t).map((x) => ({
      id: x.n ? t.id + "~" + x.n : t.id, card: t, n: x.n, head: x.head,
      title: x.n ? t.title + " " + x.head : t.title, body: x.body, rank: t.rank, category: t.category,
    }));
  }
  function allUnits() { return db.theories.reduce((a, t) => a.concat(unitsOf(t)), []); }
  function findUnit(id) {
    const i = String(id).lastIndexOf("~");
    const t = find(i >= 0 ? id.slice(0, i) : id);
    return t ? unitsOf(t).find((u) => u.id === id) || null : null;
  }

  // 今日の復習：復習日が来た学習済みの項目＋新しい項目（1日の上限まで、ランクの高い順）
  function todaysQueue() {
    const rankOrder = { A: 0, B: 1, C: 2 };
    const byRank = (a, b) => (rankOrder[a.rank] ?? 3) - (rankOrder[b.rank] ?? 3);
    const startedToday = Object.values(db.progress).filter((p) => p.history.length && dateOf(p.history[0].t) === today()).length;
    const room = Math.max(0, (db.settings.newPerDay || 0) - startedToday);
    const units = allUnits();
    const due = units.filter((t) => !isNew(t.id) && isDue(t.id))
      .sort((a, b) => (db.progress[a.id].due || "").localeCompare(db.progress[b.id].due || "") || byRank(a, b));
    const fresh = units.filter((t) => isNew(t.id)).sort((a, b) => byRank(a, b) || byTitle(a, b)).slice(0, room);
    return due.concat(fresh).map((t) => t.id);
  }
  function rate(id, q, mode, score) {
    const p = prog(id);
    if (q === 0) {
      p.reps = 0; p.interval = 0; p.ease = Math.max(1.3, p.ease - 0.2);
    } else if (q === 1) {
      p.interval = Math.max(1, Math.round(p.interval * 1.2)); p.ease = Math.max(1.3, p.ease - 0.1);
    } else {
      p.reps += 1;
      p.interval = p.reps === 1 ? 1 : p.reps === 2 ? 3 : Math.round(Math.max(p.interval, 1) * p.ease);
      p.ease = Math.min(2.8, p.ease + 0.05);
    }
    p.due = addDays(today(), p.interval);
    p.history.push({ t: Date.now(), q: q, mode: mode, score: score == null ? undefined : score });
    if (p.history.length > 100) p.history = p.history.slice(-100);
    save();
  }

  // ---------- テキスト処理 ----------
  // 【】で囲まれた語句をキーワードとして分割
  function parse(body) {
    const out = [];
    const re = /【([^】]*)】/g;
    let last = 0, m;
    while ((m = re.exec(body))) {
      if (m.index > last) out.push({ text: body.slice(last, m.index), key: false });
      out.push({ text: m[1], key: true });
      last = re.lastIndex;
    }
    if (last < body.length) out.push({ text: body.slice(last), key: false });
    return out;
  }
  // 漢字・カタカナの連続をひとまとまりに
  const RUN_RE = /[\p{Script=Han}々〆ヶ]+|[\p{Script=Katakana}ー]+|[^\p{Script=Han}\p{Script=Katakana}々〆ヶー]+/gu;
  const WORD_RE = /^[\p{Script=Han}々〆ヶ\p{Script=Katakana}ー]+$/u;
  function plain(body) { return body.replace(/[【】]/g, ""); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function blankHtml(ans, hint) {
    const w = Math.max(2, ans.length) + "em";
    const shown = hint ? esc(hint) + "○".repeat(Math.max(0, ans.length - hint.length)) : esc(ans);
    return '<span class="blank' + (hint ? " hint" : "") + '" style="min-width:' + w + '" data-ans="' + esc(ans) + '">' + shown + "</span>";
  }
  const DEFAULT_RATIO = 0.8; // 穴埋めを開いたときの隠す割合
  function render(body, mode, seed, ratio) {
    const segs = parse(body);
    if (mode === "read") {
      return segs.map((s) => (s.key ? '<span class="key">' + esc(s.text) + "</span>" : esc(s.text))).join("");
    }
    if (mode === "cloze") {
      return segs.map((s) => (s.key ? blankHtml(s.text) : esc(s.text))).join("");
    }
    // random / initial: 漢字・カタカナ語を対象
    const rnd = mulberry(seed);
    ratio = ratio == null ? DEFAULT_RATIO : ratio;
    return segs.map((s) => {
      return (s.text.match(RUN_RE) || []).map((run) => {
        const isWord = WORD_RE.test(run) && run.length >= 2;
        if (mode === "initial") {
          return isWord ? blankHtml(run, run[0]) : esc(run);
        }
        // random: キーワードは優先的に隠す
        const p = s.key ? Math.min(1, ratio + 0.4) : ratio;
        return isWord && rnd() < p ? blankHtml(run) : esc(run);
      }).join("");
    }).join("");
  }
  function mulberry(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 書き出し判定（文字単位のLCS差分）
  // 「（法4①）」のような条文番号だけの行は判定から除く
  function norm(s) {
    return plain(s).split("\n").filter((l) => !/^\s*[（(][^）)]*[）)]\s*$/.test(l)).join("").replace(/[\s　]/g, "");
  }
  function diff(orig, typed) {
    const a = Array.from(orig), b = Array.from(typed);
    const n = a.length, m = b.length;
    const dp = [];
    for (let i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const ops = [];
    let i = 0, j = 0;
    const push = (type, ch) => {
      const last = ops[ops.length - 1];
      if (last && last.type === type) last.text += ch; else ops.push({ type: type, text: ch });
    };
    while (i < n && j < m) {
      if (a[i] === b[j]) { push("eq", a[i]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { push("miss", a[i]); i++; }
      else { push("extra", b[j]); j++; }
    }
    while (i < n) push("miss", a[i++]);
    while (j < m) push("extra", b[j++]);
    const score = n ? Math.round((dp[0][0] / n) * 100) : 0;
    return { ops: ops, score: score };
  }

  // 以前の版で入った条文カード（id が jobun-）と、編集していない初期サンプル
  const OLD_SAMPLES = ["課税の対象", "納税義務者", "資産の譲渡等の意義", "基準期間の意義", "小規模事業者に係る納税義務の免除"];
  function legacyCards() {
    return db.theories.filter((t) => String(t.id).startsWith("jobun-") || (!t.updatedAt && OLD_SAMPLES.includes(t.title)));
  }

  // 同じ id のカードは追加しない。自分で編集していないカードは、題名・分野・ランク・本文を新しい内容に置き換える
  let lastUpdated = 0;
  function mergeTheories(list, progress) {
    const have = new Set(db.theories.map((t) => t.id));
    let n = 0;
    lastUpdated = 0;
    list.forEach((t) => {
      if (!t || !t.id || !t.title) return;
      if (have.has(t.id)) {
        const cur = find(t.id);
        if (cur && !cur.updatedAt && (cur.title !== t.title || cur.category !== t.category || cur.rank !== t.rank || cur.body !== t.body)) {
          Object.assign(cur, { title: t.title, category: t.category || "", rank: t.rank || cur.rank, body: t.body || cur.body });
          lastUpdated++;
        }
        return;
      }
      db.theories.push({ id: t.id, title: t.title, category: t.category || "", rank: t.rank || "B", body: t.body || "", createdAt: t.createdAt || Date.now() });
      if (progress[t.id]) db.progress[t.id] = progress[t.id];
      have.add(t.id); n++;
    });
    reviewQueue = null;
    save();
    return n;
  }

  // ---------- 通知・確認（ブラウザのダイアログを使わない） ----------
  let toastTimer = null;
  function toast(msg) {
    let el = document.getElementById("toast");
    if (!el) { el = document.createElement("div"); el.id = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }
  function ask(msg, okLabel, onOk, alt) {
    const wrap = document.createElement("div");
    wrap.className = "modal";
    wrap.innerHTML = '<div class="modal-box" role="dialog" aria-modal="true"><p>' + esc(msg) + '</p><div class="row" style="justify-content:flex-end">' +
      '<button id="ask-no">やめる</button>' + (alt ? '<button class="primary" id="ask-alt">' + esc(alt.label) + "</button>" : "") +
      '<button class="primary danger-fill" id="ask-ok">' + esc(okLabel) + "</button></div></div>";
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.querySelector("#ask-no").onclick = close;
    if (alt) wrap.querySelector("#ask-alt").onclick = () => { close(); alt.fn(); };
    wrap.onclick = (e) => { if (e.target === wrap) close(); };
    wrap.querySelector("#ask-ok").onclick = () => { close(); onOk(); };
    wrap.querySelector("#ask-ok").focus();
  }

  // ---------- 画面 ----------
  const app = document.getElementById("app");
  const find = (id) => db.theories.find((t) => t.id === id);
  let homeFilter = { q: "", cat: "", rank: "" };
  let reviewQueue = null;

  function route() {
    // #study-<id>、#study-<id>-<mode>、#edit-<id>（id に「-」が入ってもよい）
    const raw = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
    // #sec-<カードid~番号>、#whole-<カードid> も同じ形
    const m = raw.match(/^(study|edit|sec|whole)[-\/](.+)$/);
    let h = [raw];
    if (m) {
      const exists = (x) => (m[1] === "sec" ? findUnit(x) : find(x));
      const mm = m[2].match(/^(.+)[-\/](read|cloze|random|initial|write)$/);
      h = mm && exists(mm[1]) ? [m[1], mm[1], mm[2]] : [m[1], m[2]];
    }
    updateNav();
    if (h[0] === "study" && find(h[1])) {
      const us = unitsOf(find(h[1]));
      return us.length > 1 ? viewProblem(find(h[1])) : viewStudy(us[0], h[2] || db.settings.defaultMode);
    }
    if (h[0] === "sec" && findUnit(h[1])) return viewStudy(findUnit(h[1]), h[2] || db.settings.defaultMode);
    if (h[0] === "whole" && find(h[1])) {
      const t = find(h[1]);
      return viewStudy({ id: t.id, card: t, n: 0, title: t.title + "（全体）", body: t.body, rank: t.rank, category: t.category, whole: true }, h[2] || "read");
    }
    if (h[0] === "edit") return viewEdit(h[1] === "new" ? null : find(h[1]));
    if (h[0] === "review") return viewReview();
    if (h[0] === "data") return viewData();
    reviewQueue = null;
    return viewHome();
  }
  window.addEventListener("hashchange", route);

  // テキストの問題番号（1-1, 1-2 …）順。番号のないカードは後ろ、「対象外」はさらに後ろ
  function orderKey(t) {
    const m = t.title.match(/^(\d+)-(\d+)/);
    return m ? [0, +m[1], +m[2]] : [/^対象外/.test(t.title) ? 2 : 1, 0, 0];
  }
  function byTitle(a, b) {
    const x = orderKey(a), y = orderKey(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || a.title.localeCompare(b.title, "ja", { numeric: true });
  }
  function updateNav() {
    const n = todaysQueue().length;
    document.getElementById("nav-review").textContent = "今日の復習" + (n ? "（" + n + "）" : "");
  }
  function statusTag(id) {
    const p = db.progress[id];
    if (!p || !p.history.length) return '<span class="tag">未学習</span>';
    if (isDue(id)) return '<span class="tag due">復習日</span>';
    return '<span class="tag">次回 ' + p.due.slice(5).replace("-", "/") + "</span>";
  }
  const LEVELS = ["もう一度", "うろ覚え", "完璧"];
  function lastQ(id) {
    const p = db.progress[id];
    return p && p.history.length ? p.history[p.history.length - 1].q : null;
  }
  function levelTag(id) {
    const q = lastQ(id);
    return q == null ? "" : '<span class="tag lv' + q + '">習熟度：' + LEVELS[q] + "</span>";
  }
  // 一覧に出す、問題全体の状態（項目ごとの習熟度を四角で並べる）
  function cardStatus(t) {
    const us = unitsOf(t);
    if (us.length === 1) return statusTag(us[0].id) + histHtml(us[0].id);
    const fresh = us.filter((u) => isNew(u.id)).length;
    const due = us.filter((u) => !isNew(u.id) && isDue(u.id)).length;
    const tag = fresh === us.length ? '<span class="tag">未学習</span>'
      : due ? '<span class="tag due">復習 ' + due + "項目</span>" : '<span class="tag">学習中</span>';
    return '<span class="tag">' + us.length + "項目</span>" + tag +
      '<span class="hist" title="項目ごとの習熟度">' + us.map((u) => { const q = lastQ(u.id); return '<i class="' + (q == null ? "" : "q" + q) + '"></i>'; }).join("") + "</span>";
  }
  function histHtml(id) {
    const p = db.progress[id];
    if (!p) return "";
    return '<span class="hist">' + p.history.slice(-12).map((h) => '<i class="q' + h.q + '"></i>').join("") + "</span>";
  }

  function viewHome() {
    const cats = Array.from(new Set(db.theories.map((t) => t.category).filter(Boolean)));
    const units = allUnits();
    const total = db.theories.length;
    const studied = units.filter((u) => !isNew(u.id)).length;
    const due = todaysQueue().length;
    const mastered = units.filter((u) => db.progress[u.id] && db.progress[u.id].interval >= 7).length;
    app.innerHTML =
      '<div class="stats">' +
      '<div class="stat"><b>' + total + "</b><span>登録理論</span></div>" +
      '<div class="stat"><b>' + studied + " / " + units.length + "</b><span>学習済みの項目</span></div>" +
      '<div class="stat"><b>' + due + "</b><span>今日の復習</span></div>" +
      '<div class="stat"><b>' + mastered + "</b><span>定着（間隔7日以上）</span></div>" +
      "</div>" +
      '<div class="row" style="margin-bottom:12px"><a class="btn primary" href="#review">今日の復習を始める</a><a class="btn" href="#edit-new">＋理論を追加</a></div>' +
      '<div class="filters">' +
      '<input type="search" id="q" placeholder="題名・本文で検索" value="' + esc(homeFilter.q) + '">' +
      '<select id="cat"><option value="">全分野</option>' + cats.map((c) => "<option" + (c === homeFilter.cat ? " selected" : "") + ">" + esc(c) + "</option>").join("") + "</select>" +
      '<select id="rank"><option value="">全ランク</option>' + ["A", "B", "C"].map((r) => "<option" + (r === homeFilter.rank ? " selected" : "") + ">" + r + "</option>").join("") + "</select>" +
      "</div>" +
      '<div id="list"></div>';
    const list = document.getElementById("list");
    function draw() {
      const q = homeFilter.q.trim();
      const items = db.theories.slice().sort(byTitle).filter((t) =>
        (!q || t.title.includes(q) || plain(t.body).includes(q)) &&
        (!homeFilter.cat || t.category === homeFilter.cat) &&
        (!homeFilter.rank || t.rank === homeFilter.rank));
      list.innerHTML = items.length ? items.map((t) =>
        '<div class="card item">' +
        '<div style="flex:1;min-width:0"><a class="title" href="#study-' + t.id + '">' + esc(t.title) + "</a>" +
        '<div class="row muted" style="gap:6px">' + (t.rank ? '<span class="tag r' + t.rank + '">' + t.rank + "</span>" : "") +
        (t.category ? "<span>" + esc(t.category) + "</span>" : "") + cardStatus(t) +
        '<a class="editlink" href="#edit-' + t.id + '">編集</a></div></div>' +
        '<a class="btn primary open" href="#study-' + t.id + '">開く</a></div>').join("")
        : db.theories.length ? '<div class="empty">該当する理論がありません</div>'
        : '<div class="empty">まだ理論がありません。<br>「データ」→「ファイルから読み込む」で理論テキストのファイルを読み込むか、「＋追加」から登録してください。<br><br><a class="btn primary" href="#data">データ画面へ</a></div>';
    }
    document.getElementById("q").oninput = (e) => { homeFilter.q = e.target.value; draw(); };
    document.getElementById("cat").onchange = (e) => { homeFilter.cat = e.target.value; draw(); };
    document.getElementById("rank").onchange = (e) => { homeFilter.rank = e.target.value; draw(); };
    draw();
  }

  function viewReview() {
    if (!reviewQueue) {
      reviewQueue = todaysQueue();
    }
    updateNav();
    const next = reviewQueue.find((id) => findUnit(id) && isDue(id));
    if (!next) {
      reviewQueue = null;
      app.innerHTML = '<div class="card empty"><h1>今日の復習は完了です</h1><p>おつかれさまでした。</p><a class="btn primary" href="#home">一覧へ戻る</a></div>';
      return;
    }
    viewStudy(findUnit(next), db.settings.defaultMode, true);
  }

  // 問題を開いたとき：〔1〕〔2〕…の項目を選ぶ画面
  function viewProblem(t) {
    const us = unitsOf(t);
    app.innerHTML =
      '<div class="row"><a href="#home">← 一覧</a></div>' +
      "<h1>" + esc(t.title) + "</h1>" +
      '<div class="row muted">' + (t.rank ? '<span class="tag r' + t.rank + '">' + t.rank + "</span>" : "") + esc(t.category || "") + "</div>" +
      '<p class="muted">項目を選ぶと、その部分だけを穴埋めで解けます。解いたあとに習熟度を選んでください。</p>' +
      '<div class="seclist">' + us.map((u) =>
        '<a class="card item sec" href="#sec-' + u.id + '"><div style="flex:1;min-width:0"><b>' + esc(u.head) + "</b>" +
        '<div class="row muted" style="gap:6px">' + levelTag(u.id) + statusTag(u.id) + histHtml(u.id) + "</div></div>" +
        '<span class="chev" aria-hidden="true">›</span></a>').join("") + "</div>" +
      '<div class="row" style="margin-top:12px"><a class="btn" href="#whole-' + t.id + '-read">全体を通して読む</a><a class="btn" href="#edit-' + t.id + '">編集</a></div>';
  }

  function viewStudy(t, mode, inReview) {
    let seed = Math.floor(Math.random() * 1e9);
    let ratio = DEFAULT_RATIO; // 開くたびに80%から
    // 今はないモードを指定されたら穴埋めで開く
    if (!MODES.some(([k]) => k === mode)) mode = "random";
    const base = inReview ? "#review" : t.whole ? "#whole-" + t.card.id : t.n ? "#sec-" + t.id : "#study-" + t.id;
    const back = !inReview && t.n ? "#study-" + t.card.id : t.whole ? "#study-" + t.card.id : "#home";
    const remaining = inReview ? reviewQueue.filter((id) => findUnit(id) && isDue(id)).length : 0;
    app.innerHTML =
      '<div class="row"><a href="' + back + '">' + (back === "#home" ? "← 一覧" : "← 項目の一覧") + '</a><span class="spacer"></span>' +
      (inReview ? '<span class="muted">復習 残り ' + remaining + " 件</span>" : "") + "</div>" +
      "<h1>" + esc(t.title) + "</h1>" +
      '<div class="row muted">' + (t.rank ? '<span class="tag r' + t.rank + '">' + t.rank + "</span>" : "") + esc(t.category || "") +
        (t.whole ? "" : levelTag(t.id) + statusTag(t.id) + histHtml(t.id)) + "</div>" +
      '<div class="modes">' + MODES.map(([k, l]) => '<button data-mode="' + k + '" class="' + (k === mode ? "on" : "") + '">' + l + "</button>").join("") + "</div>" +
      '<div class="card" id="stage"></div>' +
      (t.whole ? "" : '<h2>習熟度を選ぶ</h2><div class="rate">' + RATES.map(([q, l, s]) => '<button data-q="' + q + '">' + l + "<small>" + s + "</small></button>").join("") + "</div>");

    app.querySelectorAll("[data-mode]").forEach((b) => {
      b.onclick = () => {
        mode = b.dataset.mode;
        app.querySelectorAll("[data-mode]").forEach((x) => x.classList.toggle("on", x === b));
        if (!inReview) history.replaceState(null, "", base + "-" + mode);
        draw();
      };
    });
    let lastScore = null;
    app.querySelectorAll("[data-q]").forEach((b) => {
      b.onclick = () => {
        rate(t.id, Number(b.dataset.q), mode, lastScore);
        if (inReview) {
          if (Number(b.dataset.q) === 0) { reviewQueue = reviewQueue.filter((id) => id !== t.id).concat(t.id); }
          viewReview();
        } else {
          toast("習熟度を「" + LEVELS[Number(b.dataset.q)] + "」にしました");
          location.hash = back;
        }
      };
    });

    const stage = document.getElementById("stage");
    function draw() {
      lastScore = null;
      if (mode === "write") return drawWrite();
      const tools =
        '<div class="row" style="margin-bottom:10px">' +
        (mode !== "read" ? '<button id="reveal">すべて表示</button><button id="hide">すべて隠す</button>' : "") +
        (mode === "random" ? '<button id="shuffle">別の穴</button><label style="margin:0">隠す割合 <select id="ratio" style="width:auto">' +
          [0.2, 0.4, 0.6, 0.8, 1].map((r) => '<option value="' + r + '"' + (r === ratio ? " selected" : "") + ">" + r * 100 + "%</option>").join("") + "</select></label>" : "") +
        "</div>";
      stage.innerHTML = tools + '<div class="theory">' + render(t.body, mode, seed, ratio) + "</div>" +
        (mode !== "read" ? '<p class="muted">空欄をタップすると答えが出ます。</p>' : "");
      stage.querySelectorAll(".blank").forEach((el) => {
        el.onclick = () => {
          const shown = el.classList.toggle("shown");
          el.textContent = shown ? el.dataset.ans : el.classList.contains("hint") ? el.dataset.ans[0] + "○".repeat(el.dataset.ans.length - 1) : el.dataset.ans;
        };
      });
      const setAll = (show) => stage.querySelectorAll(".blank").forEach((el) => { if (el.classList.contains("shown") !== show) el.click(); });
      const r = document.getElementById("reveal"); if (r) r.onclick = () => setAll(true);
      const hd = document.getElementById("hide"); if (hd) hd.onclick = () => setAll(false);
      const sh = document.getElementById("shuffle"); if (sh) sh.onclick = () => { seed++; draw(); };
      const ra = document.getElementById("ratio"); if (ra) ra.onchange = (e) => { ratio = Number(e.target.value); draw(); };
    }
    function drawWrite() {
      const draftKey = "taxstudy.draft." + t.id;
      let draft = "";
      try { draft = sessionStorage.getItem(draftKey) || ""; } catch (e) { draft = ""; }
      stage.innerHTML =
        '<p class="muted" style="margin-top:0">題名だけを見て、本文を思い出して書いてください（空白・改行・条文番号だけの行は判定に含めません）。</p>' +
        '<textarea id="ans" placeholder="ここに書き出す">' + esc(draft) + "</textarea>" +
        '<div class="row" style="margin-top:8px"><button class="primary" id="check">判定する</button><button id="clear">消去</button></div>' +
        '<div id="result"></div>';
      const ta = document.getElementById("ans");
      ta.oninput = () => { try { sessionStorage.setItem(draftKey, ta.value); } catch (e) { /* 保存できなくても続行 */ } };
      document.getElementById("clear").onclick = () => { ta.value = ""; ta.oninput(); document.getElementById("result").innerHTML = ""; };
      document.getElementById("check").onclick = () => {
        const d = diff(norm(t.body), norm(ta.value));
        lastScore = d.score;
        const cls = d.score >= 90 ? "good" : d.score >= 70 ? "mid" : "bad";
        const miss = d.ops.filter((o) => o.type === "miss").map((o) => o.text).filter((s) => s.length >= 2);
        document.getElementById("result").innerHTML =
          '<h2>結果 <span class="score ' + cls + '">' + d.score + "%</span></h2>" +
          '<p class="muted">赤＝書けなかった部分　取消線＝余分に書いた部分</p>' +
          '<div class="diff">' + d.ops.map((o) => (o.type === "eq" ? esc(o.text) : '<span class="' + o.type + '">' + esc(o.text) + "</span>")).join("") + "</div>" +
          (miss.length ? '<h2>抜けた語句</h2><p>' + miss.map((m) => '<span class="tag due wrap">' + esc(m) + "</span>").join(" ") + "</p>" : "") +
          '<p class="muted">目安：90%以上→完璧、70%以上→うろ覚え</p>';
        const target = d.score >= 90 ? 2 : d.score >= 70 ? 1 : 0;
        app.querySelectorAll("[data-q]").forEach((b) => b.classList.toggle("on", Number(b.dataset.q) === target));
      };
    }
    draw();
  }

  function viewEdit(t) {
    const isNew = !t;
    t = t || { title: "", category: "", rank: "A", body: "" };
    const cats = Array.from(new Set(db.theories.map((x) => x.category).filter(Boolean)));
    app.innerHTML =
      '<div class="row"><a href="#home">← 一覧</a></div>' +
      "<h1>" + (isNew ? "理論を追加" : "理論を編集") + "</h1>" +
      '<div class="card">' +
      '<label>題名</label><input type="text" id="title" value="' + esc(t.title) + '" placeholder="例：仕入れに係る消費税額の控除">' +
      '<div class="row" style="align-items:flex-start"><div style="flex:2;min-width:180px"><label>分野</label><input type="text" id="cat" list="cats" value="' + esc(t.category || "") + '" placeholder="例：仕入税額控除">' +
      '<datalist id="cats">' + cats.map((c) => "<option>" + esc(c) + "</option>").join("") + "</datalist></div>" +
      '<div style="flex:1;min-width:100px"><label>重要度</label><select id="rank">' + ["A", "B", "C"].map((r) => "<option" + (r === t.rank ? " selected" : "") + ">" + r + "</option>").join("") + "</select></div></div>" +
      '<label>本文（「〔1〕国内取引」のように行頭に〔〕の見出しを書くと、項目ごとに分かれます）</label>' +
      '<textarea id="body">' + esc(t.body) + "</textarea>" +
      '<h2>プレビュー</h2><div class="theory" id="preview"></div>' +
      '<div class="row" style="margin-top:14px"><button class="primary" id="save">保存</button><a class="btn" href="#home">キャンセル</a><span class="spacer"></span>' +
      (isNew ? "" : '<button class="danger" id="del">削除</button>') + "</div></div>";
    const body = document.getElementById("body");
    const prev = document.getElementById("preview");
    const upd = () => { prev.innerHTML = render(body.value, "read"); };
    body.oninput = upd; upd();
    document.getElementById("save").onclick = () => {
      const title = document.getElementById("title").value.trim();
      if (!title || !body.value.trim()) { toast("題名と本文を入力してください"); return; }
      const data = { title: title, category: document.getElementById("cat").value.trim(), rank: document.getElementById("rank").value, body: body.value, updatedAt: Date.now() };
      if (isNew) db.theories.push(Object.assign({ id: uid(), createdAt: Date.now() }, data));
      else Object.assign(t, data);
      save();
      location.hash = "#home";
    };
    const del = document.getElementById("del");
    if (del) del.onclick = () => {
      ask("「" + t.title + "」を削除しますか？学習記録も消えます。", "削除する", () => {
        db.theories = db.theories.filter((x) => x.id !== t.id);
        Object.keys(db.progress).forEach((k) => { if (k === t.id || k.startsWith(t.id + "~")) delete db.progress[k]; });
        save();
        toast("削除しました");
        location.hash = "#home";
      });
    };
  }

  function viewData() {
    app.innerHTML =
      "<h1>データ・設定</h1>" +
      '<div class="card"><h2 style="margin-top:0">学習設定</h2>' +
      '<label>復習のときに最初に開くモード</label><select id="dm">' + MODES.map(([k, l]) => '<option value="' + k + '"' + (k === db.settings.defaultMode ? " selected" : "") + ">" + l + "</option>").join("") + "</select>" +
      '<label for="npd">1日に新しく覚えるカードの数（今日の復習に入る未学習カードの上限）</label><select id="npd">' +
        [0, 5, 10, 15, 20, 30, 50].map((n) => '<option value="' + n + '"' + (n === db.settings.newPerDay ? " selected" : "") + ">" + n + "枚</option>").join("") + "</select>" +
      "</div>" +
      (legacyCards().length ? '<div class="card"><h2 style="margin-top:0">条文カード・サンプルの削除</h2>' +
        '<p class="muted">以前の版で入った、消費税法の条文から作ったカードと、最初から入っていたサンプルが ' + legacyCards().length + ' 枚あります。理論テキストのカードと、自分で編集したカードは消えません。</p>' +
        '<div class="row"><button class="danger" id="dellegacy">条文カードとサンプルを削除</button></div></div>' : "") +
      '<div class="card"><h2 style="margin-top:0">バックアップ</h2>' +
      '<p class="muted">' + (cloud ? "データは claude.ai のアカウントにも保存されています（本人だけが読めます）。" : cloudState === "error" ? "claude.ai への保存ができていません。データはこのブラウザの中だけにあります。" : "データはこのブラウザの中だけに保存されます。") + "機種変更やブラウザのデータ削除に備えて、ときどき書き出してください。</p>" +
      '<div class="row"><button class="primary" id="exp">バックアップを表示</button><button id="dl">ファイルに保存</button><label class="btn" style="margin:0;color:var(--text)">ファイルから読み込む<input type="file" id="imp" accept=".json,application/json" hidden></label></div>' +
      '<div id="expbox" hidden><label for="exptext">下の文字列をメモアプリなどに貼り付けて保管してください</label><textarea id="exptext" style="min-height:120px;font-size:12px" readonly></textarea>' +
      '<div class="row" style="margin-top:6px"><button id="copy">コピー</button></div></div>' +
      '<label for="imptext">バックアップの文字列を貼り付けて読み込む</label><textarea id="imptext" style="min-height:70px;font-size:12px" placeholder="{&quot;theories&quot;: …}"></textarea>' +
      '<div class="row" style="margin-top:6px"><button id="impbtn">貼り付けた内容を読み込む</button></div>' +
      '<p class="muted">「ファイルに保存」は claude.ai 上では動かないことがあります。そのときは「バックアップを表示」からコピーしてください。</p></div>' +
      '<div class="card"><h2 style="margin-top:0">まとめて追加（テキスト）</h2>' +
      '<p class="muted">「# 題名」の行で理論を区切って貼り付けます。題名の後ろに「｜分野｜ランク」を付けられます。<br>例：<code># 課税の対象｜総則｜A</code></p>' +
      '<textarea id="bulk" style="min-height:160px" placeholder="# 題名｜分野｜A\n本文……\n\n# 次の題名\n本文……"></textarea>' +
      '<div class="row" style="margin-top:8px"><button id="bulkadd">追加する</button></div></div>' +
      '<div class="card"><h2 style="margin-top:0">リセット</h2><div class="row"><button class="danger" id="resetp">学習記録だけ消す</button><button class="danger" id="resetall">すべて消す</button></div></div>';
    document.getElementById("npd").onchange = (e) => { db.settings.newPerDay = Number(e.target.value); reviewQueue = null; save(); };
    const dl = document.getElementById("dellegacy");
    if (dl) dl.onclick = () => {
      const ids = new Set(legacyCards().map((t) => t.id));
      ask("条文カードとサンプル " + ids.size + " 枚を削除しますか？学習記録も消えます。", "削除する", () => {
        db.theories = db.theories.filter((t) => !ids.has(t.id));
        ids.forEach((id) => delete db.progress[id]);
        reviewQueue = null;
        save();
        toast(ids.size + "枚削除しました");
        location.hash = "#home";
      });
    };
    document.getElementById("dm").onchange = (e) => { db.settings.defaultMode = e.target.value; save(); };
    document.getElementById("exp").onclick = () => {
      const box = document.getElementById("expbox");
      box.hidden = false;
      const ta = document.getElementById("exptext");
      ta.value = JSON.stringify(db);
      ta.focus(); ta.select();
    };
    document.getElementById("copy").onclick = () => {
      const ta = document.getElementById("exptext");
      const fallback = () => { ta.focus(); ta.select(); toast("選択しました。長押しまたは Ctrl+C でコピーしてください"); };
      try {
        navigator.clipboard.writeText(ta.value).then(() => toast("コピーしました"), fallback);
      } catch (e) { fallback(); }
    };
    document.getElementById("dl").onclick = () => {
      const blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "taxstudy-backup-" + today() + ".json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    document.getElementById("imp").onchange = (e) => {
      const f = e.target.files[0];
      if (!f) return;
      f.text().then(importText);
    };
    document.getElementById("impbtn").onclick = () => importText(document.getElementById("imptext").value);
    function importText(txt) {
      {
        let d;
        try { d = JSON.parse(txt); } catch (err) { toast("JSONとして読み込めませんでした"); return; }
        if (!d || !Array.isArray(d.theories)) { toast("このツールのバックアップ形式ではありません"); return; }
        ask("読み込んだ " + d.theories.length + " 件を、いまのデータに追加しますか？それとも、いまのデータをすべて置き換えますか？", "置き換える", () => {
          db = { theories: d.theories, progress: d.progress || {}, settings: Object.assign(db.settings, d.settings || {}) };
          reviewQueue = null;
          save();
          toast("読み込みました");
          location.hash = "#home";
        }, { label: "追加する", fn: () => {
          const n = mergeTheories(d.theories, d.progress || {});
          toast(n + "件追加" + (lastUpdated ? "、" + lastUpdated + "件の題名などを更新" : "") + "しました");
          location.hash = "#home";
        } });
      }
    }
    document.getElementById("bulkadd").onclick = () => {
      const txt = document.getElementById("bulk").value;
      const blocks = txt.split(/^#\s*/m).map((b) => b.trim()).filter(Boolean);
      let n = 0;
      blocks.forEach((b) => {
        const nl = b.indexOf("\n");
        if (nl < 0) return;
        const [title, cat, rank] = b.slice(0, nl).split(/[｜|]/).map((s) => s.trim());
        const body = b.slice(nl + 1).trim();
        if (!title || !body) return;
        db.theories.push({ id: uid(), createdAt: Date.now(), title: title, category: cat || "", rank: /^[ABC]$/.test(rank || "") ? rank : "B", body: body });
        n++;
      });
      save();
      toast(n ? n + "件追加しました" : "追加できる理論がありませんでした。「# 題名」の次の行から本文を書いてください");
      if (n) location.hash = "#home";
    };
    document.getElementById("resetp").onclick = () => {
      ask("学習記録をすべて消しますか？登録した理論は残ります。", "消す", () => { db.progress = {}; save(); toast("学習記録を消しました"); });
    };
    document.getElementById("resetall").onclick = () => {
      ask("登録した理論も含めてすべて消えます。よろしいですか？", "すべて消す", () => {
        try { localStorage.removeItem(STORE_KEY); } catch (e) { /* 無視 */ }
        db = load(); save(); toast("すべて消しました"); location.hash = "#home";
      });
    };
  }

  route();
  cloudInit();
})();
