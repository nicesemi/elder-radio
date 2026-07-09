/**
 * 老年收音机 - 交互逻辑
 * 模拟硬件收音机终端：旋钮调台/调年代/音量 + AI对讲
 */

// ============ 应用状态 ============
const state = {
    channel: 'news',
    year: 1980,
    volume: 50,
    isPlaying: false,
    selectedVoice: null,
    apiKey: '',
    serverUrl: window.location.origin,
    isRecording: false,
    mediaRecorder: null,
    audioChunks: [],
    audioContext: null,
    currentAudio: null
};

// 频道列表
const channels = [
    { id: 'news', name: '新闻', icon: '📰' },
    { id: 'sports', name: '体育', icon: '⚽' },
    { id: 'music', name: '音乐', icon: '🎵' },
    { id: 'finance', name: '金融', icon: '💰' },
    { id: 'culture', name: '文化', icon: '📚' },
    { id: 'technology', name: '科技', icon: '🔬' }
];

// 年代范围
const YEAR_MIN = 1950;
const YEAR_MAX = 2025;

// ============ DOM 引用 ============
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
    timeDisplay: $('#timeDisplay'),
    channelIcon: $('#channelIcon'),
    channelName: $('#channelName'),
    yearValue: $('#yearValue'),
    statusIndicator: $('#statusIndicator'),
    freqFill: $('#freqFill'),
    channelKnob: $('#channelKnob'),
    yearKnob: $('#yearKnob'),
    volumeKnob: $('#volumeKnob'),
    channelKnobValue: $('#channelKnobValue'),
    yearKnobValue: $('#yearKnobValue'),
    volumeKnobValue: $('#volumeKnobValue'),
    pttButton: $('#pttButton'),
    playBtn: $('#playBtn'),
    stopBtn: $('#stopBtn'),
    chatArea: $('#chatArea'),
    chatMessages: $('#chatMessages'),
    chatInput: $('#chatInput'),
    chatSendBtn: $('#chatSendBtn'),
    recordingOverlay: $('#recordingOverlay'),
    recordingCancel: $('#recordingCancel'),
    settingsPanel: $('#settingsPanel'),
    backBtn: $('#backBtn'),
    voiceList: $('#voiceList'),
    customVoiceList: $('#customVoiceList'),
    presetList: $('#presetList'),
    apiKeyInput: $('#apiKeyInput'),
    serverUrlInput: $('#serverUrlInput'),
    saveConfigBtn: $('#saveConfigBtn'),
    uploadVoiceBtn: $('#uploadVoiceBtn'),
    voiceFileInput: $('#voiceFileInput'),
    audioPlayer: $('#audioPlayer'),
    navBtns: $$('.nav-btn')
};

// ============ 初始化 ============
function init() {
    updateTime();
    setInterval(updateTime, 30000);
    loadConfig();
    updateDisplay();
    initKnobs();
    initPTT();
    initPlayControls();
    initChatControls();
    initNav();
    initSettings();
    initRecordingCancel();
}

