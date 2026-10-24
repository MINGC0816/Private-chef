from typing import Optional

from pydantic import BaseModel, Field

# --- 2. 数据模型 ---
class ChatRequest(BaseModel):
    message: str
    image_url: Optional[str] = None
    thread_id: str


class ThreadUpdate(BaseModel):
    title: Optional[str] = None
    manual: bool = False
    auto_titled: bool = False


class PantryItemBody(BaseModel):
    name: str
    category: str = "其他"
    quantity: Optional[float] = None
    unit: Optional[str] = None
    freshness: str = "未知"
    note: str = ""


class PantryRemoveBody(BaseModel):
    names: list[str] = Field(default_factory=list)


class ProfileUpdate(BaseModel):
    household_size: Optional[int] = None
    taste_pref: Optional[list[str]] = None
    likes: Optional[list[str]] = None
    dislikes: Optional[list[str]] = None
    allergies: Optional[list[str]] = None
    diet_tags: Optional[list[str]] = None
    appliances: Optional[list[str]] = None
    notes: Optional[str] = None