#!/usr/bin/env python3
"""
fetch_archive_broadcasts.py — Internet Archive 广播档案采集脚本
搜索 1950-2020 年代中国广播录音，下载并上传到 R2。

用法:
  python fetch_archive_broadcasts.py                    # 全量采集 1950-2020
  python fetch_archive_broadcasts.py --year 1980        # 单年
  python fetch_archive_broadcasts.py --year 1980,1990,2000  # 多年
  python fetch_archive_broadcasts.py --dry-run          # 预览模式
  python fetch_archive_broadcasts.py --max-per-year 5   # 每年最多下载数
"""

import argparse
import json
import os
import re
import sys
import time
import tempfile
import urllib.request
import urllib.parse
import urllib.error
from pathlib import Path

# ============ R2 配置 ============
R2_ACCESS_KEY = "57161070c2bdd7fda32c8f6967c858aa"
R2_SECRET_KEY = "22b802816535b857c5f10c18ff91390794265847da2c6d08bbc3d174217a2dde"
R2_ENDPOINT   = "https://8c9e2df83d17acfe5b951a9d016a785c.r2.cloudflarestorage.com"
R2_BUCKET     = "radio"
PUBLIC_BASE   = "https://pub-0eec6c55dc714795a536617ead7ae89d.r2.dev"

# ============ Archive API 配置 ============
ARCHIVE_SEARCH_URL   = "https://archive.org/advancedsearch.php"
ARCHIVE_METADATA_URL = "https://archive.org/metadata/"
REQUEST_INTERVAL     = 1.5  # 请求间隔（秒）

# ============ 搜索关键词组 ============
SEARCH_QUERIES = [
    # 中文关键词
    "央广 {year}",
    "中央人民广播电台 {year}",
    "中国广播 {year}",
    "CNR {year}",
    # 英文关键词
    "china radio broadcast {year}",
    "chinese radio {year}",
    "radio china {year}",
    # 宽泛关键词（按 decade）
    "china radio {decade_start}",
    "中国 广播 {decade_start}",
]

# ============ 状态文件 ============
SCRIPT_DIR = Path(__file__).parent
STATE_FILE = SCRIPT_DIR / ".archive_state.json"

def load_state() -> dict:
    """加载断点续传状态"""
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {"downloaded_ids": [], "years_done": {}}


def save_state(state: dict):
    """保存断点续传状态"""
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2))


# ============ R2 客户端 ============
_s3_client = None

def _get_s3():
    global _s3_client
    if _s3_client is None:
        import boto3
        _s3_client = boto3.client(
            "s3",
            endpoint_url=R2_ENDPOINT,
            aws_access_key_id=R2_ACCESS_KEY,
            aws_secret_access_key=R2_SECRET_KEY,
        )
    return _s3_client


def upload_to_r2(local_path: Path, year: int, filename: str) -> str:
    """上传文件到 R2，返回公开 URL"""
    s3 = _get_s3()
    key = f"broadcasts/{year}/archive/{filename}"
    s3.upload_file(
        str(local_path), R2_BUCKET, key,
        ExtraArgs={"ContentType": "audio/mpeg", "ACL": "public-read"}
    )
    return f"{PUBLIC_BASE}/{key}"


# ============ Internet Archive 搜索 ============

