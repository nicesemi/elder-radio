#!/usr/bin/env python3
"""
archive_fetch.py — 历史广播归档抓取脚本

数据源：
  1. Internet Archive (1950-2020) — search_archive_org
  2. 蜻蜓 FM 回放 (2021-2025) — fetch_qingting_archive
  3. 云听回放 (2021-2025) — fetch_yunting_archive

抓取 → 下载 → 上传 R2 → 更新索引。

用法:
  python archive_fetch.py --year 1985                    # 单年抓取
  python archive_fetch.py --range 1950-2020              # 批量抓取
  python archive_fetch.py --range 2021-2025              # 近五年抓取
  python archive_fetch.py --source ia                    # 仅 Internet Archive
  python archive_fetch.py --source qingting              # 仅蜻蜓 FM
  python archive_fetch.py --source yunting               # 仅云听
  python archive_fetch.py --dry-run                      # 预览模式（不真实下载上传）
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import time
from datetime import datetime

# ============================================================
# R2 客户端（复用 r2_broadcast.py 的配置）
# ============================================================

try:
    import boto3
    from botocore.config import Config as BotoConfig
    HAS_BOTO3 = True
except ImportError:
    HAS_BOTO3 = False

try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False
    print("需要 requests: pip install requests")
    sys.exit(1)


def get_r2_client():
    """创建 Cloudflare R2 客户端"""
    if not HAS_BOTO3:
        print("需要 boto3: pip install boto3")
        sys.exit(1)

    from api._lib.config import R2_ACCOUNT_ID, R2_ACCESS_KEY, R2_SECRET_KEY, R2_BUCKET

    return boto3.client(
        "s3",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=R2_ACCESS_KEY,
        aws_secret_access_key=R2_SECRET_KEY,
        config=BotoConfig(region_name="auto"),
    ), R2_BUCKET


def upload_to_r2(r2, bucket, key, file_path, content_type="audio/mpeg"):
    """上传文件到 R2"""
    r2.upload_file(file_path, bucket, key, ExtraArgs={"ContentType": content_type})
    return f"r2://{bucket}/{key}"


def download_file(url, dest_path, timeout=60):
    """下载文件到本地"""
    resp = requests.get(url, stream=True, timeout=timeout, headers={
        "User-Agent": "elder-radio/1.0 (archive fetcher)"
    })
    resp.raise_for_status()
    with open(dest_path, "wb") as f:
        shutil.copyfileobj(resp.raw, f)
    return dest_path


# ============================================================
# R2 索引管理
# ============================================================

def load_index(r2, bucket):
    """加载 R2 _index.json"""
    try:
        obj = r2.get_object(Bucket=bucket, Key="broadcasts/_index.json")
        return json.loads(obj["Body"].read())
    except Exception:
        return {"years": {}}


def save_index(r2, bucket, index):
    """保存 R2 _index.json"""
    r2.put_object(
        Bucket=bucket,
        Key="broadcasts/_index.json",
        Body=json.dumps(index, ensure_ascii=False, indent=2),
        ContentType="application/json",
    )


def is_year_cached(index, year, source):
    """检查某年某源是否已缓存"""
    year_key = str(year)
    return (year_key in index.get("years", {}) and
            source in index["years"][year_key].get("sources", []))


def mark_year_cached(index, year, source, file_count):
    """标记某年某源已缓存"""
    year_key = str(year)
    if year_key not in index["years"]:
        index["years"][year_key] = {"sources": [], "file_count": 0, "updated": ""}
    if source not in index["years"][year_key]["sources"]:
        index["years"][year_key]["sources"].append(source)
    index["years"][year_key]["file_count"] += file_count
    index["years"][year_key]["updated"] = datetime.utcnow().isoformat()


# ============================================================
# 数据源 1：Internet Archive
# ============================================================

def search_archive_org(year, category="news", max_results=50):
    """
    检索 Internet Archive 上的历史广播音频。

    返回: [{title, audio_url, year, source: "archive.org"}]
    """
    results = []

    queries = [
        f"radio+china+{year}",
        f"{category}+broadcast+china+{year}",
        f"chinese+radio+broadcast+{year}",
    ]

    for query in queries:
        search_url = f"https://archive.org/advancedsearch.php"
        params = {
            "q": f"{query} AND mediatype:(audio)",
            "fl[]": ["identifier", "title", "year"],
            "sort[]": "downloads desc",
            "rows": max_results,
            "output": "json",
        }

        try:
            resp = requests.get(search_url, params=params, timeout=30)
            resp.raise_for_status()
            data = resp.json()
            docs = data.get("response", {}).get("docs", [])

            for doc in docs:
                identifier = doc.get("identifier", "")
                title = doc.get("title", "未知")

                # 获取具体文件列表
                meta_url = f"https://archive.org/metadata/{identifier}"
                meta_resp = requests.get(meta_url, timeout=30)
                meta_resp.raise_for_status()
                meta = meta_resp.json()

                for f in meta.get("files", []):
                    name = f.get("name", "")
                    fmt = f.get("format", "").lower()
                    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""

                    if ext in ("mp3", "wav", "ogg") or fmt in ("mp3", "vbr mp3"):
                        url = f"https://archive.org/download/{identifier}/{name}"
                        results.append({
                            "title": title,
                            "audio_url": url,
                            "year": year,
                            "source": "archive.org",
                            "identifier": identifier,
                        })
                        break  # 每个 item 只取第一个匹配文件

            if len(results) >= 10:
                break  # 找到足够多就停

        except Exception as e:
            print(f"  [IA] 查询失败 ({query}): {e}")
            continue

    print(f"  [IA] 找到 {len(results)} 个音频")
    return results


# ============================================================
# 数据源 2：蜻蜓 FM
# ============================================================

QINGTING_CHANNELS = {
    "zgzs": {"id": 334, "name": "中国之声"},
    "jjzs": {"id": 335, "name": "经济之声"},
    "yyzs": {"id": 336, "name": "音乐之声"},
}


def fetch_qingting_archive(year, channel_ids=None):
    """
    抓取蜻蜓 FM 某年份的节目回放。

    返回: [{date, title, audio_url, channel_name}]
    """
    if channel_ids is None:
        channel_ids = [ch["id"] for ch in QINGTING_CHANNELS.values()]

    results = []

    for channel_id in channel_ids:
        ch_info = next((ch for ch in QINGTING_CHANNELS.values() if ch["id"] == channel_id), None)
        ch_name = ch_info["name"] if ch_info else f"channel_{channel_id}"

        url = f"https://www.qingting.fm/api/v6/media/channels/{channel_id}/archive?year={year}"
        try:
            resp = requests.get(url, timeout=30, headers={
                "User-Agent": "Mozilla/5.0 (compatible; elder-radio/1.0)"
            })
            if resp.status_code == 404:
                print(f"  [蜻蜓] {ch_name} ({channel_id}): {year} 年无数据")
                continue
            resp.raise_for_status()
            data = resp.json()

            # 解析返回结构：{data: [{date, programs: [{title, audio_url}]}]}
            items = data.get("data", [])
            for item in items:
                date_str = item.get("date", "")
                programs = item.get("programs", [])
                for prog in programs:
                    audio_url = prog.get("audio_url") or prog.get("url") or ""
                    title = prog.get("title") or prog.get("name") or f"{ch_name} {date_str}"
                    if audio_url:
                        results.append({
                            "date": date_str,
                            "title": title,
                            "audio_url": audio_url,
                            "channel_name": ch_name,
                            "channel_key": ch_info.get("key", ch_name) if ch_info else ch_name,
                        })

            print(f"  [蜻蜓] {ch_name}: {len(items)} 天, {len([r for r in results if r['channel_name'] == ch_name])} 个节目")

        except Exception as e:
            print(f"  [蜻蜓] {ch_name} 抓取失败: {e}")

    return results


# ============================================================
# 数据源 3：云听
# ============================================================

YUNTING_CHANNELS = {
    "zgzs": "中国之声",
    "jjzs": "经济之声",
    "yyzs": "音乐之声",
}


def fetch_yunting_archive(year, channel="zgzs"):
    """
    爬取云听回放音频。

    返回: [{date, title, audio_url, channel_name}]
    """
    ch_name = YUNTING_CHANNELS.get(channel, channel)
    results = []

    for month in range(1, 13):
        url = f"https://radio.cnr.cn/live/history"

        params = {
            "channel": channel,
            "year": year,
            "month": str(month).zfill(2),
            "day": "",  # 获取整月列表
        }

        try:
            # POST 方式
            resp = requests.post(url, data=params, timeout=30, headers={
                "User-Agent": "Mozilla/5.0 (compatible; elder-radio/1.0)",
                "Referer": "https://radio.cnr.cn/",
            })

            if resp.status_code != 200:
                # 备选：GET 方式
                resp = requests.get(url, params=params, timeout=30, headers={
                    "User-Agent": "Mozilla/5.0 (compatible; elder-radio/1.0)",
                })

            if resp.status_code == 404:
                continue

            resp.raise_for_status()

            # 尝试解析 JSON/HTML
            content_type = resp.headers.get("Content-Type", "")
            if "json" in content_type:
                data = resp.json()
                items = data.get("list") or data.get("data") or data.get("items") or []
                for item in items:
                    audio_url = item.get("audio_url") or item.get("mp3_url") or ""
                    date_str = item.get("date") or item.get("day") or ""
                    title = item.get("title") or f"{ch_name} {date_str}"
                    if audio_url:
                        results.append({
                            "date": date_str,
                            "title": title,
                            "audio_url": audio_url,
                            "channel_name": ch_name,
                            "channel_key": channel,
                        })
            else:
                # HTML 解析：匹配 mp3 URL
                mp3_urls = re.findall(r'https?://[^"\'<>\s]+\.mp3[^"\'<>\s]*', resp.text)
                for mp3_url in mp3_urls:
                    # 提取日期信息
                    date_match = re.search(r'(\d{4}[-/]\d{2}[-/]\d{2})', resp.text)
                    date_str = date_match.group(1) if date_match else f"{year}-{month:02d}"

                    results.append({
                        "date": date_str,
                        "title": f"{ch_name} {date_str}",
                        "audio_url": mp3_url,
                        "channel_name": ch_name,
                        "channel_key": channel,
                    })

            print(f"  [云听] {ch_name} {year}-{month:02d}: {len([r for r in results if r.get('_month', month) == month])} 个节目")

        except Exception as e:
            print(f"  [云听] {ch_name} {year}-{month:02d} 抓取失败: {e}")
            continue

    print(f"  [云听] {ch_name} 总计: {len(results)} 个节目")
    return results


# ============================================================
# 批量抓取 & 入库
# ============================================================

def fetch_and_upload(r2, bucket, index, year, source, dry_run=False):
    """
    指定年份、来源的完整抓取→上传流程。
    """
    print(f"\n{'='*60}")
    print(f"年份: {year} | 来源: {source}")
    print(f"{'='*60}")

    if is_year_cached(index, year, source):
        print(f"  已缓存，跳过")
        return 0

    # 1. 抓取
    items = []
    if source == "ia":
        items = search_archive_org(year)
    elif source == "qingting":
        items = fetch_qingting_archive(year)
    elif source == "yunting":
        items = fetch_yunting_archive(year)
    else:
        print(f"  未知来源: {source}")
        return 0

    if not items:
        print(f"  无数据")
        mark_year_cached(index, year, source, 0)
        save_index(r2, bucket, index)
        return 0

    # 2. 下载 → 上传
    uploaded = 0
    for item in items:
        audio_url = item["audio_url"]
        if not audio_url:
            continue

        # 生成 R2 key
        title_slug = re.sub(r'[^\w\-]', '_', item.get("title", "unknown"))[:60]
        ext = audio_url.rsplit(".", 1)[-1].split("?")[0][:5]
        if ext not in ("mp3", "wav", "ogg"):
            ext = "mp3"

        if source == "ia":
            r2_key = f"broadcasts/{year}/archive/{title_slug}.{ext}"
        else:
            ch_key = item.get("channel_key", "unknown")
            date_str = item.get("date", "").replace("-", "")
            r2_key = f"broadcasts/{year}/{ch_key}/{date_str}_{title_slug}.{ext}"

        if dry_run:
            print(f"  [DRY-RUN] {audio_url[:80]}... → {r2_key}")
            uploaded += 1
            continue

        try:
            with tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False) as tmp:
                tmp_path = tmp.name
                download_file(audio_url, tmp_path)
                upload_to_r2(r2, bucket, r2_key, tmp_path)
                os.unlink(tmp_path)
                uploaded += 1
                print(f"  [{uploaded}/{len(items)}] {r2_key}")

        except Exception as e:
            print(f"  [失败] {audio_url[:60]}... → {e}")
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
            continue

    # 3. 更新索引
    mark_year_cached(index, year, source, uploaded)
    save_index(r2, bucket, index)
    print(f"\n  完成: {uploaded}/{len(items)} 个文件上传")

    return uploaded


# ============================================================
# 主入口
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="历史广播归档抓取脚本")
    parser.add_argument("--year", type=int, help="单年抓取")
    parser.add_argument("--range", type=str, help="年份范围，如 1950-2020")
    parser.add_argument("--source", type=str, default="all",
                        choices=["ia", "qingting", "yunting", "all"],
                        help="数据源")
    parser.add_argument("--dry-run", action="store_true", help="预览模式")
    args = parser.parse_args()

    years = []
    if args.year:
        years = [args.year]
    elif args.range:
        start, end = map(int, args.range.split("-"))
        years = list(range(start, end + 1))
    else:
        print("请指定 --year 或 --range")
        sys.exit(1)

    if args.dry_run:
        print(">>> 预览模式（不下载不上传）<<<\n")

    if not HAS_BOTO3 and not args.dry_run:
        print("需要 boto3: pip install boto3")
        sys.exit(1)

    if not args.dry_run:
        r2, bucket = get_r2_client()
        index = load_index(r2, bucket)
    else:
        r2 = bucket = index = None

    total = 0
    for year in years:
        if args.source == "all":
            for src in ["ia", "qingting", "yunting"]:
                # Internet Archive: 1950-2020
                if src == "ia" and year > 2020:
                    continue
                # 蜻蜓/云听: 2021-2025
                if src in ("qingting", "yunting") and year < 2021:
                    continue
                n = fetch_and_upload(r2, bucket, index, year, src, args.dry_run)
                total += n
        else:
            n = fetch_and_upload(r2, bucket, index, year, args.source, args.dry_run)
            total += n

    print(f"\n{'='*60}")
    print(f"总计: {total} 个文件")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
