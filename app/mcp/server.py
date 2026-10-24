"""私厨 MCP 服务器：库存、档案、联网搜菜全部以 FastMCP 工具对外提供。"""

from __future__ import annotations

import json
from typing import Any

from fastmcp import FastMCP
from pydantic import BaseModel, Field, field_validator

from app.db.store import (
    get_profile,
    list_pantry,
    remove_pantry,
    update_profile,
    upsert_pantry_items,
)

mcp = FastMCP("personal-chief")

_tavily = None


class PantryItemIn(BaseModel):
    name: str = Field(description="食材名称，如番茄、鸡蛋")
    category: str = Field(default="其他", description="蔬菜/水果/肉蛋/豆制品/主食/调味/其他")
    quantity: float | None = Field(default=None, description="估量，识别不准可省略")
    unit: str | None = Field(default=None, description="个/根/克/把等")
    freshness: str = Field(default="未知", description="新鲜/一般/较差/未知")
    note: str = Field(default="", description="如半根、叶子发黄")

    @field_validator("quantity", mode="before")
    @classmethod
    def coerce_quantity(cls, value: Any) -> float | None:
        if value is None or value == "":
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None


def _dump(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False)


def _get_tavily():
    global _tavily
    if _tavily is None:
        from langchain_tavily import TavilySearch

        _tavily = TavilySearch(
            max_results=5,
            topic="general",
            include_answer=True,
        )
    return _tavily


@mcp.tool
def pantry_upsert(
    items: list[PantryItemIn],
    source: str = "chat",
    image_url: str = "",
) -> str:
    """写入或更新冰箱库存。拍到冰箱、识别到食材、或用户口述「有鸡蛋番茄」后必须调用。
    没出现在照片里的旧库存不要删除。name 会自动规范化（西红柿→番茄）。
    source 取值 photo / chat；有图时用 photo。"""
    payload = upsert_pantry_items(
        [item.model_dump() for item in items],
        source=source,
        image_url=image_url,
    )
    return _dump(payload)


@mcp.tool
def pantry_list() -> str:
    """查看当前冰箱库存。推荐菜谱或用户问「冰箱里还有什么」时调用。"""
    items = list_pantry()
    return _dump({"ok": True, "count": len(items), "items": items})


@mcp.tool
def pantry_remove(names: list[str]) -> str:
    """从库存中移除食材。用户说「黄瓜吃完了」「鸡蛋用完了」时调用。"""
    return _dump(remove_pantry(names))


@mcp.tool
def profile_get() -> str:
    """读取用户长期档案：用餐人数、口味、忌口、过敏、厨具等。"""
    return _dump({"ok": True, "profile": get_profile()})


@mcp.tool
def profile_update(
    household_size: int | None = None,
    taste_pref: list[str] | None = None,
    likes: list[str] | None = None,
    dislikes: list[str] | None = None,
    allergies: list[str] | None = None,
    diet_tags: list[str] | None = None,
    appliances: list[str] | None = None,
    notes: str | None = None,
) -> str:
    """更新长期口味档案。只传提到的字段；列表会与现有值合并去重，不会整表覆盖。
    用户说「我们两口人」「不吃香菜」「口味清淡」「花生过敏」时必须调用。"""
    patch = {
        "household_size": household_size,
        "taste_pref": taste_pref,
        "likes": likes,
        "dislikes": dislikes,
        "allergies": allergies,
        "diet_tags": diet_tags,
        "appliances": appliances,
        "notes": notes,
    }
    patch = {key: value for key, value in patch.items() if value is not None}
    if not patch:
        return _dump({"ok": False, "error": "没有可更新的字段"})
    return _dump(update_profile(patch, merge_lists=True))


@mcp.tool
def web_search(query: str) -> str:
    """在网上检索真实菜谱。query 用中文，格式为「食材1 食材2 人数 家常菜 做法 忌口」。
    推荐菜谱前必须调用；根据返回的 title/url/content 写菜名和来源链接，不要凭空编造。"""
    tool = _get_tavily()
    result = tool.invoke({"query": query})
    if isinstance(result, (dict, list)):
        return json.dumps(result, ensure_ascii=False)
    return str(result)
