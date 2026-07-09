"""
Vercel Serverless 入口 - 老年收音机 AI 服务
将所有 API 路由合并到此单文件，适配 Vercel Python Runtime。
"""

import os
import sys
import io
import json
import uuid
from datetime import datetime

# 将 backend 目录加入路径，以便导入项目模块
BACKEND_DIR = os.path.join(os.path.dirname(__file__), "..", "backend")
sys.path.insert(0, BACKEND_DIR)

from fastapi import FastAPI, HTTPException, Query, UploadFile, File, Form, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, JSONResponse
from pydantic import BaseModel
from typing import Optional, List

from config import CHANNELS, BROADCASTER_VOICES
from ai_content import generate_broadcast_content, generate_ai_answer, detect_lead_intent
from tts_service import text_to_speech, list_available_voices
from voice_clone import (
    upload_voice_sample, train_custom_voice,
    list_custom_voices, get_preset_voice_packs, delete_custom_voice
)

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

# ---- 音频存储模式 ----
AUDIO_STORAGE = os.environ.get("AUDIO_STORAGE", "local")  # "local" | "supabase"
TMP_DIR = "/tmp"


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
    channel: Optional[str] = "chat"
    user_id: Optional[str] = "anonymous"
    session_id: Optional[str] = None


class VoiceTrainRequest(BaseModel):
    voice_id: str


# ============ 语音包 / 资源 / 对话 / 需求 数据模型 ============

class VoicePackPurchaseRequest(BaseModel):
    voice_pack_id: int
    user_id: Optional[str] = "anonymous"


class ResourceCreateRequest(BaseModel):
    title: str
    content: Optional[str] = ""
    era: str = "1980s"
    category: str = "news"
    summary: Optional[str] = ""
    audio_url: Optional[str] = None
    image_url: Optional[str] = None
    status: str = "draft"


class ResourceUpdateRequest(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    era: Optional[str] = None
    category: Optional[str] = None
    summary: Optional[str] = None
    audio_url: Optional[str] = None
    image_url: Optional[str] = None
    status: Optional[str] = None


class ResourceReviewRequest(BaseModel):
    status: str  # published | rejected
    reviewed_by: Optional[str] = "admin"


class ConversationCreateRequest(BaseModel):
    user_id: Optional[str] = "anonymous"
    session_id: Optional[str] = None
    channel: Optional[str] = "chat"
    era: Optional[str] = None
    role: str = "user"
    content: str = ""


class LeadCreateRequest(BaseModel):
    conversation_id: Optional[int] = None
    user_id: Optional[str] = "anonymous"
    lead_type: str = "咨询"
    priority: str = "中"
    description: str = ""
    status: str = "新建"
    notes: Optional[str] = None


class LeadUpdateRequest(BaseModel):
    lead_type: Optional[str] = None
    priority: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None
    notes: Optional[str] = None


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
    import asyncio

    answer = await generate_ai_answer(
        question=req.question,
        context=req.context or ""
    )

    # 记录对话到 Supabase
    session_id = req.session_id or str(uuid.uuid4())
    try:
        supabase = get_supabase()
        now = datetime.utcnow().isoformat()
        supabase.table("customer_conversations").insert({
            "user_id": req.user_id,
            "session_id": session_id,
            "channel": req.channel,
            "role": "user",
            "content": req.question,
            "created_at": now
        }).execute()
        supabase.table("customer_conversations").insert({
            "user_id": req.user_id,
            "session_id": session_id,
            "channel": req.channel,
            "role": "assistant",
            "content": answer,
            "created_at": datetime.utcnow().isoformat()
        }).execute()

        # 需求检测
        lead = detect_lead_intent(req.question)
        if lead:
            supabase.table("customer_leads").insert({
                "user_id": req.user_id,
                "lead_type": lead["lead_type"],
                "priority": lead["priority"],
                "description": lead["description"],
                "status": "新建",
                "created_at": now,
                "updated_at": now
            }).execute()
    except Exception as e:
        print(f"[Chat] 记录失败: {e}")

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
        "audio_url": audio_url,
        "session_id": session_id
    }


