#!/usr/bin/env python3
"""
批量生成 1949-2019 年 news/novel 频道 AI 文字内容，存入 R2。

用法:
    python3 tools/generate_era_text.py [--start YEAR] [--end YEAR] [--channel CHANNEL] [--dry-run]

    --start    起始年份（默认 1949）
    --end      结束年份（默认 2019）
    --channel  频道: news | novel | all（默认 all）
    --dry-run  仅生成不写入 R2
    --retry    遇到失败自动重试次数（默认 2）

示例:
    python3 tools/generate_era_text.py --start 1949 --end 1951 --channel news
    python3 tools/generate_era_text.py --dry-run
"""

import os
import sys
import json
import time
import socket
import argparse
import traceback
from pathlib import Path
from datetime import datetime

# ==================== 路径设置 ====================
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "api" / "_lib"))

# ==================== 加载 .env ====================
env_path = PROJECT_ROOT / ".env"
if env_path.exists():
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ[k.strip()] = v.strip()

# ==================== IPv4 Monkey-Patch ====================
# httpx 在 macOS 上默认走 IPv6 会导致 Agnes API 返回 503
_orig_getaddrinfo = socket.getaddrinfo

def _v4_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)

socket.getaddrinfo = _v4_getaddrinfo

# ==================== 配置 ====================
AGNES_BASE_URL = "https://apihub.agnes-ai.com/v1"
AGNES_API_KEY = os.environ.get("AGNES_API_KEY", "")
AGNES_MODEL = "agnes-2.0-flash"

R2_ACCESS_KEY = "57161070c2bdd7fda32c8f6967c858aa"
R2_SECRET_KEY = "22b802816535b857c5f10c18ff91390794265847da2c6d08bbc3d174217a2dde"
R2_ENDPOINT   = "https://8c9e2df83d17acfe5b951a9d016a785c.r2.cloudflarestorage.com"
R2_BUCKET     = "radio"

# ==================== 年代描述 ====================
ERA_CONFIG = {
    (1949, 1959): ("1950s", "新中国成立初期"),
    (1960, 1969): ("1960s", "社会主义建设时期"),
    (1970, 1979): ("1970s", "文革后期至改革开放前夕"),
    (1980, 1989): ("1980s", "改革开放初期"),
    (1990, 1999): ("1990s", "九十年代市场经济转型期"),
    (2000, 2009): ("2000s", "新世纪互联网兴起时期"),
    (2010, 2019): ("2010s", "移动互联网时代"),
}

BROADCASTER_VOICES = {
    "1950s": {"description": "字正腔圆、铿锵有力，延安/开国时期广播风格"},
    "1960s": {"description": "热情饱满、斗志昂扬，社会主义建设时期风格"},
    "1970s": {"description": "庄重严肃、字正腔圆，特殊年代广播风格"},
    "1980s": {"description": "亲切自然、温暖有力，改革开放时期风格"},
    "1990s": {"description": "流畅活泼、专业规范，市场经济转型期风格"},
    "2000s": {"description": "现代清新、亲和力强，新世纪风格"},
    "2010s": {"description": "时尚亲和、节奏明快，移动互联网时代风格"},
    "2020s": {"description": "清晰温和、智能感，AI时代风格"},
}

CHANNELS_CONFIG = {
    "news": {
        "name": "新闻频道",
        "category": "新闻/综合",
        "duration_minutes": 3,
        "target_words": 900,
    },
    "novel": {
        "name": "小说频道",
        "category": "广播剧/有声小说",
        "duration_minutes": 3,
        "target_words": 900,
    },
}


def get_era_info(year):
    """获取年代信息"""
    for (start, end), (era, desc) in ERA_CONFIG.items():
        if start <= year <= end:
            return era, desc
    return "2020s", "AI智能时代"


def get_voice_desc(year):
    era, _ = get_era_info(year)
    return BROADCASTER_VOICES.get(era, BROADCASTER_VOICES["2020s"])["description"]


# ==================== AI 内容生成 ====================

