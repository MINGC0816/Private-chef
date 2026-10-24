import warnings

from langchain.chat_models import init_chat_model
from langchain_core.messages import HumanMessage, AIMessageChunk, AIMessage
from langchain.agents import create_agent
from langchain_core._api import LangChainBetaWarning

warnings.filterwarnings("ignore", category=LangChainBetaWarning)
from langchain.mcp import MCPAdapter
from app.common.logger import logger
from app.db.store import connection, lock as _db_lock, format_memory_block
from app.mcp.server import mcp
import asyncio
import json
import os
import queue
import threading
import time
from langgraph.checkpoint.sqlite import SqliteSaver

from dotenv import load_dotenv
load_dotenv()

model = init_chat_model(
    model="qwen3.5-plus",
    model_provider="openai",
    base_url=os.getenv("DASHSCOPE_BASE_URL"),
    api_key=os.getenv("DASHSCOPE_API_KEY"),
)

checkpointer = SqliteSaver(connection)
checkpointer.setup()

USER_MARKER = "【用户】"
TOOL_HINTS = {
    "web_search": "正在网上检索真实菜谱…",
    "pantry_upsert": "正在更新冰箱库存…",
    "pantry_list": "正在查看冰箱库存…",
    "pantry_remove": "正在从库存中移除食材…",
    "profile_get": "正在读取口味档案…",
    "profile_update": "正在更新口味档案…",
}

system_prompt = """
你是一名私人厨师，同时维护用户的冰箱库存和长期口味档案。

每轮必须按顺序执行，不得跳过：

1. 若用户发了冰箱/食材照片，或口述了新食材：先调用 pantry_upsert 写入库存。
   - 有图时 source=photo，并传入 image_url。
   - 口述时 source=chat。
   - 照片里没出现的旧库存不要删除。
2. 若用户提到用餐人数、口味、忌口、过敏、厨具：调用 profile_update，只更新提到的字段。
3. 推荐菜谱前，必须调用 web_search 检索真实菜谱。
   - query 用中文，带上主要食材、忌口和人数，例如「番茄 鸡蛋 两人 家常菜 做法 不放香菜」。
   - 菜名必须来自搜索结果；每道菜附上来源链接（结果里的 url）。
   - 只有搜索结果为空时，才可以自己发挥，并写明「暂无检索结果，以下为自行建议」。
4. 推荐必须避开过敏原和忌口；优先用库存里新鲜的食材；按营养价值和制作难度排序，简单且营养的靠前。
5. 输出结构清晰的建议报告：菜谱信息、得分、推荐理由、来源链接。

关于图片：
- 仅在有可直接访问的图片直链（.jpg/.jpeg/.png/.webp 或明确 CDN 图片地址）时，才用 Markdown：![菜名](https://...)
- 不要编造链接；没有可靠图片时写「暂无参考图」即可。
"""

agent = None
_agent_lock = asyncio.Lock()


