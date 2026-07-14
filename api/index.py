"""
Vercel Serverless 入口 - 老年收音机 AI 服务
将所有 API 路由合并到此单文件，适配 Vercel Python Runtime。
使用懒加载避免顶层导入触发只读文件系统错误。
"""

import os
import sys

# Vercel serverless: ensure api/ directory is on Python path for _lib imports
sys.path.insert(0, os.path.dirname(__file__))

import io
import json
import ast
import uuid
import time
import re
import urllib.request
import urllib.parse
from datetime import datetime

LIB_DIR = os.path.join(os.path.dirname(__file__), "_lib")
sys.path.insert(0, LIB_DIR)

from fastapi import FastAPI, HTTPException, Query, UploadFile, File, Form, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, JSONResponse
from pydantic import BaseModel
from typing import Optional, List, Dict, Any

# ---- 懒加载：避免顶层导入触发 voice_clone 的 os.makedirs ----

_CHANNELS = None
_BROADCASTER_VOICES = None
_r2_broadcast = None
_live_stations = None

def _get_channels():
    global _CHANNELS, _BROADCASTER_VOICES
    if _CHANNELS is None:
        from config import CHANNELS, BROADCASTER_VOICES
        _CHANNELS = CHANNELS
        _BROADCASTER_VOICES = BROADCASTER_VOICES
    return _CHANNELS, _BROADCASTER_VOICES

def _get_r2():
    global _r2_broadcast
    if _r2_broadcast is None:
        from _lib import r2_broadcast
        _r2_broadcast = r2_broadcast
    return _r2_broadcast

def _get_live_stations():
    global _live_stations
    if _live_stations is None:
        from _lib import live_stations
        _live_stations = live_stations
    return _live_stations

# Supabase 客户端（延迟初始化）
_supabase_client = None

# 全年代广播概览缓存（5 分钟 TTL）
_broadcast_summary_cache: Optional[Dict[str, Any]] = None
_broadcast_summary_cache_time: float = 0.0
_BROADCAST_SUMMARY_CACHE_TTL: int = 300

# 小说频道外部专辑链接（年份 -> 喜马拉雅/其他平台链接）
NOVEL_EXTERNAL_LINKS: Dict[int, str] = {
    1949: "https://www.ximalaya.com/album/9044282",
}

import json as _json
import os as _os

_NOVEL_TRACKS_CACHE: Dict[int, list] = {}