def build_news_prompt(year, duration_minutes):
    """构建新闻频道 prompt"""
    era, era_desc = get_era_info(year)
    voice_desc = get_voice_desc(year)
    target_words = 500 * duration_minutes

    system_prompt = f"""你是一个专业的广播电台内容编辑，专门为老年人听众创作广播节目。

你的任务是生成{year}年的新闻频道广播稿。

历史背景：{era_desc}
播音风格：{voice_desc}

要求：
1. 内容必须符合{year}年前后的历史真实情况，不能出现该年代不存在的事物
2. 语言风格要符合那个年代的表达方式，让老年听众有亲切感和怀旧感
3. 请选取该年份 3-5 个最重要的国内外新闻事件进行播报
4. 内容时长约{duration_minutes}分钟（约{target_words}字）
5. 开头要有"各位听众朋友，欢迎收听..."的风格化开场白
6. 结尾要有温暖亲切的结束语
7. 语气亲切，适合老年人收听，语速适中"""

    user_prompt = f"请生成{year}年新闻频道的广播稿，选取{year}年最重要的3-5个历史事件进行播报。年代背景为{era_desc}，播音风格为{voice_desc}。"

    return system_prompt, user_prompt


def build_novel_prompt(year, duration_minutes):
    """构建小说频道 prompt"""
    era, era_desc = get_era_info(year)
    voice_desc = get_voice_desc(year)
    target_words = 500 * duration_minutes

    system_prompt = f"""你是一个专业的广播电台文学编辑，专门为老年人听众创作小说广播节目。

你的任务是为{year}年创作一档小说频道广播稿。

历史背景：{era_desc}
播音风格：{voice_desc}

创作要求：
1. 请在{year}年（可涵盖前后 2 年）出版的畅销小说中，挑选一部最具代表性、最适合老年听众品味的作品
2. 广播稿结构分为四段：
   - 开场：以"各位听众朋友，欢迎收听小说频道..."开头，引出本期的文学时代背景
   - 小说背景：介绍作者生平、创作年代的社会背景、小说的出版情况与当时影响力
   - 情节概要：用 2-3 段生动讲述小说的主要情节脉络，注意不要剧透关键结局，保留悬念吸引听众
   - 文学价值：评析小说的艺术特色、人物塑造、语言风格，以及它在文学史上的地位和对后世的影响
3. 语言风格必须贴合{year}年前后的年代表达方式，让老年听众有亲切感和怀旧感
4. 内容时长约{duration_minutes}分钟（约{target_words}字）
5. 结尾要有温暖亲切的结束语，可预告下期内容方向
6. 语气娓娓道来，像讲故事一样，适合老年人收听，语速适中
7. 内容必须符合{year}年前后的历史真实情况，推荐的小说必须是该年代或之前已出版的真实作品，严禁推荐该年代之后才出版的小说"""

    user_prompt = f"请为{year}年小说频道创作一档广播稿，挑选一部{year}年前后出版的畅销小说，介绍其背景、情节概要和文学价值。年代背景为{era_desc}，播音风格为{voice_desc}。"

    return system_prompt, user_prompt


def call_agnes_ai(system_prompt, user_prompt, max_retries=2):
    """调用 Agnes AI 生成内容"""
    import httpx

    for attempt in range(max_retries + 1):
        try:
            # 每次重试等待递增
            if attempt > 0:
                wait = 5 * attempt
                print(f"  ⏳ 重试 {attempt}/{max_retries}，等待 {wait}s...")
                time.sleep(wait)

            with httpx.Client(timeout=120.0) as client:
                resp = client.post(
                    f"{AGNES_BASE_URL}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {AGNES_API_KEY}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": AGNES_MODEL,
                        "messages": [
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_prompt},
                        ],
                        "temperature": 0.8,
                        "max_tokens": 4000,
                    },
                )
                resp.raise_for_status()
                data = resp.json()
                content = data["choices"][0]["message"]["content"]
                return content

        except Exception as e:
            if attempt >= max_retries:
                raise
            print(f"  ⚠️  调用失败: {type(e).__name__}: {str(e)[:100]}")


# ==================== R2 存储 ====================

def _get_s3():
    """获取 boto3 S3 客户端"""
    import boto3
    return boto3.client(
        "s3",
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY,
        aws_secret_access_key=R2_SECRET_KEY,
    )


