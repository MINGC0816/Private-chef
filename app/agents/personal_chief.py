from langchain.chat_models import init_chat_model
from langchain_core.messages import HumanMessage, AIMessageChunk, AIMessage
from langchain_tavily import TavilySearch
from langchain.agents import create_agent
from app.common.logger import logger
import asyncio
import json
import os
from pathlib import Path
from langgraph.checkpoint.sqlite import SqliteSaver
import sqlite3

from dotenv import load_dotenv
load_dotenv()

web_search = TavilySearch(max_results=5, topic="general")

model = init_chat_model(
    model="qwen3.5-plus",
    model_provider="openai",
    base_url=os.getenv("DASHSCOPE_BASE_URL"),
    api_key=os.getenv("DASHSCOPE_API_KEY"),
)

_db_path = Path(__file__).resolve().parent.parent / "db" / "personal_chief.db"
_db_path.parent.mkdir(parents=True, exist_ok=True)
connection = sqlite3.connect(str(_db_path), check_same_thread=False)
checkpointer = SqliteSaver(connection)
checkpointer.setup()

system_prompt = """
你是一名私人厨师。收到用户提供的食材照片或清单后，请按以下流程操作：
1.识别和评估食材：若用户提供照片，首先辨识所有可见食材。基于食材的外观状态，评估其新鲜度与可用量，整理出一份“当前可用食材清单”。
2.智能食谱检索：优先调用 web_search 工具，以“可用食材清单”为核心关键词，查找可行菜谱。
3.多维度评估与排序：从营养价值和制作难度两个维度对检索到的候选食谱进行量化打分，并根据得分排序，制作简单且营养丰富的排名靠前。
4.结构化方案输出：把排序后的食谱整理为一份结构清晰的建议报告，要包含食谱信息、得分、推荐理由。

关于图片：
- 仅在有可直接访问的图片直链（.jpg/.jpeg/.png/.webp 或明确 CDN 图片地址）时，才用 Markdown：![菜名](https://...)
- 不要编造链接；没有可靠图片时写“暂无参考图”即可。

请严格按照流程，优先调用 web_search 工具搜索食谱，搜索不到的情况下才能自己发挥。
"""

agent = create_agent(
    model=model,
    tools=[web_search],
    checkpointer=checkpointer,
    system_prompt=system_prompt,
)


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


def _normalize_message_content(content) -> dict:
    if content is None:
        return {"text": "", "image_url": None}
    if isinstance(content, str):
        return {"text": content, "image_url": None}
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
        return {"text": "\n".join(texts).strip(), "image_url": image_url}
    return {"text": str(content), "image_url": None}


async def search_recipes(prompt: str, image: str | None, thread_id: str, should_stop=None):
    """异步包装同步 stream，并按 SSE data: 行输出（否则前端会丢掉换行正文）。"""
    logger.info(f"[用户]: {prompt}, image: {image}, thread_id: {thread_id}")
    try:
        if not image or not str(image).strip():
            message = HumanMessage(content=prompt)
        else:
            message = HumanMessage(content=[
                {"type": "image_url", "image_url": {"url": image}},
                {"type": "text", "text": prompt},
            ])

        # SqliteSaver 不支持 astream；在线程中逐步拉取 sync stream，避免堵死事件循环
        stream_iter = agent.stream(
            {"messages": [message]},
            {"configurable": {"thread_id": thread_id}},
            stream_mode="messages",
        )

        def _next_item():
            try:
                return next(stream_iter), False
            except StopIteration:
                return None, True

        while True:
            if should_stop and await should_stop():
                yield f"data: {json.dumps(chr(10) + chr(10) + '（已停止生成）', ensure_ascii=False)}\n\n"
                break

            item, finished = await asyncio.to_thread(_next_item)
            if finished:
                break

            chunk, metadata = item
            if not isinstance(chunk, AIMessageChunk):
                continue
            if getattr(chunk, "tool_call_chunks", None):
                continue
            text = _extract_text(chunk.content)
            if text:
                yield f"data: {json.dumps(text, ensure_ascii=False)}\n\n"

    except Exception as e:
        logger.error(f"\n[错误]: {str(e)}")
        yield f"data: {json.dumps('信息检索失败，试试看手动输入食物列表？', ensure_ascii=False)}\n\n"


def clear_messages(thread_id: str):
    logger.info(f"清空历史消息，thread_id: {thread_id}")
    checkpointer.delete_thread(thread_id)


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
