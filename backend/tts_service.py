"""
TTS 语音合成服务 - 支持年代感播音员声音
使用 macOS say 命令作为主力引擎（离线可用）
"""

import asyncio
import os
import subprocess
import tempfile
from config import BROADCASTER_VOICES


# 音频输出目录
AUDIO_DIR = os.path.join(os.path.dirname(__file__), "audio_output")
os.makedirs(AUDIO_DIR, exist_ok=True)


# macOS 年代 → say 语音映射
ERA_VOICE_MAP = {
    "1950s": "Tingting",   # 普通话女声
    "1960s": "Tingting",
    "1970s": "Tingting",
    "1980s": "Tingting",
    "1990s": "Tingting",
    "2000s": "Tingting",
    "2010s": "Tingting",
    "2020s": "Tingting",
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


def _sanitize_text(text: str) -> str:
    """清理文本中可能导致 say 命令失败的特殊字符"""
    # 转义双引号
    text = text.replace('"', "'")
    # 移除可能导致问题的控制字符
    import re
    text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', text)
    return text


async def text_to_speech(
    text: str,
    year: int = 1980,
    voice_id: str = None,
    output_filename: str = None
) -> str:
    """
    文字转语音 - 使用 macOS say 命令

    Args:
        text: 要合成的文本
        year: 目标年代（用于自动选择音色）
        voice_id: 指定音色ID（可选，覆盖年代自动选择）
        output_filename: 输出文件名（可选）

    Returns:
        生成的音频文件路径
    """
    voice_config = get_voice_for_era(year)

    # 确定使用的语音
    if voice_id:
        say_voice = voice_id
    else:
        era = _get_era_key(year)
        say_voice = ERA_VOICE_MAP.get(era, "Tingting")

    # 语速控制：通过 say 命令的 -r 参数（词/分钟，默认约 180）
    speed = voice_config.get("speed", 1.0)
    rate = int(180 * speed)

    if not output_filename:
        output_filename = f"broadcast_{year}_{int(asyncio.get_event_loop().time())}"

    # 去掉调用方可能传入的扩展名
    base_name = os.path.splitext(output_filename)[0]
    aiff_path = os.path.join(AUDIO_DIR, f"{base_name}.aiff")

    clean_text = _sanitize_text(text)

    # macOS say 输出 .aiff 格式 - 通过临时文件避免命令行限制
    import tempfile as _tmp
    with _tmp.NamedTemporaryFile(mode='w', suffix='.txt', delete=False, encoding='utf-8') as tf:
        tf.write(clean_text)
        text_file_path = tf.name

    cmd = ["say", "-v", say_voice, "-r", str(rate), "-o", aiff_path, "-f", text_file_path]

    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None,
        lambda: subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    )

    # 清理临时文本文件
    try:
        os.remove(text_file_path)
    except OSError:
        pass

    if result.returncode != 0:
        raise RuntimeError(f"say 命令失败 (exit {result.returncode}): {result.stderr}")

    # 实际输出可能是 aiff_path 或 aiff_path + ".aiff"（say 自动追加的情况）
    actual_aiff = aiff_path
    if not os.path.exists(aiff_path) and os.path.exists(aiff_path + ".aiff"):
        actual_aiff = aiff_path + ".aiff"

    if not os.path.exists(actual_aiff):
        raise RuntimeError(f"say 命令未能生成音频文件")

    # 转换为 M4A (AAC) - afconvert 原生支持
    m4a_path = os.path.join(AUDIO_DIR, f"{base_name}.m4a")
    convert_cmd = ["afconvert", "-f", "m4af", "-d", "aac", "-q", "127", actual_aiff, m4a_path]
    await loop.run_in_executor(
        None,
        lambda: subprocess.run(convert_cmd, capture_output=True, text=True, timeout=60)
    )

    # 清理 .aiff 中间文件
    os.remove(actual_aiff)

    return m4a_path


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


async def text_to_speech_streaming(text: str, year: int = 1980) -> bytes:
    """
    流式文字转语音 - 使用 macOS say 命令输出到 stdout
    """
    voice_config = get_voice_for_era(year)
    era = _get_era_key(year)
    say_voice = ERA_VOICE_MAP.get(era, "Tingting")
    speed = voice_config.get("speed", 1.0)
    rate = int(180 * speed)

    clean_text = _sanitize_text(text)

    # 输出 aiff 到临时文件再读回（say 不支持 stdout 直接输出音频）
    with tempfile.NamedTemporaryFile(suffix=".aiff", delete=False) as tmp:
        tmp_path = tmp.name

    with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False, encoding='utf-8') as tf:
        tf.write(clean_text)
        text_file_path = tf.name

    cmd = ["say", "-v", say_voice, "-r", str(rate), "-o", tmp_path, "-f", text_file_path]
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(
        None,
        lambda: subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    )

    try:
        os.remove(text_file_path)
    except OSError:
        pass

    with open(tmp_path, "rb") as f:
        audio_data = f.read()

    os.remove(tmp_path)
    return audio_data


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