// ============ 时间 ============
function updateTime() {
    const now = new Date();
    dom.timeDisplay.textContent =
        `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
}

// ============ 显示更新 ============
function updateDisplay() {
    const ch = channels.find(c => c.id === state.channel) || channels[0];
    dom.channelIcon.textContent = ch.icon;
    dom.channelName.textContent = ch.name;
    dom.yearValue.textContent = state.year;
    dom.channelKnobValue.textContent = ch.name;
    dom.yearKnobValue.textContent = state.year;
    dom.volumeKnobValue.textContent = `${state.volume}%`;

    // 频率条位置
    const yearPercent = ((state.year - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 100;
    dom.freqFill.style.width = `${yearPercent}%`;
}

// ============ 旋钮交互 ============
function initKnobs() {
    setupKnob(dom.channelKnob, 'channel', (dir) => {
        const idx = channels.findIndex(c => c.id === state.channel);
        const newIdx = (idx + dir + channels.length) % channels.length;
        state.channel = channels[newIdx].id;
        updateDisplay();
    });

    setupKnob(dom.yearKnob, 'year', (dir) => {
        state.year = Math.max(YEAR_MIN, Math.min(YEAR_MAX, state.year + dir * 5));
        updateDisplay();
    });

    setupKnob(dom.volumeKnob, 'volume', (dir) => {
        state.volume = Math.max(0, Math.min(100, state.volume + dir * 10));
        dom.audioPlayer.volume = state.volume / 100;
        updateDisplay();
    });
}

function setupKnob(element, type, onChange) {
    let startY = 0;
    let accumulated = 0;
    const THRESHOLD = 20; // 累积移动阈值

    element.addEventListener('pointerdown', (e) => {
        element.setPointerCapture(e.pointerId);
        startY = e.clientY;
        accumulated = 0;
    });

    element.addEventListener('pointermove', (e) => {
        if (!element.hasPointerCapture(e.pointerId)) return;
        const deltaY = startY - e.clientY;
        accumulated += deltaY;
        startY = e.clientY;

        while (Math.abs(accumulated) >= THRESHOLD) {
            const dir = accumulated > 0 ? 1 : -1;
            onChange(dir);
            accumulated -= dir * THRESHOLD;
        }
    });

    element.addEventListener('pointerup', () => {
        // 处理剩余累积
        if (Math.abs(accumulated) >= THRESHOLD / 2) {
            onChange(accumulated > 0 ? 1 : -1);
        }
        accumulated = 0;
    });

    // 也支持滚轮
    element.addEventListener('wheel', (e) => {
        e.preventDefault();
        const dir = e.deltaY < 0 ? 1 : -1;
        onChange(dir);
    }, { passive: false });
}

// ============ 对讲按键 ============
function initPTT() {
    let pressTimer = null;
    let isLongPress = false;

    dom.pttButton.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        dom.pttButton.classList.add('pressed');
        isLongPress = false;

        pressTimer = setTimeout(() => {
            isLongPress = true;
            startVoiceRecording();
        }, 500);
    });

    dom.pttButton.addEventListener('pointerup', (e) => {
        e.preventDefault();
        dom.pttButton.classList.remove('pressed');
        clearTimeout(pressTimer);

        if (isLongPress) {
            stopVoiceRecording();
        } else {
            // 短按：显示文字输入
            toggleChatArea();
        }
    });

    dom.pttButton.addEventListener('pointerleave', () => {
        dom.pttButton.classList.remove('pressed');
        clearTimeout(pressTimer);
        if (isLongPress && state.isRecording) {
            stopVoiceRecording();
        }
    });
}

function toggleChatArea() {
    const isVisible = dom.chatArea.style.display !== 'none';
    dom.chatArea.style.display = isVisible ? 'none' : 'flex';
    if (!isVisible) {
        dom.chatInput.focus();
    }
}

// ============ 语音录制 ============
async function startVoiceRecording() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        state.mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        state.audioChunks = [];

        state.mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) state.audioChunks.push(e.data);
        };

        state.mediaRecorder.onstop = async () => {
            stream.getTracks().forEach(t => t.stop());
            const audioBlob = new Blob(state.audioChunks, { type: 'audio/webm' });
            await processVoiceInput(audioBlob);
        };

        state.mediaRecorder.start();
        state.isRecording = true;
        dom.recordingOverlay.style.display = 'flex';
        setStatus('聆听中...', 'loading');
    } catch (err) {
        console.error('录音失败:', err);
        setStatus('录音权限未开启', '');
        // 降级为文字输入
        toggleChatArea();
    }
}

function stopVoiceRecording() {
    if (state.mediaRecorder && state.isRecording) {
        state.mediaRecorder.stop();
        state.isRecording = false;
        dom.recordingOverlay.style.display = 'none';
    }
}

function initRecordingCancel() {
    dom.recordingCancel.addEventListener('click', () => {
        if (state.mediaRecorder && state.isRecording) {
            state.mediaRecorder.stop();
            state.isRecording = false;
            dom.recordingOverlay.style.display = 'none';
            // 丢弃录音
            state.audioChunks = [];
        }
    });
}

async function processVoiceInput(audioBlob) {
    // 暂时用文字输入代替语音识别
    // TODO: 接入语音识别API（如Agnes STT / 百度语音 / 讯飞）
    setStatus('语音已录制，请文字确认', '');
    toggleChatArea();

    // 如果后续接入了语音识别，这里会调用 ASR API
    // const transcript = await speechToText(audioBlob);
    // if (transcript) await sendChatMessage(transcript);
}

// ============ AI 对讲 ============
function initChatControls() {
    dom.chatSendBtn.addEventListener('click', () => {
        const text = dom.chatInput.value.trim();
        if (text) sendChatMessage(text);
    });

    dom.chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const text = dom.chatInput.value.trim();
            if (text) sendChatMessage(text);
        }
    });
}

async function sendChatMessage(text) {
    dom.chatInput.value = '';
    addChatBubble('user', text);

    setStatus('AI思考中...', 'loading');

    try {
        const res = await apiCall('/api/chat/text-only', {
            question: text
        });

        if (res.success) {
            addChatBubble('assistant', res.answer);
            setStatus('就绪', '');
        } else {
            addChatBubble('assistant', '抱歉，我暂时无法回答这个问题。');
            setStatus('就绪', '');
        }
    } catch (err) {
        console.error('AI对讲失败:', err);
        addChatBubble('assistant', '网络连接失败，请检查服务是否启动。');
        setStatus('离线', '');
    }
}

function addChatBubble(role, text) {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${role}`;
    bubble.textContent = text;
    dom.chatMessages.appendChild(bubble);
    dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

// ============ 播放控制 ============
function initPlayControls() {
    dom.playBtn.addEventListener('click', startBroadcast);
    dom.stopBtn.addEventListener('click', stopBroadcast);

    dom.audioPlayer.addEventListener('ended', () => {
        state.isPlaying = false;
        dom.playBtn.disabled = false;
        dom.stopBtn.disabled = true;
        setStatus('播放完毕', '');
    });

    dom.audioPlayer.addEventListener('error', () => {
        state.isPlaying = false;
        dom.playBtn.disabled = false;
        dom.stopBtn.disabled = true;
        setStatus('播放失败', '');
    });
}

async function startBroadcast() {
    if (state.isPlaying) return;

    setStatus('AI生成中...', 'loading');
    dom.playBtn.disabled = true;
    dom.stopBtn.disabled = false;

    try {
        const res = await apiCall('/api/broadcast/generate', {
            channel: state.channel,
            year: state.year,
            duration: 5
        });

        if (res.success && res.audio_url) {
            const audioUrl = `${state.serverUrl}${res.audio_url}`;
            dom.audioPlayer.src = audioUrl;
            dom.audioPlayer.volume = state.volume / 100;
            await dom.audioPlayer.play();
            state.isPlaying = true;
            setStatus('正在播放', 'playing');
        } else {
            throw new Error('生成失败');
        }
    } catch (err) {
        console.error('广播生成失败:', err);
        setStatus('生成失败，请检查API配置', '');
        dom.playBtn.disabled = false;
        dom.stopBtn.disabled = true;

        // 回退：仅生成文本展示
        try {
            const textRes = await apiCall('/api/broadcast/content-only', {
                channel: state.channel,
                year: state.year,
                duration: 5
            });
            if (textRes.success) {
                addChatBubble('assistant', textRes.content.substring(0, 500) + '...');
                toggleChatArea();
            }
        } catch (e) {
            // 静默失败
        }
    }
}

function stopBroadcast() {
    dom.audioPlayer.pause();
    dom.audioPlayer.currentTime = 0;
    state.isPlaying = false;
    dom.playBtn.disabled = false;
    dom.stopBtn.disabled = true;
    setStatus('已停止', '');
}

function setStatus(text, className) {
    dom.statusIndicator.textContent = text;
    dom.statusIndicator.className = 'status-indicator';
    if (className) dom.statusIndicator.classList.add(className);
}

// ============ 底部导航 ============
function initNav() {
    if (!dom.navBtns.length) return;
    dom.navBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            dom.navBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            if (tab === 'settings' && dom.settingsPanel) {
                dom.settingsPanel.style.display = 'flex';
                loadSettings();
            } else if (dom.settingsPanel) {
                dom.settingsPanel.style.display = 'none';
            }
        });
    });

    if (dom.backBtn) {
        dom.backBtn.addEventListener('click', () => {
            dom.settingsPanel.style.display = 'none';
            dom.navBtns.forEach(b => b.classList.remove('active'));
            dom.navBtns[0].classList.add('active');
        });
    }
}

