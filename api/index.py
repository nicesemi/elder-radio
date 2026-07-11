"""
Vercel Serverless 入口 - 老年收音机 AI 服务
将所有 API 路由合并到此单文件，适配 Vercel Python Runtime。
使用懒加载避免顶层导入触发只读文件系统错误。
"""

import os
import sys
import io
import json
import ast
import uuid
import urllib.request
import urllib.parse
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
        import r2_broadcast
        _r2_broadcast = r2_broadcast
    return _r2_broadcast

def _get_live_stations():
    global _live_stations
    if _live_stations is None:
        import live_stations
        _live_stations = live_stations
    return _live_stations

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


# ============ 云听 CNR 回听节目 API ============

@app.get("/api/cntv/years")
async def cntv_years():
    """返回有云听回听数据的年份列表"""
    r2 = _get_r2()
    years = r2.get_cnr_years()
    return {"years": years, "source": "ytapi.radio.cn", "station": "中国之声"}


@app.get("/api/cntv/{year}")
async def cntv_year_programs(year: str):
    """返回指定年份的全部节目索引（按日期分组）"""
    r2 = _get_r2()
    programs = r2.get_cnr_year_programs(year)
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
    """
    返回指定日期的节目列表。
    date: YYYY-MM-DD，例如 2023-07-01
    返回每档节目的 start/end/name/url，可直接播放
    """
    from datetime import datetime as dt
    try:
        dt.strptime(date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="日期格式错误，请使用 YYYY-MM-DD")

    r2 = _get_r2()
    programs = r2.get_cnr_programs_by_date(date)
    if not programs:
        return {
            "date": date,
            "programs": [],
            "source": "none",
            "message": f"{date} 无回听数据"
        }

    # programs format: [[start, end, name, url], ...]
    result = []
    for p in programs:
        result.append({
            "start": p[0],
            "end": p[1],
            "name": p[2],
            "url": p[3],
        })
    return {
        "date": date,
        "programs": result,
        "total": len(result),
        "source": "ytapi.radio.cn",
        "station": "中国之声",
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
