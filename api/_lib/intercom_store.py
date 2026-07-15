"""
对讲系统存储层 - 使用 R2 持久化频道状态、消息记录和问题分析
"""

import json
import time
from typing import Optional, List, Dict, Any

# 复用 r2_broadcast 的 S3 客户端
from _lib.r2_broadcast import R2_BUCKET, PUBLIC_BASE, _get_s3


class IntercomStore:
    """基于 R2 的对讲系统存储"""

    def __init__(self):
        self.s3 = _get_s3()

    def _key(self, channel: int) -> str:
        return f"intercom/channel_{channel}.json"

    def _read_channel(self, channel: int) -> dict:
        """从 R2 读取频道状态"""
        try:
            resp = self.s3.get_object(Bucket=R2_BUCKET, Key=self._key(channel))
            raw = resp['Body'].read()
            return json.loads(raw)
        except Exception:
            return self._default_channel(channel)

    def _write_channel(self, channel: int, data: dict):
        """写入频道状态到 R2"""
        try:
            self.s3.put_object(
                Bucket=R2_BUCKET,
                Key=self._key(channel),
                Body=json.dumps(data, ensure_ascii=False).encode('utf-8'),
                ContentType='application/json'
            )
        except Exception as e:
            print(f"[IntercomStore] R2 write failed: {e}")

    def _default_channel(self, channel: int) -> dict:
        return {
            "channel": channel,
            "users": [],
            "messages": [],
            "questions": []
        }

    # ==================== 频道管理 ====================

    def join_channel(self, channel: int, user_id: str) -> dict:
        """加入频道，返回频道状态"""
        if not (1 <= channel <= 99):
            return {"error": "频道号必须在 1-99 之间"}

        data = self._read_channel(channel)

        existing = [u for u in data["users"] if u["user_id"] == user_id]
        if existing:
            peer_id = None
            for u in data["users"]:
                if u["user_id"] != user_id:
                    peer_id = u["user_id"]
                    break
            return {"channel": channel, "user_count": len(data["users"]),
                    "peer_id": peer_id, "status": "already_joined",
                    "last_msg_idx": len(data["messages"])}

        if len(data["users"]) >= 2:
            return {"error": "该频道已满（最多 2 人）", "user_count": 2}

        data["users"].append({
            "user_id": user_id,
            "joined_at": time.time(),
            "last_msg_idx": len(data["messages"])
        })
        self._write_channel(channel, data)

        peer_id = None
        for u in data["users"]:
            if u["user_id"] != user_id:
                peer_id = u["user_id"]
                break

        return {"channel": channel, "user_count": len(data["users"]),
                "peer_id": peer_id, "status": "joined",
                "last_msg_idx": len(data["messages"])}

    def leave_channel(self, channel: int, user_id: str):
        """离开频道"""
        data = self._read_channel(channel)
        data["users"] = [u for u in data["users"] if u["user_id"] != user_id]
        self._write_channel(channel, data)
        return {"status": "left", "remaining": len(data["users"])}

    # ==================== 消息 ====================

    def send_message(self, channel: int, from_user: str, r2_key: str,
                     text: str = "") -> dict:
        """记录消息到频道"""
        data = self._read_channel(channel)
        msg = {
            "from": from_user,
            "r2_key": r2_key,
            "text": text,
            "timestamp": time.time()
        }
        data["messages"].append(msg)
        self._write_channel(channel, data)
        return {"msg_idx": len(data["messages"]) - 1, "channel": channel}

    def upload_audio(self, audio_bytes: bytes, channel: int, prefix: str) -> str:
        """上传音频到 R2，返回公开 URL"""
        ts = int(time.time() * 1000)
        key = f"intercom/audio/ch{channel}/{prefix}_{ts}.webm"
        try:
            self.s3.put_object(
                Bucket=R2_BUCKET,
                Key=key,
                Body=audio_bytes,
                ContentType='audio/webm'
            )
        except Exception as e:
            print(f"[IntercomStore] audio upload failed: {e}")
            return ""
        return f"{PUBLIC_BASE}/{key}"

    def upload_tts_audio(self, audio_bytes: bytes, channel: int) -> str:
        """上传 TTS 音频到 R2"""
        ts = int(time.time() * 1000)
        key = f"intercom/audio/ch{channel}/bot_{ts}.mp3"
        try:
            self.s3.put_object(
                Bucket=R2_BUCKET,
                Key=key,
                Body=audio_bytes,
                ContentType='audio/mpeg'
            )
        except Exception as e:
            print(f"[IntercomStore] tts upload failed: {e}")
            return ""
        return f"{PUBLIC_BASE}/{key}"

    def poll_messages(self, channel: int, user_id: str, last_idx: int) -> dict:
        """轮询新消息"""
        data = self._read_channel(channel)
        new_msgs = data["messages"][last_idx:]

        for u in data["users"]:
            if u["user_id"] == user_id:
                u["last_msg_idx"] = len(data["messages"])
                break
        self._write_channel(channel, data)

        return {
            "messages": new_msgs,
            "count": len(new_msgs),
            "total": len(data["messages"]),
            "user_count": len(data["users"])
        }

    # ==================== 问题记录 ====================

    def add_question(self, channel: int, user_id: str, question: str, answer: str):
        """记录用户问题及 AI 回答到管理后台"""
        data = self._read_channel(channel)
        data["questions"].append({
            "user_id": user_id,
            "question": question,
            "answer": answer,
            "timestamp": time.time(),
            "channel": channel
        })
        self._write_channel(channel, data)

    # ==================== 管理后台 ====================

    def get_all_channel_states(self) -> List[dict]:
        """获取所有活跃频道概要"""
        channels = []
        for ch in range(1, 100):
            try:
                data = self._read_channel(ch)
                if data["users"] or data["messages"] or data["questions"]:
                    channels.append({
                        "channel": ch,
                        "user_count": len(data["users"]),
                        "message_count": len(data["messages"]),
                        "question_count": len(data["questions"]),
                        "last_activity": data["messages"][-1]["timestamp"] if data["messages"] else 0
                    })
            except Exception:
                pass
        return channels

    def get_all_questions(self, channel: Optional[int] = None) -> List[dict]:
        """获取所有问题记录"""
        questions = []
        channels_to_check = [channel] if channel else range(1, 100)
        for ch in channels_to_check:
            data = self._read_channel(ch)
            questions.extend(data["questions"])
        questions.sort(key=lambda q: q.get("timestamp", 0), reverse=True)
        return questions

    def get_channel_messages(self, channel: int) -> List[dict]:
        """获取某频道所有消息"""
        return self._read_channel(channel)["messages"]


_intercom_store: Optional[IntercomStore] = None


def get_intercom_store() -> IntercomStore:
    global _intercom_store
    if _intercom_store is None:
        _intercom_store = IntercomStore()
    return _intercom_store
