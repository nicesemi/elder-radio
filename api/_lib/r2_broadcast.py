"""
R2 广播缓存 + 外部广播源搜索模块
为年代切换提供四级优先级：R2缓存 → 历史API → 下载到R2 → AI兜底
"""

import os
import io
import json
import time
import hashlib
import urllib.request
import urllib.parse
import urllib.error
from typing import Optional, Dict, Any, List, Tuple
from pathlib import Path

import boto3
import httpx

# ==================== R2 配置 ====================
R2_ACCESS_KEY = "57161070c2bdd7fda32c8f6967c858aa"
R2_SECRET_KEY = "22b802816535b857c5f10c18ff91390794265847da2c6d08bbc3d174217a2dde"
R2_ENDPOINT   = "https://8c9e2df83d17acfe5b951a9d016a785c.r2.cloudflarestorage.com"
R2_BUCKET     = "radio"
PUBLIC_BASE   = "https://pub-0eec6c55dc714795a536617ead7ae89d.r2.dev"

# ==================== 广播分类映射 ====================
CATEGORY_LABELS = {
    "news": "新闻", "sports": "体育", "music": "音乐",
    "finance": "金融", "culture": "文化", "technology": "科技",
    "综合": "综合", "综合": "general",
}

# ==================== 公开广播流 URL（实时广播用） ====================
LIVE_STREAM_CANDIDATES = [
    # 中国国际广播电台 / 中央人民广播电台
    {"name": "CRI 环球资讯", "url": "https://lhttp.qingting.fm/live/386/64k.mp3", "category": "news"},
    {"name": "CNR 中国之声", "url": "https://lhttp.qingting.fm/live/386/64k.mp3", "category": "news"},
    {"name": "CRI Hit FM", "url": "https://lhttp.qingting.fm/live/20189/64k.mp3", "category": "music"},
    {"name": "CNR 音乐之声", "url": "https://lhttp.qingting.fm/live/388/64k.mp3", "category": "music"},
    {"name": "CNR 经济之声", "url": "https://lhttp.qingting.fm/live/387/64k.mp3", "category": "finance"},
    {"name": "北京新闻广播", "url": "https://lhttp.qingting.fm/live/333/64k.mp3", "category": "news"},
    {"name": "北京音乐广播", "url": "https://lhttp.qingting.fm/live/335/64k.mp3", "category": "music"},
    {"name": "上海新闻广播", "url": "https://lhttp.qingting.fm/live/273/64k.mp3", "category": "news"},
    {"name": "广东新闻广播", "url": "https://lhttp.qingting.fm/live/1259/64k.mp3", "category": "news"},
    {"name": "CRI EZFM", "url": "https://lhttp.qingting.fm/live/20190/64k.mp3", "category": "culture"},
]

# ==================== Internet Archive 搜索配置 ====================
ARCHIVE_SEARCH_URL = "https://archive.org/advancedsearch.php"
ARCHIVE_METADATA_URL = "https://archive.org/metadata/"

# ==================== R2 连接（懒加载） ====================
_s3_client = None

def _get_s3():
    global _s3_client
    if _s3_client is None:
        _s3_client = boto3.client(
            "s3",
            endpoint_url=R2_ENDPOINT,
            aws_access_key_id=R2_ACCESS_KEY,
            aws_secret_access_key=R2_SECRET_KEY,
        )
    return _s3_client


# ==================== R2 缓存查询 ====================

def _list_r2_objects(prefix: str, max_keys: int = 20) -> List[Dict[str, Any]]:
    """列出 R2 指定前缀下的对象"""
    try:
        s3 = _get_s3()
        resp = s3.list_objects_v2(Bucket=R2_BUCKET, Prefix=prefix, MaxKeys=max_keys)
        contents = resp.get("Contents", [])
        return sorted(contents, key=lambda x: x.get("LastModified", ""), reverse=True)
    except Exception as e:
        print(f"[R2] list_objects 失败 ({prefix}): {e}")
        return []


def check_r2_cache(year: int, category: str) -> Optional[str]:
    """
    检查 R2 中 broadcasts/{year}/{category}/ 下是否有 MP3 缓存
    返回公开 URL 或 None
    """
    prefix = f"broadcasts/{year}/{category}/"
    objects = _list_r2_objects(prefix)

    mp3_objects = [o for o in objects if o.get("Key", "").endswith(".mp3")]
    if mp3_objects:
        key = mp3_objects[0]["Key"]
        return f"{PUBLIC_BASE}/{key}"

    return None


