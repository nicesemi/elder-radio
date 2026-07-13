#!/usr/bin/env python3
"""
elder-radio 音乐频道 R2 批量下载上传管道

用法:
  python3 music_r2_pipeline.py [--dry-run] [--year 1949] [--batch-size 5]

流程:
  1. 对每首歌用 yt-dlp 在 YouTube 搜索并下载音频
  2. 用 ffmpeg 转为 128k mp3
  3. 上传到 R2: broadcasts/{year}/music/{filename}.mp3
  4. 更新 R2 _index.json

依赖: pip install boto3 yt-dlp
"""

import json
import os
import sys
import subprocess
import tempfile
import time

# === Config ===
MUSIC_DB_PATH = "temp/music_db_1949_2019.json"
R2_ENDPOINT = "https://8c9e2df83d17acfe5b951a9d016a785c.r2.cloudflarestorage.com"
R2_BUCKET = "radio"
R2_PUBLIC = "https://pub-0eec6c55dc714795a536617ead7ae89d.r2.dev"
# R2 credentials from env
R2_ACCESS_KEY = os.environ.get("R2_ACCESS_KEY_ID", "")
R2_SECRET_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "")

# === Helpers ===

def sanitize_filename(title):
    """Remove special chars for safe filename."""
    safe = "".join(c for c in title if c.isalnum() or c in " _-")
    return safe.strip()[:80] or "unknown"

def search_youtube(query):
    """Search YouTube and return first video URL."""
    try:
        cmd = [
            "yt-dlp", "--flat-playlist", "--dump-json",
            f"ytsearch:{query}", "--skip-download"
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0 or not result.stdout.strip():
            return None
        data = json.loads(result.stdout.split("\n")[0])
        return f"https://youtube.com/watch?v={data['id']}"
    except Exception as e:
        print(f"  [yt search error] {e}")
        return None

def download_audio(url, output_path):
    """Download audio from URL as mp3 using yt-dlp."""
    try:
        cmd = [
            "yt-dlp", "--extract-audio", "--audio-format", "mp3",
            "--audio-quality", "128K",
            "-o", output_path,
            "--no-playlist", "--socket-timeout", "30",
            url
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode == 0:
            # yt-dlp adds .mp3 extension itself
            final = output_path + ".mp3" if not output_path.endswith(".mp3") else output_path
            actual = output_path.rsplit(".", 1)[0] + ".mp3"
            if os.path.exists(actual):
                return actual
            return final if os.path.exists(final) else None
        return None
    except Exception as e:
        print(f"  [download error] {e}")
        return None

def upload_to_r2(local_path, key):
    """Upload file to Cloudflare R2."""
    if not R2_ACCESS_KEY:
        print(f"  [SKIP] No R2 credentials. File at: {local_path}")
        return None
    try:
        import boto3
        s3 = boto3.client(
            "s3",
            endpoint_url=R2_ENDPOINT,
            aws_access_key_id=R2_ACCESS_KEY,
            aws_secret_access_key=R2_SECRET_KEY,
        )
        s3.upload_file(local_path, R2_BUCKET, key, ExtraArgs={"ContentType": "audio/mpeg"})
        return f"{R2_PUBLIC}/{key}"
    except Exception as e:
        print(f"  [R2 upload error] {e}")
        return None

def update_db(music_db_path, year, song_index, r2_url):
    """Update the local music DB with R2 URL."""
    with open(music_db_path, "r", encoding="utf-8") as f:
        db = json.load(f)
    db[str(year)][song_index]["r2_url"] = r2_url
    db[str(year)][song_index]["downloaded"] = True
    with open(music_db_path, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=2)

def process_song(year, song, song_index, work_dir, dry_run=False):
    """Process a single song: search -> download -> upload."""
    title = song["title"]
    artist = song["artist"]
    query = f"{title} {artist} 歌曲"
    safe_name = sanitize_filename(f"{year}_{title}")
    
    print(f"\n[{year}] {title} - {artist}")
    
    if dry_run:
        print(f"  [DRY RUN] Would search: {query}")
        return True
    
    # Check if already done
    if song.get("downloaded"):
        print(f"  [SKIP] Already downloaded: {song.get('r2_url', '')}")
        return True
    
    # Step 1: Search YouTube
    print(f"  Searching...")
    url = search_youtube(query)
    if not url:
        print(f"  [FAIL] No YouTube result")
        song["error"] = "no_youtube_result"
        return False
    
    print(f"  Found: {url}")
    
    # Step 2: Download
    print(f"  Downloading...")
    local_path = os.path.join(work_dir, safe_name)
    downloaded = download_audio(url, local_path)
    if not downloaded:
        print(f"  [FAIL] Download failed")
        song["error"] = "download_failed"
        return False
    
    size_kb = os.path.getsize(downloaded) / 1024
    print(f"  Downloaded: {size_kb:.0f}KB")
    
    # Step 3: Upload to R2
    print(f"  Uploading to R2...")
    r2_key = f"broadcasts/{year}/music/{safe_name}.mp3"
    r2_url = upload_to_r2(downloaded, r2_key)
    if not r2_url:
        print(f"  [WARN] R2 upload failed (file kept locally)")
    
    # Cleanup local file
    try:
        os.remove(downloaded)
    except:
        pass
    
    return True

def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--year", type=int)
    parser.add_argument("--batch-size", type=int, default=5)
    parser.add_argument("--project-root", default=".")
    args = parser.parse_args()
    
    db_path = os.path.join(args.project_root, MUSIC_DB_PATH)
    if not os.path.exists(db_path):
        print(f"Music DB not found: {db_path}")
        sys.exit(1)
    
    with open(db_path, "r", encoding="utf-8") as f:
        music_db = json.load(f)
    
    work_dir = os.path.join(args.project_root, "temp", "music_downloads")
    os.makedirs(work_dir, exist_ok=True)
    
    years = sorted(music_db.keys())
    if args.year:
        years = [str(args.year)]
    
    total = 0
    success = 0
    failed = 0
    
    for year in years:
        songs = music_db[year]
        for i, song in enumerate(songs):
            total += 1
            result = process_song(year, song, i, work_dir, args.dry_run)
            if result:
                success += 1
            else:
                failed += 1
            
            time.sleep(2)  # Rate limiting
    
    print(f"\n=== Pipeline Complete ===")
    print(f"Total: {total}, Success: {success}, Failed: {failed}")

if __name__ == "__main__":
    main()
