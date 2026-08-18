from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
import httpx
from urllib.parse import urlparse

router = APIRouter()

ALLOWED_SCHEMES = {"http", "https"}
MAX_BYTES = 8 * 1024 * 1024


@router.get("/proxy/image")
async def proxy_image(url: str = Query(..., min_length=8, max_length=2048)):
    """代理外链图片，缓解防盗链导致的参考图无法显示。"""
    parsed = urlparse(url)
    if parsed.scheme not in ALLOWED_SCHEMES or not parsed.netloc:
        raise HTTPException(status_code=400, detail="无效的图片地址")

    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; PersonalChief/0.1)",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Referer": f"{parsed.scheme}://{parsed.netloc}/",
    }
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=20.0) as client:
            resp = await client.get(url, headers=headers)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"拉取图片失败: {exc}") from exc

    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"上游返回 {resp.status_code}")

    content = resp.content
    if len(content) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="图片过大")

    content_type = resp.headers.get("content-type", "image/jpeg").split(";")[0].strip()
    if not content_type.startswith("image/"):
        if "html" in content_type:
            raise HTTPException(status_code=502, detail="目标不是图片资源")
        content_type = "image/jpeg"

    return Response(
        content=content,
        media_type=content_type,
        headers={
            "Cache-Control": "public, max-age=86400",
            "Access-Control-Allow-Origin": "*",
        },
    )
