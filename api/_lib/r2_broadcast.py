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


# ==================== 蜻蜓 FM 回放抓取 ====================

# 常用频道 ID
QINGTING_CHANNELS = {
    "zgzs": 334,    # 央广中国之声
    "jjzs": 335,    # 经济之声
    "yyzs": 336,    # 音乐之声
    "jdyl": 337,    # 经典音乐广播
    "thzs": 338,    # 台海之声
    "szzs": 339,    # 神州之声
    "mzzs": 340,    # 民族之声
    "wyzs": 341,    # 文艺之声
    "lnzs": 342,    # 老年之声
    "ylgb": 343,    # 娱乐广播
}


def fetch_qingting_archive(year: int, channel_id: int = None) -> List[Dict[str, Any]]:
    """
    调 Qingting API 抓取指定年份的每日节目回放列表。

    参数:
        year: 年份（2021-2025）
        channel_id: 频道 ID（默认 334 中国之声）

    返回:
        [{date, title, audio_url, channel_name}] 列表
    """
    if channel_id is None:
        channel_id = QINGTING_CHANNELS["zgzs"]

    results = []
    url = f"https://www.qingting.fm/api/v6/media/channels/{channel_id}/archive?year={year}"

    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (compatible; elder-radio/1.0)",
            "Referer": "https://www.qingting.fm/",
        })
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        if data.get("code") != 0:
            print(f"[Qingting] API error for channel {channel_id}, year {year}: {data.get('msg', 'unknown')}")
            return results

        channel_name = data.get("data", {}).get("channel_name", f"channel_{channel_id}")
        daily_list = data.get("data", {}).get("daily_list", []) or data.get("data", {}).get("list", [])

        for day in daily_list:
            date_str = day.get("date", "")
            programs = day.get("programs", []) or day.get("list", [])

            for prog in programs:
                title = prog.get("title", "") or prog.get("name", "")
                audio_url = prog.get("audio_url", "") or prog.get("mp3_url", "") or prog.get("url", "")

                if not audio_url:
                    # 部分接口返回 cdn 字段或 uri
                    audio_url = prog.get("cdn", "") or prog.get("uri", "")

                if audio_url:
                    results.append({
                        "date": date_str,
                        "title": title,
                        "audio_url": audio_url,
                        "channel_name": channel_name,
                        "source": "qingting",
                    })

        print(f"[Qingting] {channel_id} {year}: {len(results)} 条节目")
    except urllib.error.HTTPError as e:
        print(f"[Qingting] HTTP {e.code} for channel {channel_id}, year {year}")
    except Exception as e:
        print(f"[Qingting] 抓取失败 (channel={channel_id}, year={year}): {e}")

    return results


# ==================== 云听回放爬取 ====================

def fetch_yunting_archive(year: int, channel: str = "zgzs") -> List[Dict[str, Any]]:
    """
    爬取云听（央广 radio.cnr.cn）的历史回放音频 URL。

    参数:
        year: 年份（2021-2025）
        channel: 频道代码（zgzs 中国之声 / jjzs 经济之声 / yyzs 音乐之声）

    返回:
        [{date, title, audio_url, channel_name}] 列表
    """
    results = []
    channel_name_map = {
        "zgzs": "中国之声",
        "jjzs": "经济之声",
        "yyzs": "音乐之声",
        "jdyl": "经典音乐广播",
    }
    channel_name = channel_name_map.get(channel, channel)

    for month in range(1, 13):
        url = f"https://radio.cnr.cn/live/history?channel={channel}&year={year}&month={month}"

        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (compatible; elder-radio/1.0)",
                "Referer": "https://radio.cnr.cn/",
            })
            with urllib.request.urlopen(req, timeout=15) as resp:
                html = resp.read().decode("utf-8", errors="ignore")

            # 解析 HTML 中的音频链接
            # 常见模式: 页面嵌入了音频播放器，URL 通常在 data-src 或 <audio src="...">
            import re
            audio_patterns = [
                r'data-src\s*=\s*["\']([^"\']+\.mp3[^"\']*)["\']',
                r'<audio[^>]+src\s*=\s*["\']([^"\']+\.mp3[^"\']*)["\']',
                r'(https?://[^"\'\s]+/(?:audio|mp3|radio)/[^"\'\s]+\.mp3)',
                r'(https?://[^"\'\s]+/cnr/[^"\'\s]+\.mp3)',
                r'(https?://[^"\'\s]+/live/[^"\'\s]+\.mp3)',
            ]

            audio_urls = []
            for pattern in audio_patterns:
                matches = re.findall(pattern, html, re.IGNORECASE)
                audio_urls.extend(matches)

            if audio_urls:
                # 去重
                seen = set()
                unique_urls = []
                for u in audio_urls:
                    if u not in seen:
                        seen.add(u)
                        unique_urls.append(u)

                date_prefix = f"{year}-{month:02d}"
                for idx, audio_url in enumerate(unique_urls):
                    results.append({
                        "date": date_prefix,
                        "title": f"{channel_name} {year}年{month}月 回放{idx + 1}",
                        "audio_url": audio_url,
                        "channel_name": channel_name,
                        "source": "yunting",
                    })

            print(f"[Yunting] {channel} {year}-{month:02d}: {len(audio_urls)} 条")

        except urllib.error.HTTPError as e:
            print(f"[Yunting] HTTP {e.code} for {year}-{month:02d}")
        except Exception as e:
            print(f"[Yunting] 抓取失败 ({year}-{month:02d}): {e}")
            continue

    print(f"[Yunting] {channel} {year}: 总计 {len(results)} 条节目")
    return results


