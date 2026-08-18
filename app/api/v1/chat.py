from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from app.models.schemas import ChatRequest
from app.agents.personal_chief import search_recipes, get_messages, clear_messages

router = APIRouter()


@router.post("/chat/stream")
async def chat_endpoint(request: Request, body: ChatRequest):
    """流式对话；客户端断开后尽快结束。"""

    async def should_stop() -> bool:
        return await request.is_disconnected()

    async def event_stream():
        async for chunk in search_recipes(
            body.message,
            body.image_url,
            body.thread_id,
            should_stop=should_stop,
        ):
            if await request.is_disconnected():
                break
            yield chunk

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/chat/messages")
async def get_chat_messages(thread_id: str):
    return {"messages": get_messages(thread_id)}


@router.delete("/chat/messages")
async def clear_chat_messages(thread_id: str):
    clear_messages(thread_id)
    return {"success": True}
