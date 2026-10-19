/* note売れ筋レーダー
 * data/latest.json（GitHub Actions が1時間ごとに更新）を読み込み、
 * テーマ切り替え・絞り込み・並べ替え・集計をすべてブラウザ側で行う。
 * latest.json に入っているのは「直近24時間でスキが増えた有料note」だけ。
 */
(() => {
  "use strict";

  const PAGE = 30;
  const REFRESH_MS = 10 * 60 * 1000;
  const WINDOWS = [1, 3, 6, 24];
  const STORE = { maru: "nr:maru", batsu: "nr:batsu", theme: "nr:theme", view: "nr:view" };
  const ALL = { id: "", name: "すべて", emoji: "✕○" };

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const state = {
    notes: [],
    themes: [],
    meta: null,
    demo: false,
    shown: PAGE,
    theme: "",
    q: "",
    window: 24,
    published: 0,
    price: "all",
    minGain: 1,
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
  const gainOf = (n, h = state.window) => n[`gain${h}h`] ?? 0;
  const themeById = (id) => state.themes.find((t) => t.id === id);

  function hoursSince(iso) {
    return Math.max((Date.now() - new Date(iso).getTime()) / 3600000, 0);
  }
  function ago(iso) {
    const h = hoursSince(iso);
    if (h < 1) return `${Math.max(1, Math.round(h * 60))}分前`;
    if (h < 48) return `${Math.floor(h)}時間前`;
    return `${Math.floor(h / 24)}日前`;
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
  async function getJson(path) {
    const res = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  async function fetchData() {
    let themes = [];
    try { themes = await getJson("themes.json"); } catch (_) { /* latest.json 側の定義を使う */ }
    try {
      const json = await getJson("data/latest.json");
      if (!Array.isArray(json.notes)) throw new Error("no notes");
      state.meta = json;
      state.notes = json.notes.map(enrich);
      state.demo = false;
      if (!themes.length && Array.isArray(json.themes)) themes = json.themes;
    } catch (_) {
      const demo = makeDemo(themes);
      state.meta = demo;
      state.notes = demo.notes.map(enrich);
      state.demo = true;
    }
    state.themes = themes.map(({ id, name, emoji }) => ({ id, name, emoji }));
    if (state.theme && !themeById(state.theme)) state.theme = "";

    const badge = $("#dataBadge");
    badge.textContent = state.demo ? "サンプルデータ表示中" : `24hで売れた有料note ${num(state.notes.length)}件`;
    badge.classList.toggle("badge--demo", state.demo);
    $("#updatedAt").textContent = state.meta?.generatedAt ? `最終更新 ${fmtTime(state.meta.generatedAt)}（JST）` : "";
    renderNotice();
    render();
  }

  function enrich(n) {
    const tags = Array.isArray(n.hashtags) ? n.hashtags : [];
    const themes = Array.isArray(n.themes) ? n.themes : [];
    return {
      ...n,
      hashtags: tags,
      themes,
      search: [n.title, n.creator?.name, n.creator?.urlname, ...tags.map((t) => "#" + t)].join(" ").toLowerCase(),
    };
  }

  function renderNotice() {
    const box = $("#notice");
    const m = state.meta;
    if (state.demo) {
      box.innerHTML = "<b>サンプルデータを表示しています。</b> GitHub Actions がデータを集め始めると、実際の「24時間以内に売れた有料note」に切り替わります。";
      box.hidden = false;
      return;
    }
    const since = m?.trackingSince ? (new Date(m.generatedAt) - new Date(m.trackingSince)) / 3600000 : 24;
    if (since < 24) {
      box.innerHTML = `<b>計測を始めてから ${Math.floor(since)}時間です。</b> 24時間分の記録がそろうまでは、前から出ている記事の「売れた数」が実際より少なめに出ます。`;
      box.hidden = false;
    } else {
      box.hidden = true;
    }
  }

  // ---------- 絞り込み・並べ替え ----------
  function baseFiltered() {
    // テーマ以外の条件（テーマ別の件数はテーマ選択前の母集団で出す）
    const words = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    const [pmin, pmax] = state.price === "all" ? [0, Infinity] : state.price.split("-").map(Number);
    return state.notes.filter((n) => {
      if (gainOf(n) < state.minGain) return false;
      if (state.published && hoursSince(n.publishedAt) > state.published) return false;
      if (n.price < pmin || n.price > pmax) return false;
      if (state.onlyMaru && !state.maru.has(n.key)) return false;
      if (!state.showBatsu && state.batsu.has(n.key)) return false;
      return words.every((w) => n.search.includes(w));
    });
  }

  const SORTERS = {
    heat: (a, b) => b.heat - a.heat,
    gain24h: (a, b) => b.gain24h - a.gain24h || b.heat - a.heat,
    gain3h: (a, b) => b.gain3h - a.gain3h || b.heat - a.heat,
    gain1h: (a, b) => b.gain1h - a.gain1h || b.heat - a.heat,
    salesIndex: (a, b) => b.salesIndex - a.salesIndex,
    likes: (a, b) => b.likes - a.likes,
    priceDesc: (a, b) => b.price - a.price,
    priceAsc: (a, b) => a.price - b.price,
    new: (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt),
  };

  const inTheme = (n, id) => !id || n.themes.includes(id);

  function filtered(base = baseFiltered()) {
    return base.filter((n) => inTheme(n, state.theme)).sort(SORTERS[state.sort] || SORTERS.heat);
  }

  // ---------- 描画 ----------
  function render() {
    syncControls();
    syncUrl();
    const base = baseFiltered();
    const list = filtered(base);
    renderTabs(base);
    renderThemeHead(base, list);
    renderKpis(list);
    renderList(list);
    renderThemeChart(base);
    renderTags(list);
    renderPrices(list);
    renderHours(list);
    renderCreators(list);
  }

  function themeStats(list) {
    const sold = list.reduce((s, n) => s + gainOf(n), 0);
    const sales = list.reduce((s, n) => s + gainOf(n) * n.price, 0);
    return { count: list.length, sold, sales };
  }

  function renderTabs(base) {
    const tabs = [ALL, ...state.themes].map((t) => {
      const count = base.filter((n) => inTheme(n, t.id)).length;
      const on = state.theme === t.id;
      return `<button role="tab" aria-selected="${on}" class="theme-tab ${on ? "on" : ""}" data-topic="${esc(t.id)}">
        <span class="theme-tab__emoji">${esc(t.emoji)}</span><span>${esc(t.name)}</span><span class="theme-tab__count">${num(count)}</span>
      </button>`;
    });
    $("#themeTabs").innerHTML = tabs.join("");
    const active = $("#themeTabs .on");
    if (active && !renderTabs.scrolled) { active.scrollIntoView({ inline: "center", block: "nearest" }); renderTabs.scrolled = true; }
  }

  function renderThemeHead(base, list) {
    const box = $("#themeHead");
    if (!state.theme) {
      // 「すべて」のときはテーマごとの売れ行きカードを並べる
      const cards = state.themes.map((t) => {
        const items = base.filter((n) => inTheme(n, t.id));
        const s = themeStats(items);
        const top = items.slice().sort(SORTERS.heat)[0];
        return { t, s, top };
      }).sort((a, b) => b.s.sold - a.s.sold);
      box.innerHTML = `<div class="theme-grid">${cards.map(({ t, s, top }, i) => `
        <button class="theme-card ${i === 0 && s.sold ? "theme-card--top" : ""}" data-topic="${esc(t.id)}">
          <span class="theme-card__emoji">${esc(t.emoji)}</span>
          <span class="theme-card__name">${esc(t.name)}</span>
          <span class="theme-card__num">+${num(s.sold)}<small> 売れた</small></span>
          <span class="theme-card__sub">${num(s.count)}本${top ? `・1位「${esc(top.title.slice(0, 14))}${top.title.length > 14 ? "…" : ""}」` : ""}</span>
        </button>`).join("")}</div>`;
      return;
    }
    const t = themeById(state.theme);
    const s = themeStats(list);
    const tagCount = new Map();
    list.forEach((n) => n.hashtags.forEach((h) => tagCount.set(h, (tagCount.get(h) || 0) + gainOf(n))));
    const tags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    box.innerHTML = `
      <div class="theme-banner">
        <span class="theme-banner__emoji">${esc(t.emoji)}</span>
        <div class="theme-banner__body">
          <h2>${esc(t.name)}<small>で${state.window}時間以内に売れたnote</small></h2>
          <p>${num(s.count)}本 ／ 売れた数の目安 +${num(s.sold)} ／ 売上の目安 ${yen(s.sales)}</p>
          <div class="theme-banner__tags">${tags.map(([h]) => `<button class="tag" data-tag="${esc(h)}">#${esc(h)}</button>`).join("")}</div>
        </div>
        <button class="btn btn--ghost" data-topic="">すべてのテーマへ</button>
      </div>`;
  }

  function renderKpis(list) {
    const s = themeStats(list);
    const prices = list.map((n) => n.price).sort((a, b) => a - b);
    const median = prices.length ? prices[Math.floor(prices.length / 2)] : 0;
    const fresh = list.filter((n) => hoursSince(n.publishedAt) <= 24).length;
    $("#kpis").innerHTML = [
      kpi(`${state.window}時間以内に売れたnote`, `${num(list.length)}<small>本</small>`, `うち新作 ${num(fresh)}本`),
      kpi("売れた数の目安", `+${num(s.sold)}`, `売上の目安 ${yen(s.sales)}`),
      kpi("売れた記事の価格（中央値）", yen(median), prices.length ? `${yen(prices[0])} 〜 ${yen(prices[prices.length - 1])}` : "—"),
    ].join("");
  }
  function kpi(label, value, sub) {
    return `<div class="kpi"><div class="kpi__label">${label}</div><div class="kpi__value">${value}</div><div class="kpi__sub">${sub}</div></div>`;
  }

  function renderList(list) {
    const t = themeById(state.theme);
    $("#rankTitle").textContent = t ? `${t.name}の売れ筋ランキング` : "売れ筋ランキング";
    $("#resultCount").textContent = `${num(list.length)}件`;
    const box = $("#list");
    if (!list.length) {
      box.innerHTML = `<div class="panel empty"><img src="img/icon.webp" alt="" width="88" height="88"><p>この条件で${state.window}時間以内に売れた有料noteは見つからなかった。<br>キーワードを減らすか、期間・価格・テーマを広げてみて。</p></div>`;
      $("#moreBtn").hidden = true;
      return;
    }
    const items = list.slice(0, state.shown);
    box.innerHTML = state.view === "table" ? tableHtml(items) : items.map((n, i) => cardHtml(n, i + 1)).join("");
    $("#moreBtn").hidden = list.length <= state.shown;
    $("#moreBtn").textContent = `もっと見る（残り ${num(list.length - state.shown)}件）`;
  }

  function themeChips(n) {
    return n.themes.slice(0, 2).map((id) => {
      const t = themeById(id);
      return t ? `<button class="label label--theme" data-topic="${esc(t.id)}">${esc(t.emoji)} ${esc(t.name)}</button>` : "";
    }).join("");
  }

  // noteの記事へのリンク。サンプルデータは実在しないので、noteの検索結果に飛ばす
  function noteLink(n) {
    if (n.sample) return { href: `https://note.com/search?context=note&q=${encodeURIComponent(n.searchWord || n.title)}`, label: "noteで似た記事を探す" };
    return { href: safeUrl(n.url), label: "noteで読む" };
  }

  function cardHtml(n, rank) {
    const maru = state.maru.has(n.key);
    const batsu = state.batsu.has(n.key);
    const img = safeUrl(n.eyecatch);
    const avatar = safeUrl(n.creator?.avatar);
    const link = noteLink(n);
    const fresh = hoursSince(n.publishedAt) <= 24 ? `<span class="label label--new">新作</span>` : `<span class="label">ロングセラー</span>`;
    const partial = n.measuredHours != null && n.measuredHours < 24 && hoursSince(n.publishedAt) > 24
      ? `<span class="card__hint">計測を始めてから${Math.floor(n.measuredHours)}時間分</span>` : "";
    return `
      <article class="card ${rank <= 3 ? "card--top" : ""} ${maru ? "is-maru" : ""} ${batsu ? "is-batsu" : ""}" data-key="${esc(n.key)}">
        <div class="card__rank ${rank <= 3 ? "card__rank--" + rank : ""}">${rank}</div>
        <a class="card__thumb" href="${esc(link.href)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true" ${img ? `style="background-image:url('${esc(img)}')"` : ""}>${img ? "" : `<img src="img/icon.webp" alt="">`}</a>
        <div class="card__main">
          <div class="card__meta">${fresh}${themeChips(n)}<span class="muted">公開 ${ago(n.publishedAt)}</span></div>
          <h3 class="card__title"><a href="${esc(link.href)}" target="_blank" rel="noopener">${esc(n.title)}</a></h3>
          <div class="card__creator">
            ${avatar ? `<img class="avatar" src="${esc(avatar)}" alt="" loading="lazy">` : ""}
            <button class="linkish" data-creator="${esc(n.creator?.name)}">${esc(n.creator?.name || "不明")}</button>
          </div>
          <div class="card__nums">
            <div class="num-big"><span class="num-big__v">+${num(gainOf(n))}</span><span class="num-big__l">${state.window}時間で売れた</span></div>
            <div class="num"><span class="num__v">${yen(n.price)}</span><span class="num__l">価格</span></div>
            <div class="num"><span class="num__v">${n.heat}</span><span class="num__l">勢い</span></div>
            <div class="num"><span class="num__v">${num(n.likes)}</span><span class="num__l">スキ累計</span></div>
          </div>
          ${partial}
          ${n.hashtags.length ? `<div class="card__tags">${n.hashtags.slice(0, 4).map((t) => `<button class="tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join("")}</div>` : ""}
        </div>
        <div class="card__side">
          <a class="read-btn" href="${esc(link.href)}" target="_blank" rel="noopener">${link.label} <span aria-hidden="true">→</span></a>
          <div class="card__sub-actions">
            <button class="mini" data-detail="${esc(n.key)}">詳しく</button>
            <button class="mini mini--icon ${maru ? "on" : ""}" data-maru="${esc(n.key)}" title="保存" aria-label="保存" aria-pressed="${maru}">○</button>
            <button class="mini mini--icon ${batsu ? "on" : ""}" data-batsu="${esc(n.key)}" title="非表示" aria-label="非表示" aria-pressed="${batsu}">✕</button>
          </div>
        </div>
      </article>`;
  }

  function tableHtml(items) {
    const cols = [
      ["#", null], ["タイトル", null], ["テーマ", null], ["価格", "priceDesc"], ["🔥勢い", "heat"],
      ["24h売れ", "gain24h"], ["3h", "gain3h"], ["1h", "gain1h"], ["増加×価格", "salesIndex"], ["♥累計", "likes"], ["公開", "new"], ["", null],
    ];
    const head = cols.map(([label, key]) => `<th ${key ? `data-sort="${key}"` : ""}>${label}${key === state.sort ? " ▼" : ""}</th>`).join("");
    const rows = items.map((n, i) => {
      const maru = state.maru.has(n.key);
      return `<tr>
        <td class="num">${i + 1}</td>
        <td class="title"><a href="${esc(noteLink(n).href)}" target="_blank" rel="noopener">${esc(n.title)}</a><br><small class="muted">${esc(n.creator?.name || "")}</small></td>
        <td>${n.themes.slice(0, 2).map((id) => esc(themeById(id)?.name || "")).join("<br>")}</td>
        <td class="num">${yen(n.price)}</td>
        <td class="num">${n.heat}</td>
        <td class="num"><b>+${num(n.gain24h)}</b></td>
        <td class="num">+${num(n.gain3h)}</td>
        <td class="num">+${num(n.gain1h)}</td>
        <td class="num">${yen(n.salesIndex)}</td>
        <td class="num">${num(n.likes)}</td>
        <td>${ago(n.publishedAt)}</td>
        <td><button class="mini mini--icon ${maru ? "on" : ""}" data-maru="${esc(n.key)}" title="保存" aria-label="保存">○</button></td>
      </tr>`;
    }).join("");
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function sparkPoints(n) {
    let pts = (n.history || []).map(([ts, v]) => [new Date(ts).getTime(), v]);
    if (pts.length < 2) pts = [[Date.now() - 24 * 3600000, n.likes - n.gain24h], [Date.now(), n.likes]];
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

  function renderThemeChart(base) {
    const rows = state.themes.map((t) => {
      const s = themeStats(base.filter((n) => inTheme(n, t.id)));
      return { key: t.id, label: `${t.emoji} ${t.name}`, value: s.sold, display: `+${num(s.sold)}` };
    }).sort((a, b) => b.value - a.value);
    $("#themeChart").innerHTML = rows.length ? bars(rows, "topic", state.theme) : `<p class="note-text">データなし</p>`;
  }

  function renderTags(list) {
    const m = new Map();
    list.forEach((n) => n.hashtags.forEach((t) => m.set(t, (m.get(t) || 0) + gainOf(n))));
    const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18);
    $("#tagCloud").innerHTML = top.length
      ? top.map(([t, v]) => `<button data-tag="${esc(t)}">#${esc(t)}<small>+${num(v)}</small></button>`).join("")
      : `<p class="note-text">ハッシュタグなし</p>`;
  }

  function renderPrices(list) {
    const bands = [["〜300", 0, 300], ["301〜500", 301, 500], ["501〜1,000", 501, 1000], ["1,001〜3,000", 1001, 3000], ["3,001〜10,000", 3001, 10000], ["10,001〜", 10001, Infinity]];
    const rows = bands.map(([label, lo, hi]) => {
      const items = list.filter((n) => n.price >= lo && n.price <= hi);
      const sold = items.reduce((s, n) => s + gainOf(n), 0);
      return { key: label, label, value: sold, display: `+${num(sold)}` };
    });
    const best = rows.slice().sort((a, b) => b.value - a.value)[0];
    $("#priceChart").innerHTML = bars(rows, null) +
      (best.value ? `<p class="note-text">いちばん売れている価格帯: <b>${best.label}円</b></p>` : "");
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
      const c = m.get(name) || { sold: 0, count: 0 };
      c.sold += gainOf(n); c.count += 1;
      m.set(name, c);
    });
    const top = [...m.entries()].sort((a, b) => b[1].sold - a[1].sold).slice(0, 8);
    $("#creators").innerHTML = top.map(([name, c]) =>
      `<li><button data-creator="${esc(name)}">${esc(name)}</button><span>${c.count}本・+${num(c.sold)}</span></li>`).join("");
  }

  // ---------- 詳細 ----------
  function openDetail(key) {
    const n = state.notes.find((x) => x.key === key);
    if (!n) return;
    const lo = Math.round(n.gain24h * 0.3), hi = Math.round(n.gain24h * 0.8);
    $("#detailBody").innerHTML = `
      <div>${themeChips(n)}</div>
      <h3>${esc(n.title)}</h3>
      <p class="muted">${esc(n.creator?.name || "")}・公開 ${fmtTime(n.publishedAt)}（${ago(n.publishedAt)}）</p>
      <div class="detail__grid">
        <div><small>価格</small><b>${yen(n.price)}</b></div>
        <div><small>勢いスコア</small><b>🔥${n.heat}</b></div>
        <div><small>24hのスキ増加</small><b>+${num(n.gain24h)}</b></div>
        <div><small>直近 6h / 3h / 1h</small><b>+${n.gain6h} / +${n.gain3h} / +${n.gain1h}</b></div>
        <div><small>スキ累計</small><b>♥${num(n.likes)}</b></div>
        <div><small>24h増加×価格</small><b>${yen(n.salesIndex)}</b></div>
      </div>
      ${sparkSvg(n, 600, 140, "bigspark", true)}
      <p class="note-text">参考: 増えたスキの 30〜80% が購入者だと仮定すると、24時間の購入数はおよそ <b>${num(lo)}〜${num(hi)}件</b>、売上は <b>${yen(lo * n.price)}〜${yen(hi * n.price)}</b>。あくまで仮定に基づく目安です。</p>
      ${n.measuredHours != null && n.measuredHours < 24 && hoursSince(n.publishedAt) > 24 ? `<p class="note-text">※ この記事は計測を始めてから ${Math.floor(n.measuredHours)}時間分の増加数です。</p>` : ""}
      <p class="note-text">${n.hashtags.map((t) => "#" + esc(t)).join(" ")}</p>
      <p class="detail__cta"><a class="read-btn" href="${esc(noteLink(n).href)}" target="_blank" rel="noopener">${noteLink(n).label} <span aria-hidden="true">→</span></a></p>`;
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
    if ($("#q").value !== state.q) $("#q").value = state.q;
    $$("#windowChips button").forEach((b) => b.classList.toggle("on", Number(b.dataset.v) === state.window));
    $$("#priceChips button").forEach((b) => b.classList.toggle("on", b.dataset.v === state.price));
    $("#published").value = String(state.published);
    $("#minLikes").value = String(state.minGain);
    $("#minLikesVal").textContent = String(state.minGain);
    $("#sort").value = state.sort;
    $("#onlyMaru").checked = state.onlyMaru;
    $("#showBatsu").checked = state.showBatsu;
    $("#viewCard").classList.toggle("on", state.view === "card");
    $("#viewTable").classList.toggle("on", state.view === "table");
  }

  function syncUrl() {
    const p = new URLSearchParams();
    if (state.theme) p.set("theme", state.theme);
    if (state.q) p.set("q", state.q);
    if (state.window !== 24) p.set("h", state.window);
    if (state.published) p.set("pub", state.published);
    if (state.price !== "all") p.set("price", state.price);
    if (state.minGain > 1) p.set("min", state.minGain);
    if (state.sort !== "heat") p.set("sort", state.sort);
    const qs = p.toString();
    history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
  }
  function readUrl() {
    const p = new URLSearchParams(location.search);
    state.theme = p.get("theme") ?? load(STORE.theme, "") ?? "";
    state.q = p.get("q") || "";
    state.window = WINDOWS.includes(Number(p.get("h"))) ? Number(p.get("h")) : 24;
    state.published = [24, 168, 720].includes(Number(p.get("pub"))) ? Number(p.get("pub")) : 0;
    state.price = p.get("price") || "all";
    state.minGain = Math.max(1, Number(p.get("min")) || 1);
    state.sort = SORTERS[p.get("sort")] ? p.get("sort") : "heat";
  }

  function update(patch) {
    Object.assign(state, patch, { shown: PAGE });
    if ("theme" in patch) save(STORE.theme, state.theme);
    render();
  }

  function exportCsv() {
    const list = filtered();
    const head = ["順位", "タイトル", "作者", "テーマ", "価格", "勢いスコア", "24hスキ増加", "6h", "3h", "1h", "24h増加×価格", "スキ累計", "公開日時", "ハッシュタグ", "URL"];
    const rows = list.map((n, i) => [i + 1, n.title, n.creator?.name, n.themes.map((id) => themeById(id)?.name).filter(Boolean).join(" "), n.price, n.heat, n.gain24h, n.gain6h, n.gain3h, n.gain1h, n.salesIndex, n.likes, fmtTime(n.publishedAt), n.hashtags.join(" "), n.url]);
    const csv = [head, ...rows].map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `note-urezuji-${state.theme || "all"}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`${list.length}件をCSVに書き出しました`);
  }

  function bind() {
    let t;
    $("#q").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => update({ q: e.target.value.trim() }), 200); });
    $("#windowChips").addEventListener("click", (e) => e.target.dataset.v && update({ window: Number(e.target.dataset.v) }));
    $("#priceChips").addEventListener("click", (e) => e.target.dataset.v && update({ price: e.target.dataset.v }));
    $("#published").addEventListener("change", (e) => update({ published: Number(e.target.value) }));
    $("#minLikes").addEventListener("input", (e) => update({ minGain: Number(e.target.value) }));
    $("#sort").addEventListener("change", (e) => update({ sort: e.target.value }));
    $("#onlyMaru").addEventListener("change", (e) => update({ onlyMaru: e.target.checked }));
    $("#showBatsu").addEventListener("change", (e) => update({ showBatsu: e.target.checked }));
    $("#viewCard").addEventListener("click", () => { save(STORE.view, "card"); update({ view: "card" }); });
    $("#viewTable").addEventListener("click", () => { save(STORE.view, "table"); update({ view: "table" }); });
    $("#moreBtn").addEventListener("click", () => { state.shown += PAGE; render(); });
    $("#csvBtn").addEventListener("click", exportCsv);
    $("#resetBtn").addEventListener("click", () => update({ theme: "", q: "", window: 24, published: 0, price: "all", minGain: 1, sort: "heat", onlyMaru: false, showBatsu: false }));
    $("#shareBtn").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(location.href); toast("この検索条件のURLをコピーしました"); }
      catch (_) { toast(location.href); }
    });

    // 一覧・サイド内のボタンはまとめて委譲
    document.addEventListener("click", (e) => {
      const el = e.target.closest("[data-maru],[data-batsu],[data-tag],[data-creator],[data-topic],[data-detail],[data-sort]");
      if (!el) return;
      const d = el.dataset;
      if (d.maru) toggleMark(state.maru, state.batsu, d.maru, STORE.maru, STORE.batsu);
      else if (d.batsu) toggleMark(state.batsu, state.maru, d.batsu, STORE.batsu, STORE.maru);
      else if (d.tag) update({ q: "#" + d.tag });
      else if (d.creator) update({ q: d.creator });
      else if (d.topic !== undefined) {
        $("#detail").open && $("#detail").close();
        update({ theme: d.topic });
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
      else if (d.detail) openDetail(d.detail);
      else if (d.sort) update({ sort: d.sort });
    });
    $("#detail").addEventListener("click", (e) => { if (e.target.id === "detail") e.target.close(); });
  }

  // ---------- サンプルデータ（data/latest.json がまだ無いとき用） ----------
  function makeDemo(themes) {
    let seed = 20261014;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pickOne = (a) => a[Math.floor(rnd() * a.length)];
    const titles = {
      fukugyo: ["会社員が副業で月5万円を超えるまでにやったこと全部", "noteで初月30万円売れた有料記事の作り方", "スキマ時間で始める物販の教科書"],
      ai: ["ChatGPTで月10万円稼ぐ完全マニュアル", "Claudeで業務を9割自動化したプロンプト集", "生成AI画像で副業を始める全手順"],
      sns: ["フォロワー0から1万人までのX運用ロードマップ", "インスタ集客で予約が3倍になった投稿テンプレ", "バズるショート動画の台本の型"],
      money: ["新NISAで迷わない銘柄選びの結論", "高配当株で月3万円の不労所得をつくる", "FXで負けない資金管理ルール"],
      gamble: ["今週末の重賞 本命と穴馬を全公開", "回収率120%を続ける馬券の買い方"],
      love: ["3ヶ月で-8kgした食事メニュー全公開", "マッチングアプリで会える人になるプロフィール術"],
      career: ["年収を150万上げた転職の進め方", "外資コンサル流 資料作成の基本"],
      study: ["TOEIC900点までの独学ロードマップ", "子どもが勉強好きになる声かけ集"],
      creative: ["売れるイラストポートフォリオの作り方", "小説新人賞の一次選考を通る構成術"],
      fortune: ["2026年下半期の12星座別 運勢鑑定", "お金に好かれる人の開運習慣"],
    };
    const ids = themes.length ? themes.map((t) => t.id) : Object.keys(titles);
    const names = ["ゆうき｜AI副業", "まる子", "ペン田くん", "Kei@マーケター", "しろくろ", "あおい｜投資", "夜ふかし研究所", "とげとげ", "ナマイキ編集部", "はやて"];
    const now = Date.now();
    const notes = [];
    for (let i = 0; i < 80; i++) {
      const theme = pickOne(ids);
      const tags = themes.find((t) => t.id === theme)?.keywords || ["note"];
      const age = rnd() > 0.45 ? rnd() * 23 + 0.5 : 24 + rnd() * 24 * 40;
      const price = pickOne([100, 300, 480, 500, 980, 1000, 1480, 1980, 2980, 4980, 9800]);
      const speed = Math.pow(rnd(), 2.4) * 4 + 0.05;
      const g = (h) => Math.round(speed * Math.min(h, age) * (0.6 + rnd() * 0.8));
      const gain1h = g(1), gain3h = Math.max(gain1h, g(3)), gain6h = Math.max(gain3h, g(6)), gain24h = Math.max(gain6h, g(24), 1);
      const likes = gain24h + (age > 24 ? Math.round(rnd() * 300) : 0);
      const history = [];
      for (let h = 24; h >= 0; h--) history.push([new Date(now - h * 3600000).toISOString(), Math.round(likes - gain24h * (h / 24))]);
      notes.push({
        key: "nsample" + i.toString(16).padStart(6, "0"),
        title: pickOne(titles[theme] || ["有料noteサンプル"]) + (rnd() > 0.7 ? "【保存版】" : ""),
        url: "https://note.com/",
        sample: true,
        searchWord: pickOne(tags),
        price, likes,
        publishedAt: new Date(now - age * 3600000).toISOString(),
        eyecatch: null,
        hashtags: [...new Set([pickOne(tags), pickOne(tags), "有料記事"])],
        themes: [theme],
        creator: { name: pickOne(names), urlname: "", avatar: null },
        gain1h, gain3h, gain6h, gain24h,
        measuredHours: 24,
        heat: +((gain24h + gain3h * 3) * (1 + Math.min(price, 30000) / 10000)).toFixed(1),
        salesIndex: gain24h * price,
        history,
      });
    }
    return { generatedAt: new Date(now).toISOString(), trackingSince: new Date(now - 48 * 3600000).toISOString(), notes };
  }

  // ---------- 起動 ----------
  state.view = load(STORE.view, "card") === "table" ? "table" : "card";
  readUrl();
  bind();
  $("#list").innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  fetchData();
  setInterval(fetchData, REFRESH_MS);
})();