def upload_content_to_r2(year, channel, text, dry_run=False):
    """上传 AI 文字内容到 R2 broadcasts/{year}/{channel}/content.json"""
    key = f"broadcasts/{year}/{channel}/content.json"
    content_obj = {
        "year": year,
        "channel": channel,
        "text": text,
        "generated_at": datetime.now().isoformat(),
    }

    if dry_run:
        print(f"  [DRY-RUN] 将写入 R2: {key} ({len(text)} 字)")
        return key

    s3 = _get_s3()
    s3.put_object(
        Bucket=R2_BUCKET,
        Key=key,
        Body=json.dumps(content_obj, ensure_ascii=False, indent=2).encode("utf-8"),
        ContentType="application/json",
        ACL="public-read",
    )
    print(f"  ✅ 已写入 R2: {key}")
    return key


# ==================== 主流程 ====================

def process_year(year, channels, dry_run=False, retries=2):
    """处理单年：生成指定频道内容并上传 R2"""
    results = {}
    for channel in channels:
        label = CHANNELS_CONFIG[channel]["name"]
        duration = CHANNELS_CONFIG[channel]["duration_minutes"]
        print(f"\n{'='*50}")
        print(f"📻 {year}年 {label} ({channel})")
        print(f"{'='*50}")

        try:
            if channel == "news":
                sys_prompt, usr_prompt = build_news_prompt(year, duration)
            elif channel == "novel":
                sys_prompt, usr_prompt = build_novel_prompt(year, duration)
            else:
                raise ValueError(f"未知频道: {channel}")

            t0 = time.time()
            text = call_agnes_ai(sys_prompt, usr_prompt, max_retries=retries)
            elapsed = time.time() - t0

            words = len(text)
            print(f"  📝 内容长度: {words} 字 | 耗时: {elapsed:.1f}s")

            # 上传 R2
            key = upload_content_to_r2(year, channel, text, dry_run=dry_run)
            results[channel] = {"success": True, "key": key, "words": words, "elapsed": elapsed}

        except Exception as e:
            print(f"  ❌ 失败: {type(e).__name__}: {str(e)[:200]}")
            traceback.print_exc()
            results[channel] = {"success": False, "error": str(e)}

    return results


def main():
    parser = argparse.ArgumentParser(description="批量生成 1949-2019 年 AI 文字内容")
    parser.add_argument("--start", type=int, default=1949)
    parser.add_argument("--end", type=int, default=2019)
    parser.add_argument("--channel", type=str, default="all",
                        choices=["news", "novel", "all"])
    parser.add_argument("--dry-run", action="store_true",
                        help="仅生成不写入 R2")
    parser.add_argument("--retry", type=int, default=2,
                        help="AI 调用失败重试次数")
    args = parser.parse_args()

    channels = ["news", "novel"] if args.channel == "all" else [args.channel]

    if not AGNES_API_KEY:
        print("❌ 未设置 AGNES_API_KEY，请检查 .env 文件")
        sys.exit(1)

    print(f"🚀 批量生成 {args.start}-{args.end} 年 AI 文字内容")
    print(f"   频道: {', '.join(channels)}")
    print(f"   Dry-run: {args.dry_run} | 重试: {args.retry}次")
    print(f"   API: {AGNES_BASE_URL} | Model: {AGNES_MODEL}")

    total_start = time.time()
    success_count = 0
    fail_count = 0
    failed_years = []

    for year in range(args.start, args.end + 1):
        year_results = process_year(year, channels, args.dry_run, args.retry)
        for ch, result in year_results.items():
            if result["success"]:
                success_count += 1
            else:
                fail_count += 1
                failed_years.append(f"{year}/{ch}")

        # 年份之间短暂休息，避免 API 限流
        if year < args.end:
            time.sleep(2)

    total_elapsed = time.time() - total_start
    print(f"\n{'='*60}")
    print(f"📊 完成！")
    print(f"   总耗时: {total_elapsed:.0f}s ({total_elapsed/60:.1f}min)")
    print(f"   成功: {success_count} | 失败: {fail_count}")
    if failed_years:
        print(f"   失败列表: {', '.join(failed_years)}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
