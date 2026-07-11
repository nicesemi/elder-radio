"""
live_stations.py — 直播电台聚合模块

数据源：
  1. Radio Browser API (de1.api.radio-browser.info) — country/China + tag/news,china
  2. FanMingMing M3U (live.fanmingming.com，多镜像容错)
  3. CNR 央广官方直链（内置兜底）

聚合去重后返回统一格式电台列表，支持按分类筛选。
注意：RadioBrowser 返回大量 HLS (.m3u8) 流，前端已集成 HLS.js 支持播放。
"""

import concurrent.futures
import json
import os
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


# ========== 分类映射 ==========

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


# ========== 数据源 1：Radio Browser API ==========

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


def _map_rb_station(s):
    """将 Radio Browser 返回条目映射为统一格式。
    字段映射：url_resolved → stream_url, name → name, tags → 分类解析"""
    stream_url = s.get("url_resolved", "") or s.get("url", "")
    name = (s.get("name", "") or "").strip()
    if not stream_url or not name or len(name) < 2:
        return None
    return {
        "id": f"rb_{s.get('stationuuid', '')[:12]}",
        "name": name,
        "stream_url": stream_url,
        "category": _resolve_category(s.get("tags", "")),
        "source": "RadioBrowser",
        "favicon": s.get("favicon", ""),
        "hls": bool(s.get("hls", 0)),
        "codec": s.get("codec", "") or "",
    }


def _fetch_rb_endpoint(endpoint, timeout=8):
    """遍历多镜像请求单个 RB 端点，返回电台列表或空列表。"""
    last_error = None
    for server in _RB_SERVERS:
        url = f"{server}/json/stations/{endpoint}"
        try:
            raw = _try_fetch_json(url, timeout=timeout)
        except Exception as e:
            last_error = e
            continue

        stations = []
        for s in raw:
            mapped = _map_rb_station(s)
            if mapped:
                stations.append(mapped)
        return stations

    print(f"[live_stations] RB endpoint '{endpoint}' failed (all mirrors): {last_error}")
    return []


def fetch_radio_browser_stations():
    """
    从 Radio Browser API 获取国内电台。
    并行请求两个端点后合并去重：
      1. /json/stations/country/China  — 国内全部电台
      2. /json/stations/tag/news,china — 补充新闻分类
    """
    endpoints = [
        "country/China",
        "tag/news,china",
    ]

    all_stations = []
    seen_ids = set()

    for endpoint in endpoints:
        stations = _fetch_rb_endpoint(endpoint, timeout=8)
        for s in stations:
            if s["id"] not in seen_ids:
                seen_ids.add(s["id"])
                all_stations.append(s)

    if not all_stations:
        print("[live_stations] Radio Browser: both endpoints returned empty")
    return all_stations


# ========== 数据源 2：FanMingMing M3U ==========

# FanMingMing 主域名及镜像列表
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


# ========== 数据源 3：CNR 央广官方兜底 ==========

def get_cnr_fallback_stations():
    """
    返回 CNR 央广官方 M3U8 直链电台。
    当 Radio Browser 和 FanMingMing 均不可用时作为最终兜底，
    确保至少 10 个核心电台可用。

    分类规则：
      中国之声/中华之声/神州之声/华夏之声 → 新闻
      经济之声 → 经济
      音乐之声/经典音乐广播/文艺之声 → 音乐
      民族之声/老年之声 → 综合
    """
    cnr_stations = [
        ("cnr_001", "中国之声",        "https://ngcdn001.cnr.cn/live/zgzs/index.m3u8",  "新闻"),
        ("cnr_002", "经济之声",        "https://ngcdn002.cnr.cn/live/jjzs/index.m3u8",  "经济"),
        ("cnr_003", "音乐之声",        "https://ngcdn003.cnr.cn/live/yyzs/index.m3u8",  "音乐"),
        ("cnr_004", "经典音乐广播",    "https://ngcdn004.cnr.cn/live/jdyl/index.m3u8",  "音乐"),
        ("cnr_005", "中华之声",        "https://ngcdn005.cnr.cn/live/zhzs/index.m3u8",  "新闻"),
        ("cnr_006", "神州之声",        "https://ngcdn006.cnr.cn/live/szzs/index.m3u8",  "新闻"),
        ("cnr_007", "华夏之声",        "https://ngcdn007.cnr.cn/live/hxzs/index.m3u8",  "新闻"),
        ("cnr_008", "民族之声",        "https://ngcdn008.cnr.cn/live/mzzs/index.m3u8",  "综合"),
        ("cnr_009", "文艺之声",        "https://ngcdn009.cnr.cn/live/wyzs/index.m3u8",  "音乐"),
        ("cnr_010", "老年之声",        "https://ngcdn010.cnr.cn/live/lnzs/index.m3u8",  "综合"),
    ]

    return [
        {
            "id": sid,
            "name": name,
            "stream_url": url,
            "category": category,
            "source": "CNR",
            "favicon": "",
            "hls": True,
            "codec": "",
        }
        for sid, name, url, category in cnr_stations
    ]