// ============ 设置面板 ============
function initSettings() {
    if (dom.saveConfigBtn) dom.saveConfigBtn.addEventListener('click', saveConfig);
    if (dom.uploadVoiceBtn) dom.uploadVoiceBtn.addEventListener('click', () => {
        dom.voiceFileInput.click();
    });
    if (dom.voiceFileInput) dom.voiceFileInput.addEventListener('change', handleVoiceUpload);
}

async function loadSettings() {
    await Promise.all([
        loadVoices(),
        loadCustomVoices(),
        loadPresets()
    ]);
}

async function loadVoices() {
    try {
        const res = await apiCall('/api/voices');
        dom.voiceList.innerHTML = res.voices.map(v => `
            <div class="voice-item ${state.selectedVoice === v.era ? 'selected' : ''}"
                 data-era="${v.era}">
                <div>
                    <div class="voice-item-name">${v.name}</div>
                    <div class="voice-item-desc">${v.description}</div>
                </div>
            </div>
        `).join('');

        dom.voiceList.querySelectorAll('.voice-item').forEach(item => {
            item.addEventListener('click', () => {
                state.selectedVoice = item.dataset.era;
                dom.voiceList.querySelectorAll('.voice-item').forEach(i => i.classList.remove('selected'));
                item.classList.add('selected');
            });
        });
    } catch (err) {
        dom.voiceList.innerHTML = '<p class="hint-text">无法加载播音员列表</p>';
    }
}

