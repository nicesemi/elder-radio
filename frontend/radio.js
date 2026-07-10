/* =============================================
   radio.js - 收音机模拟器核心逻辑
   ============================================= */

(function() {
  'use strict';

  // ---- State ----
  let allStations = [];
  let currentStations = []; // filtered by category/era
  let currentIndex = 0;
  let currentEra = '2020-2026';
  let currentCategory = '全部';
  let isPlaying = false;
  let volume = 70;

  const audio = document.getElementById('audioPlayer');
  audio.volume = volume / 100;

  // ---- Categories (matching radio_sources.json) ----
  const categories = ['全部', '综合', '新闻', '音乐', '交通', '文艺', '经济', '生活', '农村', '民族', '国际'];

  const eras = ['2020-2026', '2010-2019', '2000-2009', '1990-1999', '1980-1989', '1970-1979', '1960-1969', '1949-1959'];

  // ---- Frequency mapping: map index -> FM frequency ----
  function indexToFreq(idx, total) {
    if (total <= 1) return '87.5';
    const min = 87.5, max = 108.0;
    const step = (max - min) / (total - 1);
    return (min + idx * step).toFixed(1);
  }

  // ---- Station Filtering ----
  function filterStations() {
    let filtered = allStations;
    if (currentCategory !== '全部') {
      filtered = filtered.filter(s => s.category === currentCategory);
    }
    if (currentEra !== '2020-2026') {
      // In non-current era, filter archived or matching era stations
      filtered = filtered.filter(s => s.era === currentEra || s.type === 'archive');
    }
    // Prefer live stations
    filtered.sort((a, b) => (b.type === 'live' ? 1 : 0) - (a.type === 'live' ? 1 : 0));
    currentStations = filtered;
    if (currentIndex >= currentStations.length) currentIndex = 0;
  }

  // ---- Dial Scale Rendering ----
  function renderDialScale() {
    const dial = document.getElementById('dialScale');
    if (currentStations.length === 0) {
      dial.innerHTML = '<span style="color:var(--text-muted);font-size:0.75rem;">暂无电台</span>';
      return;
    }
    const displayStations = currentStations.slice(0, 10);
    dial.innerHTML = displayStations.map((s, i) => {
      const freq = indexToFreq(i, displayStations.length);
      const active = i === currentIndex ? ' active' : '';
      return `<div class="dial-tick${active}" data-idx="${i}">
        <div class="tick-line"></div>
        <span class="tick-label">${freq}</span>
      </div>`;
    }).join('');

    // Click handler
    dial.querySelectorAll('.dial-tick').forEach(tick => {
      tick.addEventListener('click', () => {
        const idx = parseInt(tick.dataset.idx);
        tuneTo(idx);
      });
    });
  }

  // ---- Update Display ----
  function updateDisplay() {
    const station = currentStations[currentIndex];
    if (!station) {
      document.getElementById('freqDisplay').textContent = '---';
      document.getElementById('freqLabel').textContent = '无信号';
      document.getElementById('stationInfo').innerHTML = '<div class="si-name">无电台</div><div class="si-detail">请切换分类或年代</div>';
      return;
    }
    const freq = indexToFreq(currentIndex, currentStations.length);
    document.getElementById('freqDisplay').textContent = freq;
    document.getElementById('freqLabel').textContent = station.name;

    document.getElementById('stationInfo').innerHTML = `
      <div class="si-name">${station.name}</div>
      <div class="si-detail">${station.province} · ${station.category} · ${station.source}</div>
    `;

    renderDialScale();
    saveRecent(station);
    playStation(station);
  }

  // ---- Tune To Station ----
  function tuneTo(idx) {
    currentIndex = Math.max(0, Math.min(idx, currentStations.length - 1));
    updateDisplay();
  }

  function nextStation() {
    if (currentStations.length === 0) return;
    currentIndex = (currentIndex + 1) % currentStations.length;
    updateDisplay();
  }

  function prevStation() {
    if (currentStations.length === 0) return;
    currentIndex = (currentIndex - 1 + currentStations.length) % currentStations.length;
    updateDisplay();
  }

  // ---- Play Station ----
  function playStation(station) {
    if (station.type === 'live' && station.stream_url) {
      audio.src = station.stream_url;
      audio.play().catch(() => {
        // Stream unavailable - try TTS fallback
        console.log('Stream unavailable, trying TTS...');
        ttsFallback(station);
      });
      isPlaying = true;
    } else if (currentEra !== '2020-2026' || station.type === 'archive') {
      // Archive or historical era - use AI TTS
      ttsFallback(station);
    }
  }

  function ttsFallback(station) {
    audio.pause();
    // Use API for historical broadcast generation
    fetch('/api/broadcast/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: station.category,
        year: currentEra.includes('-') ? parseInt(currentEra.split('-')[0]) : 2026,
        station_name: station.name
      })
    }).then(r => r.json()).then(data => {
      if (data.audio_url) {
        audio.src = data.audio_url;
        audio.play().catch(e => console.log('TTS play failed:', e));
        isPlaying = true;
      }
    }).catch(err => console.log('TTS fallback error:', err));
  }

  // ---- Recent Stations ----
  function saveRecent(station) {
    let recents = JSON.parse(localStorage.getItem('keyclaw_recents') || '[]');
    recents = recents.filter(r => r.id !== station.id);
    recents.unshift({ id: station.id, name: station.name, province: station.province, category: station.category });
    recents = recents.slice(0, 5);
    localStorage.setItem('keyclaw_recents', JSON.stringify(recents));
    renderRecents();
  }

  function renderRecents() {
    const container = document.getElementById('recentStations');
    const recents = JSON.parse(localStorage.getItem('keyclaw_recents') || '[]');
    if (recents.length === 0) {
      container.innerHTML = '<span class="recent-label">最近收听</span><span style="color:var(--text-muted);font-size:0.7rem;">暂无记录</span>';
      return;
    }
    container.innerHTML = '<span class="recent-label">最近收听</span>' +
      recents.map((r, i) =>
        `<span class="recent-chip" data-sid="${r.id}" title="${r.name}">${i + 1}. ${r.name.slice(0, 8)}</span>`
      ).join('');

    container.querySelectorAll('.recent-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const sid = chip.dataset.sid;
        const idx = currentStations.findIndex(s => s.id === sid);
        if (idx >= 0) tuneTo(idx);
        else {
          // Switch to the station's category
          const st = allStations.find(s => s.id === sid);
          if (st) {
            currentCategory = st.category;
            currentEra = st.era || '2020-2026';
            renderEraSelector();
            filterStations();
            const newIdx = currentStations.findIndex(s => s.id === sid);
            tuneTo(newIdx >= 0 ? newIdx : 0);
          }
        }
      });
    });
  }

  // ---- Era Selector ----
  function renderEraSelector() {
    const sel = document.getElementById('eraSelector');
    sel.innerHTML = eras.map(e =>
      `<button class="era-btn${e === currentEra ? ' active' : ''}" data-era="${e}">${e}</button>`
    ).join('');

    sel.querySelectorAll('.era-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        currentEra = btn.dataset.era;
        renderEraSelector();
        currentIndex = 0;
        filterStations();
        updateDisplay();
      });
    });
  }

  // ---- AI Chat ----
  function initAIChat() {
    const toggle = document.getElementById('aiChatToggle');
    const body = document.getElementById('aiChatBody');
    const input = document.getElementById('aiInput');
    const send = document.getElementById('aiSend');
    const msgs = document.getElementById('aiMessages');

    toggle.addEventListener('click', () => {
      body.classList.toggle('open');
    });

    function sendMsg() {
      const text = input.value.trim();
      if (!text) return;
      msgs.innerHTML += `<div class="ai-msg user">你：${text}</div>`;
      input.value = '';
      msgs.scrollTop = msgs.scrollHeight;

      fetch('/api/chat/text-only', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, station: currentStations[currentIndex]?.name || '' })
      }).then(r => r.json()).then(data => {
        msgs.innerHTML += `<div class="ai-msg bot">Agnes：${data.reply || '（未收到回复）'}</div>`;
        msgs.scrollTop = msgs.scrollHeight;
      }).catch(() => {
        msgs.innerHTML += '<div class="ai-msg bot">Agnes：抱歉，连接失败。</div>';
      });
    }

    send.addEventListener('click', sendMsg);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') sendMsg(); });
  }

  // ---- Volume ----
  function initVolume() {
    const slider = document.getElementById('volumeSlider');
    slider.addEventListener('input', () => {
      volume = parseInt(slider.value);
      audio.volume = volume / 100;
    });
  }

  // ---- Knob Controls ----
  function initKnobs() {
    document.getElementById('knobNext').addEventListener('click', nextStation);
    document.getElementById('knobPrev').addEventListener('click', prevStation);

    // Keyboard controls
    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT') return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') nextStation();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') prevStation();
    });
  }

  // ---- URL Parameter ----
  function loadFromURL() {
    const params = new URLSearchParams(window.location.search);
    const stationId = params.get('station');
    if (!stationId) return;

    const station = allStations.find(s => s.id === stationId);
    if (!station) return;

    currentCategory = station.category;
    currentEra = station.era || '2020-2026';
    renderEraSelector();
    filterStations();
    const idx = currentStations.findIndex(s => s.id === stationId);
    tuneTo(idx >= 0 ? idx : 0);
  }

  // ---- Initialize ----
  async function init() {
    // Load station data
    try {
      const resp = await fetch('/radio_sources.json');
      const data = await resp.json();
      allStations = data.stations;
    } catch (err) {
      console.error('Failed to load radio_sources.json:', err);
    }

    filterStations();
    renderEraSelector();
    renderRecents();
    initKnobs();
    initVolume();
    initAIChat();

    if (allStations.length > 0) {
      loadFromURL();
      if (!window.location.search.includes('station')) {
        updateDisplay();
      }
    }
  }

  init();
})();