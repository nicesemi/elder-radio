#!/usr/bin/env python3
"""
年代内容生成脚本 (Era Content Generator)
=========================================
批量调用 /api/broadcast/generate 为 1949-2019 生成 AI 广播稿（新闻频道 + 音乐频道），
调用 /api/tts 将广播稿合成为音频，上传到 R2 并更新索引。

用法:
    python generate_era_content.py --start 1949 --end 1978
    python generate_era_content.py --start 1979 --end 2019 --concurrency 3
    python generate_era_content.py --channel news --start 1950 --end 1960
    python generate_era_content.py --resume  # 从上次中断处继续
"""

import argparse
import asyncio
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import httpx

# ---------- 配置 ----------
API_BASE = os.environ.get("API_BASE", "http://localhost:8000")
R2_BUCKET = "radio"
R2_PUBLIC_BASE = "https://pub-0eec6c55dc714795a536617ead7ae89d.r2.dev"

# 断点文件路径
PROGRESS_FILE = Path(__file__).parent / ".generate_era_progress.json"

# 默认并发数
DEFAULT_CONCURRENCY = 3


# ---------- R2 工具 ----------
def get_s3_client():
    """延迟初始化 boto3 S3 客户端"""
    import boto3
    return boto3.client(
        "s3",
        endpoint_url="https://8c9e2df83d17acfe5b951a9d016a785c.r2.cloudflarestorage.com",
        aws_access_key_id="57161070c2bdd7fda32c8f6967c858aa",
        aws_secret_access_key="22b802816535b857c5f10c18ff91390794265847da2c6d08bbc3d174217a2dde",
    )


def load_index(s3) -> dict:
    """加载 R2 broadcasts/_index.json"""
    try:
        resp = s3.get_object(Bucket=R2_BUCKET, Key="broadcasts/_index.json")
        return json.loads(resp["Body"].read().decode("utf-8"))
    except Exception:
        return {}


def save_index(s3, index_data: dict):
    """保存 R2 broadcasts/_index.json"""
    s3.put_object(
        Bucket=R2_BUCKET,
        Key="broadcasts/_index.json",
        Body=json.dumps(index_data, ensure_ascii=False, indent=2).encode("utf-8"),
        ContentType="application/json",
        ACL="public-read",
    )
    print(f"[Index] 已更新 broadcasts/_index.json ({len(index_data)} 个年份)")


def upload_audio_to_r2(s3, audio_bytes: bytes, year: int, category: str, filename: str) -> str:
    """上传音频到 R2 并返回公开 URL"""
    key = f"broadcasts/{year}/{category}/{filename}"
    s3.put_object(
        Bucket=R2_BUCKET,
        Key=key,
        Body=audio_bytes,
        ContentType="audio/mpeg",
        ACL="public-read",
    )
    url = f"{R2_PUBLIC_BASE}/{key}"
    print(f"  [R2] 上传成功: {key}")
    return url


# ---------- 断点续传 ----------
def load_progress() -> dict:
    """加载断点进度"""
    if PROGRESS_FILE.exists():
        with open(PROGRESS_FILE, "r") as f:
            return json.load(f)
    return {"completed": {}, "in_progress": None}


def save_progress(progress: dict):
    """保存断点进度"""
    with open(PROGRESS_FILE, "w") as f:
        json.dump(progress, f, ensure_ascii=False, indent=2)


# ---------- API 调用 ----------
async def generate_broadcast(client: httpx.AsyncClient, year: int, channel: str) -> dict:
    """调用 /api/broadcast/generate 生成 AI 广播稿"""
    url = f"{API_BASE}/api/broadcast/generate"
    payload = {
        "channel": channel,
        "year": year,
        "duration": 3,  # 3 分钟广播稿
    }
    resp = await client.post(url, json=payload, timeout=120.0)
    resp.raise_for_status()
    return resp.json()


async def download_audio(client: httpx.AsyncClient, audio_url: str) -> bytes:
    """下载生成的音频文件"""
    # 处理相对路径
    if audio_url.startswith("/api/audio/"):
        audio_url = f"{API_BASE}{audio_url}"

    resp = await client.get(audio_url, timeout=120.0)
    resp.raise_for_status()
    return resp.content