def _load_novel_tracks(year: int) -> list:
    if year not in _NOVEL_TRACKS_CACHE:
        tracks_path = _os.path.join(_os.path.dirname(__file__), '..', 'data', f'novel_tracks_{year}.json')
        if _os.path.exists(tracks_path):
            with open(tracks_path, 'r', encoding='utf-8') as f:
                _NOVEL_TRACKS_CACHE[year] = _json.load(f)
        else:
            _NOVEL_TRACKS_CACHE[year] = []
    return _NOVEL_TRACKS_CACHE[year]

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
    """AI 生成广播内容，优先检查 R2 缓存"""
    r2 = _get_r2()

    # 优先级 1：检查 R2 缓存
    cached_url = r2.check_r2_cache(req.year, req.channel)
    if cached_url:
        return {
            "success": True,
            "source": "r2",
            "audio_url": cached_url,
            "channel": req.channel,
            "year": req.year
        }

    # AI 生成兜底
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

        # 上传到 R2 缓存，下次直接用
        if audio_path and os.path.exists(audio_path):
            try:
                with open(audio_path, "rb") as f:
                    audio_bytes = f.read()
                r2.upload_to_r2(audio_bytes, req.year, req.channel, source="ai")
            except Exception as e:
                print(f"[R2 Upload] 缓存失败: {e}")

    except Exception as e:
        print(f"[Broadcast] TTS 失败，降级文本模式: {e}")

    return {
        "success": True,
        "source": "ai",
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


# ============ 年代/日期/实时广播路由 ============

async def _ai_broadcast_to_r2(r2, channel: str, year: int, date_str: str = None):
    """AI 生成广播内容 → TTS → 上传 R2 → 返回 URL"""
    from ai_content import generate_broadcast_content
    from tts_service import text_to_speech

    content = await generate_broadcast_content(channel=channel, year=year, duration_minutes=5)
    output_filename = f"broadcast_{channel}_{year}_ai.mp3"
    audio_path = await text_to_speech(text=content, year=year, output_filename=output_filename)

    with open(audio_path, "rb") as f:
        audio_bytes = f.read()
    r2_url = r2.upload_to_r2(audio_bytes, year, channel, source="ai", date_str=date_str)
    return r2_url, content


@app.get("/api/broadcast/year/{year}")
async def broadcast_by_year(
    year: int,
    category: str = Query("news", description="分类: news, music, sports, finance, culture, technology"),
    duration: int = Query(5, description="AI 兜底时生成的时长（分钟）")
):
    """
    按年代检索广播内容，五级优先级：
    R2 历史库 → R2缓存 → 历史API → 下载到R2 → AI兜底
    """
    if category not in ("news", "music", "sports", "finance", "culture", "technology", "综合", "general"):
        raise HTTPException(status_code=400, detail=f"不支持的分类: {category}")

    r2 = _get_r2()

    # 优先级 0：R2 历史归档库 — 如果有该年份的完整历史广播，直接返回列表
    history_stations = r2.get_history_stations(year)
    if history_stations:
        # 按 category 筛选匹配的电台
        cat_map = {
            "news": "zgzs", "music": "yyzs", "sports": "tyzs",
            "finance": "jjzs", "culture": "wyzs", "technology": "kj",
            "综合": "zh", "general": "zh",
        }
        target_key = cat_map.get(category)
        matched = [
            s for s in history_stations
            if not target_key or s.get("category_key") == target_key
        ] if target_key else history_stations

        return {
            "success": True,
            "year": year,
            "stations": matched if matched else history_stations,
            "total": len(matched) if matched else len(history_stations),
            "source": "r2_archive",
        }

    # 走四级优先级解析
    result = r2.broadcast_4level_resolve(year, category)
    if result.get("source"):
        return {
            "success": True,
            **result
        }

    # 兜底：AI 生成
    try:
        audio_url, content = await _ai_broadcast_to_r2(r2, category, year)
        return {
            "success": True,
            "source": "ai",
            "audio_url": audio_url,
            "content": content,
            "channel": category,
            "year": year
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"广播生成失败: {str(e)}")


@app.get("/api/broadcast/date/{date}")
async def broadcast_by_date(
    date: str,
    category: str = Query("news", description="分类: news, music, sports, finance, culture, technology")
):
    """
    按具体日期（YYYY-MM-DD）检索广播内容，四级优先级同上。
    """
    # 校验日期格式
    try:
        parts = date.split("-")
        year = int(parts[0])
        if not (1949 <= year <= 2026):
            raise ValueError
    except (ValueError, IndexError):
        raise HTTPException(status_code=400, detail=f"日期格式无效: {date}，应为 YYYY-MM-DD（1949-2026）")

    r2 = _get_r2()

    # 走四级优先级解析（带 date_str）
    result = r2.broadcast_4level_resolve(year, category, date_str=date)
    if result.get("source"):
        return {
            "success": True,
            **result
        }

    # 兜底：AI 生成
    try:
        audio_url, content = await _ai_broadcast_to_r2(r2, category, year, date_str=date)
        return {
            "success": True,
            "source": "ai",
            "audio_url": audio_url,
            "content": content,
            "channel": category,
            "year": year,
            "date": date
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"广播生成失败: {str(e)}")


@app.get("/api/broadcast/live")
async def broadcast_live(
    category: str = Query("news", description="分类: news, music, sports, finance, culture, technology")
):
    """
    2026 年实时广播：
    1. 搜索在线实时广播流 → 直接返回 stream_url
    2. AI 生成"实时"内容 → TTS → R2
    """
    r2 = _get_r2()

    # 优先级 1：搜索在线实时广播流
    live_result = r2.search_live_stream(category)
    if live_result:
        return {
            "success": True,
            "source": "live",
            "audio_url": live_result["audio_url"],
            "station_name": live_result.get("name", ""),
            "category": category
        }

    # 优先级 2：AI 生成"实时"广播
    try:
        # 生成当前日期的广播
        today = datetime.now().strftime("%Y-%m-%d")
        audio_url, content = await _ai_broadcast_to_r2(r2, category, 2026, date_str=today)
        return {
            "success": True,
            "source": "ai",
            "audio_url": audio_url,
            "content": content,
            "channel": category,
            "year": 2026,
            "date": today
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"实时广播生成失败: {str(e)}")


@app.get("/api/broadcast/history/{year}")
async def broadcast_history(year: int):
    """
    返回指定年份的历史电台列表（来自 R2 已归档的广播音频）。

    调用 get_history_stations(year) 读取 R2 broadcasts/{year}/ 目录，
    返回按频道/分类分组的可用音频列表。

    返回:
        {
            "year": 1985,
            "stations": [
                {
                    "station_name": "中国之声",
                    "category": "新闻",
                    "category_key": "zgzs",
                    "audio_urls": [
                        {"key": "broadcasts/1985/zgzs/xxx.mp3", "url": "https://...", "filename": "xxx.mp3"},
                        ...
                    ]
                },
                ...
            ],
            "source": "r2_archive"
        }
        如果该年份无数据，返回 {"year": 1985, "stations": [], "source": "none"}
    """
    r2 = _get_r2()
    stations = r2.get_history_stations(year)

    if stations:
        return {
            "year": year,
            "stations": stations,
            "source": "r2_archive",
        }
    else:
        return {
            "year": year,
            "stations": [],
            "source": "none",
        }


# ============ Internet Archive 广播代理 API ============

@app.get("/api/broadcast/archive/search")
async def archive_search(
    year: int = Query(..., description="年份，1950-2020"),
):
    """
    搜索 Internet Archive 上指定年份的中国广播录音（1 小时缓存）。

    返回:
        {
            "year": 1980,
            "results": [
                {"identifier": "...", "title": "...", "year": "1980", "audio_url": "...", "duration": 0, "source": "archive.org"},
                ...
            ],
            "total": 5,
            "source": "archive.org"
        }
    """
    if year < 1950 or year > 2020:
        raise HTTPException(status_code=400, detail="年份范围: 1950-2020")

    r2 = _get_r2()
    results = r2.search_archive_broadcasts(year)

    return {
        "year": year,
        "results": results,
        "total": len(results),
        "source": "archive.org",
    }


@app.get("/api/broadcast/archive/play/{identifier:path}")
async def archive_play(identifier: str):
    """
    获取 Archive 广播在 R2 上的缓存音频代理 URL。
    identifier: Archive.org identifier，如 'cnr_1980_news_001'
    返回 R2 公开直链或 404。
    """
    r2 = _get_r2()
    r2_url = r2.get_archive_audio(identifier)

    if r2_url:
        return {
            "success": True,
            "identifier": identifier,
            "audio_url": r2_url,
            "source": "r2_cache",
        }

    raise HTTPException(status_code=404, detail=f"未找到缓存的音频: {identifier}")


# ============ 云听 CNR 回听节目 API ============

# ==================== CNTV 云听回听（直读 R2 公开 HTTP，不依赖 r2_broadcast） ====================

CNTV_PUBLIC_BASE = "https://pub-0eec6c55dc714795a536617ead7ae89d.r2.dev"

CNTV_YEARS = ["2020", "2021", "2022", "2023", "2024", "2025"]

CNTV_SUMMARY = {
    "2020": {"days": 246, "total_programs": 5174, "date_range": ["2020-04-30", "2020-12-31"]},
    "2021": {"days": 365, "total_programs": 7836, "date_range": ["2021-01-01", "2021-12-31"]},
    "2022": {"days": 365, "total_programs": 8067, "date_range": ["2022-01-01", "2022-12-31"]},
    "2023": {"days": 365, "total_programs": 7801, "date_range": ["2023-01-01", "2023-12-31"]},
    "2024": {"days": 366, "total_programs": 7858, "date_range": ["2024-01-01", "2024-12-31"]},
    "2025": {"days": 365, "total_programs": 7921, "date_range": ["2025-01-01", "2025-12-31"]},
}

@app.get("/api/debug/cntv")
async def debug_cntv():
    """诊断端点：测试 CNTV 数据链路"""
    import httpx, time
    results = {"ts": time.time(), "tests": {}}
    
    # Test 1: httpx import
    results["tests"]["httpx"] = "ok"
    
    # Test 2: _index.json
    url = f"{CNTV_PUBLIC_BASE}/cntv/_index.json"
    try:
        r = httpx.get(url, timeout=15.0)
        results["tests"]["index_json"] = {
            "status": r.status_code,
            "body_preview": str(r.json())[:200]
        }
    except Exception as e:
        results["tests"]["index_json"] = {"error": str(e)}
    
    # Test 3: year JSON
    try:
        r2 = httpx.get(f"{CNTV_PUBLIC_BASE}/cntv/cntv_zhisheng_2025.json", timeout=15.0)
        data = r2.json()
        results["tests"]["year_json"] = {
            "status": r2.status_code,
            "dates_count": len(data),
            "sample_date": list(data.keys())[:1]
        }
    except Exception as e:
        results["tests"]["year_json"] = {"error": str(e)}
    
    return results

# 内存缓存（Vercel 冷启动不共享，但在单次请求内节省重复 HTTP 调用）
_cntv_index_cache = None
_cntv_year_cache = {}

def _cntv_http_json(path: str):
    """从 R2 公开 URL 读取 JSON，优先 httpx 降级 urllib。"""
    url = f"{CNTV_PUBLIC_BASE}/{path}"
    try:
        import httpx
        r = httpx.get(url, timeout=15.0, follow_redirects=True)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    # 降级：使用标准库 urllib（带 SSL 容错）
    try:
        import ssl
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        req = urllib.request.Request(url, headers={"User-Agent": "elder-radio/1.0"})
        with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"[CNTV HTTP] {path} failed: {e}")
    # 最后降级：不使用 SSL context
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "elder-radio/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"[CNTV HTTP fallback] {path} failed: {e}")
    return None