@app.post("/api/chat/text-only")
async def ai_chat_text(req: AIChatRequest):
    answer = await generate_ai_answer(
        question=req.question,
        context=req.context or ""
    )

    # 记录对话
    session_id = req.session_id or str(uuid.uuid4())
    try:
        supabase = get_supabase()
        now = datetime.utcnow().isoformat()
        supabase.table("customer_conversations").insert({
            "user_id": req.user_id,
            "session_id": session_id,
            "channel": req.channel,
            "role": "user",
            "content": req.question,
            "created_at": now
        }).execute()
        supabase.table("customer_conversations").insert({
            "user_id": req.user_id,
            "session_id": session_id,
            "channel": req.channel,
            "role": "assistant",
            "content": answer,
            "created_at": datetime.utcnow().isoformat()
        }).execute()

        lead = detect_lead_intent(req.question)
        if lead:
            supabase.table("customer_leads").insert({
                "user_id": req.user_id,
                "lead_type": lead["lead_type"],
                "priority": lead["priority"],
                "description": lead["description"],
                "status": "新建",
                "created_at": now,
                "updated_at": now
            }).execute()
    except Exception as e:
        print(f"[Chat] 记录失败: {e}")

    return {
        "success": True,
        "question": req.question,
        "answer": answer,
        "session_id": session_id
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


# ============ 语音包 API ============

@app.get("/api/voice-packs")
async def get_voice_packs():
    supabase = get_supabase()
    result = supabase.table("voice_packs").select("*").order("created_at", desc=True).execute()
    return result.data


@app.post("/api/voice-packs/purchase")
async def purchase_voice_pack(req: VoicePackPurchaseRequest):
    supabase = get_supabase()
    result = supabase.table("voice_packs").update({"is_purchased": True}).eq("id", req.voice_pack_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="语音包不存在")
    return {"success": True, "message": "购买成功"}


# ============ 资源管理 API ============

@app.get("/api/resources")
async def get_resources(
    era: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(50, le=100)
):
    supabase = get_supabase()
    query = supabase.table("resource_articles").select("*").order("created_at", desc=True).limit(limit)
    if era:
        query = query.eq("era", era)
    if category:
        query = query.eq("category", category)
    if status:
        query = query.eq("status", status)
    else:
        query = query.eq("status", "published")
    result = query.execute()
    return result.data


@app.get("/api/resources/{resource_id}")
async def get_resource(resource_id: int):
    supabase = get_supabase()
    result = supabase.table("resource_articles").select("*").eq("id", resource_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="资源不存在")
    return result.data[0]


@app.post("/api/resources")
async def create_resource(req: ResourceCreateRequest):
    supabase = get_supabase()
    data = req.model_dump()
    data["created_at"] = datetime.utcnow().isoformat()
    data["updated_at"] = data["created_at"]
    result = supabase.table("resource_articles").insert(data).execute()
    return {"success": True, "id": result.data[0]["id"] if result.data else None}


@app.put("/api/resources/{resource_id}")
async def update_resource(resource_id: int, req: ResourceUpdateRequest):
    supabase = get_supabase()
    update_data = {k: v for k, v in req.model_dump().items() if v is not None}
    update_data["updated_at"] = datetime.utcnow().isoformat()
    result = supabase.table("resource_articles").update(update_data).eq("id", resource_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="资源不存在")
    return {"success": True}


@app.delete("/api/resources/{resource_id}")
async def delete_resource(resource_id: int):
    supabase = get_supabase()
    result = supabase.table("resource_articles").delete().eq("id", resource_id).execute()
    return {"success": True}


@app.put("/api/resources/{resource_id}/review")
async def review_resource(resource_id: int, req: ResourceReviewRequest):
    supabase = get_supabase()
    update_data = {
        "status": req.status,
        "reviewed_by": req.reviewed_by,
        "updated_at": datetime.utcnow().isoformat()
    }
    result = supabase.table("resource_articles").update(update_data).eq("id", resource_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="资源不存在")
    return {"success": True, "status": req.status}


# ============ 对话记录 API ============

@app.get("/api/conversations")
async def get_conversations(
    channel: Optional[str] = Query(None),
    era: Optional[str] = Query(None),
    session_id: Optional[str] = Query(None),
    limit: int = Query(100, le=200)
):
    supabase = get_supabase()
    query = supabase.table("customer_conversations").select("*").order("created_at", desc=True).limit(limit)
    if channel:
        query = query.eq("channel", channel)
    if era:
        query = query.eq("era", era)
    if session_id:
        query = query.eq("session_id", session_id)
    result = query.execute()
    return result.data


@app.get("/api/conversations/{session_id}")
async def get_conversation_detail(session_id: str):
    supabase = get_supabase()
    result = supabase.table("customer_conversations").select("*").eq("session_id", session_id).order("created_at").execute()
    return result.data


@app.post("/api/conversations")
async def create_conversation(req: ConversationCreateRequest):
    supabase = get_supabase()
    sid = req.session_id or str(uuid.uuid4())
    data = {
        "user_id": req.user_id,
        "session_id": sid,
        "channel": req.channel,
        "era": req.era,
        "role": req.role,
        "content": req.content,
        "created_at": datetime.utcnow().isoformat()
    }
    result = supabase.table("customer_conversations").insert(data).execute()
    return {"success": True, "session_id": sid, "id": result.data[0]["id"] if result.data else None}


# ============ 客户需求 API ============

@app.get("/api/leads")
async def get_leads(
    status: Optional[str] = Query(None),
    priority: Optional[str] = Query(None),
    limit: int = Query(100, le=200)
):
    supabase = get_supabase()
    query = supabase.table("customer_leads").select("*").order("created_at", desc=True).limit(limit)
    if status:
        query = query.eq("status", status)
    if priority:
        query = query.eq("priority", priority)
    result = query.execute()
    return result.data


@app.put("/api/leads/{lead_id}")
async def update_lead(lead_id: int, req: LeadUpdateRequest):
    supabase = get_supabase()
    update_data = {k: v for k, v in req.model_dump().items() if v is not None}
    update_data["updated_at"] = datetime.utcnow().isoformat()
    result = supabase.table("customer_leads").update(update_data).eq("id", lead_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="需求不存在")
    return {"success": True}


@app.post("/api/leads")
async def create_lead(req: LeadCreateRequest):
    supabase = get_supabase()
    data = req.model_dump()
    data["created_at"] = datetime.utcnow().isoformat()
    data["updated_at"] = data["created_at"]
    result = supabase.table("customer_leads").insert(data).execute()
    return {"success": True, "id": result.data[0]["id"] if result.data else None}


@app.get("/api/leads/stats")
async def get_lead_stats():
    supabase = get_supabase()
    result = supabase.table("customer_leads").select("status, priority, lead_type").execute()
    data = result.data or []
    total = len(data)
    status_counts = {}
    priority_counts = {}
    type_counts = {}
    for item in data:
        s = item.get("status", "未知")
        p = item.get("priority", "未知")
        t = item.get("lead_type", "未知")
        status_counts[s] = status_counts.get(s, 0) + 1
        priority_counts[p] = priority_counts.get(p, 0) + 1
        type_counts[t] = type_counts.get(t, 0) + 1
    return {
        "total": total,
        "by_status": status_counts,
        "by_priority": priority_counts,
        "by_type": type_counts
    }


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