async function loadCustomVoices() {
    try {
        const res = await apiCall('/api/voice/custom');
        if (res.voices && res.voices.length > 0) {
            dom.customVoiceList.innerHTML = res.voices.map(v => `
                <div class="voice-item">
                    <div>
                        <div class="voice-item-name">${v.speaker_name}</div>
                        <div class="voice-item-desc">状态: ${v.status}</div>
                    </div>
                </div>
            `).join('');
        }
    } catch (err) {
        // 忽略
    }
}

async function loadPresets() {
    try {
        const res = await apiCall('/api/voice/presets');
        dom.presetList.innerHTML = res.packs.map(p => `
            <div class="preset-item">
                <div class="preset-info">
                    <div class="preset-name">${p.name}</div>
                    <div class="preset-desc">${p.description}</div>
                </div>
                <span class="preset-price">¥${p.price}</span>
                <button class="buy-btn">购买</button>
            </div>
        `).join('');
    } catch (err) {
        dom.presetList.innerHTML = '<p class="hint-text">声音包商店暂不可用</p>';
    }
}

async function handleVoiceUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('audio', file);
    formData.append('speaker_name', file.name.replace(/\.[^/.]+$/, ''));

    try {
        const res = await fetch(`${state.serverUrl}/api/voice/upload`, {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (data.success) {
            alert('语音样本上传成功！训练可能需要几分钟。');
            loadCustomVoices();
        }
    } catch (err) {
        alert('上传失败，请检查服务连接。');
    }

    dom.voiceFileInput.value = '';
}

function saveConfig() {
    state.apiKey = dom.apiKeyInput.value.trim();
    state.serverUrl = dom.serverUrlInput.value.trim();
    localStorage.setItem('elder_radio_api_key', state.apiKey);
    localStorage.setItem('elder_radio_server_url', state.serverUrl);
    alert('配置已保存！');
}

function loadConfig() {
    state.apiKey = localStorage.getItem('elder_radio_api_key') || '';
    state.serverUrl = localStorage.getItem('elder_radio_server_url') || window.location.origin;
    dom.apiKeyInput.value = state.apiKey;
    dom.serverUrlInput.value = state.serverUrl;
}

// ============ API 调用 ============
async function apiCall(endpoint, data = null) {
    const url = `${state.serverUrl}${endpoint}`;

    const options = {
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': state.apiKey
        }
    };

    if (data) {
        options.method = 'POST';
        options.body = JSON.stringify(data);
    }

    const response = await fetch(url, options);
    if (!response.ok) {
        throw new Error(`API Error: ${response.status}`);
    }
    return response.json();
}

// ============ 启动 ============
document.addEventListener('DOMContentLoaded', init);