def _cntv_get_years():
    """返回有数据的年份列表。数据已硬编码，不再从 R2 获取。"""
    return CNTV_YEARS

def _cntv_get_year(year: str):
    """返回指定年份的节目索引。"""
    if year in _cntv_year_cache:
        return _cntv_year_cache[year]
    data = _cntv_http_json(f"cntv/cntv_zhisheng_{year}.json")
    _cntv_year_cache[year] = data or {}
    return _cntv_year_cache[year]

def _cntv_get_date(date: str):
    """返回指定日期的节目列表。"""
    year = date[:4]
    year_data = _cntv_get_year(year)
    return year_data.get(date, [])


@app.get("/api/cntv/years")
async def cntv_years():
    years = _cntv_get_years()
    return {"years": years, "source": "ytapi.radio.cn", "station": "中国之声"}


@app.get("/api/cntv/{year}")
async def cntv_year_programs(year: str):
    programs = _cntv_get_year(year)
    dates = sorted(programs.keys()) if programs else []
    total = sum(len(v) for v in programs.values()) if programs else 0
    return {
        "year": year,
        "dates": dates,
        "total_days": len(dates),
        "total_programs": total,
        "programs": programs,
        "source": "ytapi.radio.cn",
        "station": "中国之声",
    }


@app.get("/api/cntv/date/{date}")
async def cntv_date_programs(date: str):
    from datetime import datetime as dt
    try:
        dt.strptime(date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="日期格式错误，请使用 YYYY-MM-DD")

    programs = _cntv_get_date(date)
    if not programs:
        return {"date": date, "programs": [], "source": "none", "message": f"{date} 无回听数据"}

    result = [{"start": p[0], "end": p[1], "name": p[2], "url": p[3]} for p in programs]
    return {
        "date": date, "programs": result, "total": len(result),
        "source": "ytapi.radio.cn", "station": "中国之声",
    }


