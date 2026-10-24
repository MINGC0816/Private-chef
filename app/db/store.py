"""冰箱库存与长期口味档案，与会话 checkpoint 共用同一份 SQLite。"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

DEFAULT_USER_ID = "local"

DB_PATH = Path(__file__).resolve().parent / "personal_chief.db"
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

connection = sqlite3.connect(str(DB_PATH), check_same_thread=False)
lock = threading.Lock()

NAME_ALIASES = {
    "西红柿": "番茄",
    "蕃茄": "番茄",
    "圣女果": "番茄",
    "小番茄": "番茄",
    "樱桃番茄": "番茄",
    "青椒": "青椒",
    "柿子椒": "青椒",
    "灯笼椒": "彩椒",
    "甜椒": "彩椒",
    "圆椒": "彩椒",
    "包菜": "卷心菜",
    "高丽菜": "卷心菜",
    "土豆": "土豆",
    "马铃薯": "土豆",
    "洋芋": "土豆",
    "芫荽": "香菜",
    "香荽": "香菜",
}

VALID_CATEGORIES = {"蔬菜", "水果", "肉蛋", "豆制品", "主食", "调味", "其他"}
VALID_FRESHNESS = {"新鲜", "一般", "较差", "未知"}
VALID_SOURCES = {"photo", "chat", "manual"}

LIST_FIELDS = ("taste_pref", "likes", "dislikes", "allergies", "diet_tags", "appliances")


def now_ms() -> int:
    return int(time.time() * 1000)


def canonicalize_name(name: str) -> str:
    raw = (name or "").strip()
    if not raw:
        return ""
    return NAME_ALIASES.get(raw, raw)


def _normalize_category(value: str | None) -> str:
    text = (value or "").strip()
    return text if text in VALID_CATEGORIES else "其他"


def _normalize_freshness(value: str | None) -> str:
    text = (value or "").strip()
    return text if text in VALID_FRESHNESS else "未知"


def _normalize_source(value: str | None, image_url: str | None = None) -> str:
    text = (value or "").strip()
    if text in VALID_SOURCES:
        return text
    if image_url:
        return "photo"
    return "chat"


def _json_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        items = value
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
            items = parsed if isinstance(parsed, list) else [text]
        except json.JSONDecodeError:
            items = [part.strip() for part in text.replace("，", ",").replace("、", ",").split(",")]
    else:
        items = [value]
    result = []
    seen = set()
    for item in items:
        text = str(item).strip()
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
    return result


def _merge_unique(old: list[str], incoming: list[str]) -> list[str]:
    seen = set(old)
    merged = list(old)
    for item in incoming:
        if item not in seen:
            seen.add(item)
            merged.append(item)
    return merged


def init_schema() -> None:
    with lock:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS pantry_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                display_name TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT '其他',
                quantity REAL,
                unit TEXT,
                freshness TEXT NOT NULL DEFAULT '未知',
                source TEXT NOT NULL DEFAULT 'chat',
                image_url TEXT,
                note TEXT NOT NULL DEFAULT '',
                first_seen_at INTEGER NOT NULL,
                last_seen_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                UNIQUE (user_id, name)
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS user_profile (
                user_id TEXT PRIMARY KEY,
                household_size INTEGER NOT NULL DEFAULT 1,
                taste_pref TEXT NOT NULL DEFAULT '[]',
                likes TEXT NOT NULL DEFAULT '[]',
                dislikes TEXT NOT NULL DEFAULT '[]',
                allergies TEXT NOT NULL DEFAULT '[]',
                diet_tags TEXT NOT NULL DEFAULT '[]',
                appliances TEXT NOT NULL DEFAULT '[]',
                notes TEXT NOT NULL DEFAULT '',
                updated_at INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        connection.commit()


init_schema()


def _coerce_quantity(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number


def _row_to_item(row: sqlite3.Row | tuple) -> dict[str, Any]:
    return {
        "id": row[0],
        "user_id": row[1],
        "name": row[2],
        "display_name": row[3],
        "category": row[4],
        "quantity": row[5],
        "unit": row[6],
        "freshness": row[7],
        "source": row[8],
        "image_url": row[9],
        "note": row[10] or "",
        "first_seen_at": row[11],
        "last_seen_at": row[12],
        "updated_at": row[13],
    }


def upsert_pantry_items(
    items: list[dict[str, Any]],
    *,
    source: str = "chat",
    image_url: str | None = None,
    user_id: str = DEFAULT_USER_ID,
) -> dict[str, Any]:
    added: list[str] = []
    updated: list[str] = []
    skipped: list[str] = []
    ts = now_ms()
    image = (image_url or "").strip() or None
    src = _normalize_source(source, image)

    with lock:
        for raw in items or []:
            if not isinstance(raw, dict):
                skipped.append(str(raw))
                continue
            display_name = str(raw.get("name") or "").strip()
            name = canonicalize_name(display_name)
            if not name:
                skipped.append(display_name or "(空)")
                continue
            category = _normalize_category(raw.get("category"))
            quantity = _coerce_quantity(raw.get("quantity"))
            unit = str(raw.get("unit") or "").strip() or None
            freshness = _normalize_freshness(raw.get("freshness"))
            note = str(raw.get("note") or "").strip()

            existing = connection.execute(
                "SELECT id FROM pantry_items WHERE user_id = ? AND name = ?",
                (user_id, name),
            ).fetchone()
            if existing is None:
                connection.execute(
                    """
                    INSERT INTO pantry_items (
                        user_id, name, display_name, category, quantity, unit,
                        freshness, source, image_url, note,
                        first_seen_at, last_seen_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        user_id,
                        name,
                        display_name or name,
                        category,
                        quantity,
                        unit,
                        freshness,
                        src,
                        image,
                        note,
                        ts,
                        ts,
                        ts,
                    ),
                )
                added.append(name)
            else:
                connection.execute(
                    """
                    UPDATE pantry_items
                    SET display_name = ?,
                        category = ?,
                        quantity = COALESCE(?, quantity),
                        unit = COALESCE(?, unit),
                        freshness = ?,
                        source = ?,
                        image_url = COALESCE(?, image_url),
                        note = CASE WHEN ? = '' THEN note ELSE ? END,
                        last_seen_at = ?,
                        updated_at = ?
                    WHERE user_id = ? AND name = ?
                    """,
                    (
                        display_name or name,
                        category,
                        quantity,
                        unit,
                        freshness,
                        src,
                        image,
                        note,
                        note,
                        ts,
                        ts,
                        user_id,
                        name,
                    ),
                )
                updated.append(name)
        connection.commit()

    return {
        "ok": True,
        "added": added,
        "updated": updated,
        "skipped": skipped,
        "message": f"新增 {len(added)} 项，更新 {len(updated)} 项",
    }


