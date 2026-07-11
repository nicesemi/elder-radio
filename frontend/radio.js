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
  let liveStations = [];
  let historyStations = [];
  let cntvStations = [];
  let cntrYearSet = new Set();
  let currentCategory = '';
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

  // 五月天模式
  let maydayYears = [];
  let maydaySongs = [];
  let maydayYearsInfo = {};
  let maydayLoaded = false;
  const MAYDAY_MIN = 1999, MAYDAY_MAX = 2024;

  AUDIO.volume = volume;

  // ============ 旋钮拖动系统 ============
  function angleForValue(val, min, max) {
    return ((val - min) / (max - min)) * 270;
  }

  function makeKnobDraggable(el, getVal, setVal, opts) {
    const { min, max, step, onChange } = opts;
    let dragging = false, startY, startVal;
    let lastY = 0, lastTime = 0, velocity = 0;
    let inertiaFrame = null;

    // 移动端：增大触摸热区
    el.style.minWidth = '88px';
    el.style.minHeight = '88px';
    el.style.display = 'flex';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';

    function startDrag(clientY) {
      dragging = true;
      startY = clientY;
      startVal = getVal();
      lastY = clientY;
      lastTime = performance.now();
      velocity = 0;
      el.style.cursor = 'grabbing';
      if (inertiaFrame) { cancelAnimationFrame(inertiaFrame); inertiaFrame = null; }
    }

    function moveDrag(clientY, e) {
      if (!dragging) return;
      if (e && e.cancelable) e.preventDefault();
      const now = performance.now();
      const dt = now - lastTime;
      if (dt > 0) {
        velocity = (lastY - clientY) / dt;
      }
      lastY = clientY;
      lastTime = now;

      const dy = startY - clientY;
      const sens = (max - min) / 200;
      let newVal = startVal + dy * sens;
      if (step) newVal = Math.round(newVal / step) * step;
      newVal = Math.max(min, Math.min(max, newVal));
      setVal(newVal);
      if (onChange) onChange(newVal);
    }

    function endDrag() {
      if (!dragging) return;
      dragging = false;
      el.style.cursor = 'grab';

      // 惯性滑动
      if (Math.abs(velocity) > 0.05) {
        let v = velocity * 80 * ((max - min) / 200);
        function animate() {
          v *= 0.92;
          if (Math.abs(v) < 0.01) { inertiaFrame = null; return; }
          let newVal = getVal() + v;
          if (step) newVal = Math.round(newVal / step) * step;
          newVal = Math.max(min, Math.min(max, newVal));
          setVal(newVal);
          if (onChange) onChange(newVal);
          inertiaFrame = requestAnimationFrame(animate);
        }
        inertiaFrame = requestAnimationFrame(animate);
      }
    }

    // Mouse events (desktop)
    el.addEventListener('mousedown', function(e) {
      e.preventDefault();
      startDrag(e.clientY);
    });

    window.addEventListener('mousemove', function(e) {
      moveDrag(e.clientY, e);
    });

    window.addEventListener('mouseup', endDrag);

    // Touch events (mobile)
    el.addEventListener('touchstart', function(e) {
      if (e.touches.length === 1) {
        startDrag(e.touches[0].clientY);
      }
    }, { passive: true });

    el.addEventListener('touchmove', function(e) {
      if (e.touches.length === 1) {
        moveDrag(e.touches[0].clientY, e);
      }
    }, { passive: false });

    el.addEventListener('touchend', endDrag);
    el.addEventListener('touchcancel', endDrag);

    // Wheel (desktop scroll)
    el.addEventListener('wheel', function(e) {
      e.preventDefault();
      const dir = e.deltaY > 0 ? -1 : 1;
      let newVal = getVal() + dir * (step || 1);
      newVal = Math.max(min, Math.min(max, newVal));
      setVal(newVal);
      if (onChange) onChange(newVal);
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
    renderChannelList();
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
    if (mode === 'MAYDAY' && maydayYears.length > 0) {
      var curIdx = maydayYears.indexOf(year);
      if (curIdx < 0) curIdx = 0;
      if (y > year) curIdx = Math.min(curIdx + 1, maydayYears.length - 1);
      else if (y < year) curIdx = Math.max(curIdx - 1, 0);
      year = maydayYears[curIdx];
    } else {
      year = Math.max(ERA_MIN, Math.min(ERA_MAX, Math.round(y)));
    }
    document.getElementById('nixieYear').textContent = year;

    if (mode === 'MAYDAY') {
      if (maydayYears.length > 0) {
        var idx = maydayYears.indexOf(year);
        if (idx >= 0) setKnobRotation(document.getElementById('knobEra'), angleForValue(idx, 0, maydayYears.length - 1));
      }
      fetchMaydaySongs(year);
    } else {
      setKnobRotation(document.getElementById('knobEra'), angleForValue(year, ERA_MIN, ERA_MAX));
      filterStations();
      // CNR 有该年数据 → 自动切到 1月1日
      if (cntrYearSet.has(String(year))) {
        selectedMonth = 1;
        selectedDay = 1;
        document.getElementById('selMonth').value = 1;
        populateDayOptions();
        document.getElementById('selDay').value = 1;
      }
      fetchHistoryStations(year);
    }
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
    document.getElementById('btnMAYDAY').classList.toggle('active', m === 'MAYDAY');
    document.getElementById('modeIndicator').textContent = m === 'MAYDAY' ? 'MD' : m;

    var isLive = m === 'FM';
    var isMayday = m === 'MAYDAY';
    document.getElementById('liveLed').classList.toggle('off', !isLive && !isMayday);
    document.getElementById('dialLed').classList.toggle('off', !isLive && !isMayday);
    document.getElementById('dialModeLabel').textContent = m === 'MAYDAY' ? 'MAYDAY' : m;

    if (m === 'FM') {
      document.getElementById('dialRange').textContent = '88-108 MHz';
      document.getElementById('channelList').style.display = '';
      document.getElementById('categoryTabs').style.display = '';
      currentCategory = '';
      fetchLiveStations();
    } else if (m === 'MAYDAY') {
      document.getElementById('dialRange').textContent = '五月天电台';
      document.getElementById('channelList').style.display = 'none';
      document.getElementById('categoryTabs').style.display = 'none';
      document.getElementById('nixieLabel').textContent = 'YEAR / 年代';
      // 隐藏日期选择器
      document.getElementById('selMonth').parentElement.style.display = 'none';
      fetchMaydayYears();
    } else {
      document.getElementById('dialRange').textContent = '年代电台';
      document.getElementById('channelList').style.display = '';
      document.getElementById('categoryTabs').style.display = '';
      document.getElementById('nixieLabel').textContent = 'YEAR / 年代';
      document.getElementById('selMonth').parentElement.style.display = '';
      filterStations();
      fetchHistoryStations(year);
    }

    updateEraScroll();
    if (!isMayday) onTuneChange();
  }

  document.getElementById('btnAM').addEventListener('click', function() { setMode('AM'); });
  document.getElementById('btnFM').addEventListener('click', function() { setMode('FM'); });
  document.getElementById('btnMAYDAY').addEventListener('click', function() { setMode('MAYDAY'); });
  document.getElementById('btnTONE').addEventListener('click', function() {
    toneIdx = (toneIdx + 1) % TONE_NAMES.length;
    var t = TONE_NAMES[toneIdx];
    document.getElementById('btnTONE').textContent = t[0];
    document.getElementById('btnTONE').title = '音色: ' + t;
    if (mode === 'AM' && stations[stationIdx]) ttsGenerate(stations[stationIdx]);
  });

  // ============ 五月天模式 ============
  function fetchMaydayYears() {
    fetch('/api/mayday/years')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.success && data.years && data.years.length > 0) {
          maydayYears = data.years;
          maydayYearsInfo = data.years_info || {};
          maydayLoaded = true;

          if (maydayYears.indexOf(year) < 0) {
            year = maydayYears[0];
          }
          document.getElementById('nixieYear').textContent = year;
          if (maydayYears.length > 0) {
            setKnobRotation(document.getElementById('knobEra'), angleForValue(
              maydayYears.indexOf(year), 0, maydayYears.length - 1
            ));
          }
          fetchMaydaySongs(year);
        } else {
          document.getElementById('nowPlaying').textContent = '五月天数据为空';
        }
      })
      .catch(function(e) {
        console.error('五月天API失败:', e);
        document.getElementById('nowPlaying').textContent = '五月天电台暂不可用';
      });
  }

  function fetchMaydaySongs(y) {
    document.getElementById('nowPlaying').textContent = '加载中... ' + y;
    fetch('/api/mayday/year/' + y)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.success && data.songs && data.songs.length > 0) {
          maydaySongs = data.songs;
          stations = maydaySongs.map(function(s, i) {
            return {
              id: 'mayday_' + y + '_' + i,
              name: s.filename.replace(/\.[^.]+$/, '').replace(/^[\d]{4}-/, ''),
              stream_url: s.url,
              type: 'mayday',
              category: '五月天',
              era: String(y),
              verified: true,
              source: 'r2_mayday'
            };
          });
          stationIdx = 0;
          bindTuningKnob();
          setStIdx(0);
          renderDial();
          renderChannelListMayday();
          updateEraScrollMayday();
          updateNowPlaying();
          playCurrent();
        } else {
          stations = [];
          stationIdx = 0;
          renderDial();
          updateNowPlaying();
          stopPlayback();
        }
      })
      .catch(function(e) {
        console.error('五月天歌曲API失败:', e);
        document.getElementById('nowPlaying').textContent = '加载失败';
      });
  }

  function renderChannelListMayday() {
    var el = document.getElementById('channelList');
    var scroll = document.getElementById('channelListScroll');
    if (!el || !scroll) return;
    document.getElementById('categoryTabs').style.display = 'none';

    if (stations.length <= 1) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';
    document.getElementById('channelList').querySelector('.channel-list-label').textContent = year + '年 歌曲列表';

    scroll.innerHTML = stations.map(function(s, i) {
      var cls = 'channel-chip';
      if (i === stationIdx) cls += ' current';
      var label = s.name.length > 22 ? s.name.slice(0, 22) + '…' : s.name;
      return '<span class="' + cls + '" data-idx="' + i + '">' + label + '</span>';
    }).join('');

    var chips = scroll.querySelectorAll('.channel-chip');
    for (var j = 0; j < chips.length; j++) {
      chips[j].addEventListener('click', function() {
        setStIdx(parseInt(this.dataset.idx));
        onTuneChange();
      });
    }
  }

  function updateEraScrollMayday() {
    var el = document.getElementById('eraScroll');
    el.style.display = 'block';
    el.textContent = year + '年 · ' + stations.length + '首 · 循环播放中';
  }

  function filterStations() {
    var filtered = allStations.slice();

    if (mode === 'FM') {
      // FM: 所有有流的直播台，verified 优先
      filtered = filtered.filter(function(s) { return s.type === 'live' && s.stream_url; });
      filtered.sort(function(a, b) { return (b.verified ? 1 : 0) - (a.verified ? 1 : 0); });
    } else {
      // AM: 年代匹配的电台
      filtered = filtered.filter(function(s) {
        var era = s.era || '';
        var matchDecade = era.match(/^(\d{4})/);
        if (!matchDecade) return false;
        var eraYear = parseInt(matchDecade[1]);
        return eraYear <= year && s.type === 'live' && s.stream_url;
      });
    }

    // AM 兜底：从 broadcast_data.json 生成虚拟电台
    if (filtered.length === 0 && mode === 'AM') {
      var yearData = broadcastData.years && broadcastData.years[String(year)];
      var bStations = yearData ? (yearData.stations || []) : [];
      for (var i = 0; i < bStations.length; i++) {
        filtered.push({
          id: 'ai_' + i,
          name: bStations[i],
          type: 'ai_archive',
          category: '历史',
          era: String(year),
          stream_url: null,
          verified: false
        });
      }
    }

    stations = filtered;
    if (stations.length === 0) {
      stationIdx = 0;
      renderDial();
      renderChannelList();
      updateNowPlaying();
      return;
    }
    if (stationIdx >= stations.length) stationIdx = 0;
    bindTuningKnob();
    setStIdx(stationIdx);
    renderDial();
    renderChannelList();
    playCurrent();
    updateNowPlaying();
  }

  // ============ FM 实时电台获取 ============
  function fetchLiveStations(category) {
    var url = '/api/stations/live?limit=300';
    if (category) url += '&category=' + encodeURIComponent(category);

    fetch(url).then(function(r) {
      if (!r.ok) throw new Error('API error');
      return r.json();
    }).then(function(data) {
      if (data.stations && data.stations.length > 0) {
        liveStations = data.stations.map(function(s) {
          return {
            id: s.id,
            name: s.name,
            stream_url: s.stream_url,
            type: 'live',
            category: s.category,
            source: s.source,
            favicon: s.favicon || '',
            verified: true
          };
        });
      } else {
        fallbackToLocalVerified();
      }
      applyLiveStations();
    }).catch(function() {
      fallbackToLocalVerified();
      applyLiveStations();
    });

    function fallbackToLocalVerified() {
      // 使用全部直播电台（不限定 verified），按名称去重
      var seen = {};
      liveStations = [];
      allStations.forEach(function(s) {
        if (s.type === 'live' && s.stream_url) {
          var key = s.id || s.name;
          if (!seen[key]) {
            seen[key] = true;
            liveStations.push(s);
          }
        }
      });
    }

    function applyLiveStations() {
      stations = liveStations;
      if (stations.length === 0) {
        stationIdx = 0;
        renderDial();
        renderChannelList();
        renderCategoryTabs();
        updateNowPlaying();
        return;
      }
      if (stationIdx >= stations.length) stationIdx = 0;
      bindTuningKnob();
      setStIdx(stationIdx);
      renderDial();
      renderChannelList();
      renderCategoryTabs();
      playCurrent();
      updateNowPlaying();
    }
  }

  // ============ AM 历史存档电台获取 ============
  function fetchHistoryStations(y) {
    var url = '/api/broadcast/history/' + y;

    fetch(url).then(function(r) {
      if (!r.ok) throw new Error('API error');
      return r.json();
    }).then(function(data) {
      if (data.stations && data.stations.length > 0) {
        // 将 R2 归档数据转为 station 对象
        var histStations = [];
        data.stations.forEach(function(entry) {
          var stationName = entry.station_name || '未知电台';
          var category = entry.category || '历史';
          (entry.audio_urls || []).forEach(function(item, i) {
            var url = typeof item === 'string' ? item : (item.url || '');
            var dateLabel = '';
            if (entry.dates && entry.dates[i]) {
              dateLabel = ' ' + entry.dates[i];
            } else if (entry.audio_urls.length > 1) {
              dateLabel = ' #' + (i + 1);
            }
            if (!url) return;
            histStations.push({
              id: 'hist_' + y + '_' + (entry.category_key || entry.station_name) + '_' + i,
              name: stationName + dateLabel,
              stream_url: url,
              type: 'archive',
              category: category,
              era: String(y),
              verified: true,
              source: 'r2_archive'
            });
          });
        });

        if (histStations.length > 0) {
          historyStations = histStations;
          stations = histStations;
          stationIdx = 0;
          bindTuningKnob();
          setStIdx(0);
          renderDial();
          renderChannelList();
          updateEraScroll();
          updateNowPlaying();
          return;
        }
      }
      // 无历史数据 → 尝试 CNR 云听回听兜底
      console.log('[AM] broadcasts/ 无数据，尝试 CNR 云听回听');
      generateDateBroadcast();
    }).catch(function() {
      // API 不可用 → 尝试 CNR 兜底
      console.log('[AM] broadcasts/ API 不可用，尝试 CNR 云听');
      generateDateBroadcast();
    });
  }

  function updateEraScroll() {
    var el = document.getElementById('eraScroll');
    if (mode === 'AM') {
      if (cntvStations.length > 0 && stations === cntvStations) {
        var dateLabel = stations[0] && stations[0].id
          ? stations[0].id.match(/\d{4}-\d{2}-\d{2}/)
          : null;
        el.textContent = (dateLabel ? dateLabel[0] : year) + ' · 中国之声云听回听';
      } else {
        var events = (broadcastData.years && broadcastData.years[String(year)])
          ? broadcastData.years[String(year)].events || [] : [];
        var preview = events.length > 0
          ? events.slice(0, 2).join(' · ')
          : year + '年 — ' + stations.length + ' 个电台';
        el.textContent = preview;
      }
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
      c.innerHTML = '<span style="color:#555;font-size:9px;align-self:center;">等待调谐...</span>';
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
      var label;
      if (mode === 'FM') {
        label = s.stream_url ? 'FM ' + (88 + realIdx % 20) + '.' + (Math.floor(realIdx * 0.5 % 10)) : '---';
      } else if (s.type === 'ai_archive') {
        label = '◆ ' + s.name.slice(0, 7);
      } else {
        label = s.name.slice(0, 8);
      }
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
      if (s.type === 'cntv') {
        var timeLabel = s.start ? s.start + '-' + s.end : '';
        el.textContent = '[' + year + '] ' + s.name + (timeLabel ? ' ' + timeLabel : '') + ' · 云听回听';
      } else if (mode === 'FM') {
        el.textContent = '直播: ' + s.name;
      } else {
        el.textContent = '[' + year + '] ' + s.name;
      }
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

    // 优先查云听 CNR 回听节目
    fetch('/api/cntv/date/' + dateStr)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.programs && data.programs.length > 0) {
          // 有云听回听数据 → 渲染为可调谐的节目列表
          cntvStations = data.programs.map(function(p, i) {
            return {
              id: 'cntv_' + dateStr + '_' + i,
              name: p.name,
              stream_url: p.url,
              type: 'cntv',
              category: '新闻',
              era: String(year),
              verified: true,
              source: 'ytapi.radio.cn',
              start: p.start,
              end: p.end
            };
          });
          stations = cntvStations;
          stationIdx = 0;
          bindTuningKnob();
          setStIdx(0);
          renderDial();
          renderChannelList();
          updateEraScroll();
          document.getElementById('nowPlaying').textContent =
            '[' + dateStr + '] 中国之声 · ' + data.programs.length + ' 档节目';
          return;
        }
        // 无 CNR 数据 → 走原有广播生成逻辑
        _fallbackBroadcast(dateStr);
      })
      .catch(function() {
        _fallbackBroadcast(dateStr);
      });
  }

  function _fallbackBroadcast(dateStr) {
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
    if (mode === 'MAYDAY') {
      playMaydaySong(s);
    } else if (s.type === 'ai_archive') {
      ttsGenerate(s);
    } else if (s.stream_url) {
      playStream(s);
    } else {
      ttsGenerate(s);
    }
  }

  function playMaydaySong(station) {
    if (!station.stream_url) return;
    prevStreamUrl = station.stream_url;
    AUDIO.src = station.stream_url;
    AUDIO.play().catch(function(e) { console.log('Mayday play failed:', e.message); });
  }

  function stopPlayback() {
    AUDIO.pause();
    AUDIO.src = '';
    prevStreamUrl = '';
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

  // ============ 频道列表渲染 ============
  function renderChannelList() {
    var el = document.getElementById('channelList');
    var scroll = document.getElementById('channelListScroll');
    if (!el || !scroll) return;

    // 按分类筛选（仅 FM 模式生效）
    var list = stations;
    if (mode === 'FM' && currentCategory && currentCategory !== '全部') {
      list = stations.filter(function(s) {
        return s.category && s.category === currentCategory;
      });
    }

    if (list.length === 0) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';

    scroll.innerHTML = list.map(function(s, i) {
      var cls = 'channel-chip';
      // 高亮当前台：在 stations 中找到实际索引
      var realIdx = stations.indexOf(s);
      if (realIdx === stationIdx) cls += ' current';
      if (s.verified) cls += ' verified';
      if (s.type === 'ai_archive') cls += ' ai';
      if (s.type === 'cntv') cls += ' cntv';
      var label;
      if (s.type === 'cntv' && s.start) {
        label = s.start + ' ' + (s.name.length > 12 ? s.name.slice(0, 12) + '…' : s.name);
      } else {
        label = s.name.length > 18 ? s.name.slice(0, 18) + '…' : s.name;
      }
      var sourceBadge = '';
      if (s.source && s.source === 'ytapi.radio.cn') {
        sourceBadge = ' <span style="opacity:0.5;font-size:7px;">云听</span>';
      } else if (s.source && (mode === 'FM' || s.source === 'r2_archive' || s.source === 'archive.org')) {
        sourceBadge = ' <span style="opacity:0.5;font-size:7px;">' + s.source + '</span>';
      }
      return '<span class="' + cls + '" data-idx="' + realIdx + '">' + label + sourceBadge + '</span>';
    }).join('');

    var chips = scroll.querySelectorAll('.channel-chip');
    for (var j = 0; j < chips.length; j++) {
      chips[j].addEventListener('click', function() {
        setStIdx(parseInt(this.dataset.idx));
        onTuneChange();
        renderChannelList();
      });
    }
  }

  // ============ 分类标签渲染 ============
  function renderCategoryTabs() {
    var el = document.getElementById('categoryTabs');
    if (!el) return;

    // 仅 FM 模式显示
    if (mode !== 'FM') {
      el.style.display = 'none';
      return;
    }

    // 从 liveStations 聚合分类
    var cats = {};
    liveStations.forEach(function(s) {
      if (s.category) cats[s.category] = (cats[s.category] || 0) + 1;
    });

    var catNames = Object.keys(cats).sort(function(a, b) {
      // 常见分类排前面：新闻/音乐/体育/财经/交通/生活/教育
      var order = ['新闻', '音乐', '体育', '财经', '交通', '生活', '教育'];
      var ai = order.indexOf(a), bi = order.indexOf(b);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return cats[b] - cats[a];
    });

    if (catNames.length === 0) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'flex';

    var allCount = liveStations.length;
    var html = '<span class="category-tab' + (currentCategory === '' || currentCategory === '全部' ? ' active' : '') + '" data-cat="">全部 ' + allCount + '</span>';
    catNames.forEach(function(c) {
      html += '<span class="category-tab' + (currentCategory === c ? ' active' : '') + '" data-cat="' + c + '">' + c + ' ' + cats[c] + '</span>';
    });
    el.innerHTML = html;

    // 绑定点击事件
    var tabs = el.querySelectorAll('.category-tab');
    for (var k = 0; k < tabs.length; k++) {
      tabs[k].addEventListener('click', function() {
        currentCategory = this.dataset.cat;
        renderCategoryTabs();
        renderChannelList();
      });
    }
  }

  // ============ 五月天模式：歌曲循环播放 ============
  AUDIO.addEventListener('ended', function() {
    if (mode === 'MAYDAY' && stations.length > 0) {
      stationIdx = (stationIdx + 1) % stations.length;
      renderDial();
      renderChannelListMayday();
      updateNowPlaying();
      playCurrent();
    }
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

      // 预加载 CNR 年份列表（用于 AM 模式自动回退）
      fetch('/api/cntv/years')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.years) {
            cntrYearSet = new Set(data.years);
            console.log('[CNR] 可用年份:', data.years);
          }
        }).catch(function() {});

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
