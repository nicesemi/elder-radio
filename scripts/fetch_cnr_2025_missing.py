#!/usr/bin/env python3
"""
补采集 2025-06-06 ~ 2025-12-31 云听中国之声节目数据
API: POST https://ytapi.radio.cn/ytsrv/srv/interactive/program/list
"""

import json
import os
import sys
import time
import boto3
import requests
from datetime import datetime, timedelta

# ============ 配置 ============
API_URL = "https://ytapi.radio.cn/ytsrv/srv/interactive/program/list"
HEADERS = {"equipmentsource": "WEB"}
BROADCAST_ID = "639"

R2_ACCESS_KEY = "57161070c2bdd7fda32c8f6967c858aa"
R2_SECRET_KEY = "22b802816535b857c5f10c18ff91390794265847da2c6d08bbc3d174217a2dde"
R2_ENDPOINT = "https://8c9e2df83d17acfe5b951a9d016a785c.r2.cloudflarestorage.com"
R2_BUCKET = "radio"
R2_KEY_2025 = "cntv/cntv_zhisheng_2025.json"
R2_KEY_INDEX = "cntv/_index.json"

STATE_FILE = os.path.join(os.path.dirname(__file__), ".fetch_cnr_2025_state.json")

START_DATE = "2025-06-06"
END_DATE = "2025-12-31"

RATE_LIMIT = 0.5       # 每次请求间隔 (秒)
BATCH_PAUSE_EVERY = 100  # 每 N 次请求
BATCH_PAUSE_SEC = 5     # 暂停秒数


def get_s3():
    return boto3.client(
        "s3",
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY,
        aws_secret_access_key=R2_SECRET_KEY,
    )


def load_existing_data(s3):
    """从 R2 加载已有的 2025 年数据"""
    try:
        resp = s3.get_object(Bucket=R2_BUCKET, Key=R2_KEY_2025)
        return json.loads(resp["Body"].read())
    except Exception:
        print("[WARN] 无法加载已有数据，将创建新数据集")
        return {}


def load_state():
    """加载断点续传状态"""
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, "r") as f:
            return json.load(f)
    return {"last_date": None, "count": 0}


def save_state(last_date, count):
    with open(STATE_FILE, "w") as f:
        json.dump({"last_date": last_date, "count": count}, f)


def fetch_date(date_str):
    """抓取单日数据，返回 {date: [[start, end, name, url], ...]} 或空 dict"""
    try:
        resp = requests.post(
            API_URL,
            headers=HEADERS,
            data={
                "startdate": date_str,
                "enddate": date_str,
                "broadCastId": BROADCAST_ID,
            },
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f"  [ERROR] {date_str} 请求失败: {e}")
        return {}

    con = data.get("con", [])
    if not con:
        print(f"  [EMPTY] {date_str} 无数据")
        return {}

    programs = []
    for day_block in con:
        prog_list = day_block.get("progamlist", [])
        for p in prog_list:
            name = p.get("name", "")
            start_time = p.get("startTime", "")
            end_time = p.get("endTime", "")
            url = p.get("playUrl", "")
            if url and name:
                programs.append([start_time, end_time, name, url])

    if programs:
        return {date_str: programs}
    return {}


def upload_to_r2(s3, key, data):
    """上传 JSON 数据到 R2"""
    body = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
    s3.put_object(
        Bucket=R2_BUCKET,
        Key=key,
        Body=body,
        ContentType="application/json",
    )
    print(f"[R2] 已上传 {key} ({len(body)} bytes)")


def update_index(s3, data):
    """更新 cntv/_index.json"""
    years = sorted(set(k[:4] for k in data.keys()))
    # 也加载已有的其他年份
    try:
        resp = s3.get_object(Bucket=R2_BUCKET, Key=R2_KEY_INDEX)
        old_idx = json.loads(resp["Body"].read())
        existing_years = set(old_idx.get("years", []))
    except Exception:
        existing_years = set()

    all_years = sorted(existing_years | set(years))
    index = {"years": all_years}
    upload_to_r2(s3, R2_KEY_INDEX, index)
    return all_years


def generate_date_range(start_str, end_str):
    """生成日期范围列表"""
    start = datetime.strptime(start_str, "%Y-%m-%d")
    end = datetime.strptime(end_str, "%Y-%m-%d")
    dates = []
    current = start
    while current <= end:
        dates.append(current.strftime("%Y-%m-%d"))
        current += timedelta(days=1)
    return dates


def main():
    print("=" * 60)
    print(f"云听 CNR 2025 补采集: {START_DATE} ~ {END_DATE}")
    print("=" * 60)

    s3 = get_s3()
    state = load_state()
    all_dates = generate_date_range(START_DATE, END_DATE)

    # 从断点开始
    if state["last_date"]:
        start_idx = 0
        for i, d in enumerate(all_dates):
            if d > state["last_date"]:
                start_idx = i
                break
        else:
            start_idx = len(all_dates)
        print(f"[RESUME] 从断点 {state['last_date']} 之后继续，剩余 {len(all_dates) - start_idx} 天")
    else:
        start_idx = 0
        print(f"[START] 共 {len(all_dates)} 天待采集")

    # 加载已有数据
    existing = load_existing_data(s3)
    new_added = state.get("count", 0)

    successful_dates = 0
    for i in range(start_idx, len(all_dates)):
        date_str = all_dates[i]
        print(f"[{i+1}/{len(all_dates)}] {date_str} ...", end=" ", flush=True)

        result = fetch_date(date_str)
        if result and date_str in result:
            existing[date_str] = result[date_str]
            new_added += 1
            successful_dates += 1
            print(f"OK ({len(result[date_str])} 档节目)")
        else:
            print("无数据")

        # 断点保存
        save_state(date_str, new_added)

        # 限流
        time.sleep(RATE_LIMIT)
        if (i + 1) % BATCH_PAUSE_EVERY == 0:
            print(f"[PAUSE] 已请求 {i+1} 次，暂停 {BATCH_PAUSE_SEC}s ...")
            # 每 100 次也上传一次做中间备份
            upload_to_r2(s3, R2_KEY_2025, existing)
            time.sleep(BATCH_PAUSE_SEC)

    # 最终上传
    print(f"\n采集完成: 新增 {new_added - state.get('count', 0)} 天, 总计 {len(existing)} 天")
    print("上传到 R2 ...")
    upload_to_r2(s3, R2_KEY_2025, existing)

    # 更新索引
    all_years = update_index(s3, existing)
    print(f"索引已更新: {all_years}")

    # 清理状态文件
    if os.path.exists(STATE_FILE):
        os.remove(STATE_FILE)
        print("状态文件已清理")

    print("=" * 60)
    print("完成!")


if __name__ == "__main__":
    main()
