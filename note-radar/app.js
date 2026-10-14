/* note売れ筋レーダー
 * data/latest.json（GitHub Actions が1時間ごとに更新）を読み込み、
 * 絞り込み・並べ替え・集計をすべてブラウザ側で行う。
 */
(() => {
  "use strict";

  const PAGE = 30;
  const REFRESH_MS = 10 * 60 * 1000;
  const STORE = { maru: "nr:maru", batsu: "nr:batsu", theme: "nr:theme", view: "nr:view" };

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const state = {
    notes: [],
    meta: null,
    demo: false,
    shown: PAGE,
    q: "",
    window: 24,
    price: "all",
    genre: "",
    minLikes: 0,
    sort: "heat",
    onlyMaru: false,
    showBatsu: false,
    view: "card",
    maru: new Set(load(STORE.maru, [])),
    batsu: new Set(load(STORE.batsu, [])),
  };

  // ---------- 保存（ブラウザ内のみ） ----------
  function load(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch (_) {
      return fallback;
    }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* 保存できなくても動作は続ける */ }
  }

  // ---------- 表示用ヘルパー ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const yen = (n) => "¥" + Number(n || 0).toLocaleString("ja-JP");
  const num = (n) => Number(n || 0).toLocaleString("ja-JP");
  const safeUrl = (u) => (typeof u === "string" && /^https:\/\//.test(u) ? u : "");

  function hoursSince(iso) {
    return Math.max((Date.now() - new Date(iso).getTime()) / 3600000, 0);
  }
  function ago(iso) {
    const h = hoursSince(iso);
    if (h < 1) return `${Math.max(1, Math.round(h * 60))}分前`;
    return `${Math.floor(h)}時間前`;
  }
  function jstHour(iso) {
    return (new Date(iso).getUTCHours() + 9) % 24;
  }
  function fmtTime(iso) {
    const d = new Date(new Date(iso).getTime() + 9 * 3600000);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  }

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 2200);
  }

  // ---------- データ読み込み ----------
  async function fetchData() {
    try {
      const res = await fetch(`data/latest.json?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      const json = await res.json();
      if (!Array.isArray(json.notes) || json.notes.length === 0) throw new Error("empty");
      state.notes = json.notes.map(enrich);
      state.meta = json;
      state.demo = false;
    } catch (_) {
      const demo = makeDemo();
      state.notes = demo.notes.map(enrich);
      state.meta = demo;
      state.demo = true;
    }
    const badge = $("#dataBadge");
    badge.textContent = state.demo ? "サンプルデータ表示中" : `有料note ${num(state.notes.length)}件を追跡中`;
    badge.classList.toggle("badge--demo", state.demo);
    $("#updatedAt").textContent = state.meta?.generatedAt ? `最終更新 ${fmtTime(state.meta.generatedAt)}（JST）` : "";
    const maxLikes = Math.max(10, ...state.notes.map((n) => n.likes));
    $("#minLikes").max = String(Math.min(500, maxLikes));
    fillGenres();
    render();
  }

  function enrich(n) {
    const tags = Array.isArray(n.hashtags) ? n.hashtags : [];
    return {
      ...n,
      hashtags: tags,
      gain3h: n.likesGain3h ?? null,
      gain1h: n.likesGain1h ?? null,
      search: [n.title, n.creator?.name, n.creator?.urlname, n.genre, ...tags.map((t) => "#" + t)].join(" ").toLowerCase(),
    };
  }

  // ---------- 絞り込み・並べ替え ----------
  function baseFiltered() {
    // ジャンル以外の条件（サイドの集計はジャンル選択前の母集団で出す）
    const words = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    const [pmin, pmax] = state.price === "all" ? [0, Infinity] : state.price.split("-").map(Number);
    return state.notes.filter((n) => {
      if (hoursSince(n.publishedAt) > state.window) return false;
      if (n.price < pmin || n.price > pmax) return false;
      if (n.likes < state.minLikes) return false;
      if (state.onlyMaru && !state.maru.has(n.key)) return false;
      if (!state.showBatsu && state.batsu.has(n.key)) return false;
      return words.every((w) => n.search.includes(w));
    });
  }

  const SORTERS = {
    heat: (a, b) => b.heat - a.heat,
    gain3h: (a, b) => (b.gain3h ?? -1) - (a.gain3h ?? -1) || b.heat - a.heat,
    likesPerHour: (a, b) => b.likesPerHour - a.likesPerHour,
    likes: (a, b) => b.likes - a.likes,
    revenueIndex: (a, b) => b.revenueIndex - a.revenueIndex,
    priceDesc: (a, b) => b.price - a.price,
    priceAsc: (a, b) => a.price - b.price,
    new: (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt),
  };

  function filtered() {
    const list = baseFiltered().filter((n) => !state.genre || n.genre === state.genre);
    return list.sort(SORTERS[state.sort] || SORTERS.heat);
  }

  // ---------- 描画 ----------
  function render() {
    syncControls();
    syncUrl();
    const base = baseFiltered();
    const list = filtered();
    renderKpis(list);
    renderList(list);
    renderGenres(base);
    renderTags(list);
    renderPrices(list);
    renderHours(list);
    renderCreators(list);
  }

  function renderKpis(list) {
    const prices = list.map((n) => n.price).sort((a, b) => a - b);
    const median = prices.length ? prices[Math.floor(prices.length / 2)] : 0;
    const likes = list.reduce((s, n) => s + n.likes, 0);
    const top = list.slice().sort(SORTERS.heat)[0];
    const gains = list.filter((n) => n.gain3h != null);
    const gainSum = gains.reduce((s, n) => s + n.gain3h, 0);
    $("#kpis").innerHTML = [
      kpi("該当する有料note", `${num(list.length)}件`, `直近${state.window}時間に公開`, "✕"),
      kpi("集まったスキ", num(likes), gains.length ? `直近3時間で +${num(gainSum)}` : "1件あたり " + (list.length ? (likes / list.length).toFixed(1) : 0), "♥"),
      kpi("価格の中央値", yen(median), prices.length ? `${yen(prices[0])} 〜 ${yen(prices[prices.length - 1])}` : "—", "¥"),
      kpi("いちばんの勢い", top ? `🔥${top.heat}` : "—", top ? esc(top.title.slice(0, 22)) + (top.title.length > 22 ? "…" : "") : "—", "○"),
    ].join("");
  }
  function kpi(label, value, sub, mark) {
    return `<div class="panel kpi" data-mark="${mark}"><div class="kpi__label">${label}</div><div class="kpi__value">${value}</div><div class="kpi__sub">${sub}</div></div>`;
  }

  function renderList(list) {
    $("#resultCount").textContent = `${num(list.length)}件`;
    const box = $("#list");
    if (!list.length) {
      box.innerHTML = `<div class="panel empty"><div class="empty__face">✕_✕</div><p>条件に合う有料noteが見つからないぞ。<br>キーワードを減らすか、期間・価格を広げてみて。</p></div>`;
      $("#moreBtn").hidden = true;
      return;
    }
    const items = list.slice(0, state.shown);
    box.innerHTML = state.view === "table" ? tableHtml(items) : items.map((n, i) => cardHtml(n, i + 1)).join("");
    $("#moreBtn").hidden = list.length <= state.shown;
    $("#moreBtn").textContent = `もっと見る（残り ${num(list.length - state.shown)}件）`;
  }

  function cardHtml(n, rank) {
    const maru = state.maru.has(n.key);
    const batsu = state.batsu.has(n.key);
    const img = safeUrl(n.eyecatch);
    const avatar = safeUrl(n.creator?.avatar);
    const fresh = hoursSince(n.publishedAt) < 3 ? `<span class="fresh">NEW</span>` : "";
    const gain = n.gain3h != null && n.gain3h > 0 ? `<span class="stat stat--up">⤴ 3hで+${num(n.gain3h)}</span>` : "";
    const purchase = n.purchaseCount != null ? `<span class="stat stat--up">🛒 ${num(n.purchaseCount)}人購入</span>` : "";
    return `
      <article class="card ${maru ? "is-maru" : ""} ${batsu ? "is-batsu" : ""}" data-key="${esc(n.key)}">
        <div class="rank ${rank <= 3 ? "rank--" + rank : ""}">${rank}</div>
        <div class="thumb" ${img ? `style="background-image:url('${esc(img)}')"` : ""}>${img ? "" : "✕○"}</div>
        <div class="card__body">
          <h3 class="card__title"><a href="${esc(safeUrl(n.url))}" target="_blank" rel="noopener">${esc(n.title)}</a>${fresh}</h3>
          <div class="card__creator">
            ${avatar ? `<img class="avatar" src="${esc(avatar)}" alt="" loading="lazy">` : ""}
            <button class="hashtag" data-creator="${esc(n.creator?.name)}">${esc(n.creator?.name || "不明")}</button>
            <span>・${ago(n.publishedAt)}</span>
            <span class="genre-pill">${esc(n.genre)}</span>
          </div>
          <div class="stats">
            <span class="stat stat--price">${yen(n.price)}</span>
            <span class="stat stat--heat">🔥 ${n.heat}</span>
            <span class="stat">♥ ${num(n.likes)}</span>
            <span class="stat">⏱ ${n.likesPerHour}/h</span>
            ${gain}${purchase}
          </div>
          <div class="card__foot">
            <div class="hashtags">${n.hashtags.slice(0, 5).map((t) => `<button class="hashtag" data-tag="${esc(t)}">#${esc(t)}</button>`).join("")}</div>
            ${sparkSvg(n, 110, 32, "spark")}
            <button class="card__more" data-detail="${esc(n.key)}">詳しく</button>
          </div>
        </div>
        <div class="actions">
          <button class="mb mb--maru ${maru ? "on" : ""}" data-maru="${esc(n.key)}" title="保存" aria-pressed="${maru}">○</button>
          <button class="mb mb--batsu ${batsu ? "on" : ""}" data-batsu="${esc(n.key)}" title="非表示" aria-pressed="${batsu}">✕</button>
        </div>
      </article>`;
  }

  function tableHtml(items) {
    const cols = [
      ["#", null], ["タイトル", null], ["作者", null], ["価格", "priceDesc"], ["🔥勢い", "heat"],
      ["♥スキ", "likes"], ["/h", "likesPerHour"], ["3h増", "gain3h"], ["スキ×価格", "revenueIndex"], ["公開", "new"], ["", null],
    ];
    const head = cols.map(([label, key]) => `<th ${key ? `data-sort="${key}"` : ""}>${label}${key === state.sort ? " ▼" : ""}</th>`).join("");
    const rows = items.map((n, i) => {
      const maru = state.maru.has(n.key);
      return `<tr>
        <td class="num">${i + 1}</td>
        <td class="title"><a href="${esc(safeUrl(n.url))}" target="_blank" rel="noopener">${esc(n.title)}</a></td>
        <td>${esc(n.creator?.name || "")}</td>
        <td class="num">${yen(n.price)}</td>
        <td class="num">${n.heat}</td>
        <td class="num">${num(n.likes)}</td>
        <td class="num">${n.likesPerHour}</td>
        <td class="num">${n.gain3h == null ? "—" : "+" + num(n.gain3h)}</td>
        <td class="num">${yen(n.revenueIndex)}</td>
        <td>${ago(n.publishedAt)}</td>
        <td><button class="mb mb--maru ${maru ? "on" : ""}" data-maru="${esc(n.key)}" title="保存">○</button></td>
      </tr>`;
    }).join("");
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function sparkPoints(n) {
    let pts = (n.history || []).map(([ts, v]) => [new Date(ts).getTime(), v]);
    if (pts.length < 2) pts = [[new Date(n.publishedAt).getTime(), 0], [Date.now(), n.likes]];
    return pts;
  }
  function sparkSvg(n, w, h, cls, axis = false) {
    const pts = sparkPoints(n);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs) || x0 + 1;
    const y0 = Math.min(...ys), y1 = Math.max(...ys);
    const pad = axis ? 18 : 3;
    const sx = (x) => pad + ((x - x0) / Math.max(x1 - x0, 1)) * (w - pad * 2);
    const sy = (y) => h - pad - ((y - y0) / Math.max(y1 - y0, 1)) * (h - pad * 2);
    const line = pts.map((p, i) => `${i ? "L" : "M"}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join("");
    const area = `${line}L${sx(x1).toFixed(1)},${h - pad}L${sx(x0).toFixed(1)},${h - pad}Z`;
    const labels = axis
      ? `<text x="${pad}" y="12">♥${y1}</text><text x="${pad}" y="${h - 4}">${fmtTime(new Date(x0).toISOString())}</text><text x="${w - pad}" y="${h - 4}" text-anchor="end">${fmtTime(new Date(x1).toISOString())}</text>`
      : "";
    return `<svg class="${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="スキ数の推移"><path class="area" d="${area}"/><path d="${line}"/>${labels}</svg>`;
  }

  function bars(rows, attr, activeValue) {
    const max = Math.max(1, ...rows.map((r) => r.value));
    return rows.map((r) => `
      <button class="bar ${activeValue === r.key ? "on" : ""}" ${attr ? `data-${attr}="${esc(r.key)}"` : ""}>
        <span>${esc(r.label)}</span>
        <span class="bar__track"><span class="bar__fill" style="width:${(r.value / max) * 100}%;display:block"></span></span>
        <span class="bar__val">${r.display}</span>
      </button>`).join("");
  }

  function renderGenres(list) {
    const m = new Map();
    list.forEach((n) => {
      const g = m.get(n.genre) || { heat: 0, count: 0 };
      g.heat += n.heat; g.count += 1;
      m.set(n.genre, g);
    });
    const rows = [...m.entries()].sort((a, b) => b[1].heat - a[1].heat)
      .map(([k, v]) => ({ key: k, label: k, value: v.heat, display: `${v.count}件` }));
    $("#genreChart").innerHTML = rows.length ? bars(rows, "genre", state.genre) : `<p class="note-text">データなし</p>`;
  }

  function renderTags(list) {
    const m = new Map();
    list.forEach((n) => n.hashtags.forEach((t) => m.set(t, (m.get(t) || 0) + n.heat)));
    const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18);
    $("#tagCloud").innerHTML = top.length
      ? top.map(([t, v]) => `<button data-tag="${esc(t)}">#${esc(t)}<small>${Math.round(v)}</small></button>`).join("")
      : `<p class="note-text">ハッシュタグなし</p>`;
  }

  function renderPrices(list) {
    const bands = [["〜300", 0, 300], ["301〜500", 301, 500], ["501〜1,000", 501, 1000], ["1,001〜3,000", 1001, 3000], ["3,001〜10,000", 3001, 10000], ["10,001〜", 10001, Infinity]];
    const rows = bands.map(([label, lo, hi]) => {
      const items = list.filter((n) => n.price >= lo && n.price <= hi);
      const avgHeat = items.length ? items.reduce((s, n) => s + n.heat, 0) / items.length : 0;
      return { key: label, label, value: items.length, display: `${items.length}件`, avgHeat };
    });
    $("#priceChart").innerHTML = bars(rows, null) +
      `<p class="note-text">平均勢いが一番高い価格帯: <b>${rows.slice().sort((a, b) => b.avgHeat - a.avgHeat)[0].label}円</b></p>`;
  }

  function renderHours(list) {
    const counts = Array(24).fill(0);
    list.forEach((n) => { counts[jstHour(n.publishedAt)] += 1; });
    const max = Math.max(1, ...counts);
    const peak = counts.indexOf(Math.max(...counts));
    $("#hourChart").innerHTML = counts.map((c, h) => `<div class="${h === peak && c ? "peak" : ""}" style="height:${(c / max) * 100}%" title="${h}時台: ${c}件"></div>`).join("");
    $("#hourNote").textContent = list.length ? `いちばん多いのは ${peak}時台（${counts[peak]}件）。0時 → 23時` : "";
  }

  function renderCreators(list) {
    const m = new Map();
    list.forEach((n) => {
      const name = n.creator?.name || "不明";
      const c = m.get(name) || { heat: 0, count: 0, likes: 0 };
      c.heat += n.heat; c.count += 1; c.likes += n.likes;
      m.set(name, c);
    });
    const top = [...m.entries()].sort((a, b) => b[1].heat - a[1].heat).slice(0, 8);
    $("#creators").innerHTML = top.map(([name, c]) =>
      `<li><button data-creator="${esc(name)}">${esc(name)}</button><span>${c.count}本・♥${num(c.likes)}</span></li>`).join("");
  }

  // ---------- 詳細 ----------
  function openDetail(key) {
    const n = state.notes.find((x) => x.key === key);
    if (!n) return;
    const est = (rate) => Math.round(n.likes * rate);
    $("#detailBody").innerHTML = `
      <span class="genre-pill">${esc(n.genre)}</span>
      <h3>${esc(n.title)}</h3>
      <p class="muted">${esc(n.creator?.name || "")}・公開 ${fmtTime(n.publishedAt)}（${ago(n.publishedAt)}）</p>
      <div class="detail__grid">
        <div><small>価格</small><b>${yen(n.price)}</b></div>
        <div><small>勢いスコア</small><b>🔥${n.heat}</b></div>
        <div><small>スキ</small><b>♥${num(n.likes)}</b></div>
        <div><small>1時間あたり</small><b>${n.likesPerHour}</b></div>
        <div><small>直近1h / 3h</small><b>${n.gain1h == null ? "—" : "+" + n.gain1h} / ${n.gain3h == null ? "—" : "+" + n.gain3h}</b></div>
        <div><small>スキ×価格</small><b>${yen(n.revenueIndex)}</b></div>
      </div>
      ${sparkSvg(n, 600, 140, "bigspark", true)}
      <p class="note-text">参考: スキした人の 30〜80% が購入者だと仮定すると、購入数はおよそ <b>${num(est(0.3))}〜${num(est(0.8))}件</b>、売上は <b>${yen(est(0.3) * n.price)}〜${yen(est(0.8) * n.price)}</b>。あくまで仮定に基づく目安です。</p>
      <p class="note-text">${n.hashtags.map((t) => "#" + esc(t)).join(" ")}</p>
      <p style="margin-top:14px"><a class="btn" href="${esc(safeUrl(n.url))}" target="_blank" rel="noopener">noteで開く ↗</a></p>`;
    $("#detail").showModal();
  }

  // ---------- 操作 ----------
  function toggleMark(set, other, key, storeKey, otherKey) {
    if (set.has(key)) set.delete(key);
    else { set.add(key); other.delete(key); }
    save(storeKey, [...set]);
    save(otherKey, [...other]);
    render();
  }

  function syncControls() {
    $("#q").value !== state.q && ($("#q").value = state.q);
    $$("#windowChips button").forEach((b) => b.classList.toggle("on", Number(b.dataset.v) === state.window));
    $$("#priceChips button").forEach((b) => b.classList.toggle("on", b.dataset.v === state.price));
    $("#genre").value = state.genre;
    $("#minLikes").value = String(state.minLikes);
    $("#minLikesVal").textContent = String(state.minLikes);
    $("#sort").value = state.sort;
    $("#onlyMaru").checked = state.onlyMaru;
    $("#showBatsu").checked = state.showBatsu;
    $("#viewCard").classList.toggle("on", state.view === "card");
    $("#viewTable").classList.toggle("on", state.view === "table");
  }

  function fillGenres() {
    const genres = [...new Set(state.notes.map((n) => n.genre))].sort();
    $("#genre").innerHTML = `<option value="">すべて</option>` + genres.map((g) => `<option>${esc(g)}</option>`).join("");
  }

  function syncUrl() {
    const p = new URLSearchParams();
    if (state.q) p.set("q", state.q);
    if (state.window !== 24) p.set("h", state.window);
    if (state.price !== "all") p.set("price", state.price);
    if (state.genre) p.set("genre", state.genre);
    if (state.minLikes) p.set("min", state.minLikes);
    if (state.sort !== "heat") p.set("sort", state.sort);
    const qs = p.toString();
    history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
  }
  function readUrl() {
    const p = new URLSearchParams(location.search);
    state.q = p.get("q") || "";
    state.window = [3, 6, 12, 24].includes(Number(p.get("h"))) ? Number(p.get("h")) : 24;
    state.price = p.get("price") || "all";
    state.genre = p.get("genre") || "";
    state.minLikes = Number(p.get("min")) || 0;
    state.sort = SORTERS[p.get("sort")] ? p.get("sort") : "heat";
  }

  function update(patch) {
    Object.assign(state, patch, { shown: PAGE });
    render();
  }

  function exportCsv() {
    const list = filtered();
    const head = ["順位", "タイトル", "作者", "価格", "勢いスコア", "スキ", "1時間あたりスキ", "3h増加", "スキ×価格", "ジャンル", "公開日時", "ハッシュタグ", "URL"];
    const rows = list.map((n, i) => [i + 1, n.title, n.creator?.name, n.price, n.heat, n.likes, n.likesPerHour, n.gain3h ?? "", n.revenueIndex, n.genre, fmtTime(n.publishedAt), n.hashtags.join(" "), n.url]);
    const csv = [head, ...rows].map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `note-urezuji-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`${list.length}件をCSVに書き出しました`);
  }

  function bind() {
    let t;
    $("#q").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => update({ q: e.target.value.trim() }), 200); });
    $("#windowChips").addEventListener("click", (e) => e.target.dataset.v && update({ window: Number(e.target.dataset.v) }));
    $("#priceChips").addEventListener("click", (e) => e.target.dataset.v && update({ price: e.target.dataset.v }));
    $("#genre").addEventListener("change", (e) => update({ genre: e.target.value }));
    $("#minLikes").addEventListener("input", (e) => update({ minLikes: Number(e.target.value) }));
    $("#sort").addEventListener("change", (e) => update({ sort: e.target.value }));
    $("#onlyMaru").addEventListener("change", (e) => update({ onlyMaru: e.target.checked }));
    $("#showBatsu").addEventListener("change", (e) => update({ showBatsu: e.target.checked }));
    $("#viewCard").addEventListener("click", () => { save(STORE.view, "card"); update({ view: "card" }); });
    $("#viewTable").addEventListener("click", () => { save(STORE.view, "table"); update({ view: "table" }); });
    $("#moreBtn").addEventListener("click", () => { state.shown += PAGE; render(); });
    $("#csvBtn").addEventListener("click", exportCsv);
    $("#resetBtn").addEventListener("click", () => update({ q: "", window: 24, price: "all", genre: "", minLikes: 0, sort: "heat", onlyMaru: false, showBatsu: false }));
    $("#shareBtn").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(location.href); toast("この検索条件のURLをコピーしました"); }
      catch (_) { toast(location.href); }
    });
    $("#themeBtn").addEventListener("click", () => {
      const dark = document.documentElement.dataset.theme
        ? document.documentElement.dataset.theme === "dark"
        : matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.dataset.theme = dark ? "light" : "dark";
      save(STORE.theme, document.documentElement.dataset.theme);
    });

    // 一覧・サイド内のボタンはまとめて委譲
    document.addEventListener("click", (e) => {
      const el = e.target.closest("[data-maru],[data-batsu],[data-tag],[data-creator],[data-genre],[data-detail],[data-sort]");
      if (!el) return;
      const d = el.dataset;
      if (d.maru) toggleMark(state.maru, state.batsu, d.maru, STORE.maru, STORE.batsu);
      else if (d.batsu) toggleMark(state.batsu, state.maru, d.batsu, STORE.batsu, STORE.maru);
      else if (d.tag) update({ q: "#" + d.tag });
      else if (d.creator) update({ q: d.creator });
      else if (d.genre !== undefined) update({ genre: state.genre === d.genre ? "" : d.genre });
      else if (d.detail) openDetail(d.detail);
      else if (d.sort) update({ sort: d.sort });
    });
    $("#detail").addEventListener("click", (e) => { if (e.target.id === "detail") e.target.close(); });
  }

  // ---------- サンプルデータ（data/latest.json がまだ無いとき用） ----------
  function makeDemo() {
    let seed = 20261014;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pickOne = (a) => a[Math.floor(rnd() * a.length)];
    const topics = [
      ["AI・テック", ["ChatGPT", "生成AI", "プロンプト", "Claude"], ["ChatGPTで月10万円稼ぐ完全マニュアル", "Claudeで業務を9割自動化したプロンプト集", "生成AI画像で副業を始める全手順"]],
      ["副業・稼ぐ", ["副業", "コンテンツ販売", "マネタイズ"], ["会社員が副業で月5万円を超えるまでにやったこと全部", "noteで初月30万円売れた有料記事の作り方", "スキマ時間で始める物販の教科書"]],
      ["SNS・マーケ", ["X運用", "SNS運用", "Instagram"], ["フォロワー0から1万人までのX運用ロードマップ", "インスタ集客で予約が3倍になった投稿テンプレ", "バズるショート動画の台本の型"]],
      ["投資・お金", ["投資", "新NISA", "株"], ["新NISAで迷わない銘柄選びの結論", "高配当株で月3万円の不労所得をつくる", "FXで負けない資金管理ルール"]],
      ["ギャンブル予想", ["競馬", "競馬予想"], ["今週末の重賞 本命と穴馬を全公開", "回収率120%を続ける馬券の買い方"]],
      ["恋愛・美容", ["恋愛", "ダイエット", "美容"], ["3ヶ月で-8kgした食事メニュー全公開", "マッチングアプリで会える人になるプロフィール術"]],
      ["仕事・キャリア", ["転職", "キャリア"], ["年収を150万上げた転職の進め方", "外資コンサル流 資料作成の基本"]],
      ["占い・スピ", ["占い", "タロット"], ["2026年下半期の12星座別 運勢鑑定", "お金に好かれる人の開運習慣"]],
    ];
    const names = ["ゆうき｜AI副業", "まる子", "ペン田くん", "Kei@マーケター", "しろくろ", "あおい｜投資", "夜ふかし研究所", "とげとげ", "ナマイキ編集部", "はやて"];
    const now = Date.now();
    const notes = [];
    for (let i = 0; i < 64; i++) {
      const [genre, tags, titles] = pickOne(topics);
      const age = rnd() * 23.5 + 0.3;
      const price = pickOne([100, 300, 480, 500, 980, 1000, 1480, 1980, 2980, 4980, 9800, 19800]);
      const speed = Math.pow(rnd(), 2.2) * 9;
      const likes = Math.max(0, Math.round(speed * age + rnd() * 3));
      const published = new Date(now - age * 3600000);
      const history = [];
      for (let h = Math.min(Math.floor(age), 24); h >= 0; h--) {
        history.push([new Date(now - h * 3600000).toISOString(), Math.round(likes * Math.pow((age - h) / age, 0.8))]);
      }
      const g3 = likes - (history[history.length - 4]?.[1] ?? 0);
      const lph = +(likes / Math.max(age, 0.5)).toFixed(2);
      notes.push({
        key: "nsample" + i.toString(16).padStart(6, "0"),
        title: pickOne(titles) + (rnd() > 0.7 ? "【保存版】" : ""),
        url: "https://note.com/",
        price, likes, comments: Math.round(likes * 0.05),
        publishedAt: published.toISOString(),
        eyecatch: null,
        hashtags: [...new Set([pickOne(tags), pickOne(tags), "有料記事"])],
        genre,
        creator: { name: pickOne(names), urlname: "", avatar: null },
        likesPerHour: lph,
        likesGain1h: likes - (history[history.length - 2]?.[1] ?? 0),
        likesGain3h: g3,
        heat: +((lph * 0.6 + (g3 / 3) * 0.4) * (1 + Math.min(price, 30000) / 10000) * 10).toFixed(1),
        revenueIndex: likes * price,
        history,
      });
    }
    return { generatedAt: new Date(now).toISOString(), windowHours: 24, notes };
  }

  // ---------- 起動 ----------
  const theme = load(STORE.theme, null);
  if (theme) document.documentElement.dataset.theme = theme;
  state.view = load(STORE.view, "card") === "table" ? "table" : "card";
  readUrl();
  bind();
  $("#list").innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  fetchData();
  setInterval(fetchData, REFRESH_MS);
})();
