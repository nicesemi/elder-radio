"""
Vercel Serverless 入口 - 诊断版：逐层测试 _lib 导入
"""

import os, sys, json, traceback
from datetime import datetime

LIB_DIR = os.path.join(os.path.dirname(__file__), "_lib")
sys.path.insert(0, LIB_DIR)

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def _try_import(name):
    try:
        __import__(name)
        return True
    except Exception as e:
        return str(e)


@app.get("/api/health")
async def health_check():
    results = {}
    for mod in ["config", "ai_content", "tts_service", "voice_clone", "supabase_client"]:
        r = _try_import(mod)
        results[mod] = r if not isinstance(r, bool) else "OK"
    results["edge-tts"] = _try_import("edge_tts")
    return {
        "status": "ok",
        "sys_path": [p for p in sys.path if "_lib" in p],
        "imports": results,
        "lib_files": os.listdir(LIB_DIR)
    }


@app.get("/api/channels")
async def get_channels():
    from config import CHANNELS
    return {
        "channels": [
            {"id": k, "name": v["name"], "icon": v["icon"]}
            for k, v in CHANNELS.items()
        ]
    }
