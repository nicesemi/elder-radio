"""
Vercel Serverless 入口 - 老年收音机 AI 服务
将所有 API 路由合并到此单文件，适配 Vercel Python Runtime。
"""

import os
import sys
import io

# 将 backend 目录加入路径，以便导入项目模块
BACKEND_DIR = os.path.join(os.path.dirname(__file__), "..", "backend")
sys.path.insert(0, BACKEND_DIR)

from fastapi import FastAPI, HTTPException, Query, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel
from typing import Optional

from config import CHANNELS, BROADCASTER_VOICES
from ai_content import generate_broadcast_content, generate_ai_answer
from tts_service import text_to_speech, list_available_voices
from voice_clone import (
    upload_voice_sample, train_custom_voice,
    list_custom_voices, get_preset_voice_packs, delete_custom_voice
)

# ---- 音频存储模式 ----
AUDIO_STORAGE = os.environ.get("AUDIO_STORAGE", "local")  # "local" | "supabase"
TMP_DIR = "/tmp"

# ---- Supabase 客户端（延迟初始化） ----
_supabase_client = None

def get_supabase():
    global _supabase_client
    if _supabase_client is None:
        from supabase_client import init_supabase
        _supabase_client = init_supabase()
    return _supabase_client


app = FastAPI(
    title="老年收音机AI服务",
    description="为老年人提供的AI收音机与对讲服务 - Vercel Serverless 版",
    version="2.0.0"
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


class VoiceTrainRequest(BaseModel):
    voice_id: str


# ============ 频道与音色 ============

@app.get("/api/channels")
async def get_channels():
    return {
        "channels": [
            {"id": k, "name": v["name"], "icon": v["icon"]}
            for k, v in CHANNELS.items()
        ]
    }


@app.get("/api/voices")
async def get_voices():
    return {"voices": list_available_voices()}


# ============ 收音机广播 ============

@app.post("/api/broadcast/generate")
async def generate_broadcast(req: BroadcastRequest):
    # 1. AI 生成广播稿
    content = await generate_broadcast_content(
        channel=req.channel,
        year=req.year,
        duration_minutes=req.duration
    )

    # 2. TTS 合成语音
    output_filename = f"broadcast_{req.channel}_{req.year}.mp3"
    audio_path = await text_to_speech(
        text=content,
        year=req.year,
        output_filename=output_filename
    )

    # 3. 如果启用 Supabase 存储，上传音频
    audio_url = None
    if AUDIO_STORAGE == "supabase":
        try:
            supabase = get_supabase()
            from supabase_client import upload_audio_to_supabase, get_public_url
            filename = os.path.basename(audio_path)
            upload_audio_to_supabase(supabase, audio_path, filename)
            audio_url = get_public_url(supabase, filename)
        except Exception as e:
            # Supabase 上传失败时降级为本地 URL
            audio_url = f"/api/audio/{os.path.basename(audio_path)}"

    if not audio_url:
        audio_url = f"/api/audio/{os.path.basename(audio_path)}"

    return {
        "success": True,
        "content": content,
        "audio_url": audio_url,
        "channel": req.channel,
        "year": req.year
    }


@app.post("/api/broadcast/content-only")
async def generate_content_only(req: BroadcastRequest):
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
    # Supabase 模式：重定向到 Supabase 公开 URL
    if AUDIO_STORAGE == "supabase":
        try:
            supabase = get_supabase()
            from supabase_client import get_public_url
            url = get_public_url(supabase, filename)
            return RedirectResponse(url=url)
        except Exception:
            pass

    # 本地模式：从 /tmp 读取
    file_path = os.path.join(TMP_DIR, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="音频文件不存在或已过期")

    media_type = "audio/mpeg" if filename.endswith(".mp3") else "audio/mp4"
    return FileResponse(file_path, media_type=media_type)


# ============ AI 对讲 ============

@app.post("/api/chat")
async def ai_chat(req: AIChatRequest):
    answer = await generate_ai_answer(
        question=req.question,
        context=req.context or ""
    )

    audio_path = await text_to_speech(
        text=answer,
        year=2020,
        output_filename="chat_reply.mp3"
    )

    audio_url = f"/api/audio/{os.path.basename(audio_path)}"

    if AUDIO_STORAGE == "supabase":
        try:
            supabase = get_supabase()
            from supabase_client import upload_audio_to_supabase, get_public_url
            filename = os.path.basename(audio_path)
            upload_audio_to_supabase(supabase, audio_path, filename)
            audio_url = get_public_url(supabase, filename)
        except Exception:
            pass

    return {
        "success": True,
        "question": req.question,
        "answer": answer,
        "audio_url": audio_url
    }


@app.post("/api/chat/text-only")
async def ai_chat_text(req: AIChatRequest):
    answer = await generate_ai_answer(
        question=req.question,
        context=req.context or ""
    )
    return {
        "success": True,
        "question": req.question,
        "answer": answer
    }


# ============ 声音管理 ============

@app.post("/api/voice/upload")
async def upload_voice(
    audio: UploadFile = File(...),
    speaker_name: str = Form("自定义声音")
):
    audio_data = await audio.read()
    result = await upload_voice_sample(
        audio_data=audio_data,
        filename=audio.filename or "sample.wav",
        speaker_name=speaker_name
    )
    return {"success": True, "voice": result}


@app.post("/api/voice/train")
async def train_voice(req: VoiceTrainRequest):
    result = await train_custom_voice(req.voice_id)
    return {"success": True, "voice": result}


@app.get("/api/voice/custom")
async def get_custom_voices():
    return {"voices": list_custom_voices()}


@app.get("/api/voice/presets")
async def get_presets():
    return {"packs": get_preset_voice_packs()}


@app.delete("/api/voice/{voice_id}")
async def remove_voice(voice_id: str):
    success = delete_custom_voice(voice_id)
    if not success:
        raise HTTPException(status_code=404, detail="声音不存在")
    return {"success": True}


# ============ 健康检查 ============

@app.get("/api/health")
async def health_check():
    return {
        "status": "ok",
        "service": "老年收音机AI服务",
        "version": "2.0.0",
        "deployment": "vercel-serverless",
        "audio_storage": AUDIO_STORAGE
    }
