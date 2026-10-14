#!/usr/bin/env python3
"""note.com から「直近24時間に公開された有料note」を集めて JSON に書き出す。

GitHub Actions から1時間ごとに実行する想定。標準ライブラリのみで動く。

注意:
- note.com は販売数を公開していないため、スキ数とその増え方を「売れ筋」の代わりの指標にする。
- 使っている API は非公式。仕様が変わっても壊れにくいように、レスポンスの形に依存せず
  「note らしいオブジェクト」を再帰的に探して正規化している。

出力:
  data/latest.json   … 画面が読む最新データ
  data/history.json  … 各noteのスキ数の推移（48時間分）。増加量の計算に使う
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

# 検索キーワード。有料noteが多いジャンルを中心に、広く拾えるように並べている。
DEFAULT_KEYWORDS = [
    "有料", "副業", "稼ぐ", "収益化", "ブログ", "SNS運用", "X運用", "Instagram", "TikTok",
    "YouTube", "ChatGPT", "AI", "生成AI", "プロンプト", "Claude", "マーケティング", "コンテンツ販売",
    "Brain", "Tips", "せどり", "物販", "転売", "投資", "株", "FX", "仮想通貨", "不動産",
    "競馬", "競艇", "予想", "恋愛", "婚活", "美容", "ダイエット", "筋トレ", "健康",
    "転職", "就活", "資格", "英語", "勉強法", "プログラミング", "デザイン", "イラスト",
    "小説", "エッセイ", "占い", "スピリチュアル", "子育て", "教育", "ビジネス", "起業",
    "営業", "コピーライティング", "ライティング", "Kindle", "アフィリエイト", "ポイ活", "節約",
    "マネタイズ", "ノウハウ", "完全版", "マニュアル", "テンプレート", "教材",
]

# ジャンル判定用の辞書。タイトルとハッシュタグから推定する。
GENRES = {
    "副業・稼ぐ": ["副業", "稼", "収益", "マネタイズ", "月収", "万円", "不労所得", "アフィリ", "ポイ活", "せどり", "物販", "転売", "コンテンツ販売", "Brain", "Tips"],
    "SNS・マーケ": ["SNS", "X運用", "Twitter", "ツイッター", "インスタ", "Instagram", "TikTok", "YouTube", "フォロワー", "マーケ", "集客", "ブランディング", "コピー", "セールス", "LP"],
    "AI・テック": ["AI", "ChatGPT", "GPT", "Claude", "生成AI", "プロンプト", "Gemini", "自動化", "プログラミング", "Python", "ノーコード", "GAS"],
    "投資・お金": ["投資", "株", "FX", "仮想通貨", "ビットコイン", "NISA", "不動産", "資産", "節約", "家計", "トレード"],
    "ギャンブル予想": ["競馬", "競艇", "ボートレース", "競輪", "予想", "馬券", "パチ", "スロ"],
    "恋愛・美容": ["恋愛", "婚活", "モテ", "美容", "メイク", "スキンケア", "ダイエット", "痩せ", "筋トレ", "ファッション"],
    "仕事・キャリア": ["転職", "就活", "キャリア", "営業", "マネジメント", "起業", "ビジネス", "フリーランス", "資格", "面接"],
    "学び・教育": ["勉強", "英語", "受験", "教育", "子育て", "学習", "読書"],
    "創作・エンタメ": ["小説", "エッセイ", "漫画", "マンガ", "イラスト", "デザイン", "写真", "音楽", "創作", "詩"],
    "占い・スピ": ["占い", "スピリチュアル", "タロット", "星座", "運勢", "開運", "風水"],
}


def log(*args: object) -> None:
    print(*args, file=sys.stderr, flush=True)


def get_json(url: str, retries: int = 3, wait: float = 1.0) -> dict | None:
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=20) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (404, 400):
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


def guess_genre(title: str, tags: list[str]) -> str:
    text = (title + " " + " ".join(tags)).lower()
    best, best_hits = "その他", 0
    for genre, words in GENRES.items():
        hits = sum(1 for w in words if w.lower() in text)
        if hits > best_hits:
            best, best_hits = genre, hits
    return best


def normalize(d: dict) -> dict | None:
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
        "genre": guess_genre(title, tags),
        "type": d.get("type") or "TextNote",
        "isLimited": bool(pick(d, "is_limited", "isLimited")),
        "purchaseCount": purchase,
        "creator": {
            "urlname": urlname,
            "name": pick(user, "nickname", "name") or urlname,
            "avatar": pick(user, "user_profile_image_path", "userProfileImagePath", "profile_image_url"),
            "followers": to_int(pick(user, "follower_count", "followerCount")),
        },
    }


# ---------- 収集 ----------

def search(keyword: str, pages: int, size: int = 20):
    for page in range(pages):
        q = urllib.parse.urlencode({"context": "note", "q": keyword, "size": size, "start": page * size, "sort": "new"})
        data = get_json(f"{BASE}/api/v3/searches?{q}")
        if not data:
            return
        found = list(walk_notes(data))
        if not found:
            return
        yield from found
        time.sleep(0.8)


def hashtag(tag: str, pages: int):
    for page in range(1, pages + 1):
        q = urllib.parse.urlencode({"order": "new", "page": page, "paid_only": "true"})
        data = get_json(f"{BASE}/api/v3/hashtags/{urllib.parse.quote(tag)}/notes?{q}")
        if not data:
            return
        found = list(walk_notes(data))
        if not found:
            return
        yield from found
        time.sleep(0.8)


def detail(key: str) -> dict | None:
    data = get_json(f"{BASE}/api/v3/notes/{key}")
    found = next(walk_notes(data), None) if data else None
    return found


def collect(keywords: list[str], pages: int, window_hours: int, refresh_keys: list[str]) -> dict[str, dict]:
    now = datetime.now(JST)
    since = now - timedelta(hours=window_hours)
    notes: dict[str, dict] = {}

    def add(raw: dict) -> None:
        n = normalize(raw)
        if not n or n["price"] <= 0:
            return
        if datetime.fromisoformat(n["publishedAt"]) < since:
            return
        prev = notes.get(n["key"])
        if not prev or n["likes"] >= prev["likes"]:
            notes[n["key"]] = n

    for i, kw in enumerate(keywords, 1):
        before = len(notes)
        for raw in search(kw, pages):
            add(raw)
        log(f"[{i}/{len(keywords)}] search '{kw}': +{len(notes) - before} (total {len(notes)})")

    for tag in ("有料記事", "有料note", "副業", "AI"):
        for raw in hashtag(tag, 2):
            add(raw)

    # 前回まで追跡していたnoteは検索に出なくても最新のスキ数を取りにいく
    for key in refresh_keys:
        if key in notes:
            continue
        raw = detail(key)
        if raw:
            add(raw)
        time.sleep(0.5)

    return notes


# ---------- スコア計算 ----------

def likes_at(history: list[list], target: datetime) -> int | None:
    """target 時点以前で一番新しいスキ数。"""
    best = None
    for ts, likes in history:
        if datetime.fromisoformat(ts) <= target:
            best = likes
    return best


def score(notes: dict[str, dict], history: dict[str, list], now: datetime) -> list[dict]:
    out = []
    for n in notes.values():
        published = datetime.fromisoformat(n["publishedAt"])
        hours = max((now - published).total_seconds() / 3600, 0.5)
        hist = history.get(n["key"], [])
        base_1h = likes_at(hist, now - timedelta(hours=1))
        base_3h = likes_at(hist, now - timedelta(hours=3))
        n["ageHours"] = round(hours, 1)
        n["likesPerHour"] = round(n["likes"] / hours, 2)
        n["likesGain1h"] = n["likes"] - base_1h if base_1h is not None else None
        n["likesGain3h"] = n["likes"] - base_3h if base_3h is not None else None
        n["history"] = hist[-48:]
        # 勢いスコア: 1時間あたりのスキ + 直近の伸び + 価格の重み（高単価ほど1スキの価値が高い）
        recent = n["likesGain3h"] / 3 if n["likesGain3h"] is not None else n["likesPerHour"]
        price_weight = 1 + min(n["price"], 30000) / 10000
        n["heat"] = round((n["likesPerHour"] * 0.6 + recent * 0.4) * price_weight * 10, 1)
        # スキ×価格の指数（売上の大きさの目安。実際の売上ではない）
        n["revenueIndex"] = n["likes"] * n["price"]
        out.append(n)
    out.sort(key=lambda x: x["heat"], reverse=True)
    for i, n in enumerate(out, 1):
        n["rank"] = i
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data"))
    ap.add_argument("--pages", type=int, default=3, help="キーワードごとの検索ページ数")
    ap.add_argument("--window", type=int, default=24, help="何時間以内に公開されたnoteを対象にするか")
    ap.add_argument("--keywords", help="カンマ区切りで検索キーワードを上書き")
    ap.add_argument("--from-file", help="APIを叩かず、保存済みのレスポンスJSONから作る（テスト用）")
    args = ap.parse_args()

    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    hist_path = os.path.join(out_dir, "history.json")
    try:
        with open(hist_path, encoding="utf-8") as f:
            history: dict[str, list] = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        history = {}

    now = datetime.now(JST)
    if args.from_file:
        with open(args.from_file, encoding="utf-8") as f:
            raw = json.load(f)
        notes: dict[str, dict] = {}
        since = now - timedelta(hours=args.window)
        for r in walk_notes(raw):
            n = normalize(r)
            if n and n["price"] > 0 and datetime.fromisoformat(n["publishedAt"]) >= since:
                notes[n["key"]] = n
    else:
        keywords = args.keywords.split(",") if args.keywords else DEFAULT_KEYWORDS
        notes = collect(keywords, args.pages, args.window, list(history.keys()))

    # 履歴を更新（48時間より古い点と、対象外になったnoteは捨てる）
    stamp = now.isoformat(timespec="seconds")
    cutoff = now - timedelta(hours=48)
    for key, n in notes.items():
        history.setdefault(key, []).append([stamp, n["likes"]])
    history = {
        k: [p for p in v if datetime.fromisoformat(p[0]) >= cutoff]
        for k, v in history.items()
        if k in notes
    }

    ranked = score(notes, history, now)
    latest = {
        "generatedAt": stamp,
        "windowHours": args.window,
        "source": "note.com (非公式API)",
        "count": len(ranked),
        "notes": ranked,
    }
    with open(os.path.join(out_dir, "latest.json"), "w", encoding="utf-8") as f:
        json.dump(latest, f, ensure_ascii=False, separators=(",", ":"))
    with open(hist_path, "w", encoding="utf-8") as f:
        json.dump(history, f, ensure_ascii=False, separators=(",", ":"))
    log(f"wrote {len(ranked)} notes -> {out_dir}")
    return 0 if ranked or args.from_file else 1


if __name__ == "__main__":
    sys.exit(main())
