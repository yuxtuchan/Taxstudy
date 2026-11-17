"use strict";
(function () {
  const STORE_KEY = "taxstudy.v1";
  const MODES = [
    ["read", "全文"],
    ["cloze", "キーワード穴埋め"],
    ["random", "ランダム穴埋め"],
    ["initial", "頭文字"],
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
    if (!s || !Array.isArray(s.theories)) {
      s = { theories: [], progress: {}, settings: {} };
      (window.SAMPLE_THEORIES || []).forEach((t) => s.theories.push(Object.assign({ id: uid(), createdAt: Date.now() }, t)));
    }
    s.progress = s.progress || {};
    s.settings = Object.assign({ blankRatio: 0.4, ttsRate: 1.0, defaultMode: "cloze" }, s.settings || {});
    return s;
  }
  let db = load();
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); } catch (e) { alert("保存に失敗しました（ブラウザの保存領域が使えません）"); }
  }
  save();

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
  function render(body, mode, seed) {
    const segs = parse(body);
    if (mode === "read") {
      return segs.map((s) => (s.key ? '<span class="key">' + esc(s.text) + "</span>" : esc(s.text))).join("");
    }
    if (mode === "cloze") {
      return segs.map((s) => (s.key ? blankHtml(s.text) : esc(s.text))).join("");
    }
    // random / initial: 漢字・カタカナ語を対象
    const rnd = mulberry(seed);
    const ratio = db.settings.blankRatio;
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

  // ---------- 読み上げ ----------
  function speak(text) {
    if (!("speechSynthesis" in window)) { alert("このブラウザは読み上げに対応していません"); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(plain(text).replace(/（/g, "、").replace(/）/g, "、"));
    u.lang = "ja-JP";
    u.rate = db.settings.ttsRate;
    speechSynthesis.speak(u);
  }

  // ---------- 画面 ----------
  const app = document.getElementById("app");
  const find = (id) => db.theories.find((t) => t.id === id);
  let homeFilter = { q: "", cat: "", rank: "" };
  let reviewQueue = null;

  function route() {
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    const h = location.hash.replace(/^#\/?/, "").split("/");
    const dueCount = db.theories.filter((t) => isDue(t.id)).length;
    document.getElementById("nav-review").textContent = "今日の復習" + (dueCount ? "（" + dueCount + "）" : "");
    if (h[0] === "study" && find(h[1])) return viewStudy(find(h[1]), h[2] || db.settings.defaultMode);
    if (h[0] === "edit") return viewEdit(h[1] === "new" ? null : find(h[1]));
    if (h[0] === "review") return viewReview();
    if (h[0] === "data") return viewData();
    reviewQueue = null;
    return viewHome();
  }
  window.addEventListener("hashchange", route);

  function statusTag(id) {
    const p = db.progress[id];
    if (!p || !p.history.length) return '<span class="tag">未学習</span>';
    if (isDue(id)) return '<span class="tag due">復習日</span>';
    return '<span class="tag">次回 ' + p.due.slice(5).replace("-", "/") + "</span>";
  }
  function histHtml(id) {
    const p = db.progress[id];
    if (!p) return "";
    return '<span class="hist">' + p.history.slice(-12).map((h) => '<i class="q' + h.q + '"></i>').join("") + "</span>";
  }

  function viewHome() {
    const cats = Array.from(new Set(db.theories.map((t) => t.category).filter(Boolean)));
    const total = db.theories.length;
    const studied = db.theories.filter((t) => db.progress[t.id] && db.progress[t.id].history.length).length;
    const due = db.theories.filter((t) => isDue(t.id)).length;
    const mastered = db.theories.filter((t) => db.progress[t.id] && db.progress[t.id].interval >= 7).length;
    app.innerHTML =
      '<div class="stats">' +
      '<div class="stat"><b>' + total + "</b><span>登録理論</span></div>" +
      '<div class="stat"><b>' + studied + "</b><span>学習済み</span></div>" +
      '<div class="stat"><b>' + due + "</b><span>今日の復習</span></div>" +
      '<div class="stat"><b>' + mastered + "</b><span>定着（間隔7日以上）</span></div>" +
      "</div>" +
      '<div class="row" style="margin-bottom:12px"><a class="btn primary" href="#/review">今日の復習を始める</a><a class="btn" href="#/edit/new">＋理論を追加</a></div>' +
      '<div class="filters">' +
      '<input type="search" id="q" placeholder="題名・本文で検索" value="' + esc(homeFilter.q) + '">' +
      '<select id="cat"><option value="">全分野</option>' + cats.map((c) => "<option" + (c === homeFilter.cat ? " selected" : "") + ">" + esc(c) + "</option>").join("") + "</select>" +
      '<select id="rank"><option value="">全ランク</option>' + ["A", "B", "C"].map((r) => "<option" + (r === homeFilter.rank ? " selected" : "") + ">" + r + "</option>").join("") + "</select>" +
      "</div>" +
      '<div id="list"></div>';
    const list = document.getElementById("list");
    function draw() {
      const q = homeFilter.q.trim();
      const items = db.theories.filter((t) =>
        (!q || t.title.includes(q) || plain(t.body).includes(q)) &&
        (!homeFilter.cat || t.category === homeFilter.cat) &&
        (!homeFilter.rank || t.rank === homeFilter.rank));
      list.innerHTML = items.length ? items.map((t) =>
        '<div class="card item">' +
        '<div style="flex:1;min-width:0"><a class="title" href="#/study/' + t.id + '">' + esc(t.title) + "</a>" +
        '<div class="row muted" style="gap:6px">' + (t.rank ? '<span class="tag r' + t.rank + '">' + t.rank + "</span>" : "") +
        (t.category ? "<span>" + esc(t.category) + "</span>" : "") + statusTag(t.id) + histHtml(t.id) + "</div></div>" +
        '<a class="btn" href="#/edit/' + t.id + '">編集</a></div>').join("")
        : '<div class="empty">該当する理論がありません</div>';
    }
    document.getElementById("q").oninput = (e) => { homeFilter.q = e.target.value; draw(); };
    document.getElementById("cat").onchange = (e) => { homeFilter.cat = e.target.value; draw(); };
    document.getElementById("rank").onchange = (e) => { homeFilter.rank = e.target.value; draw(); };
    draw();
  }

  function viewReview() {
    if (!reviewQueue) {
      const rankOrder = { A: 0, B: 1, C: 2 };
      reviewQueue = db.theories.filter((t) => isDue(t.id))
        .sort((a, b) => ((db.progress[a.id] || {}).due || "").localeCompare((db.progress[b.id] || {}).due || "") || (rankOrder[a.rank] ?? 3) - (rankOrder[b.rank] ?? 3))
        .map((t) => t.id);
    }
    const next = reviewQueue.find((id) => find(id) && isDue(id));
    if (!next) {
      reviewQueue = null;
      app.innerHTML = '<div class="card empty"><h1>今日の復習は完了です</h1><p>おつかれさまでした。</p><a class="btn primary" href="#/">一覧へ戻る</a></div>';
      return;
    }
    viewStudy(find(next), db.settings.defaultMode, true);
  }

  function viewStudy(t, mode, inReview) {
    let seed = Math.floor(Math.random() * 1e9);
    const base = inReview ? "#/review" : "#/study/" + t.id;
    const remaining = inReview ? reviewQueue.filter((id) => find(id) && isDue(id)).length : 0;
    app.innerHTML =
      '<div class="row"><a href="#/">← 一覧</a><span class="spacer"></span>' +
      (inReview ? '<span class="muted">復習 残り ' + remaining + " 件</span>" : "") + "</div>" +
      "<h1>" + esc(t.title) + "</h1>" +
      '<div class="row muted">' + (t.rank ? '<span class="tag r' + t.rank + '">' + t.rank + "</span>" : "") + esc(t.category || "") + statusTag(t.id) + histHtml(t.id) + "</div>" +
      '<div class="modes">' + MODES.map(([k, l]) => '<button data-mode="' + k + '" class="' + (k === mode ? "on" : "") + '">' + l + "</button>").join("") + "</div>" +
      '<div class="card" id="stage"></div>' +
      '<div class="rate">' + RATES.map(([q, l, s]) => '<button data-q="' + q + '">' + l + "<small>" + s + "</small></button>").join("") + "</div>";

    app.querySelectorAll("[data-mode]").forEach((b) => {
      b.onclick = () => {
        mode = b.dataset.mode;
        app.querySelectorAll("[data-mode]").forEach((x) => x.classList.toggle("on", x === b));
        if (!inReview) history.replaceState(null, "", base + "/" + mode);
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
          location.hash = "#/";
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
          [0.2, 0.4, 0.6, 0.8, 1].map((r) => '<option value="' + r + '"' + (r === db.settings.blankRatio ? " selected" : "") + ">" + r * 100 + "%</option>").join("") + "</select></label>" : "") +
        '<span class="spacer"></span><button id="tts">▶ 読み上げ</button></div>';
      stage.innerHTML = tools + '<div class="theory">' + render(t.body, mode, seed) + "</div>" +
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
      const ra = document.getElementById("ratio"); if (ra) ra.onchange = (e) => { db.settings.blankRatio = Number(e.target.value); save(); draw(); };
      document.getElementById("tts").onclick = () => speak(t.body);
    }
    function drawWrite() {
      const draftKey = "taxstudy.draft." + t.id;
      let draft = "";
      try { draft = sessionStorage.getItem(draftKey) || ""; } catch (e) { draft = ""; }
      stage.innerHTML =
        '<p class="muted" style="margin-top:0">題名だけを見て、本文を思い出して書いてください（空白・改行・【】・条文番号だけの行は判定に含めません）。</p>' +
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
      '<div class="row"><a href="#/">← 一覧</a></div>' +
      "<h1>" + (isNew ? "理論を追加" : "理論を編集") + "</h1>" +
      '<div class="card">' +
      '<label>題名</label><input type="text" id="title" value="' + esc(t.title) + '" placeholder="例：仕入れに係る消費税額の控除">' +
      '<div class="row" style="align-items:flex-start"><div style="flex:2;min-width:180px"><label>分野</label><input type="text" id="cat" list="cats" value="' + esc(t.category || "") + '" placeholder="例：仕入税額控除">' +
      '<datalist id="cats">' + cats.map((c) => "<option>" + esc(c) + "</option>").join("") + "</datalist></div>" +
      '<div style="flex:1;min-width:100px"><label>重要度</label><select id="rank">' + ["A", "B", "C"].map((r) => "<option" + (r === t.rank ? " selected" : "") + ">" + r + "</option>").join("") + "</select></div></div>" +
      '<label>本文（覚えたい語句を【】で囲むと「キーワード穴埋め」の空欄になります）</label>' +
      '<div class="row" style="margin-bottom:6px"><button id="wrap" type="button">選択範囲を【】で囲む</button><span class="muted">プレビュー：下に表示</span></div>' +
      '<textarea id="body">' + esc(t.body) + "</textarea>" +
      '<h2>プレビュー</h2><div class="theory" id="preview"></div>' +
      '<div class="row" style="margin-top:14px"><button class="primary" id="save">保存</button><a class="btn" href="#/">キャンセル</a><span class="spacer"></span>' +
      (isNew ? "" : '<button class="danger" id="del">削除</button>') + "</div></div>";
    const body = document.getElementById("body");
    const prev = document.getElementById("preview");
    const upd = () => { prev.innerHTML = render(body.value, "read"); };
    body.oninput = upd; upd();
    document.getElementById("wrap").onclick = () => {
      const s = body.selectionStart, e = body.selectionEnd;
      if (s === e) return;
      body.setRangeText("【" + body.value.slice(s, e) + "】", s, e, "end");
      body.focus(); upd();
    };
    document.getElementById("save").onclick = () => {
      const title = document.getElementById("title").value.trim();
      if (!title || !body.value.trim()) { alert("題名と本文を入力してください"); return; }
      const data = { title: title, category: document.getElementById("cat").value.trim(), rank: document.getElementById("rank").value, body: body.value, updatedAt: Date.now() };
      if (isNew) db.theories.push(Object.assign({ id: uid(), createdAt: Date.now() }, data));
      else Object.assign(t, data);
      save();
      location.hash = "#/";
    };
    const del = document.getElementById("del");
    if (del) del.onclick = () => {
      if (!confirm("「" + t.title + "」を削除しますか？学習記録も消えます。")) return;
      db.theories = db.theories.filter((x) => x.id !== t.id);
      delete db.progress[t.id];
      save();
      location.hash = "#/";
    };
  }

  function viewData() {
    app.innerHTML =
      "<h1>データ・設定</h1>" +
      '<div class="card"><h2 style="margin-top:0">学習設定</h2>' +
      '<label>復習のときに最初に開くモード</label><select id="dm">' + MODES.map(([k, l]) => '<option value="' + k + '"' + (k === db.settings.defaultMode ? " selected" : "") + ">" + l + "</option>").join("") + "</select>" +
      '<label>読み上げ速度：<span id="rv">' + db.settings.ttsRate + '</span></label><input type="range" id="rate" min="0.5" max="2" step="0.1" value="' + db.settings.ttsRate + '" style="width:100%">' +
      "</div>" +
      '<div class="card"><h2 style="margin-top:0">バックアップ</h2>' +
      '<p class="muted">データはこのブラウザの中だけに保存されます。機種変更やブラウザのデータ削除に備えて、ときどき書き出してください。</p>' +
      '<div class="row"><button class="primary" id="exp">JSONで書き出す</button><label class="btn" style="margin:0;color:var(--text)">JSONを読み込む<input type="file" id="imp" accept=".json,application/json" hidden></label></div></div>' +
      '<div class="card"><h2 style="margin-top:0">まとめて追加（テキスト）</h2>' +
      '<p class="muted">「# 題名」の行で理論を区切って貼り付けます。題名の後ろに「｜分野｜ランク」を付けられます。<br>例：<code># 課税の対象｜総則｜A</code></p>' +
      '<textarea id="bulk" style="min-height:160px" placeholder="# 題名｜分野｜A\n本文……\n\n# 次の題名\n本文……"></textarea>' +
      '<div class="row" style="margin-top:8px"><button id="bulkadd">追加する</button></div></div>' +
      '<div class="card"><h2 style="margin-top:0">リセット</h2><div class="row"><button class="danger" id="resetp">学習記録だけ消す</button><button class="danger" id="resetall">すべて消してサンプルに戻す</button></div></div>';
    document.getElementById("dm").onchange = (e) => { db.settings.defaultMode = e.target.value; save(); };
    document.getElementById("rate").oninput = (e) => { db.settings.ttsRate = Number(e.target.value); document.getElementById("rv").textContent = e.target.value; save(); };
    document.getElementById("exp").onclick = () => {
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
      f.text().then((txt) => {
        let d;
        try { d = JSON.parse(txt); } catch (err) { alert("JSONとして読み込めませんでした"); return; }
        if (!d || !Array.isArray(d.theories)) { alert("このツールのバックアップ形式ではありません"); return; }
        if (!confirm("現在のデータを読み込んだ内容で置き換えますか？")) return;
        db = { theories: d.theories, progress: d.progress || {}, settings: Object.assign(db.settings, d.settings || {}) };
        save();
        location.hash = "#/";
      });
    };
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
      alert(n + "件追加しました");
      if (n) location.hash = "#/";
    };
    document.getElementById("resetp").onclick = () => {
      if (!confirm("学習記録をすべて消しますか？")) return;
      db.progress = {}; save(); alert("消去しました");
    };
    document.getElementById("resetall").onclick = () => {
      if (!confirm("登録した理論も含めてすべて消えます。よろしいですか？")) return;
      try { localStorage.removeItem(STORE_KEY); } catch (e) { /* 無視 */ }
      db = load(); save(); location.hash = "#/";
    };
  }

  route();
})();
