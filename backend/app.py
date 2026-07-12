"""
主服务 - FastAPI 后端
提供收音机广播、AI对讲、声音管理等功能
"""

import os
import sys

# 确保项目根目录在路径中
sys.path.insert(0, os.path.dirname(__file__))

from fastapi import FastAPI, HTTPException, Query, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional
import io
import httpx

from config import SERVER_HOST, SERVER_PORT, CHANNELS, AGNES_BASE_URL, AGNES_API_KEY, AGNES_MODEL
from ai_content import generate_broadcast_content, generate_ai_answer
from tts_service import text_to_speech, list_available_voices, get_voice_for_era
from voice_clone import (
    upload_voice_sample, train_custom_voice,
    list_custom_voices, get_preset_voice_packs, delete_custom_voice
)

app = FastAPI(
    title="老年收音机AI服务",
    description="为老年人提供的AI收音机与对讲服务",
    version="1.0.0"
)

# CORS 配置
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


# ============ 收音机广播 API ============

@app.get("/api/channels")
async def get_channels():
    """获取所有频道列表"""
    return {
        "channels": [
            {"id": k, "name": v["name"], "icon": v["icon"]}
            for k, v in CHANNELS.items()
        ]
    }


@app.get("/api/voices")
async def get_voices():
    """获取所有可用播音员音色"""
    return {"voices": list_available_voices()}


@app.post("/api/broadcast/generate")
async def generate_broadcast(req: BroadcastRequest):
    """生成广播内容并合成语音"""
    # 1. AI 生成广播稿
    content = await generate_broadcast_content(
        channel=req.channel,
        year=req.year,
        duration_minutes=req.duration
    )

    # 2. TTS 合成语音
    audio_path = await text_to_speech(
        text=content,
        year=req.year,
        output_filename=f"broadcast_{req.channel}_{req.year}.m4a"
    )

    return {
        "success": True,
        "content": content,
        "audio_url": f"/api/audio/{os.path.basename(audio_path)}",
        "channel": req.channel,
        "year": req.year
    }


@app.post("/api/broadcast/content-only")
async def generate_content_only(req: BroadcastRequest):
    """仅生成广播稿文本（不合成语音）"""
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
    """获取生成的音频文件"""
    audio_dir = os.path.join(os.path.dirname(__file__), "audio_output")
    file_path = os.path.join(audio_dir, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="音频文件不存在")
    # 根据扩展名设置正确的 MIME 类型
    if filename.endswith(".m4a"):
        media_type = "audio/mp4"
    else:
        media_type = "audio/mpeg"
    return FileResponse(file_path, media_type=media_type)


# ============ AI 对讲 API ============

@app.post("/api/chat")
async def ai_chat(req: AIChatRequest):
    """AI 对讲 - 回答用户问题"""
    answer = await generate_ai_answer(
        question=req.question,
        context=req.context or ""
    )

    # 同时合成语音回答
    audio_path = await text_to_speech(
        text=answer,
        year=2020,
        output_filename=f"chat_reply.mp3"
    )

    return {
        "success": True,
        "question": req.question,
        "answer": answer,
        "audio_url": f"/api/audio/{os.path.basename(audio_path)}"
    }


@app.post("/api/chat/text-only")
async def ai_chat_text(req: AIChatRequest):
    """AI 对讲 - 仅文本模式"""
    answer = await generate_ai_answer(
        question=req.question,
        context=req.context or ""
    )
    return {
        "success": True,
        "question": req.question,
        "answer": answer
    }


class AgnesProxyRequest(BaseModel):
    text: str
    context: Optional[str] = ""


@app.post("/api/agnes/proxy")
async def agnes_proxy(req: AgnesProxyRequest):
    """Agnes AI 代理 — 接收用户语音转写的文本，返回 AI 文字回应。"""
    if not AGNES_API_KEY:
        raise HTTPException(status_code=500, detail="AGNES_API_KEY 未配置")

    system_prompt = (
        "你叫 Agnes，是一个温暖贴心的 AI 语音助手，嵌入在老年人收音机对讲机中。"
        "你的任务是根据对讲频道中的语境，给出一句简短、自然、口语化的语音回应。"
        "规则："
        "1. 回复控制在 1-3 句话、60 字以内，像对讲机里朋友聊天一样自然。"
        "2. 用亲切、耐心的语气，称呼对方为「你」。"
        "3. 可以适当加入老人喜欢的谚语或俗语。"
        "4. 如果对方只是说「喂」「有人在吗」之类试探性的话，友好地回应打招呼。"
        "5. 永远用纯文本回复，不要加任何格式或标记。"
    )

    messages = [{"role": "system", "content": system_prompt}]
    if req.context:
        messages.append({"role": "user", "content": f"频道上下文：{req.context}"})
    messages.append({"role": "user", "content": req.text})

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"{AGNES_BASE_URL}/chat/completions",
            headers={
                "Authorization": f"Bearer {AGNES_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": AGNES_MODEL,
                "messages": messages,
                "temperature": 0.8,
                "max_tokens": 120,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        reply = data["choices"][0]["message"]["content"].strip()
        return {"success": True, "reply": reply}


# ============ 声音管理 API ============

@app.post("/api/voice/upload")
async def upload_voice(
    audio: UploadFile = File(...),
    speaker_name: str = Form("自定义声音")
):
    """上传语音样本"""
    audio_data = await audio.read()
    result = await upload_voice_sample(
        audio_data=audio_data,
        filename=audio.filename or "sample.wav",
        speaker_name=speaker_name
    )
    return {"success": True, "voice": result}


@app.post("/api/voice/train")
async def train_voice(req: VoiceTrainRequest):
    """训练个性化声音模型"""
    result = await train_custom_voice(req.voice_id)
    return {"success": True, "voice": result}


@app.get("/api/voice/custom")
async def get_custom_voices():
    """获取所有自定义声音"""
    return {"voices": list_custom_voices()}


@app.get("/api/voice/presets")
async def get_presets():
    """获取预设声音包"""
    return {"packs": get_preset_voice_packs()}


@app.delete("/api/voice/{voice_id}")
async def remove_voice(voice_id: str):
    """删除自定义声音"""
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
        "version": "1.0.0"
    }


# ============ 静态文件服务（前端） ============

frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.exists(frontend_dir):
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")


# ============ 启动入口 ============

if __name__ == "__main__":
    import uvicorn
    print(f"""
╔══════════════════════════════════════════╗
║     老年收音机 AI 服务 v1.0.0           ║
║     Elder Radio AI Service              ║
╠══════════════════════════════════════════╣
║  API 地址: http://{SERVER_HOST}:{SERVER_PORT}     ║
║  API 文档: http://{SERVER_HOST}:{SERVER_PORT}/docs ║
╚══════════════════════════════════════════╝
    """)
    uvicorn.run(
        "app:app",
        host=SERVER_HOST,
        port=SERVER_PORT,
        reload=True,
        log_level="info"
    )
