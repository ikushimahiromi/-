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
  return { ...n, published, ageDays, velocity };
}

async function runSearch(e) {
  e.preventDefault();
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const pages = $('pages').value;
  const terms = $('q').value.split(/[,、，]/).map((s) => s.trim()).filter(Boolean);
  if (!terms.length) return;

  $('go').disabled = true;
  const merged = new Map();
  let demo = false;
  try {
    for (const [i, term] of terms.entries()) {
      setStatus(`取得中… 「${term}」 (${i + 1}/${terms.length})`);
      const param = mode === 'creator' ? 'id' : 'q';
      const res = await fetch(`/api/${mode}?${param}=${encodeURIComponent(term)}&pages=${pages}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      demo = demo || body.demo;
      for (const n of body.notes) merged.set(n.key || n.id, enrich(n));
    }
    allNotes = [...merged.values()];
    setStatus(`${allNotes.length}件の記事を取得しました${demo ? '（デモデータ）' : ''}`);
    $('results').hidden = false;
    render();
  } catch (err) {
    setStatus(`エラー: ${err.message}`, true);
  } finally {
    $('go').disabled = false;
  }
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

  const sorters = {
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
    document.querySelector('input[name="mode"][value="search"]').checked = true;
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
      <td class="title"><a href="${escapeHtml(n.url)}" target="_blank" rel="noopener">${escapeHtml(n.title)}</a>${n.isMagazineOnly ? '<span class="badge">マガジン限定</span>' : ''}</td>
      <td>${escapeHtml(n.creator.name)}<br><span class="muted">フォロワー ${num(n.creator.followers)}</span></td>
      <td class="num">${n.isPaid ? yen(n.price) : '無料'}</td>
      <td class="num">${num(n.likes)}</td>
      <td class="num">${n.velocity.toFixed(2)}</td>
      <td class="num">${n.revenue ? yen(n.revenue) : '—'}</td>
      <td>${n.published ? n.published.toLocaleDateString('ja-JP') : '—'}</td>
    </tr>`).join('') || '<tr><td colspan="8" class="muted">条件に合う記事がありません</td></tr>';
}

function downloadCsv() {
  const head = ['タイトル', 'URL', 'クリエイター', 'フォロワー', '価格', 'スキ', 'スキ/日', '推定売上', '公開日', 'ハッシュタグ'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = view.map((n) => [n.title, n.url, n.creator.name, n.creator.followers, n.price, n.likes,
    n.velocity.toFixed(2), Math.round(n.revenue), n.published ? n.published.toISOString().slice(0, 10) : '', n.hashtags.join(' ')].map(cell).join(','));
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
document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', () => {
  $('q').placeholder = r.value === 'creator' && r.checked
    ? '例: note.com/xxxx の xxxx（カンマ区切りで複数可）'
    : '例: 副業, ChatGPT, 投資（カンマ区切りで複数可）';
}));