# ==================== Internet Archive 批量检索 ====================

def search_archive_batch(year: int, category: str = None) -> List[Dict[str, Any]]:
    """
    批量检索 Internet Archive 中指定年份的广播音频。
    先搜索 identifier 列表，再逐个调 metadata API 获取音频 URL。

    参数:
        year: 年份
        category: 分类（可选）

    返回:
        [{title, audio_url, year, source: "archive.org", identifier}] 列表
    """
    cat_cn = CATEGORY_LABELS.get(category, category) if category else "broadcast"
    decade_start = (year // 10) * 10
    decade_end = decade_start + 9

    queries = [
        f'radio broadcast china {year}',
        f'({cat_cn} OR broadcast) AND china AND year:{year}',
        f'chinese radio broadcast {decade_start}',
    ]

    identifiers = set()
    for query in queries:
        try:
            params = urllib.parse.urlencode({
                "q": query,
                "fl[]": ["identifier", "title", "year"],
                "rows": "15",
                "output": "json",
                "sort[]": "downloads desc",
            })
            url = f"{ARCHIVE_SEARCH_URL}?{params}"
            req = urllib.request.Request(url, headers={"User-Agent": "elder-radio/1.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))

            for doc in data.get("response", {}).get("docs", []):
                ident = doc.get("identifier", "")
                if ident:
                    identifiers.add(ident)
        except Exception as e:
            print(f"[Archive Batch] 搜索失败 ({query[:50]}): {e}")
            continue

    # 逐个查询 metadata 获取音频 URL
    results = []
    for ident in list(identifiers)[:30]:  # 限制数量避免超时
        try:
            meta_url = f"{ARCHIVE_METADATA_URL}{ident}"
            req = urllib.request.Request(meta_url, headers={"User-Agent": "elder-radio/1.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                meta = json.loads(resp.read().decode("utf-8"))

            files = meta.get("files", [])
            for f in files:
                fname = f.get("name", "")
                fformat = f.get("format", "")
                if fname and (fname.endswith(".mp3") or fformat in ("VBR MP3", "MP3", "Ogg Vorbis", "FLAC", "WAV")):
                    audio_url = f"https://archive.org/download/{ident}/{fname}"
                    results.append({
                        "title": meta.get("metadata", {}).get("title", fname),
                        "audio_url": audio_url,
                        "year": year,
                        "source": "archive.org",
                        "identifier": ident,
                    })
                    break  # 每个 identifier 只取第一个音频文件

        except Exception as e:
            print(f"[Archive Batch] metadata 失败 ({ident[:40]}): {e}")
            continue

    print(f"[Archive Batch] year={year} category={category}: {len(results)} 条音频")
    return results


# ==================== 批量入库 R2 ====================

def build_history_cache(start_year: int, end_year: int, force: bool = False):
    """
    批量抓取历史广播音频并上传到 R2。

    策略：
    - 1950-2020：Internet Archive 检索 → 下载 → 上传 R2
    - 2021-2025：蜻蜓 FM + 云听 → 下载 → 上传 R2
    - 已入库年份会记录到 R2 broadcasts/_index.json，默认跳过

    参数:
        start_year/end_year: 年份范围
        force: 是否强制重新抓取（忽略 _index.json 缓存记录）

    返回:
        {year: count} 字典，记录每年入库条数
    """
    results = {}
    index_data = {}

    # 读取已有索引
    try:
        s3 = _get_s3()
        resp = s3.get_object(Bucket=R2_BUCKET, Key="broadcasts/_index.json")
        index_data = json.loads(resp["Body"].read().decode("utf-8"))
        print(f"[BuildCache] 已加载索引: {len(index_data)} 个年份")
    except Exception:
        index_data = {}

    for year in range(start_year, end_year + 1):
        year_key = str(year)
        if not force and year_key in index_data:
            print(f"[BuildCache] {year} 已入库，跳过")
            results[year] = index_data[year_key]
            continue

        year_count = 0

        if year <= 2020:
            # Internet Archive 批量检索
            categories = ["news", "music", "sports"]
            for cat in categories:
                items = search_archive_batch(year, cat)
                for item in items[:5]:  # 每分类最多 5 条
                    try:
                        audio = download_to_bytes(item["audio_url"])
                        if audio:
                            title_slug = item.get("title", f"archive_{year}")
                            safe_title = re.sub(r'[<>:"/\\|?*]', '_', str(title_slug))[:80]
                            r2_url = upload_to_r2(
                                audio, year, cat,
                                source="archive",
                                filename=f"{safe_title}.mp3",
                            )
                            year_count += 1
                            print(f"[BuildCache] {year}/{cat}: {safe_title} → R2")
                            time.sleep(1)  # 礼貌延迟
                    except Exception as e:
                        print(f"[BuildCache] 下载/上传失败 {year}/{cat}: {e}")
                        continue
        else:
            # 蜻蜓 FM + 云听（2021-2025）
            for channel_key, channel_id in QINGTING_CHANNELS.items():
                try:
                    items = fetch_qingting_archive(year, channel_id)
                    for item in items[:10]:  # 每频道最多 10 条
                        try:
                            audio = download_to_bytes(item["audio_url"])
                            if audio:
                                date_str = item.get("date", str(year))
                                safe_title = re.sub(r'[<>:"/\\|?*]', '_', item.get("title", "qingting"))[:80]
                                r2_url = upload_to_r2(
                                    audio, year, channel_key,
                                    source="qingting",
                                    filename=f"{date_str}_{safe_title}.mp3",
                                    date_str=date_str,
                                )
                                year_count += 1
                                time.sleep(1)
                        except Exception as e:
                            print(f"[BuildCache] Qingting 上传失败 {year}/{channel_key}: {e}")
                            continue
                except Exception as e:
                    print(f"[BuildCache] Qingting 抓取失败 {year}/{channel_key}: {e}")
                    continue

            # 云听
            for channel in ("zgzs", "jjzs", "yyzs"):
                try:
                    items = fetch_yunting_archive(year, channel)
                    for item in items[:10]:
                        try:
                            audio = download_to_bytes(item["audio_url"])
                            if audio:
                                safe_title = re.sub(r'[<>:"/\\|?*]', '_', item.get("title", "yunting"))[:80]
                                r2_url = upload_to_r2(
                                    audio, year, channel,
                                    source="yunting",
                                    filename=f"{safe_title}.mp3",
                                )
                                year_count += 1
                                time.sleep(1)
                        except Exception as e:
                            continue
                except Exception as e:
                    continue

        # 更新索引
        index_data[year_key] = year_count
        results[year] = year_count
        print(f"[BuildCache] {year} 入库完成: {year_count} 条")

    # 写回索引到 R2
    try:
        s3 = _get_s3()
        s3.put_object(
            Bucket=R2_BUCKET,
            Key="broadcasts/_index.json",
            Body=json.dumps(index_data, ensure_ascii=False, indent=2).encode("utf-8"),
            ContentType="application/json",
            ACL="public-read",
        )
        print(f"[BuildCache] 索引已更新: {len(index_data)} 个年份")
    except Exception as e:
        print(f"[BuildCache] 索引写入失败: {e}")

    return results


# ==================== R2 索引查询 ====================

def get_history_stations(year: int) -> Optional[List[Dict[str, Any]]]:
    """
    读取 R2 broadcasts/{year}/ 目录下列出的所有子目录和文件。

    返回:
        [
            {
                "station_name": "news",
                "category": "新闻",
                "audio_urls": [
                    {"key": "broadcasts/1985/news/xxx.mp3", "url": "https://...", "filename": "xxx.mp3"},
                    ...
                ]
            },
            ...
        ]
        如果该年份无数据，返回 None。
    """
    prefix = f"broadcasts/{year}/"
    objects = _list_r2_objects(prefix, max_keys=200)

    if not objects:
        return None

    # 按子目录/分类分组
    by_category: Dict[str, List[Dict]] = {}

    for obj in objects:
        key = obj.get("Key", "")
        if key.endswith("/") or key == prefix:
            continue  # 跳过目录标记

        # 解析路径: broadcasts/{year}/{category}/{filename}
        parts = key.split("/")
        if len(parts) < 3:
            continue

        category_key = parts[2]  # 分类/频道子目录
        filename = parts[-1]

        if category_key not in by_category:
            by_category[category_key] = []

        by_category[category_key].append({
            "key": key,
            "url": f"{PUBLIC_BASE}/{key}",
            "filename": filename,
            "size": obj.get("Size", 0),
            "last_modified": str(obj.get("LastModified", "")),
        })

    # 组装结果
    stations = []
    for cat_key, audio_list in by_category.items():
        # 分类映射
        cat_label = CATEGORY_LABELS.get(cat_key, cat_key)
        # 频道名称映射
        channel_name_map = {
            "zgzs": "中国之声", "jjzs": "经济之声", "yyzs": "音乐之声",
            "jdyl": "经典音乐广播", "thzs": "台海之声", "szzs": "神州之声",
            "mzzs": "民族之声", "wyzs": "文艺之声", "lnzs": "老年之声",
            "ylgb": "娱乐广播",
        }
        station_name = channel_name_map.get(cat_key, cat_label)

        stations.append({
            "station_name": station_name,
            "category": cat_label,
            "category_key": cat_key,
            "audio_urls": sorted(audio_list, key=lambda x: x.get("filename", "")),
        })

    print(f"[History] {year}: {len(stations)} 个频道/分类, {sum(len(s['audio_urls']) for s in stations)} 个文件")
    return stations if stations else None


# ==================== 云听 CNR 节目回听（基于 ytapi.radio.cn 采集的链接） ====================
_CNR_CACHE = {}  # year -> {date: [[start, end, name, url], ...]}
_CNR_CACHE_TIME = {}  # year -> timestamp

def get_cnr_programs_by_date(date_str: str) -> List[Dict]:
    """
    获取指定日期的云听中国之声节目列表。
    date_str: YYYY-MM-DD
    返回 [{"start": "00:00", "end": "00:30", "name": "档案揭秘", "url": "https://..."}, ...]
    """
    year = date_str[:4]
    index = _get_cnr_year_index(year)
    if index is None:
        return []
    return index.get(date_str, [])

def get_cnr_years() -> List[str]:
    """返回有数据的年份列表。"""
    try:
        s3 = _get_s3()
        resp = s3.get_object(Bucket=R2_BUCKET, Key="cntv/_index.json")
        data = json.loads(resp["Body"].read())
        return data.get("years", [])
    except Exception:
        return []

def get_cnr_year_programs(year: str) -> Dict[str, List]:
    """返回指定年份的全部节目索引 {date: [[start, end, name, url], ...]}。"""
    return _get_cnr_year_index(year) or {}

def _get_cnr_year_index(year: str) -> Optional[Dict[str, List]]:
    """从 R2 加载年份节目索引，带内存缓存。"""
    global _CNR_CACHE, _CNR_CACHE_TIME
    now = time.time()
    if year in _CNR_CACHE and (now - _CNR_CACHE_TIME.get(year, 0)) < 3600:
        return _CNR_CACHE[year]
    
    try:
        s3 = _get_s3()
        key = f"cntv/cntv_zhisheng_{year}.json"
        resp = s3.get_object(Bucket=R2_BUCKET, Key=key)
        data = json.loads(resp["Body"].read())
        _CNR_CACHE[year] = data
        _CNR_CACHE_TIME[year] = now
        return data
    except Exception as e:
        print(f"[CNR] Failed to load year {year}: {e}")
        return None
