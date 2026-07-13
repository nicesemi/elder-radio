"""
配置管理 - Agnes AI + TTS 服务配置
API Key 通过环境变量 AGNES_API_KEY 设置，请勿硬编码在代码中。
"""

import os
from pathlib import Path

# 自动加载项目根目录 .env 文件（本地开发用；Vercel 部署时环境变量由平台注入）
try:
    from dotenv import load_dotenv
    _env_path = Path(__file__).resolve().parent.parent.parent / ".env"
    if _env_path.exists():
        load_dotenv(_env_path)
except ImportError:
    pass

# Agnes AI 配置（兼容 OpenAI 接口）
AGNES_BASE_URL = "https://apihub.agnes-ai.com/v1"
AGNES_API_KEY = os.environ.get("AGNES_API_KEY", "")
AGNES_MODEL = "agnes-2.0-flash"
AGNES_TTS_MODEL = "agnes-tts-1"  # TTS 模型（灰度中）

# TTS 配置 - 播音员音色映射（按年代）
# 使用 EmotiVoice / Edge-TTS 音色
BROADCASTER_VOICES = {
    "1950s": {
        "name": "延安广播风格",
        "voice_id": "zh-CN-YunxiNeural",  # Edge-TTS 老年男声
        "style": "newscast-formal",
        "speed": 0.85,
        "pitch": "-5Hz",
        "description": "字正腔圆、铿锵有力，延安/开国时期广播风格"
    },
    "1960s": {
        "name": "建设时期广播风格",
        "voice_id": "zh-CN-YunjianNeural",
        "style": "newscast",
        "speed": 0.9,
        "pitch": "-3Hz",
        "description": "热情饱满、斗志昂扬，社会主义建设时期风格"
    },
    "1970s": {
        "name": "样板戏广播风格",
        "voice_id": "zh-CN-YunxiNeural",
        "style": "newscast-formal",
        "speed": 0.85,
        "pitch": "-2Hz",
        "description": "庄重严肃、字正腔圆，特殊年代广播风格"
    },
    "1980s": {
        "name": "改革开放广播风格",
        "voice_id": "zh-CN-YunyangNeural",
        "style": "newscast",
        "speed": 0.95,
        "pitch": "+0Hz",
        "description": "朝气蓬勃、语速明快，改革开放初期风格"
    },
    "1990s": {
        "name": "九十年代广播风格",
        "voice_id": "zh-CN-YunyangNeural",
        "style": "newscast-casual",
        "speed": 1.0,
        "pitch": "+0Hz",
        "description": "轻松自然、亲切流畅，九十年代电台风格"
    },
    "2000s": {
        "name": "新世纪广播风格",
        "voice_id": "zh-CN-XiaoxiaoNeural",
        "style": "newscast-casual",
        "speed": 1.0,
        "pitch": "+0Hz",
        "description": "时尚活泼、节奏明快，千禧年后广播风格"
    },
    "2010s": {
        "name": "现代广播风格",
        "voice_id": "zh-CN-XiaoyiNeural",
        "style": "newscast",
        "speed": 1.05,
        "pitch": "+2Hz",
        "description": "专业干练、信息密集，现代新闻广播风格"
    },
    "2020s": {
        "name": "AI时代广播风格",
        "voice_id": "zh-CN-YunxiNeural",
        "style": "newscast",
        "speed": 1.0,
        "pitch": "+0Hz",
        "description": "清晰自然、AI辅助，当代智能广播风格"
    }
}

# 频道配置
CHANNELS = {
    "news": {"name": "新闻", "icon": "📰", "prompt_template": "news"},
    "sports": {"name": "体育", "icon": "⚽", "prompt_template": "sports"},
    "music": {"name": "音乐", "icon": "🎵", "prompt_template": "music"},
    "novel": {"name": "小说频道", "icon": "📖", "prompt_template": "novel", "category": "广播剧/有声小说"},
    "finance": {"name": "金融", "icon": "💰", "prompt_template": "finance"},
    "culture": {"name": "文化", "icon": "📚", "prompt_template": "culture"},
    "technology": {"name": "科技", "icon": "🔬", "prompt_template": "technology"}
}

# 服务器配置
SERVER_HOST = "0.0.0.0"
SERVER_PORT = 8765
