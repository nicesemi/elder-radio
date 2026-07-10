"""
Vercel Serverless 入口 - 老年收音机 AI 服务
将所有 API 路由合并到此单文件，适配 Vercel Python Runtime。
使用懒加载避免顶层导入触发只读文件系统错误。
"""

import os
import sys
import io
import json
import uuid
from datetime import datetime

LIB_DIR = os.path.join(os.path.dirname(__file__), "_lib")
sys.path.insert(0, LIB_DIR)

from fastapi import FastAPI, HTTPException, Query, UploadFile, File, Form, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, JSONResponse
from pydantic import BaseModel
from typing import Optional, List

# ---- 懒加载：避免顶层导入触发 voice_clone 的 os.makedirs ----

_CHANNELS = None
_BROADCASTER_VOICES = None

def _get_channels():
    global _CHANNELS, _BROADCASTER_VOICES
    if _CHANNELS is None:
        from config import CHANNELS, BROADCASTER_VOICES
        _CHANNELS = CHANNELS
        _BROADCASTER_VOICES = BROADCASTER_VOICES
    return _CHANNELS, _BROADCASTER_VOICES

# Supabase 客户端（延迟初始化）
_supabase_client = None

def get_supabase():
    global _supabase_client
    if _supabase_client is None:
        from supabase_client import init_supabase
        SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://ggzlxzillydjhcgodqbc.supabase.co")
        SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "sb_publishable__OVyHq9MDZOb_U3xwuOjpQ_1YY0809b")
        _supabase_client = init_supabase(url=SUPABASE_URL, key=SUPABASE_KEY)
    return _supabase_client


AUDIO_STORAGE = os.environ.get("AUDIO_STORAGE", "local")
TMP_DIR = "/tmp"


app = FastAPI(
    title="老年收音机AI服务",
    version="2.0.2"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============ 数据模型 ============

class BroadcastRequest(BaseModel):
    channel: str = "news"
    year: int = 1980
    duration: int = 5


class AIChatRequest(BaseModel):
    question: str
    context: Optional[str] = ""
    channel: Optional[str] = "chat"
    user_id: Optional[str] = "anonymous"
    session_id: Optional[str] = None


@app.get("/api/health")
async def health_check():
    return {"status": "ok", "version": "2.0.2"}


@app.get("/api/channels")
async def get_channels():
    ch, _ = _get_channels()
    return {
        "channels": [
            {"id": k, "name": v["name"], "icon": v["icon"]}
            for k, v in ch.items()
        ]
    }


@app.get("/api/voices")
async def get_voices():
    from tts_service import list_available_voices
    return {"voices": list_available_voices()}


# ============ 收音机广播 ============

@app.post("/api/broadcast/generate")
async def generate_broadcast(req: BroadcastRequest):
    from ai_content import generate_broadcast_content
    from tts_service import text_to_speech

    content = await generate_broadcast_content(
        channel=req.channel,
        year=req.year,
        duration_minutes=req.duration
    )

    output_filename = f"broadcast_{req.channel}_{req.year}.mp3"
    audio_url = None
    try:
        audio_path = await text_to_speech(
            text=content,
            year=req.year,
            output_filename=output_filename
        )
        if AUDIO_STORAGE == "supabase":
            try:
                supabase = get_supabase()
                from supabase_client import upload_audio_to_supabase, get_public_url
                filename = os.path.basename(audio_path)
                upload_audio_to_supabase(supabase, audio_path, filename)
                audio_url = get_public_url(supabase, filename)
            except Exception:
                audio_url = f"/api/audio/{os.path.basename(audio_path)}"
        if not audio_url:
            audio_url = f"/api/audio/{os.path.basename(audio_path)}"
    except Exception as e:
        print(f"[Broadcast] TTS 失败，降级文本模式: {e}")

    return {
        "success": True,
        "content": content,
        "audio_url": audio_url,
        "channel": req.channel,
        "year": req.year
    }


@app.post("/api/broadcast/content-only")
async def generate_content_only(req: BroadcastRequest):
    from ai_content import generate_broadcast_content
    content = await generate_broadcast_content(
        channel=req.channel,
        year=req.year,
        duration_minutes=req.duration
    )
    return {
        "success": True,
        "content": content,
        "channel": req.channel,
        "year": req.year
    }


@app.get("/api/audio/{filename}")
async def get_audio(filename: str):
    if AUDIO_STORAGE == "supabase":
        try:
            supabase = get_supabase()
            from supabase_client import get_public_url
            url = get_public_url(supabase, filename)
            return RedirectResponse(url=url)
        except Exception:
            pass

    file_path = os.path.join(TMP_DIR, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="音频文件不存在或已过期")

    media_type = "audio/mpeg" if filename.endswith(".mp3") else "audio/mp4"
    return FileResponse(file_path, media_type=media_type)

@app.get("/api/test-tts")
async def test_tts():
    try:
        from tts_service import text_to_speech
        path = await text_to_speech("测试语音合成", year=2020, output_filename="test.mp3")
        return {"success": True, "path": path, "exists": os.path.exists(path)}
    except Exception as e:
        import traceback
        return {"success": False, "error": str(e), "traceback": traceback.format_exc()}
