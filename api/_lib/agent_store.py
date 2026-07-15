"""
业务员转接存储 - R2 持久化
Transfer: AI 检测到采购意图时创建
Active Call: 业务员接听后转为活跃通话
"""
import json
import time
import uuid
from typing import Optional

from _lib.r2_broadcast import R2_BUCKET, PUBLIC_BASE, _get_s3

TRANSFERS_KEY = "agent/transfers.json"
CALLS_KEY = "agent/active_calls.json"
MESSAGES_KEY = "agent/call_messages.json"

_agent_store = None


def get_agent_store():
    global _agent_store
    if _agent_store is None:
        _agent_store = AgentStore()
    return _agent_store


class AgentStore:
    def __init__(self):
        self.s3 = _get_s3()

    def _read_json(self, key: str) -> dict:
        try:
            resp = self.s3.get_object(Bucket=R2_BUCKET, Key=key)
            raw = resp['Body'].read()
            return json.loads(raw)
        except Exception:
            return {}

    def _write_json(self, key: str, data: dict):
        try:
            self.s3.put_object(
                Bucket=R2_BUCKET,
                Key=key,
                Body=json.dumps(data, ensure_ascii=False).encode('utf-8'),
                ContentType='application/json'
            )
        except Exception as e:
            print(f"[AgentStore] R2 write failed: {e}")

    def _prune_expired(self, items: dict, max_age: float = 300):
        now = time.time()
        return {k: v for k, v in items.items()
                if now - v.get("created_at", 0) <= max_age}

    # ==================== Transfer ====================

    def create_transfer(self, user_channel, user_id, text, intent, summary):
        tid = str(uuid.uuid4())[:8]
        transfer = {
            "id": tid,
            "user_channel": user_channel,
            "user_id": user_id,
            "text": text,
            "intent": intent,
            "summary": summary,
            "time": time.strftime("%H:%M:%S"),
            "created_at": time.time(),
        }
        data = self._read_json(TRANSFERS_KEY)
        data[tid] = transfer
        self._write_json(TRANSFERS_KEY, data)
        print(f"[Agent] New transfer {tid}: channel={user_channel} intent={intent}")
        return transfer

    def get_pending(self, agent_channel=None):
        data = self._read_json(TRANSFERS_KEY)
        data = self._prune_expired(data)
        self._write_json(TRANSFERS_KEY, data)
        return list(data.values())

    def accept_transfer(self, transfer_id, agent_id, agent_channel):
        transfers = self._read_json(TRANSFERS_KEY)
        calls = self._read_json(CALLS_KEY)
        transfer = transfers.pop(transfer_id, None)
        if not transfer:
            return None
        transfer["agent_id"] = agent_id
        transfer["agent_channel"] = agent_channel
        transfer["accepted_at"] = time.time()
        calls[transfer_id] = transfer
        self._write_json(TRANSFERS_KEY, transfers)
        self._write_json(CALLS_KEY, calls)
        return transfer

    # ==================== Messages ====================

    def _read_messages(self) -> dict:
        return self._read_json(MESSAGES_KEY)

    def _write_messages(self, data: dict):
        self._write_json(MESSAGES_KEY, data)

    def add_customer_message(self, transfer_id, text):
        msgs = self._read_messages()
        if transfer_id not in msgs:
            msgs[transfer_id] = []
        msg = {"from": "customer", "text": text, "time": time.strftime("%H:%M:%S")}
        msgs[transfer_id].append(msg)
        self._write_messages(msgs)
        return msg

    def add_agent_message(self, transfer_id, agent_name, text):
        msgs = self._read_messages()
        if transfer_id not in msgs:
            msgs[transfer_id] = []
        msg = {"from": "agent", "agent_name": agent_name, "text": text,
               "time": time.strftime("%H:%M:%S")}
        msgs[transfer_id].append(msg)
        self._write_messages(msgs)
        return msg

    def get_call_messages(self, transfer_id, agent_id):
        calls = self._read_json(CALLS_KEY)
        msgs = self._read_messages()
        for tid, call in calls.items():
            if call.get("agent_id") == agent_id and tid == transfer_id:
                return [m for m in msgs.get(tid, []) if m["from"] == "customer"]
        return [m for m in msgs.get(transfer_id, []) if m["from"] == "customer"]

    def get_call_by_transfer(self, transfer_id):
        calls = self._read_json(CALLS_KEY)
        return calls.get(transfer_id)

    def hangup(self, transfer_id, user_channel):
        calls = self._read_json(CALLS_KEY)
        call = calls.pop(transfer_id, None)
        if call:
            self._write_json(CALLS_KEY, calls)
            print(f"[Agent] Call ended: {transfer_id} channel={user_channel}")
        return call

    def get_user_call(self, user_channel):
        calls = self._read_json(CALLS_KEY)
        msgs = self._read_messages()
        for tid, call in calls.items():
            if call.get("user_channel") == user_channel:
                return {
                    "transfer_id": tid,
                    "agent_name": call.get("agent_name", "业务员"),
                    "messages": [m for m in msgs.get(tid, []) if m["from"] == "agent"],
                }
        return None

    def add_agent_message_by_channel(self, user_channel, agent_name, text):
        calls = self._read_json(CALLS_KEY)
        for tid, call in calls.items():
            if call.get("user_channel") == user_channel:
                return self.add_agent_message(tid, agent_name, text)
        return None

    def get_messages_by_channel(self, user_channel, agent_id):
        calls = self._read_json(CALLS_KEY)
        msgs = self._read_messages()
        for tid, call in calls.items():
            if call.get("user_channel") == user_channel and call.get("agent_id") == agent_id:
                return [m for m in msgs.get(tid, []) if m["from"] == "customer"]
        return []