# ---------- 核心逻辑 ----------
async def process_year(
    client: httpx.AsyncClient,
    s3,
    year: int,
    channels: list,
    semaphore: asyncio.Semaphore,
    progress: dict,
    force: bool = False,
) -> dict:
    """
    处理单个年份：生成广播稿 → 下载音频 → 上传 R2 → 更新索引。
    返回 {"year": year, "news": N, "music": M} 或错误信息。
    """
    year_key = str(year)
    result = {"year": year, "news": 0, "music": 0}

    for channel in channels:
        progress_key = f"{year_key}_{channel}"

        # 断点续传：已完成则跳过
        if not force and progress_key in progress.get("completed", {}):
            print(f"[Skip] {year}/{channel} 已完成，跳过")
            result[channel] = progress["completed"][progress_key]
            continue

        async with semaphore:
            print(f"[Generate] {year}/{channel} 开始生成...")
            try:
                # Step 1: 生成广播稿 + TTS
                gen_result = await generate_broadcast(client, year, channel)

                if not gen_result.get("success"):
                    print(f"  [Error] {year}/{channel} 生成失败: {gen_result}")
                    continue

                audio_url = gen_result.get("audio_url")
                if not audio_url:
                    print(f"  [Error] {year}/{channel} 无 audio_url")
                    continue

                # Step 2: 下载音频
                print(f"  [Download] {year}/{channel} 下载音频...")
                audio_bytes = await download_audio(client, audio_url)

                if not audio_bytes or len(audio_bytes) < 1024:
                    print(f"  [Error] {year}/{channel} 音频过小 ({len(audio_bytes)} bytes)")
                    continue

                # Step 3: 上传到 R2
                ts = int(time.time())
                filename = f"ai_{year}_{channel}_{ts}.mp3"
                r2_url = upload_audio_to_r2(s3, audio_bytes, year, channel, filename)

                # Step 4: 更新进度
                if year_key not in progress.setdefault("completed", {}):
                    progress["completed"][year_key] = {}
                count = progress["completed"].get(year_key, {}).get(channel, 0) + 1
                if year_key not in progress["completed"]:
                    progress["completed"][year_key] = {}
                progress["completed"][year_key][channel] = count
                if progress_key not in progress["completed"]:
                    progress["completed"][progress_key] = count

                result[channel] = count
                print(f"  [OK] {year}/{channel} → {r2_url}")

            except httpx.HTTPStatusError as e:
                print(f"  [HTTP Error] {year}/{channel}: {e.response.status_code} - {e.response.text[:200]}")
            except httpx.TimeoutException:
                print(f"  [Timeout] {year}/{channel} 请求超时")
            except Exception as e:
                print(f"  [Error] {year}/{channel}: {type(e).__name__}: {e}")

        # 请求间礼貌延迟
        await asyncio.sleep(1.0)

    return result


async def main():
    parser = argparse.ArgumentParser(description="年代内容生成脚本")
    parser.add_argument("--start", type=int, default=1949, help="起始年份 (默认: 1949)")
    parser.add_argument("--end", type=int, default=2019, help="结束年份 (默认: 2019)")
    parser.add_argument("--channel", type=str, default=None,
                        help="仅生成指定频道: news | music (默认: 两个频道都生成)")
    parser.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY,
                        help=f"并发数 (默认: {DEFAULT_CONCURRENCY})")
    parser.add_argument("--force", action="store_true", help="强制重新生成已完成年份")
    parser.add_argument("--resume", action="store_true", help="从上次中断处继续 (忽略 --start)")
    parser.add_argument("--api-base", type=str, default=API_BASE,
                        help=f"API 服务地址 (默认: {API_BASE})")
    args = parser.parse_args()

    global API_BASE
    API_BASE = args.api_base.rstrip("/")

    channels = [args.channel] if args.channel else ["news", "music"]

    # 加载进度
    progress = load_progress()

    # 断点续传
    if args.resume and progress.get("in_progress"):
        year_range_start = progress["in_progress"]
        year_range_end = args.end
        print(f"[Resume] 从 {year_range_start} 继续")
    else:
        year_range_start = args.start
        year_range_end = args.end

    if year_range_start < 1949:
        year_range_start = 1949
    if year_range_end > 2019:
        year_range_end = 2019

    years = list(range(year_range_start, year_range_end + 1))
    total_tasks = len(years) * len(channels)

    print(f"=" * 60)
    print(f"年代内容生成器")
    print(f"年份范围: {year_range_start} - {year_range_end} ({len(years)} 年)")
    print(f"频道: {', '.join(channels)}")
    print(f"并发数: {args.concurrency}")
    print(f"强制: {'是' if args.force else '否'}")
    print(f"总任务数: {total_tasks}")
    print(f"=" * 60)

    # 初始化 S3
    s3 = get_s3_client()

    # 并发控制
    semaphore = asyncio.Semaphore(args.concurrency)

    # 发起任务
    async with httpx.AsyncClient(timeout=120.0) as client:
        tasks = []
        for year in years:
            progress["in_progress"] = year
            save_progress(progress)

            task = process_year(
                client, s3, year, channels, semaphore, progress, force=args.force
            )
            tasks.append(task)

        # 等待所有任务完成
        results = await asyncio.gather(*tasks, return_exceptions=True)

    # 汇总
    success_count = 0
    fail_count = 0
    index_data = load_index(s3)

    for r in results:
        if isinstance(r, Exception):
            fail_count += 1
            print(f"[Task Error] {r}")
            continue
        if isinstance(r, dict) and r.get("year"):
            year_key = str(r["year"])
            news_count = r.get("news", 0)
            music_count = r.get("music", 0)
            total = news_count + music_count
            if total > 0:
                success_count += 1
                index_data[year_key] = {
                    "news_count": news_count,
                    "music_count": music_count,
                    "total": total,
                    "updated_at": datetime.now().isoformat(),
                }
            else:
                fail_count += 1
        else:
            fail_count += 1

    # 更新索引
    save_index(s3, index_data)

    # 清理进度文件
    progress["in_progress"] = None
    save_progress(progress)

    print(f"\n{'=' * 60}")
    print(f"生成完成！")
    print(f"成功: {success_count} 年")
    print(f"失败/无数据: {fail_count} 年")
    print(f"索引已更新: broadcasts/_index.json")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    asyncio.run(main())