# ========== 数据源 3b：radio_sources.json 静态兜底 ==========

def _load_static_fallback():
    """
    从 frontend/radio_sources.json 动态读取所有 verified=true 且 type=live
    的电台作为兜底源。加载失败时打印日志并返回空列表，
    让调用方回退到 CNR 硬编码兜底。
    """
    static_path = None
    candidates = [
        os.path.join(os.path.dirname(os.path.abspath(__file__)),
                     "..", "..", "frontend", "radio_sources.json"),
        "/Users/geyechazihuaxiang/elder-radio/frontend/radio_sources.json",
    ]
    for p in candidates:
        if os.path.isfile(p):
            static_path = p
            break

    if not static_path:
        print("[live_stations] radio_sources.json not found in any known location")
        return []

    try:
        with open(static_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print(f"[live_stations] Failed to load radio_sources.json: {e}")
        return []

    stations_raw = data.get("stations", [])
    if not stations_raw:
        print("[live_stations] radio_sources.json has empty stations array")
        return []

    result = []
    seen_ids = set()
    for s in stations_raw:
        # 只取 verified=true 且 type=live 且 stream_url 非空
        if s.get("type") != "live":
            continue
        if not s.get("verified", False):
            continue
        stream_url = (s.get("stream_url") or "").strip()
        if not stream_url:
            continue

        sid = str(s.get("id", "")).strip()
        if not sid:
            continue
        # 去重，避免 radio_sources.json 本身有重复 id
        if sid in seen_ids:
            continue
        seen_ids.add(sid)

        result.append({
            "id": sid,
            "name": s.get("name", "未知电台"),
            "stream_url": stream_url,
            "category": s.get("category", "综合"),
            "source": s.get("source", "CNR"),
            "favicon": s.get("logo", ""),
            "hls": True,
            "codec": "",
        })

    print(f"[live_stations] Loaded {len(result)} stations from radio_sources.json")
    return result


# ========== 聚合 ==========

def get_all_live_stations(category=None):
    """
    聚合 Radio Browser（2 端点） + FanMingMing M3U，去重后返回统一列表。

    四层容错：
      1. 并行拉取 RB + FMM
      2. 任一返回即使用
      3. 两个外部源全挂 → 降级到 radio_sources.json 静态兜底（210 个直播源）
      4. 静态兜底不可用 → 降级到 CNR 硬编码兜底（10 个核心台）

    category: 可选筛选（新闻/音乐/体育/经济/文艺/交通/综合 等）。
    """
    # 缓存检查
    if _cache_valid():
        all_stations = _cache["stations"]
    else:
        # 并行拉取 RB + FMM
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

    # 两个外部源全挂 → radio_sources.json 静态兜底 → CNR 硬编码最终兜底
    if not unique:
        print("[live_stations] Both external sources failed, trying static fallback")
        static_fallback = _load_static_fallback()
        if static_fallback:
            print(f"[live_stations] Using {len(static_fallback)} stations from radio_sources.json")
            unique = static_fallback
        else:
            print("[live_stations] Static fallback empty, falling back to CNR hardcoded")
            unique = get_cnr_fallback_stations()

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