def list_pantry(user_id: str = DEFAULT_USER_ID) -> list[dict[str, Any]]:
    with lock:
        rows = connection.execute(
            """
            SELECT id, user_id, name, display_name, category, quantity, unit,
                   freshness, source, image_url, note,
                   first_seen_at, last_seen_at, updated_at
            FROM pantry_items
            WHERE user_id = ?
            ORDER BY last_seen_at DESC, id DESC
            """,
            (user_id,),
        ).fetchall()
    return [_row_to_item(row) for row in rows]


def remove_pantry(names: list[str], user_id: str = DEFAULT_USER_ID) -> dict[str, Any]:
    removed: list[str] = []
    missing: list[str] = []
    canonical = []
    seen = set()
    for raw in names or []:
        name = canonicalize_name(str(raw))
        if not name or name in seen:
            continue
        seen.add(name)
        canonical.append(name)

    with lock:
        for name in canonical:
            cursor = connection.execute(
                "DELETE FROM pantry_items WHERE user_id = ? AND name = ?",
                (user_id, name),
            )
            if cursor.rowcount:
                removed.append(name)
            else:
                missing.append(name)
        connection.commit()

    return {
        "ok": True,
        "removed": removed,
        "missing": missing,
        "message": f"已移除 {len(removed)} 项",
    }


def _empty_profile(user_id: str) -> dict[str, Any]:
    return {
        "user_id": user_id,
        "household_size": 1,
        "taste_pref": [],
        "likes": [],
        "dislikes": [],
        "allergies": [],
        "diet_tags": [],
        "appliances": [],
        "notes": "",
        "updated_at": 0,
    }


def _row_to_profile(row: tuple) -> dict[str, Any]:
    return {
        "user_id": row[0],
        "household_size": int(row[1] or 1),
        "taste_pref": _json_list(row[2]),
        "likes": _json_list(row[3]),
        "dislikes": _json_list(row[4]),
        "allergies": _json_list(row[5]),
        "diet_tags": _json_list(row[6]),
        "appliances": _json_list(row[7]),
        "notes": row[8] or "",
        "updated_at": row[9] or 0,
    }


