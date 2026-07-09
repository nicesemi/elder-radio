"""
TTS 语音合成服务 - Edge-TTS 云端引擎
支持年代感播音员音色，输出 MP3 格式。
完全替代 macOS say 命令，适配 Vercel Serverless 环境。
"""

import asyncio
import os
import tempfile
from config import BROADCASTER_VOICES

# 音频输出目录：Vercel 环境使用 /tmp，本地开发使用项目目录
TMP_DIR = "/tmp" if os.path.exists("/tmp") else tempfile.gettempdir()


# 年代 → Edge-TTS 语音映射（与 config.py BROADCASTER_VOICES 对应）
ERA_VOICE_ID_MAP = {
    era: cfg["voice_id"] for era, cfg in BROADCASTER_VOICES.items()
}


def get_voice_for_era(year: int) -> dict:
    """根据年份获取对应年代的播音员音色配置"""
    if year < 1960:
        era = "1950s"
    elif year < 1970:
        era = "1960s"
    elif year < 1980:
        era = "1970s"
    elif year < 1990:
        era = "1980s"
    elif year < 2000:
        era = "1990s"
    elif year < 2010:
        era = "2000s"
    elif year < 2020:
        era = "2010s"
    else:
        era = "2020s"
    return BROADCASTER_VOICES.get(era, BROADCASTER_VOICES["2020s"])


async def text_to_speech(
    text: str,
    year: int = 1980,
    voice_id: str = None,
    output_filename: str = None
) -> str:
    """
    文字转语音 - 优先 Google Translate TTS（免费稳定），降级 Edge-TTS / Agnes

    Args:
        text: 要合成的文本
        year: 目标年代
        voice_id: 指定音色ID（可选）
        output_filename: 输出文件名（可选）

    Returns:
        生成的 MP3 文件绝对路径
    """
    import time
    if not output_filename:
        output_filename = f"broadcast_{year}_{int(time.time())}.mp3"

    base_name = os.path.splitext(output_filename)[0]
    mp3_path = os.path.join(TMP_DIR, f"{base_name}.mp3")

    # 方案1: Google Translate TTS（零配置，全球稳定）
    try:
        await _google_tts(text, mp3_path)
        return mp3_path
    except Exception as e:
        print(f"[TTS] Google TTS 失败 ({e}), 尝试 Edge-TTS...")

    # 方案2: Edge-TTS
    try:
        await _edge_tts(text, year, voice_id, mp3_path)
        return mp3_path
    except Exception as e:
        print(f"[TTS] Edge-TTS 失败 ({e}), 尝试 Agnes...")

    # 方案3: Agnes TTS
    await _agnes_tts_fallback(text, mp3_path)
    return mp3_path


async def _google_tts(text: str, output_path: str) -> None:
    """Google Translate TTS - 免费、零依赖、全球可用"""
    import httpx
    import urllib.parse

    # 文本长度限制：Google TTS 单次最多约 200 字符，长文本分段
    max_len = 200
    if len(text) <= max_len:
        chunks = [text]
    else:
        # 按句号分段，避免截断词语
        chunks = []
        remaining = text
        while len(remaining) > max_len:
            split_at = remaining.rfind('。', 0, max_len)
            if split_at == -1:
                split_at = remaining.rfind('，', 0, max_len)
            if split_at == -1 or split_at < 50:
                split_at = max_len
            else:
                split_at += 1  # 包含标点
            chunks.append(remaining[:split_at])
            remaining = remaining[split_at:]
        if remaining:
            chunks.append(remaining)

    audio_parts = []
    async with httpx.AsyncClient(timeout=30.0) as client:
        for chunk in chunks:
            encoded = urllib.parse.quote(chunk)
            url = f"https://translate.google.com/translate_tts?ie=UTF-8&tl=zh-CN&client=tw-ob&q={encoded}"
            resp = await client.get(url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            })
            resp.raise_for_status()
            audio_parts.append(resp.content)

    with open(output_path, "wb") as f:
        for part in audio_parts:
            f.write(part)


async def _edge_tts(text: str, year: int, voice_id: str, output_path: str) -> None:
    """Edge-TTS 生成"""
    import edge_tts

    voice_config = get_voice_for_era(year)
    if voice_id:
        tts_voice = voice_id
    else:
        era = _get_era_key(year)
        tts_voice = ERA_VOICE_ID_MAP.get(era, "zh-CN-YunxiNeural")

    speed = voice_config.get("speed", 1.0)
    rate_str = _build_rate_string(speed)
    pitch = voice_config.get("pitch", "+0Hz")

    communicate = edge_tts.Communicate(
        text=text, voice=tts_voice, rate=rate_str, pitch=pitch
    )
    await communicate.save(output_path)


async def text_to_speech_streaming(text: str, year: int = 1980) -> bytes:
    """
    流式文字转语音 - 优先 Google TTS，降级 Edge-TTS
    """
    # Google TTS 流式
    try:
        import httpx
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                f"https://translate.google.com/translate_tts?ie=UTF-8&tl=zh-CN&client=tw-ob&q={text[:200]}",
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
            )
            resp.raise_for_status()
            return resp.content
    except Exception:
        pass

    # Edge-TTS 降级
    import edge_tts
    voice_config = get_voice_for_era(year)
    era = _get_era_key(year)
    tts_voice = ERA_VOICE_ID_MAP.get(era, "zh-CN-YunxiNeural")
    speed = voice_config.get("speed", 1.0)
    rate_str = _build_rate_string(speed)
    pitch = voice_config.get("pitch", "+0Hz")

    communicate = edge_tts.Communicate(
        text=text, voice=tts_voice, rate=rate_str, pitch=pitch
    )
    chunks = []
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            chunks.append(chunk["data"])
    return b"".join(chunks)


def _get_era_key(year: int) -> str:
    """根据年份返回年代 key"""
    if year < 1960:
        return "1950s"
    elif year < 1970:
        return "1960s"
    elif year < 1980:
        return "1970s"
    elif year < 1990:
        return "1980s"
    elif year < 2000:
        return "1990s"
    elif year < 2010:
        return "2000s"
    elif year < 2020:
        return "2010s"
    return "2020s"


def _build_rate_string(speed: float) -> str:
    """将 speed 倍率转为 Edge-TTS rate 字符串"""
    if speed == 1.0:
        return "+0%"
    elif speed > 1.0:
        return f"+{int((speed - 1.0) * 100)}%"
    else:
        return f"-{int((1.0 - speed) * 100)}%"


def list_available_voices():
    """列出可用的播音员音色"""
    return [
        {
            "era": era,
            "name": cfg["name"],
            "description": cfg["description"],
            "voice_id": cfg["voice_id"]
        }
        for era, cfg in BROADCASTER_VOICES.items()
    ]


async def _agnes_tts_fallback(text: str, output_path: str) -> None:
    """Agnes AI TTS 降级方案"""
    import httpx
    from config import AGNES_BASE_URL, AGNES_API_KEY, AGNES_TTS_MODEL

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            f"{AGNES_BASE_URL}/audio/speech",
            headers={
                "Authorization": f"Bearer {AGNES_API_KEY}",
                "Content-Type": "application/json"
            },
            json={
                "model": AGNES_TTS_MODEL,
                "input": text,
                "voice": "alloy",
                "response_format": "mp3",
                "speed": 1.0
            }
        )
        resp.raise_for_status()
        with open(output_path, "wb") as f:
            f.write(resp.content)
