---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: d028bd878b182ec2195aba4761d44321_cb6fd0eb7a7e11f1914a5254002afed2
    ReservedCode1: Vx2ldhmTtbKM55NIE7lk1AXlu2qJj3PnAKgQ/6HdB+aiXlMXgKfO9FhVd2DOigUe0VCAWyyPaylK/YZck1gDfxURXpWWEFaPceqcbN3hTjV7nsvtneijTHMrqytZcy5htmWG4qI+VHXBx3GnrYD15sikQEFjW4o93JAHfOXLFm3xRZJYS97UJB/q4k8=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: d028bd878b182ec2195aba4761d44321_cb6fd0eb7a7e11f1914a5254002afed2
    ReservedCode2: Vx2ldhmTtbKM55NIE7lk1AXlu2qJj3PnAKgQ/6HdB+aiXlMXgKfO9FhVd2DOigUe0VCAWyyPaylK/YZck1gDfxURXpWWEFaPceqcbN3hTjV7nsvtneijTHMrqytZcy5htmWG4qI+VHXBx3GnrYD15sikQEFjW4o93JAHfOXLFm3xRZJYS97UJB/q4k8=
---

# 老年智能收音机 - Elder Radio AI

面向老年人的AI智能收音机产品，手机端模拟硬件终端。

## 功能特性

### 📻 收音机模式
- **调台旋钮**：新闻 / 体育 / 音乐 / 金融 / 文化 / 科技
- **调年代旋钮**：1950-2025，AI自动生成符合年代的广播内容
- **音量旋钮**：触控调节
- **年代感播音员**：不同年代自动匹配不同风格播音员声音

### 🎙️ AI 对讲
- **按住说话**：长按对讲键录音提问
- **文字输入**：短按切换文字输入模式
- 调用 Agnes AI (agnes-2.0-flash) 智能回答
- 专门针对老年人优化的回答风格（亲切、易懂）

### ⚙️ 设置面板
- 播音员选择（8种年代音色）
- 上传语音样本训练个性化声音
- 声音包商店（评书、戏曲、相声等风格）
- API Key 配置

## 技术架构

```
elder-radio/
├── backend/              # 云端AI后端 (FastAPI)
│   ├── app.py           # 主服务入口
│   ├── config.py        # 配置管理
│   ├── ai_content.py    # AI内容生成 (Agnes AI)
│   ├── tts_service.py   # TTS语音合成 (Edge-TTS + EmotiVoice)
│   ├── voice_clone.py   # 声音克隆与定制
│   └── requirements.txt
└── frontend/            # 手机端App (HTML5 PWA)
    ├── index.html       # 收音机界面
    ├── style.css        # 拟物化样式
    └── app.js           # 交互逻辑
```

### AI 模型选型

| 模块 | 方案 | 说明 |
|------|------|------|
| 文本生成 | Agnes AI (agnes-2.0-flash) | 免费、1M上下文、兼容OpenAI |
| TTS主力 | Edge-TTS | 20+音色、轻量、免费 |
| TTS增强 | EmotiVoice (有道) | 2000+音色、年龄分段、情感表达 |
| 声音克隆 | Qwen3-TTS-VC / Step-Audio2 | 1秒克隆、开源可商用 |
| 对话TTS | MOSS-TTSD (复旦) | 百万小时训练、播客级质量 |

## 快速开始

### 1. 安装后端依赖

```bash
cd backend
pip install -r requirements.txt
```

### 2. 配置 API Key

在 `backend/config.py` 中设置 Agnes API Key：
```python
AGNES_API_KEY = "your-api-key-here"
```

或在手机端设置面板中输入。

### 3. 启动服务

```bash
cd backend
python app.py
```

服务启动在 `http://localhost:8765`

### 4. 打开前端

手机浏览器访问 `http://<电脑IP>:8765` 即可使用。

推荐添加到主屏幕（PWA模式）获得全屏体验。

## API 接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/channels` | GET | 获取频道列表 |
| `/api/voices` | GET | 获取播音员音色 |
| `/api/broadcast/generate` | POST | 生成广播内容+语音 |
| `/api/broadcast/content-only` | POST | 仅生成文本 |
| `/api/chat` | POST | AI对讲（文本+语音） |
| `/api/chat/text-only` | POST | AI对讲（仅文本） |
| `/api/voice/upload` | POST | 上传语音样本 |
| `/api/voice/train` | POST | 训练声音模型 |
| `/api/voice/custom` | GET | 自定义声音列表 |
| `/api/voice/presets` | GET | 预设声音包 |
| `/api/health` | GET | 健康检查 |

## 后续规划

- [ ] 接入语音识别 (ASR)，实现真正的语音对讲
- [ ] 部署 EmotiVoice 实现更丰富的年代感音色
- [ ] 接入 Qwen3-TTS-VC 实现声音克隆
- [ ] 增加定时广播功能（闹钟式）
- [ ] 老年模式：更大字体、语音导航
- [ ] 多设备同步（硬件终端 + 手机）
*（内容由AI生成，仅供参考）*