@app.get("/api/cntv/summary")
async def cntv_summary():
    """返回各年份统计摘要。数据已硬编码，不再从 R2 获取。"""
    return {"years": CNTV_SUMMARY, "source": "cntv"}


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


# ============ 酷我音乐流代理 ============

KUWO_SEARCH_URL = "http://search.kuwo.cn/r.s"
KUWO_ANTI_URL = "https://antiserver.kuwo.cn/anti.s"


def _kuwo_search(name: str, artist: str = "五月天") -> Optional[str]:
    """搜索歌曲并返回 MUSICRID，无结果返回 None"""
    query = f"{artist} {name}"
    params = urllib.parse.urlencode({
        "all": query, "ft": "music", "itemset": "new_web",
        "pn": "0", "rn": "5", "rformat": "json", "encoding": "utf8"
    })
    url = f"{KUWO_SEARCH_URL}?{params}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=6) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        start = raw.find("{")
        if start < 0:
            return None
        data = ast.literal_eval(raw[start:])
        items = data.get("abslist", [])
        if not items:
            return None
        # 优先匹配 ARTIST 包含目标歌手的
        for item in items:
            if artist in item.get("ARTIST", ""):
                return item.get("MUSICRID")
        return items[0].get("MUSICRID")
    except Exception:
        return None


def _kuwo_stream_url(rid: str) -> Optional[str]:
    """通过 musicrid 获取 MP3 直链"""
    params = urllib.parse.urlencode({
        "type": "convert_url3", "rid": rid, "format": "mp3"
    })
    url = f"{KUWO_ANTI_URL}?{params}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=6) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if data.get("code") == 200 and data.get("url"):
            return data["url"]
        return None
    except Exception:
        return None


@app.get("/api/stream")
async def stream_song(
    name: str = Query(..., description="歌曲名"),
    artist: str = Query("五月天", description="歌手名")
):
    """实时获取歌曲 MP3 播放链接"""
    rid = _kuwo_search(name, artist)
    if not rid:
        raise HTTPException(status_code=404, detail=f"未找到歌曲: {artist} - {name}")
    stream_url = _kuwo_stream_url(rid)
    if not stream_url:
        raise HTTPException(status_code=502, detail="获取播放链接失败")
    return {
        "success": True,
        "name": name,
        "artist": artist,
        "url": stream_url,
        "source": "kuwo"
    }


# ============ 实时电台 API（2026 FM 模式）============

@app.get("/api/stations/live")
async def get_live_stations(
    category: Optional[str] = Query(None, description="分类筛选：news/music/sports/business"),
    limit: int = Query(50, ge=1, le=500, description="返回数量上限"),
):
    """获取聚合直播电台列表（RadioBrowser + FanMingMing）"""
    ls = _get_live_stations()
    stations = ls.get_all_live_stations(category=category)
    return {
        "stations": stations[:limit],
        "total": len(stations),
        "source": "RadioBrowser + FanMingMing",
    }


@app.get("/api/stations/live/categories")
async def get_live_categories():
    """返回所有可用分类及各自电台数量"""
    ls = _get_live_stations()
    all_stations = ls.get_all_live_stations()
    cats = {}
    for s in all_stations:
        cat = s.get("category", "综合")
        cats[cat] = cats.get(cat, 0) + 1
    return {"categories": list(cats.keys()), "counts": cats}


# ============ 五月天电台 API ============

@app.get("/api/mayday/years")
async def mayday_years():
    """返回所有有五月天歌曲的年份列表（1999-2024），含歌曲数。1 小时缓存。"""
    r2 = _get_r2()
    data = r2.get_mayday_years()
    return {
        "success": True,
        "years": data["years"],
        "years_info": data["years_info"],
        "total_songs": data["total_songs"],
    }


@app.get("/api/mayday/year/{year}")
async def mayday_year_songs(year: int):
    """返回某年份所有五月天歌曲的 R2 公开 URL 列表。1 小时缓存。"""
    if year < 1999 or year > 2024:
        raise HTTPException(status_code=400, detail=f"年份超出范围: {year}（仅支持 1999-2024）")
    r2 = _get_r2()
    data = r2.get_mayday_year_songs(year)
    return {
        "success": True,
        "year": data["year"],
        "songs": data["songs"],
        "count": data["count"],
    }


# ============ 全年代广播概览 & 频道列表 ============

def _compute_broadcast_summary() -> Dict[str, Any]:
    """
    扫描 R2 broadcasts/ 前缀，聚合 1949-2026 各年份数据量。
    1949-2019：区分 news/、music/ 和 novel/ 子目录
    2020-2025：统计全部历史广播
    2026：调用 live_stations 获取直播数
    """
    r2 = _get_r2()
    summary: Dict[str, Dict[str, int]] = {}

    # 初始化所有年份为 0
    for y in range(1949, 2020):
        summary[str(y)] = {"news": 0, "music": 0, "novel": 0}
    for y in range(2020, 2026):
        summary[str(y)] = {"history": 0}
    summary["2026"] = {"live": 0}

    # 扫描 R2 broadcasts/ 下所有对象，按年份+分类聚合
    try:
        all_objs = r2._list_all_r2_objects("broadcasts/")
    except Exception as e:
        print(f"[Summary] R2 scan failed: {e}")
        all_objs = []

    for obj in all_objs:
        key = obj.get("Key", "")
        if key.endswith("/") or key == "broadcasts/_index.json":
            continue
        # 解析: broadcasts/{year}/{category}/filename
        parts = key.split("/")
        if len(parts) < 3:
            continue
        year_str = parts[1]
        category = parts[2]

        try:
            year_int = int(year_str)
        except ValueError:
            continue

        if year_int < 1949 or year_int > 2026:
            continue

        if 1949 <= year_int <= 2019:
            if year_str not in summary:
                summary[year_str] = {"news": 0, "music": 0, "novel": 0}
            s = summary[year_str]
            if category == "news":
                s["news"] = s.get("news", 0) + 1
            elif category == "music":
                s["music"] = s.get("music", 0) + 1
            elif category == "novel":
                s["novel"] = s.get("novel", 0) + 1
            # 忽略其他分类（zgzs/jjzs 等）
        elif 2020 <= year_int <= 2025:
            if year_str not in summary:
                summary[year_str] = {"history": 0}
            summary[year_str]["history"] = summary[year_str].get("history", 0) + 1

    # 2026：直播电台数量
    try:
        ls = _get_live_stations()
        live_stations = ls.get_all_live_stations()
        summary["2026"]["live"] = len(live_stations)
    except Exception as e:
        print(f"[Summary] live_stations failed: {e}")
        summary["2026"]["live"] = 0

    now_iso = datetime.now().isoformat()
    return {"summary": summary, "updated_at": now_iso}


@app.get("/api/broadcast/text/{year}")
async def broadcast_text(
    year: int,
    category: str = Query("news", description="分类: news, novel, music")
):
    """返回指定年份+分类的广播稿文本内容"""
    import json
    try:
        r2 = _get_r2()
        s3 = r2._get_s3()
        key = f"broadcasts/{year}/{category}/content.json"
        resp = s3.get_object(Bucket=r2.R2_BUCKET, Key=key)
        data = json.loads(resp["Body"].read().decode("utf-8"))
        return {
            "success": True,
            "year": year,
            "category": category,
            "text": data.get("text", ""),
            "generated_at": data.get("generated_at", ""),
            "external_url": NOVEL_EXTERNAL_LINKS.get(year) if category == "novel" else None,
        }
    except HTTPException:
        raise
    except Exception as e:
        err_msg = str(e)
        if "NoSuchKey" in err_msg or "404" in err_msg:
            raise HTTPException(status_code=404, detail=f"未找到 {year} 年 {category} 的广播稿")
        raise HTTPException(status_code=500, detail=f"读取广播稿失败: {err_msg}")


@app.get("/api/broadcast/summary")
async def broadcast_summary():
    """
    GET /api/broadcast/summary

    返回 1949-2026 全年代数据概览，5 分钟内存缓存。
    1949-2019: {"news": N, "music": M}
    2020-2025: {"history": N}
    2026:       {"live": N}
    """
    global _broadcast_summary_cache, _broadcast_summary_cache_time

    now = time.time()
    if _broadcast_summary_cache and (now - _broadcast_summary_cache_time) < _BROADCAST_SUMMARY_CACHE_TTL:
        return _broadcast_summary_cache

    try:
        result = _compute_broadcast_summary()
        _broadcast_summary_cache = result
        _broadcast_summary_cache_time = now
        return result
    except Exception as e:
        print(f"[API] /api/broadcast/summary error: {e}")
        raise HTTPException(status_code=500, detail=f"概览生成失败: {str(e)}")


@app.get("/api/broadcast/{year}/channels")
async def broadcast_year_channels(
    year: int,
    channel: Optional[str] = Query(None, description="频道筛选：news | music，不传返回全部"),
):
    """
    GET /api/broadcast/{year}/channels?channel=news|music

    返回某年各频道的广播列表。
    对于 1949-2019：返回 news/ 和 music/ 两个频道
    对于 2020-2026：返回 history 频道
    """
    if year < 1949 or year > 2026:
        raise HTTPException(status_code=400, detail=f"年份超出范围: {year}（1949-2026）")

    r2 = _get_r2()
    prefix = f"broadcasts/{year}/"

    # 列出该年份下所有对象
    try:
        all_objs = r2._list_all_r2_objects(prefix)
    except Exception as e:
        print(f"[Channels] R2 scan failed for {year}: {e}")
        raise HTTPException(status_code=500, detail=f"R2 读取失败: {str(e)}")

    PUBLIC_BASE = r2.PUBLIC_BASE

    # 按频道分类聚合
    channels_data: Dict[str, Dict[str, Any]] = {}

    for obj in all_objs:
        key = obj.get("Key", "")
        if key.endswith("/"):
            continue
        parts = key.split("/")
        if len(parts) < 4:
            continue
        # broadcasts/{year}/{category}/filename
        cat = parts[2]
        filename = parts[-1]

        # 只取音频文件
        if not any(filename.lower().endswith(ext) for ext in (".mp3", ".flac", ".m4a", ".ogg", ".wav", ".aac")):
            continue

        if cat not in channels_data:
            channels_data[cat] = {"count": 0, "items": []}

        # 从文件名校验提取日期（如 1978-12-18_xxx.mp3）
        date_match = re.match(r"^(\d{4}-\d{2}-\d{2})", filename)
        item_date = date_match.group(1) if date_match else ""

        title = filename.rsplit(".", 1)[0] if "." in filename else filename

        channels_data[cat]["items"].append({
            "title": title,
            "date": item_date,
            "url": f"{PUBLIC_BASE}/{key}",
        })
        channels_data[cat]["count"] += 1

    # 按日期倒序排列
    for cat in channels_data:
        channels_data[cat]["items"].sort(
            key=lambda x: x.get("date", ""), reverse=True
        )

    # 筛选频道
    result_channels: Dict[str, Any] = {}
    if year <= 2019:
        if channel:
            requested = channel.strip().lower()
            result_channels[requested] = channels_data.get(
                requested, {"count": 0, "items": []}
            )
        else:
            for ch in ("news", "music"):
                result_channels[ch] = channels_data.get(
                    ch, {"count": 0, "items": []}
                )
    else:
        # 2020-2026：合并所有分类为 history
        all_items = []
        for cat_data in channels_data.values():
            all_items.extend(cat_data["items"])
        all_items.sort(key=lambda x: x.get("date", ""), reverse=True)
        result_channels["history"] = {
            "count": len(all_items),
            "items": all_items,
        }

    return {
        "year": year,
        "channels": result_channels,
    }
