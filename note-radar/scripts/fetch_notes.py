#!/usr/bin/env python3
"""note.com から「直近24時間で売れている有料note」をテーマ別に集めて JSON に書き出す。

GitHub Actions から1時間ごとに実行する想定。標準ライブラリのみで動く。

「売れている」の判定:
- note.com は販売数を公開していないため、有料noteの **スキの増加数** を売れ行きの代わりに使う。
- 毎回スキ数を記録し（data/history.json）、24時間前との差が 1 以上なら「24時間以内に売れた」とみなす。
- 公開日は問わない。古い記事でも直近24時間でスキが増えていれば対象になる。
- 24時間前の記録がまだ無い記事は「計測を始めてから増えた分」を使う（実際の増加以下の値になる）。
  24時間以内に公開された記事は、公開時点のスキを 0 とみなす。

使っている API は非公式。仕様が変わっても壊れにくいように、レスポンスの形に依存せず
「note らしいオブジェクト」を再帰的に探して正規化している。

出力:
  data/latest.json   … 画面が読む最新データ（24時間でスキが増えた有料noteのみ）
  data/history.json  … 追跡中のnoteのスキ数の推移
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

JST = timezone(timedelta(hours=9))
BASE = "https://note.com"
UA = "Mozilla/5.0 (compatible; note-radar/1.0; +https://github.com/ikushimahiromi/-)"
NOTE_KEY_RE = re.compile(r"^n[0-9a-f]{8,}$")
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")

MAX_AGE_DAYS = 60       # これより古い記事は追跡しない
HISTORY_HOURS = 50      # 履歴として残す時間
MAX_TRACKED = 1500      # 追跡するnoteの上限
MAX_REFRESH = 400       # 検索に出なかった追跡中noteを個別に取り直す上限
GAIN_WINDOWS = (1, 3, 6, 24)


def log(*args: object) -> None:
    print(*args, file=sys.stderr, flush=True)


def load_themes(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def get_json(url: str, retries: int = 3, wait: float = 1.0) -> dict | None:
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=20) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (400, 404):
                return None
            log(f"HTTP {e.code} {url} (try {attempt + 1})")
        except Exception as e:  # noqa: BLE001 - ネットワーク系はまとめてリトライ
            log(f"error {e!r} {url} (try {attempt + 1})")
        time.sleep(wait * (2 ** attempt))
    return None


# ---------- 正規化 ----------

def parse_time(value: object) -> datetime | None:
    if not value or not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=JST)


def to_int(value: object) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def pick(d: dict, *names: str) -> object:
    for n in names:
        if n in d and d[n] not in (None, ""):
            return d[n]
    return None


def looks_like_note(d: dict) -> bool:
    key = d.get("key")
    return (
        isinstance(key, str)
        and bool(NOTE_KEY_RE.match(key))
        and ("name" in d or "title" in d)
        and ("publish_at" in d or "publishAt" in d or "like_count" in d or "likeCount" in d)
    )


def walk_notes(obj: object):
    """レスポンス内のどこにあっても note オブジェクトを見つける。"""
    if isinstance(obj, dict):
        if looks_like_note(obj):
            yield obj
            return
        for v in obj.values():
            yield from walk_notes(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from walk_notes(v)


def extract_hashtags(d: dict) -> list[str]:
    tags: list[str] = []
    for item in d.get("hashtags") or d.get("hashtag_notes") or d.get("hashtagNotes") or []:
        if isinstance(item, dict):
            h = item.get("hashtag") if isinstance(item.get("hashtag"), dict) else item
            name = h.get("name") if isinstance(h, dict) else None
        else:
            name = item
        if isinstance(name, str) and name:
            tags.append(name.lstrip("#"))
    return list(dict.fromkeys(tags))[:10]


def classify(title: str, tags: list[str], themes: list[dict]) -> list[str]:
    """タイトルとハッシュタグから当てはまるテーマを、当たりの多い順に返す。"""
    text = (title + " " + " ".join(tags)).lower()
    scored = []
    for t in themes:
        hits = sum(1 for w in t["match"] if w.lower() in text)
        if hits:
            scored.append((hits, t["id"]))
    scored.sort(reverse=True)
    return [tid for _, tid in scored]


def normalize(d: dict, themes: list[dict]) -> dict | None:
    user = d.get("user") if isinstance(d.get("user"), dict) else {}
    urlname = pick(user, "urlname", "urlName") or ""
    key = d["key"]
    title = str(pick(d, "name", "title") or "").strip()
    published = parse_time(pick(d, "publish_at", "publishAt", "created_at", "createdAt"))
    if not title or not published:
        return None
    eyecatch = pick(d, "eyecatch", "eyecatch_url", "eyecatchUrl", "sp_eyecatch")
    tags = extract_hashtags(d)
    # 購入者数の類いが返ってくる場合だけ拾う（通常は非公開）
    purchase = None
    for k, v in d.items():
        if "purchase" in k.lower() and "count" in k.lower() and isinstance(v, int):
            purchase = v
    return {
        "key": key,
        "title": title,
        "url": f"{BASE}/{urlname}/n/{key}" if urlname else f"{BASE}/n/{key}",
        "price": to_int(d.get("price")),
        "likes": to_int(pick(d, "like_count", "likeCount")),
        "comments": to_int(pick(d, "comment_count", "commentCount")),
        "publishedAt": published.astimezone(JST).isoformat(timespec="seconds"),
        "eyecatch": eyecatch if isinstance(eyecatch, str) else None,
        "hashtags": tags,
        "themes": classify(title, tags, themes),
        "purchaseCount": purchase,
        "creator": {
            "urlname": urlname,
            "name": pick(user, "nickname", "name") or urlname,
            "avatar": pick(user, "user_profile_image_path", "userProfileImagePath", "profile_image_url"),
            "followers": to_int(pick(user, "follower_count", "followerCount")),
        },
    }


# ---------- 収集 ----------

def search(keyword: str, sort: str, pages: int, size: int = 20):
    for page in range(pages):
        q = urllib.parse.urlencode({"context": "note", "q": keyword, "size": size, "start": page * size, "sort": sort})
        data = get_json(f"{BASE}/api/v3/searches?{q}")
        found = list(walk_notes(data)) if data else []
        if not found:
            return
        yield from found
        time.sleep(0.8)


def detail(key: str) -> dict | None:
    data = get_json(f"{BASE}/api/v3/notes/{key}")
    return next(walk_notes(data), None) if data else None


def collect(themes: list[dict], pages: int, refresh_keys: list[str]) -> dict[str, dict]:
    since = datetime.now(JST) - timedelta(days=MAX_AGE_DAYS)
    notes: dict[str, dict] = {}

    def add(raw: dict, theme_id: str | None = None) -> None:
        n = normalize(raw, themes)
        if not n or n["price"] <= 0 or datetime.fromisoformat(n["publishedAt"]) < since:
            return
        # 検索に使ったテーマは、タイトルに語が無くても候補に入れる
        if theme_id and theme_id not in n["themes"]:
            n["themes"].append(theme_id)
        prev = notes.get(n["key"])
        if prev:
            n["themes"] = list(dict.fromkeys(prev["themes"] + n["themes"]))
            n["likes"] = max(n["likes"], prev["likes"])
        notes[n["key"]] = n

    for t in themes:
        before = len(notes)
        for kw in t["keywords"]:
            # 新着順で新しく出た記事を、人気順で前から売れ続けている記事を拾う
            for sort in ("new", "popular"):
                for raw in search(kw, sort, pages):
                    add(raw, t["id"])
        log(f"theme {t['name']}: +{len(notes) - before} (total {len(notes)})")

    # 前回まで追跡していたnoteは、検索に出なくても最新のスキ数を取りにいく
    missing = [k for k in refresh_keys if k not in notes][:MAX_REFRESH]
    for key in missing:
        raw = detail(key)
        if raw:
            add(raw)
        time.sleep(0.5)
    log(f"refreshed {len(missing)} tracked notes")
    return notes


# ---------- 集計 ----------

def likes_at(history: list[list], target: datetime) -> int | None:
    """target 時点以前で一番新しいスキ数。"""
    best = None
    for ts, likes in history:
        if datetime.fromisoformat(ts) <= target:
            best = likes
    return best


def gain(n: dict, hist: list[list], now: datetime, hours: int) -> int:
    """直近 hours 時間のスキ増加数（分からない部分は計測開始時点との差で代用）。"""
    start = now - timedelta(hours=hours)
    if datetime.fromisoformat(n["publishedAt"]) >= start:
        return n["likes"]
    base = likes_at(hist, start)
    if base is None:
        base = hist[0][1] if hist else n["likes"]
    return max(n["likes"] - base, 0)


def score(notes: dict[str, dict], history: dict[str, list], now: datetime) -> list[dict]:
    out = []
    for n in notes.values():
        hist = history.get(n["key"], [])
        published = datetime.fromisoformat(n["publishedAt"])
        tracked_since = datetime.fromisoformat(hist[0][0]) if hist else now
        for h in GAIN_WINDOWS:
            n[f"gain{h}h"] = gain(n, hist, now, h)
        if n["gain24h"] < 1:
            continue  # 24時間で売れていない
        n["ageHours"] = round(max((now - published).total_seconds() / 3600, 0), 1)
        # 24時間分の記録が揃っているか（揃っていなければ増加数は控えめな値）
        covered = n["ageHours"] if n["ageHours"] <= 24 else (now - tracked_since).total_seconds() / 3600
        n["measuredHours"] = round(min(24, covered), 1)
        n["history"] = hist[-25:]
        # 勢いスコア: 24h増加 + 直近3hの伸びを重め + 価格の重み（高単価ほど1スキの価値が高い）
        price_weight = 1 + min(n["price"], 30000) / 10000
        n["heat"] = round((n["gain24h"] + n["gain3h"] * 3) * price_weight, 1)
        n["salesIndex"] = n["gain24h"] * n["price"]
        out.append(n)
    out.sort(key=lambda x: x["heat"], reverse=True)
    for i, n in enumerate(out, 1):
        n["rank"] = i
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "data"))
    ap.add_argument("--themes", default=os.path.join(ROOT, "themes.json"))
    ap.add_argument("--pages", type=int, default=2, help="キーワード・並び順ごとの検索ページ数")
    ap.add_argument("--only", help="カンマ区切りのテーマIDだけ収集（テスト用）")
    ap.add_argument("--from-file", help="APIを叩かず、保存済みのレスポンスJSONから作る（テスト用）")
    ap.add_argument("--now", help="現在時刻を上書き（テスト用, ISO形式）")
    args = ap.parse_args()

    themes = load_themes(args.themes)
    if args.only:
        wanted = set(args.only.split(","))
        themes_to_fetch = [t for t in themes if t["id"] in wanted]
    else:
        themes_to_fetch = themes

    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    hist_path = os.path.join(out_dir, "history.json")
    try:
        with open(hist_path, encoding="utf-8") as f:
            history: dict[str, list] = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        history = {}

    now = datetime.fromisoformat(args.now) if args.now else datetime.now(JST)
    if args.from_file:
        with open(args.from_file, encoding="utf-8") as f:
            raw = json.load(f)
        notes = {}
        for r in walk_notes(raw):
            n = normalize(r, themes)
            if n and n["price"] > 0:
                notes[n["key"]] = n
    else:
        # 直近で伸びていたものから優先して取り直す
        recent = sorted(history, key=lambda k: history[k][-1][1] - history[k][0][1], reverse=True)
        notes = collect(themes_to_fetch, args.pages, recent)

    # 履歴を更新
    stamp = now.isoformat(timespec="seconds")
    cutoff = now - timedelta(hours=HISTORY_HOURS)
    for key, n in notes.items():
        points = [p for p in history.get(key, []) if datetime.fromisoformat(p[0]) < now]
        points.append([stamp, n["likes"]])
        history[key] = points
    history = {k: [p for p in v if datetime.fromisoformat(p[0]) >= cutoff] for k, v in history.items()}
    history = {k: v for k, v in history.items() if v}
    if len(history) > MAX_TRACKED:
        keep = sorted(history, key=lambda k: (history[k][-1][1] - history[k][0][1], history[k][-1][0]), reverse=True)
        history = {k: history[k] for k in keep[:MAX_TRACKED]}

    ranked = score(notes, history, now)
    first_seen = min((v[0][0] for v in history.values()), default=stamp)
    latest = {
        "generatedAt": stamp,
        "trackingSince": first_seen,
        "trackedCount": len(history),
        "source": "note.com (非公式API)",
        "themes": [{k: t[k] for k in ("id", "name", "emoji")} for t in themes],
        "count": len(ranked),
        "notes": ranked,
    }
    with open(os.path.join(out_dir, "latest.json"), "w", encoding="utf-8") as f:
        json.dump(latest, f, ensure_ascii=False, separators=(",", ":"))
    with open(hist_path, "w", encoding="utf-8") as f:
        json.dump(history, f, ensure_ascii=False, separators=(",", ":"))
    log(f"tracked {len(history)} notes, selling in 24h: {len(ranked)} -> {out_dir}")
    # 1件も取れないのはAPI仕様変更の可能性が高いので失敗扱いにして気づけるようにする
    return 0 if notes or args.from_file else 1


if __name__ == "__main__":
    sys.exit(main())
