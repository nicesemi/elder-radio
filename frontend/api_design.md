# elder-radio API 设计文档

> 项目：elder-radio 怀旧收音机  
> 版本：v3.0  
> 日期：2026-07-10

---

## 1. GET /api/broadcast/year/{year}

**描述**：获取指定年份的历史广播内容聚合。

**请求参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| year | int | 是 | 年份，范围 1949-2026 |

**响应示例**：
```json
{
  "year": 1985,
  "stations": [
    {"id": "cnr_001", "name": "中央人民广播电台中国之声", "category": "新闻"},
    {"id": "gd_002", "name": "广东音乐之声", "category": "音乐"}
  ],
  "events": ["裁军百万", "第一个教师节"],
  "has_live_streams": true,
  "ai_content_available": false,
  "broadcast_clips": [
    {"title": "85年春晚节选", "duration": 120, "audio_url": "/audio/1985/spring_gala.mp3"}
  ]
}
```

---

## 2. GET /api/broadcast/date/{yyyy-mm-dd}

**描述**：获取某一天的历史广播内容。适合"按天播放"模式。

**请求参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| yyyy-mm-dd | string | 是 | 日期，格式 YYYY-MM-DD，如 1985-07-10 |

**查询参数** (可选)：
| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| station_id | string | (全部) | 限定特定电台 |
| voice | string | "Agnes" | Kokoro TTS 音色 |

**响应示例**：
```json
{
  "date": "1985-07-10",
  "day_of_week": "星期三",
  "is_live": false,
  "is_ai_generated": true,
  "events_today": ["1985年7月10日无重大国家事件"],
  "station_content": [
    {
      "station_name": "中央人民广播电台中国之声",
      "segments": [
        {"time": "06:00", "title": "早间新闻", "audio_url": "/audio/1985-07-10/cnr_001_0600.mp3"},
        {"time": "07:00", "title": "新闻和报纸摘要", "audio_url": "/audio/1985-07-10/cnr_001_0700.mp3"},
        {"time": "12:00", "title": "午间半小时", "audio_url": "/audio/1985-07-10/cnr_001_1200.mp3"},
        {"time": "18:00", "title": "全国新闻联播", "audio_url": "/audio/1985-07-10/cnr_001_1800.mp3"}
      ]
    }
  ]
}
```

---

## 3. GET /api/singer/{name}

**描述**：获取指定歌手的完整歌曲列表，按年份排列。

**请求参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | 歌手名，如 "五月天" 或 "Beyond" |

**响应示例**：
```json
{
  "singer": "Beyond",
  "image_url": "/img/beyond.jpg",
  "description": "中国香港殿堂级摇滚乐队",
  "active_years": "1983-2005",
  "songs": [
    {
      "year": 1986,
      "title": "再见理想",
      "album": "再见理想",
      "stream_url": "https://music.example.com/beyond/zjlx.mp3",
      "has_stream": true
    },
    {
      "year": 1990,
      "title": "光辉岁月",
      "album": "命运派对",
      "stream_url": null,
      "has_stream": false
    }
  ],
  "stats": {
    "total_songs": 120,
    "with_stream_url": 45,
    "needs_ai_cover": 75
  }
}
```

---

## 4. POST /api/singer/generate

**描述**：AI 翻唱生成。对没有 stream_url 的歌曲，调用 AI 生成翻唱音频。

**请求体**：
```json
{
  "singer": "Beyond",
  "title": "光辉岁月",
  "year": 1990,
  "voice": "粤语播音",
  "style": "摇滚"
}
```

**响应示例**：
```json
{
  "status": "generating",
  "job_id": "gen-abc123",
  "estimated_time": 30,
  "poll_url": "/api/singer/generate/status/gen-abc123"
}
```

**GET /api/singer/generate/status/{job_id}**：
```json
{
  "status": "completed",
  "audio_url": "/audio/ai_cover/beyond_guanghuisuiyue.mp3",
  "duration": 295
}
```

---

## 5. GET /api/stream/{station_id}

**描述**：获取指定电台的实时直播流信息。

**请求参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| station_id | string | 是 | 电台 ID |

**响应示例**：
```json
{
  "station_id": "cnr_001",
  "station_name": "中央人民广播电台中国之声",
  "stream_url": "https://lhttp.qingting.fm/live/386/64k.mp3",
  "stream_status": "online",
  "format": "mp3",
  "bitrate": "64k",
  "last_checked": "2026-07-10T19:00:00Z"
}
```

---

## 6. POST /api/broadcast/generate

**描述**：Agnes AI 生成历史广播内容 + Kokoro TTS 语音合成播报。

**请求体**：
```json
{
  "channel": "新闻",
  "year": 1985,
  "month": 7,
  "day": 10,
  "station_name": "中央人民广播电台中国之声",
  "voice": "Agnes",
  "broadcast_style": "1980年代新闻联播风格"
}
```

**响应示例**：
```json
{
  "status": "completed",
  "audio_url": "/audio/generated/1985-07-10_cnr_001_news.mp3",
  "duration": 180,
  "script": "各位听众朋友大家好，今天是1985年7月10日，农历五月廿三。首先为您播报今天的主要内容...",
  "tts_engine": "Kokoro",
  "voice_model": "Agnes",
  "generation_time_seconds": 12.5
}
```

---

## 附加 API

### GET /api/stations

**描述**：获取所有电台列表（分页）。

### GET /api/broadcast_data

**描述**：获取 broadcast_data.json 完整内容，前端初始化年代表使用。

### GET /api/stream/healthcheck

**描述**：批量检查所有 is_live=true 电台的流状态，返回状态报告。

```json
{
  "total": 153,
  "online": 120,
  "offline": 18,
  "timeout": 15,
  "details": [
    {"station_id": "cnr_001", "stream_status": "online", "latency_ms": 120},
    {"station_id": "hk_001", "stream_status": "timeout", "latency_ms": null}
  ]
}
```

### GET /api/singer/list

**描述**：获取所有可用歌手列表。

---

## 数据架构总结

```
/elder-radio/frontend/
├── broadcast_data.json     # 年代广播元数据 (本文件定义结构)
├── radio_sources.json      # 电台流媒体源 (已有，新增 stream_status)
├── singer_data.json        # 歌手歌曲数据
├── api_design.md           # 本 API 设计文档
```

```
/elder-radio/backend/
├── api/
│   ├── broadcast.py        # 年代/日期广播接口
│   ├── singer.py           # 歌手接口
│   ├── stream.py           # 直播流接口
│   └── generate.py         # AI 生成接口
├── services/
│   ├── kokoro_tts.py       # Kokoro TTS 引擎
│   ├── agnes_ai.py         # Agnes AI 内容生成
│   └── stream_checker.py   # 直播流健康检查
└── data/
    └── cache/              # 生成的音频缓存
```
