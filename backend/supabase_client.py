"""
Supabase 客户端集成
提供音频上传到 Supabase Storage 的功能。
"""

import os

_supabase = None


def init_supabase():
    """
    初始化 Supabase 客户端（单例模式）。

    Returns:
        Supabase client 实例
    """
    global _supabase
    if _supabase is not None:
        return _supabase

    from supabase import create_client, Client

    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_KEY", "")

    if not url or not key:
        raise RuntimeError("SUPABASE_URL 和 SUPABASE_KEY 环境变量未设置")

    _supabase = create_client(url, key)
    return _supabase


def upload_audio_to_supabase(supabase_client, file_path: str, filename: str, bucket: str = "audio") -> str:
    """
    上传音频文件到 Supabase Storage。

    Args:
        supabase_client: Supabase 客户端实例
        file_path: 本地音频文件路径
        filename: 目标文件名
        bucket: Storage bucket 名称（默认 'audio'）

    Returns:
        上传后的文件路径
    """
    with open(file_path, "rb") as f:
        audio_data = f.read()

    content_type = "audio/mpeg" if filename.endswith(".mp3") else "audio/mp4"

    result = supabase_client.storage.from_(bucket).upload(
        path=filename,
        file=audio_data,
        file_options={"content-type": content_type, "upsert": "true"}
    )

    return result.path if hasattr(result, 'path') else filename


def get_public_url(supabase_client, filename: str, bucket: str = "audio") -> str:
    """
    获取音频文件的公开 URL。

    Args:
        supabase_client: Supabase 客户端实例
        filename: 文件名
        bucket: Storage bucket 名称（默认 'audio'）

    Returns:
        公开访问 URL
    """
    return supabase_client.storage.from_(bucket).get_public_url(filename)