def _search_archive(query: str, max_rows: int = 50) -> list:
    """搜索 Archive Advanced Search API，返回 docs 列表"""
    params = urllib.parse.urlencode({
        "q": f"{query} AND mediatype:(audio)",
        "fl[]": ["identifier", "title", "year"],
        "sort[]": "downloads desc",
        "rows": str(max_rows),
        "output": "json",
    })
    url = f"{ARCHIVE_SEARCH_URL}?{params}"

    req = urllib.request.Request(url, headers={"User-Agent": "elder-radio/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data.get("response", {}).get("docs", [])
    except Exception as e:
        print(f"  [搜索失败] {query[:50]}... → {e}")
        return []


def _get_audio_files(identifier: str) -> list:
    """获取某个 identifier 下的音频文件 URL 列表"""
    meta_url = f"{ARCHIVE_METADATA_URL}{identifier}"
    req = urllib.request.Request(meta_url, headers={"User-Agent": "elder-radio/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            meta = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"    [metadata 失败] {identifier[:40]}... → {e}")
        return []

    audio_files = []
    for f in meta.get("files", []):
        name = f.get("name", "")
        fmt = (f.get("format") or "").lower()
        size_str = f.get("size", "0")

        # 只取可播放音频
        if name.endswith((".mp3", ".ogg", ".wav", ".flac")) or fmt in ("mp3", "vbr mp3", "ogg vorbis"):
            download_url = f"https://archive.org/download/{identifier}/{name}"
            try:
                size = int(size_str)
            except (ValueError, TypeError):
                size = 0
            audio_files.append({
                "name": name,
                "url": download_url,
                "format": fmt,
                "size": size,
            })

    return audio_files


def _download_file(url: str, dest: Path, timeout: int = 120) -> bool:
    """下载文件到本地路径"""
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; elder-radio/1.0)"
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read()
        dest.write_bytes(data)
        size_mb = len(data) / (1024 * 1024)
        if size_mb < 0.05:
            print(f"    ⚠ 文件太小 ({size_mb:.2f} MB)，跳过")
            return False
        print(f"    下载完成 {size_mb:.1f} MB")
        return True
    except Exception as e:
        print(f"    [下载失败] {e}")
        return False


def _sanitize_filename(title: str, max_len: int = 80) -> str:
    """清理文件名"""
    cleaned = re.sub(r'[<>:"/\\|?*]', '_', title)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    return cleaned[:max_len]


# ============ 主采集逻辑 ============

def fetch_year(year: int, state: dict, dry_run: bool = False, max_per_year: int = 10) -> int:
    """采集某一年份的广播音频"""
    decade_start = (year // 10) * 10
    year_str = str(year)

    print(f"\n{'='*60}")
    print(f"📻 {year} 年广播采集 | decade: {decade_start}s")
    print(f"{'='*60}")

    # 断点续传：整年已标记完成则跳过
    if year_str in state.get("years_done", {}):
        done_count = state["years_done"][year_str]
        print(f"  已完成，跳过（已采集 {done_count} 个）")
        return 0

    # 搜索：所有关键词
    all_docs = {}
    for query_template in SEARCH_QUERIES:
        query = query_template.format(year=year, decade_start=decade_start)
        docs = _search_archive(query)
        for doc in docs:
            ident = doc.get("identifier", "")
            if ident and ident not in all_docs:
                all_docs[ident] = doc
        time.sleep(REQUEST_INTERVAL)

    # 去重 + 过滤已下载
    downloaded_ids = set(state.get("downloaded_ids", []))
    new_docs = {k: v for k, v in all_docs.items() if k not in downloaded_ids}

    print(f"  搜索到 {len(all_docs)} 个唯一 identifier（去重后），{len(new_docs)} 个未下载")

    if not new_docs:
        state.setdefault("years_done", {})[year_str] = 0
        save_state(state)
        return 0

    # 逐个获取音频文件 + 下载上传
    uploaded = 0
    for identifier, doc in list(new_docs.items())[:max_per_year * 2]:
        print(f"\n  📁 {identifier[:60]}...")
        title = doc.get("title", identifier)

        audio_files = _get_audio_files(identifier)
        time.sleep(REQUEST_INTERVAL * 0.5)

        if not audio_files:
            continue

        # 挑选最小的 mp3（避免单个超大文件）
        mp3_files = [f for f in audio_files if f["name"].endswith(".mp3") or f["format"] in ("mp3", "vbr mp3")]
        candidates = mp3_files if mp3_files else audio_files
        candidates.sort(key=lambda x: x.get("size", 0))

        for af in candidates[:1]:  # 只取第一个
            safe_name = _sanitize_filename(f"{identifier}_{af['name']}")
            if not safe_name.lower().endswith((".mp3", ".ogg", ".wav", ".flac")):
                safe_name += ".mp3"

            if dry_run:
                print(f"    [DRY-RUN] {af['url'][:80]}... → broadcasts/{year}/archive/{safe_name}")
                uploaded += 1
                state["downloaded_ids"].append(identifier)
                break

            # 下载
            with tempfile.NamedTemporaryFile(suffix=".tmp", delete=False) as tmp:
                tmp_path = Path(tmp.name)

            try:
                if _download_file(af["url"], tmp_path):
                    r2_url = upload_to_r2(tmp_path, year, safe_name)
                    print(f"    ✅ R2: {r2_url}")
                    uploaded += 1
                    state["downloaded_ids"].append(identifier)
                    save_state(state)
            except Exception as e:
                print(f"    ❌ 处理失败: {e}")
            finally:
                if tmp_path.exists():
                    tmp_path.unlink(missing_ok=True)

            break  # 每个 identifier 只取一个文件

        if uploaded >= max_per_year:
            print(f"  已达上限 {max_per_year}，停止")
            break

    # 标记年份完成
    state.setdefault("years_done", {})[year_str] = uploaded
    save_state(state)
    print(f"\n  {year} 年完成: {uploaded} 个音频上传")
    return uploaded


def main():
    parser = argparse.ArgumentParser(description="Internet Archive 广播档案采集")
    parser.add_argument("--year", type=str, default="",
                        help="单年或逗号分隔多年，如 '1980' 或 '1980,1990,2000'")
    parser.add_argument("--dry-run", action="store_true", help="预览模式")
    parser.add_argument("--max-per-year", type=int, default=5,
                        help="每年最多下载数（默认 5）")
    parser.add_argument("--reset", action="store_true", help="清除断点续传状态重新采集")
    args = parser.parse_args()

    # 年份解析
    if args.year:
        years = [int(y.strip()) for y in args.year.split(",")]
    else:
        years = list(range(1950, 2021))

    # 状态文件
    if args.reset and STATE_FILE.exists():
        STATE_FILE.unlink()
        print("已清除断点续传状态")

    state = load_state()
    print(f"状态: 已下载 {len(state.get('downloaded_ids', []))} 个 identifier, "
          f"已完成 {len(state.get('years_done', {}))} 个年份")

    total = 0
    for y in years:
        n = fetch_year(y, state, dry_run=args.dry_run, max_per_year=args.max_per_year)
        total += n

    print(f"\n{'='*60}")
    print(f"🎯 总计: {total} 个音频文件")
    if not args.dry_run:
        print(f"R2 路径: broadcasts/{{year}}/archive/")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
