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
    文字转语音 - 优先百度 TTS（国内稳定），降级 Google / Edge-TTS / Agnes

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

    # 方案0: 百度 TTS（国内可用，零延迟，用同一组 ASR 凭据）
    baidu_api_key = os.environ.get("BAIDU_ASR_API_KEY", "8uI2b3PTjmEtN9jmIpJlVnai")
    baidu_secret = os.environ.get("BAIDU_ASR_SECRET_KEY", "L6vQGOzNs1cMFt7r5rLApJH5ru0rjfa2")
    if baidu_api_key and baidu_secret:
        try:
            await _baidu_tts(text, year, mp3_path, baidu_api_key, baidu_secret)
            return mp3_path
        except Exception as e:
            print(f"[TTS] Baidu TTS 失败 ({e}), 降级 Google...")

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


async def _baidu_get_token(api_key: str, secret_key: str) -> str:
    """获取百度 API access_token（缓存 24h 在模块级变量中）"""
    global _baidu_token_cache
    now = __import__("time").time()
    if hasattr(_baidu_get_token, "_expire") and now < _baidu_get_token._expire:
        return _baidu_get_token._cached

    import httpx
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            "https://aip.baidubce.com/oauth/2.0/token",
            params={
                "grant_type": "client_credentials",
                "client_id": api_key,
                "client_secret": secret_key
            }
        )
    resp.raise_for_status()
    data = resp.json()
    token = data.get("access_token", "")
    _baidu_get_token._cached = token
    _baidu_get_token._expire = now + data.get("expires_in", 86400) - 300  # 提前5分钟刷新
    return token


async def _baidu_tts(text: str, year: int, output_path: str, api_key: str, secret_key: str) -> None:
    """百度 TTS - 长文本分段合成后拼接为 MP3"""
    import httpx
    import urllib.parse

    app_id = os.environ.get("BAIDU_ASR_APP_ID", "7916408")
    token = await _baidu_get_token(api_key, secret_key)

    # 百度 TTS 单次限制 1024 字节（UTF-8），约 340 个中文字
    max_bytes = 900  # 留一点余量
    chunks = []
    remaining = text
    while remaining:
        # 找到安全的截断点
        test = remaining.encode("utf-8")
        if len(test) <= max_bytes:
            chunks.append(remaining)
            break
        cut = max_bytes
        while cut > 0 and (test[cut] & 0xC0) == 0x80:
            cut -= 1
        # 在句号处断句
        snippet = test[:cut].decode("utf-8", errors="ignore")
        last_period = max(snippet.rfind("。"), snippet.rfind("，"), snippet.rfind("\n"))
        if last_period > 50:
            cut = len(snippet[:last_period+1].encode("utf-8"))
        chunks.append(test[:cut].decode("utf-8", errors="ignore"))
        remaining = test[cut:].decode("utf-8", errors="ignore")

    async with httpx.AsyncClient(timeout=30.0) as client:
        audio_parts = []
        for chunk in chunks:
            params = {
                "tex": chunk,
                "tok": token,
                "cuid": app_id,
                "ctp": "1",
                "lan": "zh",
                "spd": "5",   # 语速 0-15，5 为正常
                "pit": "5",   # 音调
                "vol": "5",   # 音量
                "per": "0",   # 0=普通女声（度小美）
                "aue": "3",   # mp3
            }
            encoded = urllib.parse.urlencode(params)
            resp = await client.post(
                "https://tsn.baidu.com/text2audio",
                content=encoded.encode(),
                headers={"Content-Type": "application/x-www-form-urlencoded"}
            )
            # 百度 TTS：成功返回 audio/mp3，失败返回 application/json
            content_type = resp.headers.get("content-type", "")
            if "json" in content_type:
                err = resp.json()
                raise Exception(f"Baidu TTS error: {err}")
            audio_parts.append(resp.content)

    with open(output_path, "wb") as f:
        for part in audio_parts:
            f.write(part)


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
    流式文字转语音 - 优先百度 TTS，降级 Google / Edge-TTS
    """
    # 百度 TTS
    baidu_api_key = os.environ.get("BAIDU_ASR_API_KEY", "8uI2b3PTjmEtN9jmIpJlVnai")
    baidu_secret = os.environ.get("BAIDU_ASR_SECRET_KEY", "L6vQGOzNs1cMFt7r5rLApJH5ru0rjfa2")
    if baidu_api_key and baidu_secret:
        try:
            import tempfile
            tmp = os.path.join(TMP_DIR, f"_stream_{int(__import__('time').time())}.mp3")
            await _baidu_tts(text[:500], year, tmp, baidu_api_key, baidu_secret)
            with open(tmp, "rb") as f:
                data = f.read()
            os.remove(tmp)
            return data
        except Exception:
            pass

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
