#!/usr/bin/env node
// note 売れ筋リサーチ — 依存ゼロのローカルサーバー
// note.com の公開 API を中継し（ブラウザからは CORS で直接呼べないため）、
// 記事データを正規化してフロントエンドへ返す。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 3000;
const DEMO = process.env.NOTE_DEMO === '1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const NOTE_BASE = 'https://note.com';
const PAGE_SIZE = 20;
const MAX_PAGES = 10;
const REQUEST_INTERVAL_MS = 1000; // note へのアクセスは 1 秒に 1 回まで
const CACHE_TTL_MS = 10 * 60 * 1000;

// ジャンル → そのジャンルで売れやすい記事を拾うための検索キーワード
const GENRES = [
  { id: 'fukugyo', name: '副業・お金稼ぎ', keywords: ['副業', '稼ぐ方法', '収益化'] },
  { id: 'toushi', name: '投資・資産運用', keywords: ['投資', '株式投資', '仮想通貨'] },
  { id: 'ai', name: 'AI・ChatGPT', keywords: ['ChatGPT', '生成AI', 'AI活用'] },
  { id: 'marketing', name: 'マーケティング・SNS', keywords: ['マーケティング', 'SNS運用', 'Instagram'] },
  { id: 'writing', name: 'ブログ・ライティング', keywords: ['ブログ', 'ライティング', 'Webライター'] },
  { id: 'sedori', name: '物販・せどり', keywords: ['せどり', '物販', 'メルカリ'] },
  { id: 'programming', name: 'プログラミング・IT', keywords: ['プログラミング', 'エンジニア', 'Python'] },
  { id: 'career', name: '転職・キャリア', keywords: ['転職', 'キャリア', '就活'] },
  { id: 'jikokeihatsu', name: '自己啓発・仕事術', keywords: ['自己啓発', '仕事術', '習慣化'] },
  { id: 'renai', name: '恋愛・婚活', keywords: ['恋愛', '婚活', 'マッチングアプリ'] },
  { id: 'biyou', name: '美容・ダイエット', keywords: ['美容', 'ダイエット', 'スキンケア'] },
  { id: 'kenkou', name: '健康・メンタル', keywords: ['健康', 'メンタル', '筋トレ'] },
  { id: 'uranai', name: '占い・スピリチュアル', keywords: ['占い', 'スピリチュアル', '星読み'] },
  { id: 'keiba', name: '競馬・ギャンブル予想', keywords: ['競馬予想', '競艇', 'スポーツ予想'] },
  { id: 'kyouiku', name: '子育て・教育', keywords: ['子育て', '受験', '英語学習'] },
];

const cache = new Map();
let lastRequestAt = 0;

// ---- スキ数の履歴（直近のスキ増加を出すため、取得のたびに記録する） ----
const DATA_DIR = path.join(__dirname, 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'snapshots.json');
const SNAPSHOT_MIN_INTERVAL_MS = 60 * 60 * 1000; // 同じ記事は 1 時間に 1 回まで記録
const SNAPSHOT_MAX_PER_NOTE = 60;
const SNAPSHOT_EXPIRE_MS = 120 * 86400000;
const RECENT_WINDOW_DAYS = 7;
let snapshots = {};
try {
  snapshots = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
} catch {
  snapshots = {};
}
let saveTimer = null;
function saveSnapshotsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const cutoff = Date.now() - SNAPSHOT_EXPIRE_MS;
    for (const [k, list] of Object.entries(snapshots)) {
      if (!list.length || list[list.length - 1][0] < cutoff) delete snapshots[k];
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFile(SNAPSHOT_FILE, JSON.stringify(snapshots), (err) => err && console.error('履歴の保存に失敗:', err.message));
  }, 1000);
}

