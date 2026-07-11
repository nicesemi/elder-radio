#!/usr/bin/env python3
"""
五月天歌曲 → Kuwo 取链 → 下载 → R2 上传（按年份目录）
每首约 5-8 MB，133 首总计约 1 GB，预计耗时 15-30 分钟。
"""
import os, sys, json, ast, time, hashlib
import urllib.request, urllib.parse
import boto3
from pathlib import Path

# ============ 配置 ============
R2_ACCESS_KEY = "57161070c2bdd7fda32c8f6967c858aa"
R2_SECRET_KEY = "22b802816535b857c5f10c18ff91390794265847da2c6d08bbc3d174217a2dde"
R2_ENDPOINT   = "https://8c9e2df83d17acfe5b951a9d016a785c.r2.cloudflarestorage.com"
R2_BUCKET     = "radio"
R2_PREFIX     = "mayday"           # R2 上按 mayday/{year}/{title}.mp3 存储
PUBLIC_BASE   = "https://pub-0eec6c55dc714795a536617ead7ae89d.r2.dev"

KUWO_SEARCH   = "http://search.kuwo.cn/r.s"
KUWO_ANTI     = "https://antiserver.kuwo.cn/anti.s"
ARTIST        = "五月天"

SINGER_DATA   = Path(__file__).parent.parent / "frontend" / "singer_data.json"
BACKUP        = Path(__file__).parent.parent / "frontend" / "singer_data.json.bak"
TMP_DIR       = Path("/tmp/mayday_dl")
TMP_DIR.mkdir(parents=True, exist_ok=True)

RETRY_MAX     = 3
DELAY         = 1.5   # 每首歌间延迟秒数

# ============ Kuwo API ============
def kuwo_search(title: str) -> str | None:
    """搜索歌曲返回 MUSICRID"""
    query = f"{ARTIST} {title}"
    params = urllib.parse.urlencode({
        "all": query, "ft": "music", "itemset": "new_web",
        "pn": "0", "rn": "5", "rformat": "json", "encoding": "utf8"
    })
    req = urllib.request.Request(
        f"{KUWO_SEARCH}?{params}",
        headers={"User-Agent": "Mozilla/5.0"}
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        start = raw.find("{")
        if start < 0:
            return None
        data = ast.literal_eval(raw[start:])
        items = data.get("abslist", [])
        if not items:
            return None
        for item in items:
            if ARTIST in item.get("ARTIST", ""):
                return item.get("MUSICRID")
        return items[0].get("MUSICRID")
    except Exception as e:
        print(f"   搜索异常: {e}")
        return None

def kuwo_stream_url(rid: str) -> str | None:
    """通过 rid 获取 MP3 直链"""
    params = urllib.parse.urlencode({
        "type": "convert_url3", "rid": rid, "format": "mp3"
    })
    req = urllib.request.Request(
        f"{KUWO_ANTI}?{params}",
        headers={"User-Agent": "Mozilla/5.0"}
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if data.get("code") == 200 and data.get("url"):
            return data["url"]
        return None
    except Exception as e:
        print(f"   反代异常: {e}")
        return None

def download(url: str, dest: Path) -> bool:
    """下载文件到本地"""
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://www.kuwo.cn/"
    })
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            total = int(resp.headers.get("Content-Length", 0))
            data = resp.read()
        dest.write_bytes(data)
        size_mb = len(data) / 1024 / 1024
        print(f"   下载完成 {size_mb:.1f} MB")
        return True
    except Exception as e:
        print(f"   下载失败: {e}")
        return False

# ============ R2 上传 ============
_s3 = None
def get_s3():
    global _s3
    if _s3 is None:
        _s3 = boto3.client(
            "s3",
            endpoint_url=R2_ENDPOINT,
            aws_access_key_id=R2_ACCESS_KEY,
            aws_secret_access_key=R2_SECRET_KEY,
        )
    return _s3

def upload_to_r2(local_path: Path, r2_key: str) -> str:
    """上传到 R2，返回公开 URL"""
    s3 = get_s3()
    content_type = "audio/mpeg"
    s3.upload_file(
        str(local_path), R2_BUCKET, r2_key,
        ExtraArgs={"ContentType": content_type, "ACL": "public-read"}
    )
    return f"{PUBLIC_BASE}/{r2_key}"

# ============ 主流程 ============
def main():
    print("=" * 60)
    print("五月天歌曲 → Kuwo → R2 全量同步")
    print(f"Bucket: {R2_BUCKET} | 前缀: {R2_PREFIX}")
    print("=" * 60)

    # 备份原数据
    import shutil
    shutil.copy(SINGER_DATA, BACKUP)
    print(f"\n已备份 singer_data.json → .bak")

    # 加载数据
    data = json.loads(SINGER_DATA.read_text())
    mayday = next((s for s in data["singers"] if s["name"] == ARTIST), None)
    if not mayday:
        print("未找到五月天数据"); sys.exit(1)

    # 收集所有歌曲
    all_songs = []
    songs_by_year = mayday.get("songs_by_year", {})
    for year_str in sorted(songs_by_year.keys(), key=int):
        for song in songs_by_year[year_str]:
            all_songs.append({
                "year": year_str,
                "title": song["title"],
            })

    total = len(all_songs)
    print(f"共 {total} 首待处理\n")

    # 逐个处理
    success, failed = 0, 0
    for i, song in enumerate(all_songs):
        title = song["title"]
        year = song["year"]
        progress = f"[{i+1}/{total}]"

        print(f"{progress} {year}年 - {title}")

        # 清理文件名
        safe_title = title.replace("/", "／").replace(":", "：")

        # 获取流链接
        rid = None
        for retry in range(RETRY_MAX):
            rid = kuwo_search(title)
            if rid:
                break
            time.sleep(1)

        if not rid:
            print("   ❌ 搜索无结果")
            failed += 1
            continue

        stream_url = kuwo_stream_url(rid)
        if not stream_url:
            print("   ❌ 获取流链接失败")
            failed += 1
            continue

        # 下载
        tmp_file = TMP_DIR / f"{year}_{safe_title}.mp3"
        if not download(stream_url, tmp_file):
            failed += 1
            continue

        # 上传 R2
        r2_key = f"{R2_PREFIX}/{year}/{safe_title}.mp3"
        try:
            public_url = upload_to_r2(tmp_file, r2_key)
            print(f"   ✅ R2: {public_url}")

            # 更新数据中的 stream_url
            for s in songs_by_year[year]:
                if s["title"] == title:
                    s["stream_url"] = public_url
                    s["has_stream"] = True
                    break

            success += 1
        except Exception as e:
            print(f"   ❌ R2 上传失败: {e}")
            failed += 1

        # 清理临时文件（跳过，Marvis 环境限制）
        # tmp_file.unlink(missing_ok=True)

        # 延迟
        if i < total - 1:
            time.sleep(DELAY)

    # 写回 JSON
    output = json.dumps(data, ensure_ascii=False, indent=2)
    SINGER_DATA.write_text(output)

    print(f"\n{'=' * 60}")
    print(f"完成: {success} 成功, {failed} 失败（共 {total} 首）")
    print(f"singer_data.json 已更新（备份: .bak）")
    print(f"记得 git commit & push 使 Vercel 生效")

if __name__ == "__main__":
    main()
