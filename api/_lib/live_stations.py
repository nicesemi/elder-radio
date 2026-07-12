"""
live_stations.py — 直播电台聚合模块

数据源：
  1. Radio Browser API (de1.api.radio-browser.info)
  2. FanMingMing M3U (live.fanmingming.com，多镜像容错)
  3. 本地内置电台（硬编码兜底）

聚合去重后返回统一格式电台列表，支持按分类筛选。
注意：RadioBrowser 返回大量 HLS (.m3u8) 流，前端已集成 HLS.js 支持播放。
"""

import concurrent.futures
import json
import re
import time
import urllib.request
import urllib.parse
import urllib.error

# ========== 缓存 ==========
_cache = {"ts": 0, "stations": []}
_CACHE_TTL = 3600  # 1 小时


def _cache_valid():
    return _cache["ts"] > 0 and (time.time() - _cache["ts"]) < _CACHE_TTL


def _normalize_url(url):
    """规范化 URL，用于去重比较"""
    if not url:
        return ""
    return url.strip().rstrip("/")


# ========== 数据源 1：Radio Browser API ==========

# tag → 项目分类映射
TAG_TO_CATEGORY = {
    # 新闻
    "news": "新闻", "talk": "新闻", "information": "新闻",
    "sports news": "体育",
    # 音乐
    "music": "音乐", "pop": "音乐", "classical": "音乐",
    "rock": "音乐", "jazz": "音乐", "dance": "音乐",
    "pop music": "音乐", "classical music": "音乐",
    "golden oldies": "音乐", "golden music": "音乐",
    "oldies": "音乐", "classic hits": "音乐",
    # 体育
    "sports": "体育", "olympics": "体育",
    # 经济
    "business": "经济", "economics": "经济",
    # 文艺
    "culture": "文艺", "literature": "文艺", "opera": "文艺",
    "film": "文艺", "radio drama": "文艺", "storytelling": "文艺",
    # 教育
    "education": "教育", "educational": "教育",
    "college radio": "教育",
    # 综艺
    "entertainment": "综艺", "variety": "综艺",
    # 交通
    "traffic": "交通", "traffic radio broadcast": "交通",
    "traffic information": "交通",
    # 综合/公共服务
    "full service": "综合", "public radio": "综合",
    "general": "综合", "lifestyle": "综合",
    # 儿童
    "children": "少儿",
    # 其他
    "agriculture": "农业", "health": "健康",
    "religion": "宗教", "buddhism": "宗教", "catholic": "宗教",
    "bible": "宗教", "chirstian": "宗教", "christian": "宗教",
    "international": "国际", "english": "国际",
    "tourism": "旅游", "anime": "动漫",
    "internet radio": "网络", "hls video": "视频",
    "tv": "视频",
    # 地方台（省份/城市）
    "hong kong": "地方", "beijing": "地方",
    "shensi": "地方", "shaanxi": "地方",
    "chekiang": "地方", "zhejiang": "地方",
    "kiangsu": "地方", "jiangsu": "地方",
    "shanghai": "地方", "guangdong": "地方",
    "地方台": "地方", "5g智慧电台": "综合",
    # 其他语义标签
    "chinese": "综合", "student": "教育",
    "old age": "老年", "中国之声": "新闻",
    "soldiers sortie": "综合",
    "hot": "音乐", "lounge": "音乐",
    "m3u8": "综合",
    "baladas cumbia 70 80 varios": "音乐",
    "podcast": "播客", "播客": "播客",
}


def _resolve_category(tags_str):
    """将 Radio Browser tags 映射到项目分类"""
    if not tags_str:
        return "综合"
    raw_tags = [t.strip().lower() for t in tags_str.split(",")]
    for t in raw_tags:
        if t in TAG_TO_CATEGORY:
            return TAG_TO_CATEGORY[t]
    # 忽略纯数字标签（频率值如 "105.1"）和非语义标签
    meaningful = [t for t in raw_tags
                  if not re.match(r'^[\d.]+(\s*fm)?$', t, re.IGNORECASE)
                  and len(t) > 2]
    return meaningful[0] if meaningful else "综合"


# Radio Browser 多镜像
_RB_SERVERS = [
    "https://de1.api.radio-browser.info",
    "https://de2.api.radio-browser.info",
    "https://at1.api.radio-browser.info",
]