// 記事ごとに [時刻, スキ数] を記録し、約 7 日前の記録との差を recentLikes として付ける
function attachHistory(notes) {
  const now = Date.now();
  let changed = false;
  const out = notes.map((n) => {
    const k = n.key || String(n.id);
    const list = snapshots[k] || (snapshots[k] = []);
    const last = list[list.length - 1];
    if (!last || now - last[0] >= SNAPSHOT_MIN_INTERVAL_MS) {
      list.push([now, n.likes]);
      if (list.length > SNAPSHOT_MAX_PER_NOTE) list.splice(0, list.length - SNAPSHOT_MAX_PER_NOTE);
      changed = true;
    }
    const windowStart = now - RECENT_WINDOW_DAYS * 86400000;
    // 7 日より前の最新の記録。無ければ一番古い記録を基準にする
    const base = [...list].reverse().find(([t]) => t <= windowStart) || list[0];
    const spanDays = (now - base[0]) / 86400000;
    if (spanDays < 0.5) return { ...n, recentLikes: null, recentDays: 0, trackedSince: list[0][0] };
    return { ...n, recentLikes: Math.max(0, n.likes - base[1]), recentDays: spanDays, trackedSince: list[0][0] };
  });
  if (changed) saveSnapshotsSoon();
  return out;
}

// デモモードでは履歴が無いので、それらしい直近スキを付ける
function demoHistory(notes) {
  return notes.map((n, i) => {
    const r = ((n.likes * 7919 + i * 104729) % 1000) / 1000;
    return { ...n, recentLikes: Math.round(n.likes * r * r * 0.25), recentDays: RECENT_WINDOW_DAYS, trackedSince: Date.now() - 30 * 86400000 };
  });
}
const withHistory = (notes) => (DEMO ? demoHistory(notes) : attachHistory(notes));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const wait = lastRequestAt + REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'note-research-local/1.0 (personal research tool)',
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`note.com が ${res.status} を返しました (${url})`);
  const data = await res.json();
  cache.set(url, { at: Date.now(), data });
  return data;
}