def _ensure_threads_table():
    with _db_lock:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_threads (
                thread_id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '新对话',
                manual_title INTEGER NOT NULL DEFAULT 0,
                auto_titled INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
            )
            """
        )
        connection.commit()


_ensure_threads_table()


async def ensure_agent():
    """通过 MCPAdapter 发现 FastMCP 工具，再交给 LangChain Agent。"""
    global agent
    async with _agent_lock:
        if agent is not None:
            return agent
        async with MCPAdapter(mcp) as adapter:
            tools = await adapter.list_tools()
        names = [getattr(tool, "name", str(tool)) for tool in tools]
        logger.info(f"已接入 MCP 工具: {names}")
        agent = create_agent(
            model=model,
            tools=tools,
            checkpointer=checkpointer,
            system_prompt=system_prompt,
        )
        return agent


def _extract_text(content) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                if isinstance(block.get("text"), str):
                    parts.append(block["text"])
                elif isinstance(block.get("content"), str):
                    parts.append(block["content"])
        return "".join(parts)
    return str(content)


def _strip_memory_prefix(text: str) -> str:
    if USER_MARKER in (text or ""):
        return text.split(USER_MARKER, 1)[1].strip()
    return text or ""


def _normalize_message_content(content) -> dict:
    if content is None:
        return {"text": "", "image_url": None}
    if isinstance(content, str):
        return {"text": _strip_memory_prefix(content), "image_url": None}
    if isinstance(content, list):
        texts = []
        image_url = None
        for block in content:
            if isinstance(block, str):
                texts.append(block)
                continue
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype in ("text", None) and isinstance(block.get("text"), str):
                texts.append(block["text"])
            elif btype == "image_url":
                raw = block.get("image_url")
                if isinstance(raw, str):
                    image_url = raw
                elif isinstance(raw, dict):
                    image_url = raw.get("url")
            elif btype == "image" and isinstance(block.get("url"), str):
                image_url = block["url"]
        return {"text": _strip_memory_prefix("\n".join(texts).strip()), "image_url": image_url}
    return {"text": _strip_memory_prefix(str(content)), "image_url": None}


def touch_thread(
    thread_id: str,
    title: str | None = None,
    *,
    manual: bool = False,
    auto_titled: bool | None = None,
):
    """写入/更新会话目录。手动改名后不再被自动标题覆盖。"""
    if not thread_id:
        return
    now = int(time.time() * 1000)
    next_title = (title or "").strip()[:32]
    with _db_lock:
        row = connection.execute(
            "SELECT title, manual_title, auto_titled FROM chat_threads WHERE thread_id = ?",
            (thread_id,),
        ).fetchone()
        if row is None:
            connection.execute(
                """
                INSERT INTO chat_threads
                    (thread_id, title, manual_title, auto_titled, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    thread_id,
                    next_title or "新对话",
                    1 if manual else 0,
                    1 if auto_titled else 0,
                    now,
                ),
            )
        else:
            old_title, old_manual, old_auto = row
            new_manual = 1 if (manual or old_manual) else 0
            new_auto = 1 if auto_titled else old_auto
            new_title = old_title
            if manual and next_title:
                new_title = next_title
                new_manual = 1
            elif auto_titled and next_title and not old_manual:
                new_title = next_title
                new_auto = 1
            elif next_title and not old_manual and not old_auto:
                new_title = next_title
            connection.execute(
                """
                UPDATE chat_threads
                SET title = ?, manual_title = ?, auto_titled = ?, updated_at = ?
                WHERE thread_id = ?
                """,
                (new_title, new_manual, new_auto, now, thread_id),
            )
        connection.commit()


def reset_thread(thread_id: str):
    now = int(time.time() * 1000)
    with _db_lock:
        connection.execute(
            """
            UPDATE chat_threads
            SET title = '新对话', manual_title = 0, auto_titled = 0, updated_at = ?
            WHERE thread_id = ?
            """,
            (now, thread_id),
        )
        connection.commit()


def remove_thread(thread_id: str):
    with _db_lock:
        connection.execute("DELETE FROM chat_threads WHERE thread_id = ?", (thread_id,))
        connection.commit()


def list_threads() -> list[dict]:
    """会话目录以 chat_threads 为准，并用 checkpoints 回填清缓存前就存在的历史。"""
    _ensure_threads_table()
    with _db_lock:
        try:
            checkpoint_rows = connection.execute(
                "SELECT thread_id, MAX(checkpoint_id) FROM checkpoints GROUP BY thread_id"
            ).fetchall()
        except Exception:
            checkpoint_rows = []
        existing = {
            row[0]
            for row in connection.execute("SELECT thread_id FROM chat_threads").fetchall()
        }
        missing_rows = [row for row in checkpoint_rows if row[0] not in existing]

    derived_titles = {}
    for tid, _checkpoint_id in missing_rows:
        messages = get_messages(tid)
        first_user = next(
            (
                msg["content"]
                for msg in messages
                if msg.get("role") == "user" and msg.get("content")
            ),
            None,
        )
        derived_titles[tid] = (first_user or "新对话").strip()[:32] or "新对话"

    now = int(time.time() * 1000)
    missing_rows.sort(key=lambda row: row[1] or "", reverse=True)
    with _db_lock:
        for offset, (tid, _checkpoint_id) in enumerate(missing_rows):
            connection.execute(
                """
                INSERT OR IGNORE INTO chat_threads
                    (thread_id, title, manual_title, auto_titled, updated_at)
                VALUES (?, ?, 0, 0, ?)
                """,
                (tid, derived_titles.get(tid, "新对话"), now - offset),
            )
        connection.commit()
        rows = connection.execute(
            """
            SELECT thread_id, title, manual_title, auto_titled, updated_at
            FROM chat_threads
            ORDER BY updated_at DESC
            """
        ).fetchall()

    return [
        {
            "id": row[0],
            "title": row[1],
            "manual_title": bool(row[2]),
            "auto_titled": bool(row[3]),
            "updated_at": row[4],
        }
        for row in rows
    ]


