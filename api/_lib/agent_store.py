"""
业务员转接存储 - 内存模式
Transfer: AI 检测到采购意图时创建
Active Call: 业务员接听后转为活跃通话
"""
import time
import uuid

_agent_store = None

def get_agent_store():
    global _agent_store
    if _agent_store is None:
        _agent_store = AgentStore()
    return _agent_store


class AgentStore:
    def __init__(self):
        self.pending_transfers = {}   # transfer_id → transfer
        self.active_calls = {}        # transfer_id → call
        self.call_messages = {}       # transfer_id → [messages]

    def create_transfer(self, user_channel, user_id, text, intent, summary):
        """AI 检测到采购意图，创建转接"""
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
        self.pending_transfers[tid] = transfer
        print(f"[Agent] New transfer {tid}: channel={user_channel} intent={intent}")
        return transfer

    def get_pending(self, agent_channel=None):
        """获取待接转接列表"""
        now = time.time()
        # 清理超过 5 分钟的过期转接
        expired = [tid for tid, t in self.pending_transfers.items()
                   if now - t["created_at"] > 300]
        for tid in expired:
            del self.pending_transfers[tid]

        return list(self.pending_transfers.values())

    def accept_transfer(self, transfer_id, agent_id, agent_channel):
        """业务员接听转接"""
        transfer = self.pending_transfers.pop(transfer_id, None)
        if not transfer:
            return None
        transfer["agent_id"] = agent_id
        transfer["agent_channel"] = agent_channel
        transfer["accepted_at"] = time.time()
        self.active_calls[transfer_id] = transfer
        self.call_messages[transfer_id] = []
        return transfer

    def add_customer_message(self, transfer_id, text):
        """客户发送新消息到通话"""
        msg = {
            "from": "customer",
            "text": text,
            "time": time.strftime("%H:%M:%S"),
        }
        if transfer_id in self.call_messages:
            self.call_messages[transfer_id].append(msg)
        return msg

    def add_agent_message(self, transfer_id, agent_name, text):
        """业务员回复消息"""
        msg = {
            "from": "agent",
            "agent_name": agent_name,
            "text": text,
            "time": time.strftime("%H:%M:%S"),
        }
        if transfer_id in self.call_messages:
            self.call_messages[transfer_id].append(msg)
        return msg

    def get_call_messages(self, transfer_id, agent_id):
        """获取通话的消息（业务员视角）"""
        # 找到该 agent 的活跃通话
        for tid, call in self.active_calls.items():
            if call.get("agent_id") == agent_id and tid == transfer_id:
                msgs = self.call_messages.get(tid, [])
                return [m for m in msgs if m["from"] == "customer"]
        # 兼容：直接用 transfer_id 查
        return [m for m in self.call_messages.get(transfer_id, [])
                if m["from"] == "customer"]

    def get_call_by_transfer(self, transfer_id):
        return self.active_calls.get(transfer_id)

    def hangup(self, transfer_id, user_channel):
        """挂断通话"""
        call = self.active_calls.pop(transfer_id, None)
        if call:
            msgs = self.call_messages.pop(transfer_id, [])
            print(f"[Agent] Call ended: {transfer_id} channel={user_channel}")
        return call

    def get_user_call(self, user_channel):
        """根据用户频道查找活跃通话（给用户端轮询用）"""
        for tid, call in self.active_calls.items():
            if call.get("user_channel") == user_channel:
                msgs = self.call_messages.get(tid, [])
                return {
                    "transfer_id": tid,
                    "agent_name": call.get("agent_name", "业务员"),
                    "messages": [m for m in msgs if m["from"] == "agent"],
                }
        return None

    def add_agent_message_by_channel(self, user_channel, agent_name, text):
        """通过用户频道号添加业务员消息"""
        for tid, call in self.active_calls.items():
            if call.get("user_channel") == user_channel:
                return self.add_agent_message(tid, agent_name, text)
        return None

    def get_messages_by_channel(self, user_channel, agent_id):
        """通过用户频道号获取客户消息"""
        for tid, call in self.active_calls.items():
            if call.get("user_channel") == user_channel and call.get("agent_id") == agent_id:
                return self.get_call_messages(tid, agent_id)
        return []