// note の API はエンドポイントごとにフィールド名が微妙に違うので、ここで吸収する
function normalizeNote(n) {
  const user = n.user || {};
  const price = Number(n.price ?? n.priceInfo?.price ?? 0) || 0;
  const key = n.key || n.noteKey || '';
  const urlname = user.urlname || user.urlName || '';
  const publishAt = n.publish_at || n.publishAt || n.created_at || null;
  const hashtags = (n.hashtags || n.hashtag_notes || [])
    .map((h) => (h.hashtag ? h.hashtag.name : h.name) || '')
    .filter(Boolean)
    .map((t) => t.replace(/^#/, ''));
  return {
    id: n.id,
    key,
    title: n.name || n.title || '(無題)',
    url: n.note_url || n.noteUrl || (urlname && key ? `${NOTE_BASE}/${urlname}/n/${key}` : ''),
    type: n.type || 'TextNote',
    price,
    isPaid: price > 0,
    likes: Number(n.like_count ?? n.likeCount ?? 0) || 0,
    comments: Number(n.comment_count ?? n.commentCount ?? 0) || 0,
    publishAt,
    hashtags,
    creator: {
      urlname,
      name: user.nickname || user.name || urlname,
      followers: Number(user.follower_count ?? user.followerCount ?? 0) || 0,
    },
    isMagazineOnly: Boolean(n.is_limited || n.isLimited),
  };
}

async function searchNotes(q, pages) {
  if (DEMO) return demoNotes(q, pages * PAGE_SIZE);
  const out = [];
  for (let p = 0; p < pages; p++) {
    const url = `${NOTE_BASE}/api/v3/searches?context=note&q=${encodeURIComponent(q)}` +
      `&size=${PAGE_SIZE}&start=${p * PAGE_SIZE}`;
    const json = await fetchJson(url);
    const block = json?.data?.notes || {};
    const contents = block.contents || [];
    out.push(...contents.map(normalizeNote));
    if (block.is_last_page || block.isLastPage || contents.length < PAGE_SIZE) break;
  }
  return out;
}

async function genreNotes(genre, pages) {
  const merged = new Map();
  for (const kw of genre.keywords) {
    for (const n of await searchNotes(kw, pages)) {
      if (!merged.has(n.key || n.id)) merged.set(n.key || n.id, { ...n, genre: genre.name });
    }
  }
  return [...merged.values()];
}

async function creatorNotes(urlname, pages) {
  if (DEMO) return demoNotes(urlname, pages * PAGE_SIZE, urlname);
  const out = [];
  for (let p = 1; p <= pages; p++) {
    const url = `${NOTE_BASE}/api/v2/creators/${encodeURIComponent(urlname)}/contents?kind=note&page=${p}`;
    const json = await fetchJson(url);
    const contents = json?.data?.contents || [];
    out.push(...contents.map(normalizeNote));
    if (json?.data?.isLastPage || contents.length === 0) break;
  }
  return out;
}

// ネットワークなしで UI を試すためのダミーデータ（NOTE_DEMO=1）
function demoNotes(q, count, fixedCreator) {
  let seed = [...String(q)].reduce((a, c) => a + c.charCodeAt(0), 7);
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const prices = [0, 0, 0, 100, 300, 500, 980, 1480, 1980, 2980, 4980, 9800];
  const angles = ['完全ガイド', '初心者向け', '月5万円稼いだ方法', 'テンプレート付き', '実録', '失敗談', 'ロードマップ', 'AI活用術'];
  const tags = [q, '副業', 'ブログ', 'AI', 'マーケティング', 'ライティング', 'SNS運用'];
  const creators = Array.from({ length: 12 }, (_, i) => ({ urlname: `demo_creator${i + 1}`, nickname: `デモ作者${i + 1}`, follower_count: Math.round(rand() * 20000) }));
  return Array.from({ length: count }, (_, i) => {
    const price = prices[Math.floor(rand() * prices.length)];
    const days = Math.floor(rand() * 400);
    const user = fixedCreator ? { urlname: fixedCreator, nickname: fixedCreator, follower_count: 5000 } : creators[Math.floor(rand() * creators.length)];
    return normalizeNote({
      id: `${q}-${i + 1}`,
      key: `ndemo${encodeURIComponent(q)}${i}`,
      name: `【${q}】${angles[Math.floor(rand() * angles.length)]} vol.${i + 1}`,
      price,
      like_count: Math.round(Math.pow(rand(), 3) * (price ? 1500 : 800)),
      comment_count: Math.round(rand() * 20),
      publish_at: new Date(Date.now() - days * 86400000).toISOString(),
      hashtags: tags.filter(() => rand() < 0.35).map((name) => ({ hashtag: { name: `#${name}` } })),
      user,
    });
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pages = Math.min(MAX_PAGES, Math.max(1, Number(u.searchParams.get('pages')) || 3));
  try {
    if (u.pathname === '/api/search') {
      const q = (u.searchParams.get('q') || '').trim();
      if (!q) return sendJson(res, 400, { error: 'キーワードを入力してください' });
      return sendJson(res, 200, { query: q, demo: DEMO, notes: withHistory(await searchNotes(q, pages)) });
    }
    if (u.pathname === '/api/genres') {
      return sendJson(res, 200, { genres: GENRES });
    }
    if (u.pathname === '/api/genre') {
      const genre = GENRES.find((g) => g.id === u.searchParams.get('id'));
      if (!genre) return sendJson(res, 400, { error: 'ジャンルが見つかりません' });
      return sendJson(res, 200, { query: genre.name, demo: DEMO, notes: withHistory(await genreNotes(genre, pages)) });
    }
    if (u.pathname === '/api/creator') {
      const id = (u.searchParams.get('id') || '').trim().replace(/^https?:\/\/note\.com\//, '').replace(/\/.*$/, '');
      if (!/^[A-Za-z0-9_-]+$/.test(id)) return sendJson(res, 400, { error: 'クリエイターID（note.com/xxxx の xxxx）を入力してください' });
      return sendJson(res, 200, { query: id, demo: DEMO, notes: withHistory(await creatorNotes(id, pages)) });
    }
    if (req.method === 'GET') return serveStatic(req, res, u.pathname);
    sendJson(res, 405, { error: 'method not allowed' });
  } catch (e) {
    sendJson(res, 502, { error: e.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`note 売れ筋リサーチ: http://localhost:${PORT}${DEMO ? '  (デモモード)' : ''}`);
  });
}

module.exports = { normalizeNote, attachHistory, server, GENRES, _snapshots: () => snapshots };
