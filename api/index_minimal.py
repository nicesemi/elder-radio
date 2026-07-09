"""
Vercel Serverless 最小测试入口
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.get("/api/health")
async def health_check():
    return {"status": "ok", "version": "minimal-test"}

@app.get("/api/channels")
async def get_channels():
    return {"channels": []}
