'use strict';

const $ = (id) => document.getElementById(id);
const yen = (n) => '¥' + Math.round(n).toLocaleString('ja-JP');
const num = (n) => Math.round(n).toLocaleString('ja-JP');
const DAY = 86400000;
const PRICE_BANDS = [
  { label: '〜¥499', min: 1, max: 499 },
  { label: '¥500〜999', min: 500, max: 999 },
  { label: '¥1,000〜1,999', min: 1000, max: 1999 },
  { label: '¥2,000〜4,999', min: 2000, max: 4999 },
  { label: '¥5,000〜9,999', min: 5000, max: 9999 },
  { label: '¥10,000〜', min: 10000, max: Infinity },
];

let allNotes = [];
let view = [];
let mode = 'genre';
let genres = [];
let rankingNotes = [];
let busy = false;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setStatus(msg, isError) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('error', Boolean(isError));
}

function enrich(n) {
  const published = n.publishAt ? new Date(n.publishAt) : null;
  const ageDays = published ? Math.max(1, (Date.now() - published.getTime()) / DAY) : null;
  // 公開直後の記事が極端に高く出ないよう、最低 7 日として割る
  const velocity = ageDays ? n.likes / Math.max(7, ageDays) : 0;
  const recentPerDay = n.recentLikes !== null && n.recentLikes !== undefined && n.recentDays ? n.recentLikes / n.recentDays : null;
  // 閲覧数は非公開のため、フォロワー数に対するスキの割合を「反応率」として使う
  const engagement = n.likes / Math.max(100, n.creator.followers);
  return { ...n, published, ageDays, velocity, recentPerDay, momentum: recentPerDay ?? velocity, engagement };
}

// ---- 総合スコア ----
// 各指標を「集めた記事の中で上位何%か」に直してから重み付けで合算する（0〜100）
const SCORE_FACTORS = [
  { id: 'wLikes', label: '累計スキ', get: (n) => n.likes },
  { id: 'wRecent', label: '直近の伸び', get: (n) => n.momentum },
  { id: 'wEngage', label: '反応率', get: (n) => n.engagement },
  { id: 'wPrice', label: '価格', get: (n) => n.price },
];

function percentileRanks(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return values.map((v) => {
    if (n < 2) return 1;
    let lo = 0, hi = n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
    let up = lo;
    while (up < n && sorted[up] === v) up++;
    return ((lo + up - 1) / 2) / (n - 1); // 同値は平均順位
  });
}

function scoreNotes(list) {
  const weights = SCORE_FACTORS.map((f) => Math.max(0, Number($(f.id).value) || 0));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const ranks = SCORE_FACTORS.map((f) => percentileRanks(list.map(f.get)));
  return list.map((n, i) => {
    const parts = SCORE_FACTORS.map((f, j) => ({ label: f.label, pct: ranks[j][i], w: weights[j] }));
    const score = (parts.reduce((s, p) => s + p.pct * p.w, 0) / total) * 100;
    return { ...n, score, scoreParts: parts };
  });
}

const scoreTitle = (n) => n.scoreParts.map((p) => `${p.label}: 上位${Math.max(1, Math.round((1 - p.pct) * 100))}%`).join(' / ');
const recentCell = (n) => (n.recentLikes === null || n.recentLikes === undefined
  ? '<span class="muted" title="次回以降の取得から計測します">記録開始</span>'
  : `+${num(n.recentLikes)}<br><span class="muted">${Math.round(n.recentDays)}日間</span>`);
const scoreCell = (n) => `<td class="num" title="${escapeHtml(scoreTitle(n))}"><span class="score">${Math.round(n.score)}</span></td>`;

// requests: [{ label, url }] を順に取得し、記事をキーで重複排除してまとめる
async function loadNotes(requests) {
  const merged = new Map();
  let demo = false;
  for (const [i, r] of requests.entries()) {
    setStatus(`取得中… 「${r.label}」 (${i + 1}/${requests.length})`);
    const res = await fetch(r.url);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    demo = demo || body.demo;
    for (const n of body.notes) {
      const k = n.key || n.id;
      if (!merged.has(k)) merged.set(k, enrich(n));
    }
  }
  return { notes: [...merged.values()], demo };
}