def get_profile(user_id: str = DEFAULT_USER_ID) -> dict[str, Any]:
    with lock:
        row = connection.execute(
            """
            SELECT user_id, household_size, taste_pref, likes, dislikes,
                   allergies, diet_tags, appliances, notes, updated_at
            FROM user_profile
            WHERE user_id = ?
            """,
            (user_id,),
        ).fetchone()
        if row is None:
            empty = _empty_profile(user_id)
            connection.execute(
                """
                INSERT INTO user_profile (
                    user_id, household_size, taste_pref, likes, dislikes,
                    allergies, diet_tags, appliances, notes, updated_at
                ) VALUES (?, ?, '[]', '[]', '[]', '[]', '[]', '[]', '', ?)
                """,
                (user_id, empty["household_size"], empty["updated_at"]),
            )
            connection.commit()
            return empty
    return _row_to_profile(row)


def update_profile(
    patch: dict[str, Any],
    *,
    merge_lists: bool = True,
    user_id: str = DEFAULT_USER_ID,
) -> dict[str, Any]:
    current = get_profile(user_id)
    next_profile = dict(current)

    if "household_size" in patch and patch["household_size"] is not None:
        try:
            size = int(patch["household_size"])
            if size >= 1:
                next_profile["household_size"] = min(size, 20)
        except (TypeError, ValueError):
            pass

    for field in LIST_FIELDS:
        if field not in patch or patch[field] is None:
            continue
        incoming = _json_list(patch[field])
        if merge_lists:
            next_profile[field] = _merge_unique(current[field], incoming)
        else:
            next_profile[field] = incoming

    if "notes" in patch and patch["notes"] is not None:
        next_profile["notes"] = str(patch["notes"]).strip()

    ts = now_ms()
    next_profile["updated_at"] = ts
    with lock:
        connection.execute(
            """
            INSERT INTO user_profile (
                user_id, household_size, taste_pref, likes, dislikes,
                allergies, diet_tags, appliances, notes, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                household_size = excluded.household_size,
                taste_pref = excluded.taste_pref,
                likes = excluded.likes,
                dislikes = excluded.dislikes,
                allergies = excluded.allergies,
                diet_tags = excluded.diet_tags,
                appliances = excluded.appliances,
                notes = excluded.notes,
                updated_at = excluded.updated_at
            """,
            (
                user_id,
                next_profile["household_size"],
                json.dumps(next_profile["taste_pref"], ensure_ascii=False),
                json.dumps(next_profile["likes"], ensure_ascii=False),
                json.dumps(next_profile["dislikes"], ensure_ascii=False),
                json.dumps(next_profile["allergies"], ensure_ascii=False),
                json.dumps(next_profile["diet_tags"], ensure_ascii=False),
                json.dumps(next_profile["appliances"], ensure_ascii=False),
                next_profile["notes"],
                ts,
            ),
        )
        connection.commit()
    return {"ok": True, "profile": next_profile, "message": "档案已更新"}


def _join_cn(values: list[str]) -> str:
    return "、".join(values) if values else "未填写"


def format_memory_block(user_id: str = DEFAULT_USER_ID) -> str:
    profile = get_profile(user_id)
    items = list_pantry(user_id)
    profile_line = (
        f"【长期档案】用餐人数 {profile['household_size']}；"
        f"口味 {_join_cn(profile['taste_pref'])}；"
        f"爱吃 {_join_cn(profile['likes'])}；"
        f"忌口 {_join_cn(profile['dislikes'])}；"
        f"过敏 {_join_cn(profile['allergies'])}；"
        f"饮食 {_join_cn(profile['diet_tags'])}；"
        f"厨具 {_join_cn(profile['appliances'])}"
    )
    if profile.get("notes"):
        profile_line += f"；备注 {profile['notes']}"

    if not items:
        stock_line = "【当前库存】暂无记录。若用户发了冰箱照片或口述食材，必须先调用 pantry_upsert。"
    else:
        parts = []
        for item in items:
            bit = item["display_name"] or item["name"]
            qty = item.get("quantity")
            if qty is not None:
                number = int(qty) if float(qty).is_integer() else qty
                bit += f"×{number}{item.get('unit') or ''}"
            if item.get("freshness") and item["freshness"] != "未知":
                bit += f" {item['freshness']}"
            parts.append(bit)
        stock_line = "【当前库存】" + "；".join(parts)
    return f"{profile_line}\n{stock_line}"
