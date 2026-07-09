"""
Vercel Serverless 入口 - 老年收音机 AI 服务（诊断版）
先去掉所有自定义模块导入，确认基础链路正常。
"""

import os
import sys
import io
import json
import uuid
from datetime import datetime

LIB_DIR = os.path.join(os.path.dirname(__file__), "_lib")
sys.path.insert(0, LIB_DIR)

from fastapi import FastAPI, HTTPException, Query, UploadFile, File, Form, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, JSONResponse
from pydantic import BaseModel
from typing import Optional, List

# 延迟导入项目模块，避免启动时崩溃
CHANNELS = None
BROADCASTER_VOICES = None

def _lazy_import():
    global CHANNELS, BROADCASTER_VOICES
    if CHANNELS is None:
        from _lib.config import CHANNELS as ch, BROADCASTER_VOICES as bv
        CHANNELS = ch
        BROADCASTER_VOICES = bv


app = FastAPI(
    title="老年收音机AI服务",
    version="2.0.1"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health_check():
    return {"status": "ok", "version": "2.0.1", "lib_dir": LIB_DIR, "lib_exists": os.path.isdir(LIB_DIR)}


@app.get("/api/channels")
async def get_channels():
    _lazy_import()
    return {
        "channels": [
            {"id": k, "name": v["name"], "icon": v["icon"]}
            for k, v in CHANNELS.items()
        ]
    }
