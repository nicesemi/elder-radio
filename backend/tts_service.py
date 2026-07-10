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
    文字转语音 - 使用 Edge-TTS（云端免费 TTS）

    Args:
        text: 要合成的文本
        year: 目标年代（用于自动选择音色）
        voice_id: 指定音色ID（可选，覆盖年代自动选择）
        output_filename: 输出文件名（可选）

    Returns:
        生成的 MP3 文件绝对路径
    """
    import edge_tts

    voice_config = get_voice_for_era(year)

    # 确定使用的 Edge-TTS 语音名称
    if voice_id:
        tts_voice = voice_id
    else:
        era = _get_era_key(year)
        tts_voice = ERA_VOICE_ID_MAP.get(era, "zh-CN-YunxiNeural")

    # 语速控制：Edge-TTS rate 用百分比字符串
    speed = voice_config.get("speed", 1.0)
    rate_str = _build_rate_string(speed)

    # 音高控制
    pitch = voice_config.get("pitch", "+0Hz")

    if not output_filename:
        import time
        output_filename = f"broadcast_{year}_{int(time.time())}.mp3"

    # 确保输出为 .mp3
    base_name = os.path.splitext(output_filename)[0]
    mp3_path = os.path.join(TMP_DIR, f"{base_name}.mp3")

    # 使用 Edge-TTS 生成 MP3
    communicate = edge_tts.Communicate(
        text=text,
        voice=tts_voice,
        rate=rate_str,
        pitch=pitch
    )
    await communicate.save(mp3_path)

    return mp3_path


async def text_to_speech_streaming(text: str, year: int = 1980) -> bytes:
    """
    流式文字转语音 - 使用 Edge-TTS 返回音频字节

    Args:
        text: 要合成的文本
        year: 目标年代

    Returns:
        MP3 音频数据（bytes）
    """
    import edge_tts

    voice_config = get_voice_for_era(year)
    era = _get_era_key(year)
    tts_voice = ERA_VOICE_ID_MAP.get(era, "zh-CN-YunxiNeural")
    speed = voice_config.get("speed", 1.0)
    rate_str = _build_rate_string(speed)
    pitch = voice_config.get("pitch", "+0Hz")

    communicate = edge_tts.Communicate(
        text=text,
        voice=tts_voice,
        rate=rate_str,
        pitch=pitch
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