def check_r2_date_cache(date_str: str, category: str) -> Optional[str]:
    """
    检查 R2 中 broadcasts/by_date/{date}/{category}/ 下是否有 MP3 缓存
    date_str 格式: YYYY-MM-DD
    """
    prefix = f"broadcasts/by_date/{date_str}/{category}/"
    objects = _list_r2_objects(prefix)

    mp3_objects = [o for o in objects if o.get("Key", "").endswith(".mp3")]
    if mp3_objects:
        key = mp3_objects[0]["Key"]
        return f"{PUBLIC_BASE}/{key}"

    return None


def upload_to_r2(
    audio_bytes: bytes,
    year: int,
    category: str,
    source: str,  # "r2" | "api" | "downloaded" | "ai"
    filename: Optional[str] = None,
    date_str: Optional[str] = None,
) -> str:
    """
    上传音频字节到 R2 并返回公开 URL

    路径规则：
    - 有 date_str: broadcasts/by_date/{date}/{category}/{filename}
    - 无 date_str: broadcasts/{year}/{category}/{filename}
    """
    s3 = _get_s3()

    if not filename:
        ts = int(time.time())
        filename = f"{source}_{ts}.mp3"

    if date_str:
        key = f"broadcasts/by_date/{date_str}/{category}/{filename}"
    else:
        key = f"broadcasts/{year}/{category}/{filename}"

    s3.put_object(
        Bucket=R2_BUCKET,
        Key=key,
        Body=audio_bytes,
        ContentType="audio/mpeg",
        ACL="public-read",
    )

    return f"{PUBLIC_BASE}/{key}"


# ==================== Internet Archive 搜索 ====================

def search_archive_org(year: int, category: str) -> List[Dict[str, str]]:
    """
    搜索 Internet Archive 上指定年代+分类的广播音频资源。
    返回 [{title, url, identifier, format, year}] 列表。
    """
    cat_cn = CATEGORY_LABELS.get(category, category)
    decade_start = (year // 10) * 10
    decade_end = decade_start + 9

    # 构建搜索查询
    queries = [
        f'({category} OR {cat_cn}) AND radio AND year:[{decade_start} TO {decade_end}]',
        f'({cat_cn} OR broadcast) AND china AND year:[{decade_start} TO {decade_end}]',
        f'chinese radio broadcast {decade_start}',
    ]

    results = []
    for query in queries[:2]:  # 最多搜两轮
        try:
            params = urllib.parse.urlencode({
                "q": query,
                "fl[]": ["identifier", "title", "year", "format", "mediatype"],
                "rows": "10",
                "output": "json",
                "sort[]": "downloads desc",
            })
            url = f"{ARCHIVE_SEARCH_URL}?{params}"
            req = urllib.request.Request(url, headers={"User-Agent": "elder-radio/1.0"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))

            docs = data.get("response", {}).get("docs", [])
            for doc in docs:
                identifier = doc.get("identifier", "")
                if not identifier:
                    continue

                fmt = doc.get("format", [])
                if isinstance(fmt, str):
                    fmt = [fmt]

                # 只关注音频格式
                audio_formats = {"MP3", "mp3", "VBR MP3", "Ogg Vorbis", "FLAC", "WAV"}
                has_audio = any(f in audio_formats for f in fmt)
                if not has_audio:
                    continue

                # 构建音频 URL
                audio_url = f"https://archive.org/download/{identifier}/{identifier}.mp3"
                results.append({
                    "title": doc.get("title", identifier),
                    "url": audio_url,
                    "identifier": identifier,
                    "format": ",".join(fmt) if isinstance(fmt, list) else str(fmt),
                    "year": doc.get("year", ""),
                    "source": "archive.org",
                })

        except Exception as e:
            print(f"[Archive] 搜索失败 ({query[:40]}): {e}")
            continue

    return results


def _verify_stream_url(url: str, timeout: int = 5) -> bool:
    """快速验证流 URL 是否可访问"""
    try:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0",
                "Range": "bytes=0-1024"
            }
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = resp.getcode()
            content_type = resp.headers.get("Content-Type", "")
            return status in (200, 206) and (
                "audio" in content_type or "mpeg" in content_type or
                "octet-stream" in content_type or status == 200
            )
    except Exception:
        return False


