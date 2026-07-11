/* =============================================
   radio.js — 复古收音机模拟器 v3.0
   新增：URL 年代参数、按天选择器、年代模式电台名显示
   ============================================= */

(function() {
  'use strict';

  // ============ 状态 ============
  const AUDIO = document.getElementById('audioPlayer');
  const ERA_MIN = 1949, ERA_MAX = 2026;
  const TONE_NAMES = ['Agnes', '温婉女声', '浑厚男声', '粤语播音', '童声'];

  let allStations = [];
  let broadcastData = {};
  let stations = [];
  let stationIdx = 0;
  let year = 1985;
  let volume = 0.7;
  let mode = 'AM';
  let toneIdx = 0;
  let isRecording = false;
  let mediaRecorder = null;
  let recordedChunks = [];
  let prevStreamUrl = '';
  let selectedMonth = 7;
  let selectedDay = 10;

  AUDIO.volume = volume;

  // ============ 旋钮拖动系统 ============
  function angleForValue(val, min, max) {
    return ((val - min) / (max - min)) * 270;
  }

  function makeKnobDraggable(el, getVal, setVal, opts) {
    const { min, max, step, onChange } = opts;
    let dragging = false, startY, startVal;

    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      startY = e.clientY;
      startVal = getVal();
      el.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dy = startY - e.clientY;
      const sens = (max - min) / 200;
      let newVal = startVal + dy * sens;
      if (step) newVal = Math.round(newVal / step) * step;
      newVal = Math.max(min, Math.min(max, newVal));
      setVal(newVal);
      onChange(newVal);
    });

    window.addEventListener('mouseup', () => {
      if (dragging) { dragging = false; el.style.cursor = 'grab'; }
    });

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const dir = e.deltaY > 0 ? -1 : 1;
      let newVal = getVal() + dir * (step || 1);
      newVal = Math.max(min, Math.min(max, newVal));
      setVal(newVal);
      onChange(newVal);
    }, { passive: false });
  }

  function setKnobRotation(el, deg) {
    el.style.transform = 'rotate(' + deg + 'deg)';
  }

  // ============ 调台旋钮 ============
  function getStIdx() { return stationIdx; }
  function setStIdx(idx) {
    stationIdx = Math.max(0, Math.min(idx, stations.length - 1));
    const deg = stations.length > 1
      ? angleForValue(stationIdx, 0, stations.length - 1) : 135;
    setKnobRotation(document.getElementById('knobTuning'), deg);
  }
  function onTuneChange() {
    renderDial();
    playCurrent();
    if (stations[stationIdx]) {
      saveRecent(stations[stationIdx]);
      updateNowPlaying();
    }
  }

  function bindTuningKnob() {
    makeKnobDraggable(
      document.getElementById('knobTuning'),
      getStIdx, setStIdx,
      { min: 0, max: Math.max(0, stations.length - 1), onChange: onTuneChange }
    );
  }

  // ============ 年代旋钮 ============
  function getYear() { return year; }
  function setYear(y) {
    year = Math.max(ERA_MIN, Math.min(ERA_MAX, y));
    document.getElementById('nixieYear').textContent = year;
    setKnobRotation(document.getElementById('knobEra'), angleForValue(year, ERA_MIN, ERA_MAX));

    if (mode === 'AM' && year === ERA_MAX) {
      setMode('FM');
    }

    filterStations();
    updateEraScroll();
  }

  makeKnobDraggable(
    document.getElementById('knobEra'),
    getYear, setYear,
    { min: ERA_MIN, max: ERA_MAX, step: 1, onChange: function() {} }
  );

  // ============ 音量旋钮 ============
  function getVol() { return volume; }
  function setVol(v) {
    volume = Math.max(0, Math.min(1, v));
    AUDIO.volume = volume;
    setKnobRotation(document.getElementById('knobVolume'), angleForValue(volume, 0, 1));
  }

  makeKnobDraggable(
    document.getElementById('knobVolume'),
    getVol, setVol,
    { min: 0, max: 1, step: 0.01, onChange: function() {} }
  );

  // ============ 模式切换 ============
  function setMode(m) {
    mode = m;
    document.getElementById('btnAM').classList.toggle('active', m === 'AM');
    document.getElementById('btnFM').classList.toggle('active', m === 'FM');
    document.getElementById('modeIndicator').textContent = m;

    var isLive = m === 'FM';
    document.getElementById('liveLed').classList.toggle('off', !isLive);
    document.getElementById('dialLed').classList.toggle('off', !isLive);
    document.getElementById('dialModeLabel').textContent = m;

    if (m === 'FM') {
      document.getElementById('dialRange').textContent = '88-108 MHz';
    } else {
      document.getElementById('dialRange').textContent = '年代电台';
    }

    filterStations();
    updateEraScroll();
    onTuneChange();
  }

  document.getElementById('btnAM').addEventListener('click', function() { setMode('AM'); });
  document.getElementById('btnFM').addEventListener('click', function() { setMode('FM'); });
  document.getElementById('btnTONE').addEventListener('click', function() {
    toneIdx = (toneIdx + 1) % TONE_NAMES.length;
    var t = TONE_NAMES[toneIdx];
    document.getElementById('btnTONE').textContent = t[0];
    document.getElementById('btnTONE').title = '音色: ' + t;
    if (mode === 'AM' && stations[stationIdx]) ttsGenerate(stations[stationIdx]);
  });

  // ============ 电台过滤 ============
  function filterStations() {
    var filtered = allStations.slice();

    if (mode === 'FM') {
      filtered = filtered.filter(function(s) { return s.type === 'live' && s.stream_url; });
    } else {
      // AM 模式：过滤年代匹配的电台
      filtered = filtered.filter(function(s) {
        var era = s.era || '';
        var matchDecade = era.match(/^(\d{4})/);
        if (!matchDecade) return false;
        var eraYear = parseInt(matchDecade[1]);
        return eraYear <= year && s.type === 'live' && s.stream_url;
      });
    }

    stations = filtered;
    if (stations.length === 0) {
      stationIdx = 0;
      renderDial();
      updateNowPlaying();
      return;
    }
    if (stationIdx >= stations.length) stationIdx = 0;
    bindTuningKnob();
    setStIdx(stationIdx);
    renderDial();
    playCurrent();
    updateNowPlaying();
  }

  function updateEraScroll() {
    var el = document.getElementById('eraScroll');
    if (mode === 'AM') {
      var events = (broadcastData.years && broadcastData.years[String(year)])
        ? broadcastData.years[String(year)].events || [] : [];
      var preview = events.length > 0
        ? events.slice(0, 2).join(' · ')
        : year + '年 — ' + stations.length + ' 个电台';
      el.textContent = preview;
      el.style.display = 'block';
    } else {
      el.style.display = 'none';
    }
  }

  // ============ 刻度盘渲染 ============
  function renderDial() {
    var c = document.getElementById('dialTicks');
    var total = stations.length;
    if (total === 0) {
      c.innerHTML = '<span style="color:#555;font-size:9px;align-self:center;">无信号</span>';
      return;
    }
    var range = 3;
    var start = Math.max(0, stationIdx - range);
    var end = Math.min(total - 1, stationIdx + range);
    while (end - start < range * 2 && (start > 0 || end < total - 1)) {
      if (start > 0) start--;
      if (end < total - 1) end++;
    }
    var visible = stations.slice(start, end + 1);
    c.innerHTML = visible.map(function(s, i) {
      var realIdx = start + i;
      var cls = realIdx === stationIdx ? ' current' : '';
      var label = mode === 'FM'
        ? (s.stream_url ? 'FM ' + (88 + realIdx % 20) + '.' + (Math.floor(realIdx * 0.5 % 10)) : '---')
        : s.name.slice(0, 8);
      return '<div class="dial-tick' + cls + '" data-idx="' + realIdx + '">' +
        '<div class="tick-line"></div>' +
        '<span class="tick-name">' + label + '</span></div>';
    }).join('');

    var ticks = c.querySelectorAll('.dial-tick');
    for (var j = 0; j < ticks.length; j++) {
      ticks[j].addEventListener('click', function() {
        setStIdx(parseInt(this.dataset.idx));
        onTuneChange();
      });
    }
  }

  // ============ Now Playing ============
  function updateNowPlaying() {
    var el = document.getElementById('nowPlaying');
    if (stations[stationIdx]) {
      var s = stations[stationIdx];
      el.textContent = mode === 'FM'
        ? '直播: ' + s.name
        : '[' + year + '] ' + s.name;
    } else {
      el.textContent = '等待信号...';
    }
  }

  // ============ 日期选择器 ============
  function populateDateSelector() {
    var mSel = document.getElementById('selMonth');
    var dSel = document.getElementById('selDay');

    // 月份
    mSel.innerHTML = '';
    for (var m = 1; m <= 12; m++) {
      var opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m + '月';
      if (m === selectedMonth) opt.selected = true;
      mSel.appendChild(opt);
    }

    mSel.addEventListener('change', function() {
      selectedMonth = parseInt(this.value);
      populateDayOptions();
    });

    populateDayOptions();
  }

  function populateDayOptions() {
    var dSel = document.getElementById('selDay');
    var daysInMonth = new Date(year, selectedMonth, 0).getDate();

    dSel.innerHTML = '';
    for (var d = 1; d <= daysInMonth; d++) {
      var opt = document.createElement('option');
      opt.value = d;
      opt.textContent = d + '日';
      if (d === selectedDay) opt.selected = true;
      dSel.appendChild(opt);
    }

    dSel.addEventListener('change', function() {
      selectedDay = parseInt(this.value);
    });
  }

  document.getElementById('dateGoBtn').addEventListener('click', function() {
    selectedMonth = parseInt(document.getElementById('selMonth').value);
    selectedDay = parseInt(document.getElementById('selDay').value);
    generateDateBroadcast();
  });

  function generateDateBroadcast() {
    var dateStr = year + '-' +
      String(selectedMonth).padStart(2, '0') + '-' +
      String(selectedDay).padStart(2, '0');

    var channel = stations[stationIdx] ? (stations[stationIdx].category || 'news') : 'news';
    document.getElementById('nowPlaying').textContent = '生成中: ' + dateStr;

    // 调用新 API: /api/broadcast/date/{date}?category=...
    fetch('/api/broadcast/date/' + dateStr + '?category=' + encodeURIComponent(channel))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.audio_url) {
          AUDIO.src = data.audio_url;
          AUDIO.play().catch(function() {});
          var sourceLabel = formatSource(data.source);
          var title = (data.metadata && data.metadata.title) ? data.metadata.title : dateStr;
          document.getElementById('nowPlaying').textContent =
            title + ' · ' + sourceLabel;
        } else {
          document.getElementById('nowPlaying').textContent =
            dateStr + ' — 无内容';
        }
      })
      .catch(function() {
        // API 不可用 → AI 兜底
        aiGenerateDate(dateStr);
      });
  }

  function aiGenerateDate(dateStr) {
    var st = stations[stationIdx];
    fetch('/api/broadcast/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: st ? st.category : 'news',
        year: year,
        station_name: st ? st.name : '',
        voice: TONE_NAMES[toneIdx]
      })
    }).then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.audio_url) {
          AUDIO.src = data.audio_url;
          AUDIO.play().catch(function() {});
          var sourceLabel = formatSource(data.source || 'ai');
          document.getElementById('nowPlaying').textContent =
            dateStr + ' · ' + sourceLabel;
        }
      })
      .catch(function(err) {
        console.log('AI生成失败:', err);
        document.getElementById('nowPlaying').textContent =
          dateStr + ' · 生成失败';
      });
  }

  // ============ 播放控制 ============
  function playCurrent() {
    var s = stations[stationIdx];
    if (!s) return;
    if (mode === 'FM' && s.stream_url) {
      playStream(s);
    } else {
      ttsGenerate(s);
    }
  }

  function playStream(station) {
    if (prevStreamUrl === station.stream_url && !AUDIO.paused) return;
    prevStreamUrl = station.stream_url;
    AUDIO.src = station.stream_url;
    AUDIO.play().catch(function(e) { console.log('Stream failed:', e.message); });
  }

  function formatSource(src) {
    var labels = {
      'r2': 'R2缓存', 'api': '历史API', 'downloaded': '已下载',
      'ai': 'AI生成', 'live': '实时直播'
    };
    return labels[src] || src || '未知';
  }

  function aiFallbackGenerate(station) {
    fetch('/api/broadcast/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: station.category || 'news',
        year: year,
        station_name: station.name,
        voice: TONE_NAMES[toneIdx]
      })
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.audio_url) {
        AUDIO.src = data.audio_url;
        AUDIO.play().catch(function(e) { console.log('TTS play failed:', e); });
        document.getElementById('nowPlaying').textContent =
          '[' + year + '] ' + station.name + ' · AI生成(兜底)';
      }
    }).catch(function(err) { console.log('Fallback TTS error:', err); });
  }

  function ttsGenerate(station) {
    AUDIO.pause();
    prevStreamUrl = '';

    var channel = station.category || 'news';
    var apiUrl, fetchOptions;

    if (year === ERA_MAX) {
      // 2026 年 → 实时广播 API
      apiUrl = '/api/broadcast/live?category=' + encodeURIComponent(channel);
      fetchOptions = { method: 'GET' };
    } else {
      // 历史年代 → 年代广播 API
      apiUrl = '/api/broadcast/year/' + year + '?category=' + encodeURIComponent(channel);
      fetchOptions = { method: 'GET' };
    }

    fetch(apiUrl, fetchOptions)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.audio_url) {
          AUDIO.src = data.audio_url;
          AUDIO.play().catch(function(e) { console.log('TTS play failed:', e); });
          var sourceLabel = formatSource(data.source);
          var prefix = data.station_name
            ? '直播: ' + data.station_name
            : '[' + year + '] ' + station.name;
          document.getElementById('nowPlaying').textContent = prefix + ' · ' + sourceLabel;
        }
      })
      .catch(function(err) {
        console.log('TTS error:', err);
        // 兜底：回退到 POST /api/broadcast/generate
        aiFallbackGenerate(station);
      });
  }

  // ============ 最近收听 ============
  function saveRecent(station) {
    var recents = [];
    try { recents = JSON.parse(localStorage.getItem('elderradio_recents') || '[]'); } catch(e) {}
    recents = recents.filter(function(r) { return r.id !== station.id; });
    recents.unshift({ id: station.id, name: station.name, province: station.province, category: station.category, year: year });
    recents = recents.slice(0, 10);
    localStorage.setItem('elderradio_recents', JSON.stringify(recents));
  }

  // ============ 对讲按钮 (PTT) ============
  var pttBtn = document.getElementById('knobPTT');

  pttBtn.addEventListener('mousedown', startRecording);
  pttBtn.addEventListener('mouseup', stopRecording);
  pttBtn.addEventListener('mouseleave', stopRecording);
  pttBtn.addEventListener('touchstart', function(e) { e.preventDefault(); startRecording(); });
  pttBtn.addEventListener('touchend', stopRecording);

  function startRecording() {
    if (isRecording) return;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
      mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      recordedChunks = [];
      mediaRecorder.ondataavailable = function(e) { if (e.data.size > 0) recordedChunks.push(e.data); };
      mediaRecorder.onstop = sendRecording;
      mediaRecorder.start();
      isRecording = true;
      pttBtn.classList.add('recording');
      AUDIO.pause();
    }).catch(function(e) { console.log('Mic denied:', e); });
  }

  function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    pttBtn.classList.remove('recording');
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
      mediaRecorder.stream.getTracks().forEach(function(t) { t.stop(); });
    }
  }

  function sendRecording() {
    if (recordedChunks.length === 0) return;
    var blob = new Blob(recordedChunks, { type: 'audio/webm' });
    var fd = new FormData();
    fd.append('audio', blob, 'ptt.webm');
    fd.append('station', stations[stationIdx] ? stations[stationIdx].name : '');
    fd.append('year', String(year));
    fd.append('voice', TONE_NAMES[toneIdx]);

    fetch('/api/ai-chat', { method: 'POST', body: fd })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.audio_url) {
          var reply = new Audio(data.audio_url);
          reply.volume = volume;
          reply.play();
          reply.onended = function() {
            if (!isRecording && stations[stationIdx]) playCurrent();
          };
        }
      })
      .catch(function(e) {
        console.log('PTT error:', e);
        if (!isRecording && stations[stationIdx]) playCurrent();
      });
  }

  // ============ URL 参数加载 ============
  function loadFromURL() {
    var params = new URLSearchParams(window.location.search);

    // 年代参数: ?year=1985
    var yParam = params.get('year');
    if (yParam) {
      var y = parseInt(yParam);
      if (y >= ERA_MIN && y <= ERA_MAX) {
        year = y;
        document.getElementById('nixieYear').textContent = year;
        setKnobRotation(document.getElementById('knobEra'), angleForValue(year, ERA_MIN, ERA_MAX));
        setMode('AM');
      }
    }

    // 电台参数: ?station=cnr_001
    var sid = params.get('station');
    if (sid) {
      var st = allStations.find(function(s) { return s.id === sid; });
      if (st) {
        if (st.stream_url) setMode('FM');
        filterStations();
        var idx = stations.findIndex(function(s) { return s.id === sid; });
        if (idx >= 0) { setStIdx(idx); onTuneChange(); }
        return;
      }
    }

    filterStations();
  }

  // ============ 键盘控制 ============
  document.addEventListener('keydown', function(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (e.key === 'ArrowRight') { setStIdx(stationIdx + 1); onTuneChange(); }
    if (e.key === 'ArrowLeft')  { setStIdx(stationIdx - 1); onTuneChange(); }
    if (e.key === 'ArrowUp')    { setVol(volume + 0.05); }
    if (e.key === 'ArrowDown')  { setVol(volume - 0.05); }
  });

  // ============ 初始化 ============
  function init() {
    populateDateSelector();

    Promise.all([
      fetch('/radio_sources.json').then(function(r) { return r.json(); }),
      fetch('/broadcast_data.json').then(function(r) { return r.json(); }).catch(function() { return {}; })
    ]).then(function(results) {
      allStations = results[0].stations || [];
      broadcastData = results[1];

      setStIdx(0);
      setVol(0.7);
      loadFromURL();
      renderDial();
      updateEraScroll();

      if (stations.length > 0) {
        if (!window.location.search.includes('station') && stations[0]) {
          saveRecent(stations[0]);
          playCurrent();
        }
      }
    }).catch(function(e) { console.error('Load error:', e); });
  }

  init();
})();