async function withBusy(fn) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('#go, #rkBuild, #genreChips button').forEach((b) => { b.disabled = true; });
  try {
    await fn();
  } catch (err) {
    setStatus(`エラー: ${err.message}`, true);
  } finally {
    busy = false;
    document.querySelectorAll('#go, #rkBuild, #genreChips button').forEach((b) => { b.disabled = false; });
  }
}

function showResults(notes, demo, label) {
  allNotes = notes;
  setStatus(`${label}: ${allNotes.length}件の記事を取得しました${demo ? '（デモデータ）' : ''}`);
  $('results').hidden = false;
  updateWeightsPanel();
  render();
}

function runSearch(e) {
  e.preventDefault();
  const terms = $('q').value.split(/[,、，]/).map((s) => s.trim()).filter(Boolean);
  if (!terms.length) return;
  const pages = $('pages').value;
  const param = mode === 'creator' ? 'id' : 'q';
  withBusy(async () => {
    const { notes, demo } = await loadNotes(terms.map((t) => ({ label: t, url: `/api/${mode}?${param}=${encodeURIComponent(t)}&pages=${pages}` })));
    showResults(notes, demo, terms.join('、'));
  });
}

function runGenre(genre) {
  document.querySelectorAll('#genreChips button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === genre.id)));
  withBusy(async () => {
    const pages = $('genrePages').value;
    const { notes, demo } = await loadNotes([{ label: genre.name, url: `/api/genre?id=${genre.id}&pages=${pages}` }]);
    showResults(notes, demo, genre.name);
  });
}

function currentFilters() {
  return {
    paidOnly: $('paidOnly').checked,
    minPrice: Number($('minPrice').value) || 0,
    maxPrice: Number($('maxPrice').value) || Infinity,
    minLikes: Number($('minLikes').value) || 0,
    period: Number($('period').value) || 0,
    sort: $('sort').value,
    ratio: Math.max(0, Number($('ratio').value) || 1),
  };
}

function render() {
  const f = currentFilters();
  view = allNotes
    .filter((n) => (!f.paidOnly || n.isPaid)
      && n.price >= f.minPrice && n.price <= f.maxPrice
      && n.likes >= f.minLikes
      && (!f.period || (n.ageDays !== null && n.ageDays <= f.period)))
    .map((n) => ({ ...n, revenue: n.price * n.likes * f.ratio }));
  view = scoreNotes(view);

  const sorters = {
    score: (a, b) => b.score - a.score,
    recent: (a, b) => b.momentum - a.momentum,
    revenue: (a, b) => b.revenue - a.revenue || b.likes - a.likes,
    likes: (a, b) => b.likes - a.likes,
    velocity: (a, b) => b.velocity - a.velocity,
    price: (a, b) => b.price - a.price,
    date: (a, b) => (b.published || 0) - (a.published || 0),
  };
  view.sort(sorters[f.sort]);

  renderTiles();
  renderBands();
  renderTags();
  renderCreators();
  renderTable();
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function renderTiles() {
  const paidAll = allNotes.filter((n) => n.isPaid);
  const paid = view.filter((n) => n.isPaid);
  const top = view[0];
  const tiles = [
    { label: '該当記事', value: num(view.length), hint: `取得 ${num(allNotes.length)}件中` },
    { label: '有料記事の割合', value: allNotes.length ? Math.round((paidAll.length / allNotes.length) * 100) + '%' : '—', hint: `${num(paidAll.length)}件が有料` },
    { label: '中央価格（有料）', value: paid.length ? yen(median(paid.map((n) => n.price))) : '—', hint: '表示中の有料記事' },
    { label: '中央スキ数', value: view.length ? num(median(view.map((n) => n.likes))) : '—', hint: '表示中の記事' },
    { label: '推定売上トップ', value: top && top.revenue ? yen(top.revenue) : '—', hint: top ? escapeHtml(top.title.slice(0, 22)) : '' },
  ];
  $('tiles').innerHTML = tiles.map((t) => `
    <div class="tile"><div class="label">${t.label}</div><div class="value">${t.value}</div><div class="hint">${t.hint}</div></div>`).join('');
}

function renderBars(el, rows, fmt, tipFn) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  el.innerHTML = rows.map((r, i) => `
    <div class="bar-row" data-i="${i}">
      <span class="lab">${r.label}</span>
      <span class="track"><span class="fill" style="display:block;width:${(r.value / max) * 100}%"></span></span>
      <span class="val">${fmt(r.value)}</span>
    </div>`).join('');
  el.querySelectorAll('.bar-row').forEach((row) => {
    row.addEventListener('mousemove', (ev) => showTip(ev, tipFn(rows[row.dataset.i])));
    row.addEventListener('mouseleave', hideTip);
  });
}

function renderBands() {
  const paid = view.filter((n) => n.isPaid);
  const rows = PRICE_BANDS.map((b) => {
    const items = paid.filter((n) => n.price >= b.min && n.price <= b.max);
    const likes = items.reduce((s, n) => s + n.likes, 0);
    return { label: b.label, count: items.length, avgLikes: items.length ? likes / items.length : 0 };
  });
  renderBars($('chartCount'), rows.map((r) => ({ ...r, value: r.count })), (v) => num(v) + '件',
    (r) => `${r.label}: ${num(r.count)}件（平均スキ ${num(r.avgLikes)}）`);
  renderBars($('chartLikes'), rows.map((r) => ({ ...r, value: r.avgLikes })), num,
    (r) => `${r.label}: 平均スキ ${num(r.avgLikes)}（${num(r.count)}件）`);
}

function renderTags() {
  const counts = new Map();
  for (const n of view) {
    for (const t of n.hashtags) {
      const c = counts.get(t) || { count: 0, likes: 0 };
      c.count++; c.likes += n.likes;
      counts.set(t, c);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1].count - a[1].count || b[1].likes - a[1].likes).slice(0, 12);
  $('tagRank').innerHTML = top.length
    ? top.map(([t, c]) => `<li><button type="button" class="tag" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button><span>${c.count}件 · 平均スキ ${num(c.likes / c.count)}</span></li>`).join('')
    : '<li class="muted">ハッシュタグ情報がありません</li>';
  $('tagRank').querySelectorAll('button.tag').forEach((b) => b.addEventListener('click', () => {
    setMode('search');
    $('q').value = b.dataset.tag;
    $('searchForm').requestSubmit();
  }));
}

function renderCreators() {
  const byCreator = new Map();
  for (const n of view) {
    const k = n.creator.urlname || n.creator.name;
    const c = byCreator.get(k) || { ...n.creator, revenue: 0, count: 0, likes: 0 };
    c.revenue += n.revenue; c.count++; c.likes += n.likes;
    byCreator.set(k, c);
  }
  const top = [...byCreator.values()].sort((a, b) => b.revenue - a.revenue || b.likes - a.likes).slice(0, 12);
  $('creatorRank').innerHTML = top.length
    ? top.map((c) => `<li><a href="https://note.com/${encodeURIComponent(c.urlname)}" target="_blank" rel="noopener">${escapeHtml(c.name)}</a><span>${c.count}本 · ${c.revenue ? yen(c.revenue) : 'スキ ' + num(c.likes)}</span></li>`).join('')
    : '<li class="muted">該当なし</li>';
}

function renderTable() {
  $('count').textContent = `（${view.length}件）`;
  $('rows').innerHTML = view.slice(0, 500).map((n, i) => `
    <tr>
      <td class="num">${i + 1}</td>
      <td class="title"><a href="${escapeHtml(n.url)}" target="_blank" rel="noopener">${escapeHtml(n.title)}</a>${n.genre ? `<span class="badge">${escapeHtml(n.genre)}</span>` : ''}${n.isMagazineOnly ? '<span class="badge">マガジン限定</span>' : ''}</td>
      <td>${escapeHtml(n.creator.name)}<br><span class="muted">フォロワー ${num(n.creator.followers)}</span></td>
      <td class="num">${n.isPaid ? yen(n.price) : '無料'}</td>
      <td class="num">${num(n.likes)}</td>
      <td class="num">${recentCell(n)}</td>
      <td class="num">${n.revenue ? yen(n.revenue) : '—'}</td>
      ${scoreCell(n)}
      <td>${n.published ? n.published.toLocaleDateString('ja-JP') : '—'}</td>
    </tr>`).join('') || '<tr><td colspan="9" class="muted">条件に合う記事がありません</td></tr>';
}

function downloadCsv() {
  const head = ['タイトル', 'URL', 'ジャンル', 'クリエイター', 'フォロワー', '価格', 'スキ', 'スキ/日', '直近スキ', '直近日数', '反応率', '推定売上', '総合スコア', '公開日', 'ハッシュタグ'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = view.map((n) => [n.title, n.url, n.genre || '', n.creator.name, n.creator.followers, n.price, n.likes,
    n.velocity.toFixed(2), n.recentLikes ?? '', n.recentDays ? Math.round(n.recentDays) : '', n.engagement.toFixed(3), Math.round(n.revenue), Math.round(n.score), n.published ? n.published.toISOString().slice(0, 10) : '', n.hashtags.join(' ')].map(cell).join(','));
  const blob = new Blob(['﻿' + [head.map(cell).join(','), ...lines].join('\r\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `note-research-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function showTip(ev, text) {
  const t = $('tooltip');
  t.textContent = text;
  t.hidden = false;
  t.style.left = Math.min(ev.clientX + 12, window.innerWidth - t.offsetWidth - 8) + 'px';
  t.style.top = ev.clientY + 14 + 'px';
}
function hideTip() { $('tooltip').hidden = true; }

$('searchForm').addEventListener('submit', runSearch);
['paidOnly', 'minPrice', 'maxPrice', 'minLikes', 'period', 'sort', 'ratio'].forEach((id) => $(id).addEventListener('input', () => allNotes.length && render()));
$('csv').addEventListener('click', downloadCsv);

// ---- モード切り替え ----
function updateWeightsPanel() {
  $('weightsPanel').hidden = mode === 'ranking' ? !rankingNotes.length : !allNotes.length;
}

function setMode(next) {
  mode = next;
  document.querySelectorAll('.tabs [role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.mode === mode)));
  $('genrePanel').hidden = mode !== 'genre';
  $('searchForm').hidden = mode !== 'search' && mode !== 'creator';
  $('rankingPanel').hidden = mode !== 'ranking';
  $('ranking').hidden = mode !== 'ranking' || !rankingNotes.length;
  $('results').hidden = mode === 'ranking' || !allNotes.length;
  updateWeightsPanel();
  $('q').placeholder = mode === 'creator'
    ? '例: note.com/xxxx の xxxx（カンマ区切りで複数可）'
    : '例: 副業, ChatGPT, 投資（カンマ区切りで複数可）';
  setStatus('');
}
document.querySelectorAll('.tabs [role="tab"]').forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode)));

// ---- ジャンル ----
async function loadGenres() {
  try {
    const res = await fetch('/api/genres');
    genres = (await res.json()).genres || [];
  } catch {
    genres = [];
  }
  $('genreChips').innerHTML = genres.map((g) => `
    <button type="button" class="chip" data-id="${g.id}" aria-pressed="false">
      <span class="chip-name">${escapeHtml(g.name)}</span>
      <span class="chip-kw">${g.keywords.map(escapeHtml).join(' / ')}</span>
    </button>`).join('') || '<p class="muted">ジャンル一覧を読み込めませんでした</p>';
  $('genreChips').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => runGenre(genres.find((g) => g.id === b.dataset.id))));
  $('rkGenreFilter').innerHTML = '<option value="">すべて</option>' + genres.map((g) => `<option>${escapeHtml(g.name)}</option>`).join('');
}

// ---- ランキング ----
const METRICS = {
  score: { label: '平均総合スコア', note: (n) => n.score, fmt: (v) => v.toFixed(1) },
  recent: { label: '平均 直近スキ/日', note: (n) => n.momentum, fmt: (v) => v.toFixed(2) },
  revenue: { label: '推定売上合計', note: (n) => n.revenue, fmt: yen },
  likes: { label: '平均スキ', note: (n) => n.likes, fmt: num },
  velocity: { label: '平均スキ/日', note: (n) => n.velocity, fmt: (v) => v.toFixed(2) },
};

function buildRanking() {
  withBusy(async () => {
    // 全ジャンル × 各キーワード 1 ページずつ（サーバー側で 1 秒間隔に制限される）
    const { notes, demo } = await loadNotes(genres.map((g) => ({ label: g.name, url: `/api/genre?id=${g.id}&pages=1` })));
    rankingNotes = notes.filter((n) => n.isPaid).map((n) => ({ ...n, revenue: n.price * n.likes }));
    setStatus(`${genres.length}ジャンル・有料記事${rankingNotes.length}件からランキングを作成しました${demo ? '（デモデータ）' : ''}`);
    $('ranking').hidden = false;
    updateWeightsPanel();
    renderRanking();
  });
}

const MEDALS = ['🥇', '🥈', '🥉'];
const rankCell = (i) => `<td class="num rk-pos">${MEDALS[i] || i + 1}</td>`;

function renderRanking() {
  const period = Number($('rkPeriod').value) || 0;
  const metricKey = $('rkMetric').value;
  const metric = METRICS[metricKey];
  const inPeriod = scoreNotes(rankingNotes.filter((n) => !period || (n.ageDays !== null && n.ageDays <= period)));

  // ジャンル別
  const byGenre = genres.map((g) => {
    const items = inPeriod.filter((n) => n.genre === g.name);
    const sum = (f) => items.reduce((s, n) => s + f(n), 0);
    const avg = (f) => (items.length ? sum(f) / items.length : 0);
    return {
      genre: g,
      count: items.length,
      medianPrice: median(items.map((n) => n.price)),
      avgLikes: avg((n) => n.likes),
      avgVelocity: avg((n) => n.velocity),
      value: metricKey === 'revenue' ? sum((n) => n.revenue) : avg(metric.note),
    };
  }).sort((a, b) => b.value - a.value);
  const max = Math.max(1, ...byGenre.map((r) => r.value));
  $('rkGenreMetric').textContent = metric.label;
  $('rkGenreRows').innerHTML = byGenre.map((r, i) => `
    <tr>
      ${rankCell(i)}
      <td><button type="button" class="link" data-id="${r.genre.id}">${escapeHtml(r.genre.name)}</button></td>
      <td class="num">${num(r.count)}</td>
      <td class="num">${r.count ? yen(r.medianPrice) : '—'}</td>
      <td class="num">${num(r.avgLikes)}</td>
      <td class="num">${r.avgVelocity.toFixed(2)}</td>
      <td class="bar-col"><span class="mini-bar"><span style="width:${(r.value / max) * 100}%"></span></span><span class="mini-val">${metric.fmt(r.value)}</span></td>
    </tr>`).join('');
  $('rkGenreRows').querySelectorAll('button.link').forEach((b) => b.addEventListener('click', () => {
    setMode('genre');
    runGenre(genres.find((g) => g.id === b.dataset.id));
  }));

  // 記事
  const genreFilter = $('rkGenreFilter').value;
  const topNotes = inPeriod.filter((n) => !genreFilter || n.genre === genreFilter)
    .sort((a, b) => metric.note(b) - metric.note(a)).slice(0, 30);
  $('rkNoteRows').innerHTML = topNotes.map((n, i) => `
    <tr>
      ${rankCell(i)}
      <td class="title"><a href="${escapeHtml(n.url)}" target="_blank" rel="noopener">${escapeHtml(n.title)}</a></td>
      <td><span class="badge">${escapeHtml(n.genre || '')}</span></td>
      <td>${escapeHtml(n.creator.name)}</td>
      <td class="num">${yen(n.price)}</td>
      <td class="num">${num(n.likes)}</td>
      <td class="num">${recentCell(n)}</td>
      <td class="num">${yen(n.revenue)}</td>
      ${scoreCell(n)}
    </tr>`).join('') || '<tr><td colspan="9" class="muted">該当する有料記事がありません</td></tr>';

  // クリエイター
  const byCreator = new Map();
  for (const n of inPeriod) {
    const k = n.creator.urlname || n.creator.name;
    const c = byCreator.get(k) || { ...n.creator, revenue: 0, likes: 0, count: 0, genres: new Map() };
    c.revenue += n.revenue; c.likes += n.likes; c.count++; c.genres.set(n.genre, (c.genres.get(n.genre) || 0) + 1);
    byCreator.set(k, c);
  }
  const topCreators = [...byCreator.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10);
  $('rkCreators').innerHTML = topCreators.map((c) => `
    <li><a href="https://note.com/${encodeURIComponent(c.urlname)}" target="_blank" rel="noopener">${escapeHtml(c.name)}</a>
    <span>${[...c.genres].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([g]) => escapeHtml(g)).join('・')}${c.genres.size > 2 ? ' ほか' : ''} · ${c.count}本 · ${yen(c.revenue)}</span></li>`).join('') || '<li class="muted">該当なし</li>';
}

$('rkBuild').addEventListener('click', buildRanking);
SCORE_FACTORS.forEach((f) => $(f.id).addEventListener('input', () => {
  if (allNotes.length) render();
  if (rankingNotes.length) renderRanking();
}));
['rkPeriod', 'rkMetric', 'rkGenreFilter'].forEach((id) => $(id).addEventListener('input', () => rankingNotes.length && renderRanking()));

loadGenres();
setMode('genre');