def _try_fetch_json(url, timeout=8):
    """尝试从接口获取 JSON（Vercel Serverless 限制 10s，预留 2s 余量）"""
    req = urllib.request.Request(url, headers={
        "User-Agent": "elder-radio/2.0",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def fetch_radio_browser_stations(tag=None):
    """
    从 Radio Browser API 获取国内电台。
    tag: 可选过滤（news/music/sports/classical 等），不传则获取全部。
    返回统一格式列表。
    """
    params = []
    if tag:
        params.append(f"tag={urllib.parse.quote(tag)}")
    query = "?" + "&".join(params) if params else ""

    last_error = None
    for server in _RB_SERVERS:
        url = f"{server}/json/stations/bycountry/China{query}"
        try:
            raw = _try_fetch_json(url)
        except Exception as e:
            last_error = e
            continue

        # 成功：映射字段
        stations = []
        for s in raw:
            stream_url = s.get("url_resolved", "") or s.get("url", "")
            name = (s.get("name", "") or "").strip()
            if not stream_url or not name or len(name) < 2:
                continue
            stations.append({
                "id": f"rb_{s.get('stationuuid', '')[:12]}",
                "name": name,
                "stream_url": stream_url,
                "category": _resolve_category(s.get("tags", "")),
                "source": "RadioBrowser",
                "favicon": s.get("favicon", ""),
                "hls": bool(s.get("hls", 0)),
                "codec": s.get("codec", "") or "",
            })
        return stations

    print(f"[live_stations] Radio Browser fetch failed (all mirrors): {last_error}")
    return []


# ========== 数据源 2：FanMingMing M3U ==========

# FanMingMing 主域名及镜像列表（主域名不稳定时自动降级）
_FMM_MIRRORS = [
    "https://live.fanmingming.com/radio/m3u/index.m3u",
    "https://raw.fastgit.org/fanmingming/live/main/radio/m3u/index.m3u",
    "https://raw.githubusercontent.com/fanmingming/live/main/radio/m3u/index.m3u",
    "https://gh-proxy.com/raw.githubusercontent.com/fanmingming/live/main/radio/m3u/index.m3u",
]


def _try_fetch_text(url, timeout=5):
    """尝试获取文本内容"""
    req = urllib.request.Request(url, headers={
        "User-Agent": "elder-radio/2.0",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="ignore")


def fetch_fanmingming_stations():
    """
    从 FanMingMing 拉取广播 M3U 列表，正则解析电台名和流 URL。
    多镜像容错，任一可用即返回。
    """
    text = None
    for mirror_url in _FMM_MIRRORS:
        try:
            text = _try_fetch_text(mirror_url, timeout=5)
            if text and "#EXTINF" in text:
                break
        except Exception:
            continue
        text = None

    if not text:
        return []

    # 解析 M3U：#EXTINF:-1 tvg-name="台名" ... ,台名
    #            http://stream.url
    pattern = re.compile(
        r'#EXTINF:[^\n]*?tvg-name="(?P<name>[^"]*)"[^\n]*?,(?P<label>[^\n]*)\s*\n(?P<url>https?://[^\s\n]+)',
        re.IGNORECASE,
    )

    stations = []
    for m in pattern.finditer(text):
        name = m.group("name") or m.group("label") or "未知电台"
        url = m.group("url").strip()
        if not url:
            continue
        is_hls = ".m3u8" in url.lower()
        stations.append({
            "id": f"fmm_{abs(hash(url)) % (10**12):012d}",
            "name": name,
            "stream_url": url,
            "category": "综合",
            "source": "FanMingMing",
            "favicon": "",
            "hls": is_hls,
            "codec": "",
        })

    return stations


# ========== 内置兜底电台（两个外部数据源均不可用时使用） ==========

def _get_builtin_stations():
    """返回一组硬编码的已验证可用电台，作为最终兜底。"""
    return [
        {
            "id": "builtin_001",
            "name": "中国之声",
            "stream_url": "https://lhttp.qtfm.cn/live/486/64k.mp3",
            "category": "新闻", "source": "Builtin",
            "favicon": "", "hls": False, "codec": "MP3",
        },
        {
            "id": "builtin_002",
            "name": "经济之声",
            "stream_url": "https://lhttp.qtfm.cn/live/487/64k.mp3",
            "category": "经济", "source": "Builtin",
            "favicon": "", "hls": False, "codec": "MP3",
        },
        {
            "id": "builtin_003",
            "name": "音乐之声",
            "stream_url": "https://lhttp.qtfm.cn/live/488/64k.mp3",
            "category": "音乐", "source": "Builtin",
            "favicon": "", "hls": False, "codec": "MP3",
        },
        {
            "id": "builtin_004",
            "name": "经典音乐广播",
            "stream_url": "https://lhttp.qtfm.cn/live/489/64k.mp3",
            "category": "音乐", "source": "Builtin",
            "favicon": "", "hls": False, "codec": "MP3",
        },
        {
            "id": "builtin_005",
            "name": "环球资讯广播",
            "stream_url": "https://lhttp.qtfm.cn/live/490/64k.mp3",
            "category": "新闻", "source": "Builtin",
            "favicon": "", "hls": False, "codec": "MP3",
        },
        {
            "id": "builtin_006",
            "name": "文艺之声",
            "stream_url": "https://lhttp.qtfm.cn/live/491/64k.mp3",
            "category": "文艺", "source": "Builtin",
            "favicon": "", "hls": False, "codec": "MP3",
        },
        {
            "id": "builtin_007",
            "name": "上海新闻广播",
            "stream_url": "https://lhttp.qtfm.cn/live/267/64k.mp3",
            "category": "新闻", "source": "Builtin",
            "favicon": "", "hls": False, "codec": "MP3",
        },
        {
            "id": "builtin_008",
            "name": "北京新闻广播",
            "stream_url": "https://lhttp.qtfm.cn/live/331/64k.mp3",
            "category": "新闻", "source": "Builtin",
            "favicon": "", "hls": False, "codec": "MP3",
        },
        {
            "id": "builtin_009",
            "name": "广东新闻广播",
            "stream_url": "https://lhttp.qtfm.cn/live/309/64k.mp3",
            "category": "新闻", "source": "Builtin",
            "favicon": "", "hls": False, "codec": "MP3",
        },
        {
            "id": "builtin_010",
            "name": "央视台海之声",
            "stream_url": "http://lhttp.qtfm.cn/live/5022227/64k.mp3",
            "category": "新闻", "source": "Builtin",
            "favicon": "", "hls": False, "codec": "MP3",
        },
    ]


# ========== 聚合 ==========

def get_all_live_stations(category=None):
    """
    聚合 Radio Browser + FanMingMing，去重后返回统一列表。
    category: 可选筛选（新闻/音乐/体育/经济/文艺/交通/综合 等）。

    使用并行请求避免 Vercel Serverless 10s 超时。
    """
    # 缓存检查
    if _cache_valid():
        all_stations = _cache["stations"]
    else:
        # 并行拉取两个数据源，超时各自独立（避免网络波动互相拖累）
        sources = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            futures = {
                executor.submit(fetch_radio_browser_stations): "RadioBrowser",
                executor.submit(fetch_fanmingming_stations): "FanMingMing",
            }
            for future in concurrent.futures.as_completed(futures):
                name = futures[future]
                try:
                    sources[name] = future.result(timeout=9)
                except Exception as e:
                    print(f"[live_stations] {name} fetch failed: {e}")
                    sources[name] = []

        all_stations = sources.get("RadioBrowser", []) + sources.get("FanMingMing", [])
        _cache["stations"] = all_stations
        _cache["ts"] = time.time()

    # 去重（按 stream_url）
    seen = set()
    unique = []
    for s in all_stations:
        url = _normalize_url(s.get("stream_url", ""))
        if not url:
            continue
        if url in seen:
            continue
        seen.add(url)
        unique.append(s)

    # 如果两个数据源都挂了，使用内置兜底电台
    if not unique:
        unique = _get_builtin_stations()

    # 按分类筛选
    if category:
        cat_map = {
            "news": "新闻", "music": "音乐", "sports": "体育",
            "business": "经济", "culture": "文艺", "traffic": "交通",
            "general": "综合",
        }
        target = cat_map.get(category.lower(), category)
        unique = [s for s in unique if s.get("category") == target]

    return unique
