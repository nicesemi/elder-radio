"""
AI 内容生成模块 - 使用 Agnes AI 生成符合年代和频道的广播内容
"""

import httpx
from config import (
    AGNES_BASE_URL, AGNES_API_KEY, AGNES_MODEL,
    CHANNELS, BROADCASTER_VOICES
)


async def generate_broadcast_content(
    channel: str,
    year: int,
    duration_minutes: int = 5
) -> str:
    """
    生成符合指定年代和频道的广播内容

    Args:
        channel: 频道类型 (news/sports/music/finance/culture/technology)
        year: 目标年代
        duration_minutes: 内容时长（分钟）

    Returns:
        生成的广播稿文本
    """
    channel_info = CHANNELS.get(channel, CHANNELS["news"])

    # 确定年代区间
    if year < 1960:
        era = "1950s"
        era_desc = "新中国成立初期"
    elif year < 1970:
        era = "1960s"
        era_desc = "社会主义建设时期"
    elif year < 1980:
        era = "1970s"
        era_desc = "文革后期至改革开放前夕"
    elif year < 1990:
        era = "1980s"
        era_desc = "改革开放初期"
    elif year < 2000:
        era = "1990s"
        era_desc = "九十年代市场经济转型期"
    elif year < 2010:
        era = "2000s"
        era_desc = "新世纪互联网兴起时期"
    elif year < 2020:
        era = "2010s"
        era_desc = "移动互联网时代"
    else:
        era = "2020s"
        era_desc = "AI智能时代"

    voice_info = BROADCASTER_VOICES.get(era, BROADCASTER_VOICES["2020s"])

    system_prompt = f"""你是一个专业的广播电台内容编辑，专门为老年人听众创作广播节目。

你的任务是生成{year}年左右的{channel_info['name']}频道广播稿。

历史背景：{era_desc}
播音风格：{voice_info['description']}

要求：
1. 内容必须符合{year}年前后的历史真实情况，不能出现该年代不存在的事物
2. 语言风格要符合那个年代的表达方式
3. 如果是新闻频道，请模拟该年代的重大新闻事件播报
4. 如果是音乐频道，请介绍该年代流行的音乐和歌手
5. 如果是体育频道，请回顾该年代的体育赛事和明星
6. 如果是金融频道，请介绍该年代的经济状况和市场特点
7. 内容时长约{duration_minutes}分钟（约{500 * duration_minutes}字）
8. 开头要有"各位听众朋友，欢迎收听..."的风格化开场白
9. 结尾要有结束语
10. 语气亲切，适合老年人收听，语速适中"""

    user_prompt = f"请生成{year}年{channel_info['name']}频道的广播稿，年代背景为{era_desc}，播音风格为{voice_info['description']}。"

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            f"{AGNES_BASE_URL}/chat/completions",
            headers={
                "Authorization": f"Bearer {AGNES_API_KEY}",
                "Content-Type": "application/json"
            },
            json={
                "model": AGNES_MODEL,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                "temperature": 0.8,
                "max_tokens": 4000
            }
        )
        response.raise_for_status()
        data = response.json()
        return data["choices"][0]["message"]["content"]


async def generate_ai_answer(question: str, context: str = "") -> str:
    """
    AI 对讲功能 - 回答老年人提出的问题

    Args:
        question: 用户问题
        context: 上下文信息

    Returns:
        AI 回答文本
    """
    system_prompt = """你是一个专门为老年人服务的AI助手，名字叫"小马"。

要求：
1. 用亲切、耐心、易懂的语言回答
2. 避免使用过于专业的术语，如必须使用请解释
3. 回答简洁明了，每次控制在200字以内
4. 可以适当加入长辈喜欢的谚语或俗语
5. 如果问题涉及健康，请先声明"我不是医生，以下信息仅供参考"
6. 语气温暖，像晚辈和长辈聊天一样"""

    messages = [{"role": "system", "content": system_prompt}]
    if context:
        messages.append({"role": "user", "content": f"背景信息：{context}"})
    messages.append({"role": "user", "content": question})

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            f"{AGNES_BASE_URL}/chat/completions",
            headers={
                "Authorization": f"Bearer {AGNES_API_KEY}",
                "Content-Type": "application/json"
            },
            json={
                "model": AGNES_MODEL,
                "messages": messages,
                "temperature": 0.7,
                "max_tokens": 500
            }
        )
        response.raise_for_status()
        data = response.json()
        return data["choices"][0]["message"]["content"]