def _tool_names_from_chunk(chunk) -> list[str]:
    names = []
    tool_chunks = getattr(chunk, "tool_call_chunks", None) or []
    for tc in tool_chunks:
        name = tc.get("name") if isinstance(tc, dict) else getattr(tc, "name", None)
        args = tc.get("args") if isinstance(tc, dict) else getattr(tc, "args", None)
        if name:
            names.append(name)
        if name or args:
            logger.info(f"[工具调用] name={name} args={args}")
    tool_calls = getattr(chunk, "tool_calls", None) or []
    for tc in tool_calls:
        name = tc.get("name") if isinstance(tc, dict) else getattr(tc, "name", None)
        if name:
            names.append(name)
            logger.info(f"[工具调用] name={name}")
    return names


async def search_recipes(prompt: str, image: str | None, thread_id: str, should_stop=None):
    """异步包装同步 stream，并按 SSE data: 行输出（否则前端会丢掉换行正文）。"""
    runtime = await ensure_agent()
    logger.info(f"[用户]: {prompt}, image: {image}, thread_id: {thread_id}")
    touch_thread(thread_id, title=prompt)
    try:
        memory = format_memory_block()
        composed = f"{memory}\n{USER_MARKER}{prompt}"
        image_url = (image or "").strip() or None
        if not image_url:
            message = HumanMessage(content=composed)
        else:
            message = HumanMessage(content=[
                {"type": "image_url", "image_url": {"url": image_url}},
                {"type": "text", "text": composed},
            ])

        item_q: queue.Queue = queue.Queue()

        def _produce():
            try:
                for item in runtime.stream(
                    {"messages": [message]},
                    {"configurable": {"thread_id": thread_id}},
                    stream_mode="messages",
                ):
                    item_q.put(("item", item))
                item_q.put(("done", None))
            except Exception as exc:
                item_q.put(("error", exc))

        worker = threading.Thread(target=_produce, daemon=True, name="chief-stream")
        worker.start()

        notified: set[str] = set()
        while True:
            if should_stop and await should_stop():
                yield f"data: {json.dumps(chr(10) + chr(10) + '（已停止生成）', ensure_ascii=False)}\n\n"
                break

            try:
                kind, payload = await asyncio.to_thread(item_q.get, True, 0.25)
            except queue.Empty:
                if not worker.is_alive() and item_q.empty():
                    break
                continue

            if kind == "done":
                break
            if kind == "error":
                raise payload

            chunk, _metadata = payload
            if not isinstance(chunk, (AIMessageChunk, AIMessage)):
                continue

            names = _tool_names_from_chunk(chunk)
            if names:
                for name in names:
                    if name in notified:
                        continue
                    notified.add(name)
                    hint = TOOL_HINTS.get(name, f"正在调用 {name}…")
                    yield f"data: {json.dumps(hint + chr(10) + chr(10), ensure_ascii=False)}\n\n"
                continue

            text = _extract_text(chunk.content)
            if text:
                yield f"data: {json.dumps(text, ensure_ascii=False)}\n\n"

        if image_url and "pantry_upsert" not in notified:
            reminder = "（提示：这次没有把识别结果写入库存。可以说「帮我记下这些食材」。）"
            yield f"data: {json.dumps(chr(10) + chr(10) + reminder, ensure_ascii=False)}\n\n"

    except Exception as e:
        logger.error(f"\n[错误]: {str(e)}")
        yield f"data: {json.dumps('信息检索失败，试试看手动输入食物列表？', ensure_ascii=False)}\n\n"


def clear_messages(thread_id: str):
    logger.info(f"清空历史消息，thread_id: {thread_id}")
    checkpointer.delete_thread(thread_id)
    reset_thread(thread_id)


def delete_conversation(thread_id: str):
    logger.info(f"删除会话，thread_id: {thread_id}")
    checkpointer.delete_thread(thread_id)
    remove_thread(thread_id)


def get_messages(thread_id: str) -> list[dict]:
    logger.info(f"获取历史消息，thread_id: {thread_id}")
    checkpoint = checkpointer.get({"configurable": {"thread_id": thread_id}})
    if not checkpoint:
        return []
    channel_values = checkpoint.get("channel_values") or {}
    messages = channel_values.get("messages") or []
    result = []
    for msg in messages:
        if isinstance(msg, HumanMessage):
            norm = _normalize_message_content(msg.content)
            if not norm["text"] and not norm["image_url"]:
                continue
            result.append({
                "role": "user",
                "content": norm["text"] or "（图片消息）",
                "image_url": norm["image_url"],
            })
        elif isinstance(msg, AIMessage):
            text = _extract_text(msg.content)
            if not text:
                continue
            result.append({"role": "assistant", "content": text, "image_url": None})
    return result