def search_broadcast_api(year: int, category: str) -> Optional[Dict[str, Any]]:
    """
    搜索公开广播 API 获取指定年代+分类的可播放音频 URL。
    
    策略：
    1. 先搜 Internet Archive 获取音频下载链接
    2. 验证 URL 可访问性
    3. 返回最优结果
    """
    results = search_archive_org(year, category)

    if not results:
        return None

    # 验证音频 URL 可访问性，取第一个可用的
    for item in results:
        if _verify_stream_url(item["url"], timeout=8):
            return {
                "source": "api",
                "audio_url": item["url"],
                "title": item.get("title", ""),
                "identifier": item.get("identifier", ""),
                "year": item.get("year", ""),
            }

    # 如果都无法直接流式播放，返回第一个作为可下载资源
    first = results[0]
    return {
        "source": "downloadable",
        "audio_url": first["url"],
        "title": first.get("title", ""),
        "identifier": first.get("identifier", ""),
        "needs_download": True,
    }


def download_to_bytes(url: str, timeout: int = 60) -> Optional[bytes]:
    """下载 URL 内容到内存，返回 bytes 或 None"""
    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "Mozilla/5.0 (compatible; elder-radio/1.0)"}
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            total = int(resp.headers.get("Content-Length", 0))
            data = resp.read()
            size_mb = len(data) / 1024 / 1024
            print(f"[Download] {url[:60]}... → {size_mb:.1f} MB")
            return data
    except Exception as e:
        print(f"[Download] 失败: {e}")
        return None


def search_live_stream(category: str) -> Optional[Dict[str, Any]]:
    """
    搜索当前在线的实时广播流（2026 年使用）。
    返回可用的流 URL 及元数据，或 None。
    """
    # 过滤匹配分类的候选流
    candidates = [
        s for s in LIVE_STREAM_CANDIDATES
        if s["category"] == category or category in ("综合", "general")
    ]
    if not candidates:
        candidates = LIVE_STREAM_CANDIDATES  # 兜底：返回所有候选

    for candidate in candidates:
        if _verify_stream_url(candidate["url"], timeout=5):
            return {
                "source": "live",
                "audio_url": candidate["url"],
                "name": candidate["name"],
                "category": candidate["category"],
            }

    return None


def broadcast_4level_resolve(
    year: int,
    category: str,
    date_str: Optional[str] = None,
) -> Dict[str, Any]:
    """
    四级优先级解析广播音频 URL：
    1. R2 缓存
    2. 历史 API（Internet Archive 等）
    3. 下载到 R2
    4. 返回 None，由调用方 AI 兜底

    返回:
    {
        "source": "r2" | "api" | "downloaded" | None,
        "audio_url": "..." | None,
        "metadata": {...},
    }
    """
    # === 优先级 1：R2 缓存 ===
    if date_str:
        cached = check_r2_date_cache(date_str, category)
    else:
        cached = check_r2_cache(year, category)

    if cached:
        return {
            "source": "r2",
            "audio_url": cached,
            "metadata": {"year": year, "category": category, "date": date_str},
        }

    # === 优先级 2：历史 API（Internet Archive） ===
    api_result = search_broadcast_api(year, category)
    if api_result:
        if api_result.get("source") == "api":
            # 可直接流式播放的 URL
            return {
                "source": "api",
                "audio_url": api_result["audio_url"],
                "metadata": {
                    "year": year, "category": category,
                    "title": api_result.get("title", ""),
                    "identifier": api_result.get("identifier", ""),
                    "provider": "archive.org",
                },
            }
        elif api_result.get("needs_download"):
            # === 优先级 3：下载到 R2 ===
            audio_bytes = download_to_bytes(api_result["audio_url"])
            if audio_bytes:
                try:
                    r2_url = upload_to_r2(
                        audio_bytes, year, category,
                        source="downloaded",
                        filename=f"archive_{api_result.get('identifier', 'unknown')}.mp3",
                        date_str=date_str,
                    )
                    return {
                        "source": "downloaded",
                        "audio_url": r2_url,
                        "metadata": {
                            "year": year, "category": category,
                            "title": api_result.get("title", ""),
                            "identifier": api_result.get("identifier", ""),
                            "provider": "archive.org",
                            "cached_to_r2": True,
                        },
                    }
                except Exception as e:
                    print(f"[R2 Upload] 失败: {e}")

    # === 优先级 4：无结果，返回 None 让调用方 AI 兜底 ===
    return {
        "source": None,
        "audio_url": None,
        "metadata": {"year": year, "category": category, "date": date_str},
    }
