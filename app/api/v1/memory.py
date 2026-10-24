from fastapi import APIRouter

from app.db.store import get_profile, list_pantry, remove_pantry, update_profile, upsert_pantry_items
from app.models.schemas import PantryItemBody, PantryRemoveBody, ProfileUpdate

router = APIRouter()


@router.get("/pantry")
async def get_pantry():
    items = list_pantry()
    return {"items": items, "count": len(items)}


@router.post("/pantry")
async def add_pantry_item(body: PantryItemBody):
    return upsert_pantry_items(
        [body.model_dump()],
        source="manual",
    )


@router.post("/pantry/remove")
async def delete_pantry_items(body: PantryRemoveBody):
    return remove_pantry(body.names)


@router.get("/profile")
async def read_profile():
    return get_profile()


@router.put("/profile")
async def save_profile(body: ProfileUpdate):
    patch = body.model_dump(exclude_unset=True)
    return update_profile(patch, merge_lists=False)
