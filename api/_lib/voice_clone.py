"""
声音克隆与定制服务
支持上传语音样本训练个性化声音模型
"""

import os
import uuid
import shutil
from config import AGNES_BASE_URL, AGNES_API_KEY

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "voice_samples")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# 预设声音包（付费）
PRESET_VOICE_PACKS = [
    {
        "id": "vp_001",
        "name": "经典评书",
        "description": "单田芳风格评书音色",
        "price": 9.9,
        "preview_url": None
    },
    {
        "id": "vp_002",
        "name": "温暖邻家",
        "description": "亲切温和的邻家阿姨音色",
        "price": 9.9,
        "preview_url": None
    },
    {
        "id": "vp_003",
        "name": "戏曲名角",
        "description": "京剧/黄梅戏韵味的音色",
        "price": 19.9,
        "preview_url": None
    },
    {
        "id": "vp_004",
        "name": "相声逗捧",
        "description": "相声风格的幽默音色",
        "price": 14.9,
        "preview_url": None
    },
    {
        "id": "vp_005",
        "name": "电台老炮",
        "description": "资深电台DJ的专业音色",
        "price": 9.9,
        "preview_url": None
    }
]


async def upload_voice_sample(
    audio_data: bytes,
    filename: str,
    speaker_name: str
) -> dict:
    """
    上传语音样本用于声音克隆

    Args:
        audio_data: 音频数据
        filename: 文件名
        speaker_name: 说话人名称

    Returns:
        上传结果信息
    """
    voice_id = f"custom_{uuid.uuid4().hex[:12]}"
    speaker_dir = os.path.join(UPLOAD_DIR, voice_id)
    os.makedirs(speaker_dir, exist_ok=True)

    file_path = os.path.join(speaker_dir, filename)
    with open(file_path, "wb") as f:
        f.write(audio_data)

    # 记录元信息
    meta = {
        "voice_id": voice_id,
        "speaker_name": speaker_name,
        "sample_file": filename,
        "status": "pending_training",
        "created_at": str(uuid.uuid1())
    }

    import json
    with open(os.path.join(speaker_dir, "meta.json"), "w") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    return meta


async def train_custom_voice(voice_id: str) -> dict:
    """
    训练个性化声音模型（使用Qwen3-TTS-VC或Step-Audio2）

    注意：此功能需要部署声音克隆模型。目前为框架代码，
    实际训练需要接入Qwen3-TTS-VC或Step-Audio2的开源模型。
    """
    speaker_dir = os.path.join(UPLOAD_DIR, voice_id)

    if not os.path.exists(speaker_dir):
        return {"error": "语音样本不存在", "voice_id": voice_id}

    # 更新状态为训练中
    import json
    meta_path = os.path.join(speaker_dir, "meta.json")
    with open(meta_path, "r") as f:
        meta = json.load(f)

    meta["status"] = "training"
    with open(meta_path, "w") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    # TODO: 接入 Qwen3-TTS-VC 进行声音克隆训练
    # 或者使用 Step-Audio2 的1秒克隆能力
    # 当前返回模拟结果

    meta["status"] = "ready"
    meta["trained_at"] = str(uuid.uuid1())
    with open(meta_path, "w") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    return meta


def list_custom_voices() -> list:
    """列出所有自定义声音"""
    voices = []
    if not os.path.exists(UPLOAD_DIR):
        return voices

    for voice_id in os.listdir(UPLOAD_DIR):
        meta_path = os.path.join(UPLOAD_DIR, voice_id, "meta.json")
        if os.path.exists(meta_path):
            import json
            with open(meta_path, "r") as f:
                meta = json.load(f)
            voices.append(meta)

    return voices


def get_preset_voice_packs() -> list:
    """获取预设声音包列表"""
    return PRESET_VOICE_PACKS


def delete_custom_voice(voice_id: str) -> bool:
    """删除自定义声音"""
    speaker_dir = os.path.join(UPLOAD_DIR, voice_id)
    if os.path.exists(speaker_dir):
        shutil.rmtree(speaker_dir)
        return True
    return False
