/* =============================================
   radio.js — 复古收音机模拟器 v4.0
   新增：频道切换(新闻/音乐)、自动播放、URL 参数支持
   ============================================= */

(function() {
  'use strict';

  // ============ 状态 ============
  const AUDIO = document.getElementById('audioPlayer');
  const ERA_MIN = 1949, ERA_MAX = 2026;
  const TONE_NAMES = ['Agnes', '温婉女声', '浑厚男声', '粤语播音', '童声'];

  let allStations = [];
  let broadcastData = {};
  let singerData = { singers: [] };   // 歌手/歌曲数据（音乐频道用）
  let liveStations = [];
  let historyStations = [];
  let cntvStations = [];
  let cntrYearSet = new Set();
  let currentCategory = '';
  let currentChannel = 'news';         // 'news' | 'music' | 'novel'（仅 1949-2019 AM 模式生效）
  let currentTextContent = null;       // 当前 AI 文字内容缓存 {text, year, channel}
  let textContentExpanded = false;     // 是否展开全文
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

  // ============ 浏览器自动播放策略兼容 ============
  // 页面加载时 autoPlayToday() 可能触发 FM 直播自动播放，
  // 但浏览器要求有声播放需用户手势。先静音自动播放，用户交互后取消静音。
  var audioMutedByPolicy = false;

  function tryUnmuteAudio() {
    if (audioMutedByPolicy) {
      audioMutedByPolicy = false;
      AUDIO.muted = false;
      // 恢复真实电台名称
      var s = stations[stationIdx];
      if (s && mode === 'FM') {
        document.getElementById('nowPlaying').textContent = '直播: ' + s.name;
      } else {
        updateNowPlaying();
      }
    }
  }
  document.addEventListener('click', tryUnmuteAudio);
  document.addEventListener('touchstart', tryUnmuteAudio);
  document.addEventListener('keydown', tryUnmuteAudio);

  // ============ 旋钮拖动系统 ============
  function angleForValue(val, min, max) {
    return ((val - min) / (max - min)) * 270;
  }

  function makeKnobDraggable(el, getVal, setVal, opts) {
    const { min, max, step, onChange } = opts;
    let dragging = false, startY, startVal;
    let lastY = 0, lastTime = 0, velocity = 0;
    let inertiaFrame = null;

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

    el.addEventListener('mousedown', function(e) {
      e.preventDefault();
      startDrag(e.clientY);
    });

    window.addEventListener('mousemove', function(e) {
      moveDrag(e.clientY, e);
    });

    window.addEventListener('mouseup', endDrag);

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
      renderChannelTabs();  // 频道 Tab 随年代变化显隐
      filterStations();
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

  // ============ 频道 Tab 渲染 ============
  function renderChannelTabs() {
    var el = document.getElementById('channelTabs');
    if (!el) return;
    // 仅 AM 模式 + 1949-2019 显示频道 Tab
    if (mode === 'AM' && year >= 1949 && year <= 2019) {
      el.style.display = 'flex';
    } else {
      el.style.display = 'none';
      return;
    }
    // 高亮当前频道
    var tabs = el.querySelectorAll('.channel-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].dataset.channel === currentChannel);
    }
  }

  function bindChannelTabs() {
    var el = document.getElementById('channelTabs');
    if (!el) return;
    el.addEventListener('click', function(e) {
      var tab = e.target.closest('.channel-tab');
      if (!tab) return;
      var ch = tab.dataset.channel;
      if (ch && ch !== currentChannel) {
        currentChannel = ch;
        renderChannelTabs();
        filterStations();
        if (stations.length > 0) {
          stationIdx = 0;
          setStIdx(0);
          bindTuningKnob();
          renderDial();
          renderChannelList();
          updateNowPlaying();
          playCurrent();
        }
        updateEraScroll();
      }
    });
  }

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

    // 频道 Tab 随模式变化
    renderChannelTabs();

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

  // 展开全文按钮
  document.getElementById('contentExpandBtn').addEventListener('click', function() {
    textContentExpanded = !textContentExpanded;
    var textEl = document.getElementById('contentPreviewText');
    var btn = document.getElementById('contentExpandBtn');
    if (!currentTextContent) return;
    if (textContentExpanded) {
      textEl.textContent = currentTextContent.text;
      textEl.classList.add('expanded');
      btn.textContent = '收起 ▲';
    } else {
      textEl.textContent = currentTextContent.text.substring(0, 200) + '...';
      textEl.classList.remove('expanded');
      btn.textContent = '展开全文 ▼';
    }
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

  // ============ 电台过滤（核心 — v4.0 支持双频道） ============
  function filterStations() {
    var filtered = [];

    if (mode === 'FM') {
      // FM 直播：所有有流的直播台
      filtered = allStations.filter(function(s) { return s.type === 'live' && s.stream_url; });
      filtered.sort(function(a, b) { return (b.verified ? 1 : 0) - (a.verified ? 1 : 0); });
    } else if (mode === 'AM') {
      // AM 模式：按年代匹配
      filtered = allStations.filter(function(s) {
        var era = s.era || '';
        var matchDecade = era.match(/^(\d{4})/);
        if (!matchDecade) return false;
        var eraYear = parseInt(matchDecade[1]);
        return eraYear <= year && s.type === 'live' && s.stream_url;
      });

      // 1949-2019 双频道支持
      if (year >= 1949 && year <= 2019) {
        if (currentChannel === 'news') {
          // 新闻频道：筛选新闻类电台
          var newsFiltered = filtered.filter(function(s) {
            var cat = (s.category || '').toLowerCase();
            return cat.indexOf('新闻') >= 0 || cat.indexOf('综合') >= 0 || cat.indexOf('news') >= 0;
          });
          // 若新闻类电台不足，保留全部匹配电台
          filtered = newsFiltered.length > 0 ? newsFiltered : filtered;

          // 兜底：从 broadcast_data.json 生成 AI 虚拟"大事记"频道
          if (filtered.length === 0) {
            var yearData = broadcastData.years && broadcastData.years[String(year)];
            var bEvents = yearData ? (yearData.events || []) : [];
            if (bEvents.length > 0) {
              filtered.push({
                id: 'ai_news_' + year,
                name: year + '年 大事记',
                type: 'ai_archive',
                category: '新闻',
                era: String(year),
                stream_url: null,
                verified: false,
                channel: 'news'
              });
            } else {
              filtered.push({
                id: 'ai_news_' + year,
                name: year + '年 新闻广播',
                type: 'ai_archive',
                category: '新闻',
                era: String(year),
                stream_url: null,
                verified: false,
                channel: 'news'
              });
            }
          }
          // 异步获取 AI 文字内容
          fetchTextContent(year, 'news');
        } else if (currentChannel === 'music') {
          // 音乐频道：异步从 /api/music/{year} 获取歌曲数据
          stations = [{ id: 'music_loading_' + year, name: '加载中...', type: 'placeholder', category: '音乐', era: String(year), stream_url: null, verified: false, channel: 'music' }];
          stationIdx = 0;
          bindTuningKnob();
          setStIdx(0);
          renderDial();
          renderChannelList();
          updateNowPlaying();
          updateEraScroll();
          fetchMusicStations(year);
          return;
        } else if (currentChannel === 'novel') {
          // 小说频道：异步从 /api/broadcast/history/{year}?category=novel 获取
          stations = [{ id: 'novel_loading_' + year, name: '加载中...', type: 'placeholder', category: '小说', era: String(year), stream_url: null, verified: false, channel: 'novel' }];
          stationIdx = 0;
          bindTuningKnob();
          setStIdx(0);
          renderDial();
          renderChannelList();
          updateNowPlaying();
          updateEraScroll();
          fetchNovelStations(year);
          return;
        }
      } else {
        // 2020-2025：保持原有 AM 逻辑
        if (filtered.length === 0) {
          var yearData2 = broadcastData.years && broadcastData.years[String(year)];
          var bStations2 = yearData2 ? (yearData2.stations || []) : [];
          for (var k = 0; k < bStations2.length; k++) {
            filtered.push({
              id: 'ai_' + k,
              name: bStations2[k],
              type: 'ai_archive',
              category: '历史',
              era: String(year),
              stream_url: null,
              verified: false
            });
          }
        }
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
    updateNowPlaying();
  }

  // ============ 音乐频道：从 /api/music/{year} 获取歌曲 ============
  function fetchMusicStations(y) {
    fetch('/api/music/' + y)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.success && data.songs && data.songs.length > 0) {
          var songStations = data.songs.map(function(song, i) {
            return {
              id: 'music_db_' + y + '_' + i,
              name: song.title + ' - ' + song.artist,
              stream_url: null,
              type: 'music_library',
              source: 'music_db',
              category: '音乐',
              era: String(y),
              verified: false,
              channel: 'music',
              artist: song.artist
            };
          });
          stations = songStations;
        } else {
          stations = [{
            id: 'music_empty_' + y,
            name: y + '年 暂无歌曲数据',
            type: 'placeholder',
            category: '音乐',
            era: String(y),
            stream_url: null,
            verified: false,
            channel: 'music'
          }];
        }
        stationIdx = 0;
        bindTuningKnob();
        setStIdx(0);
        renderDial();
        renderChannelList();
        updateEraScroll();
        updateNowPlaying();
      })
      .catch(function() {
        stations = [{
          id: 'music_error_' + y,
          name: '歌曲数据加载失败',
          type: 'placeholder',
          category: '音乐',
          era: String(y),
          stream_url: null,
          verified: false,
          channel: 'music'
        }];
        stationIdx = 0;
        bindTuningKnob();
        setStIdx(0);
        renderDial();
        renderChannelList();
        updateEraScroll();
        updateNowPlaying();
      });
  }

  // ============ 小说频道：从 /api/broadcast/history/{year}?category=novel 获取 ============
  function fetchNovelStations(y) {
    fetch('/api/broadcast/history/' + y)
      .then(function(r) {
        if (!r.ok) throw new Error('API error');
        return r.json();
      })
      .then(function(data) {
        if (data.stations && data.stations.length > 0) {
          // 筛选 category 为 "小说" 或 category_key 为 "novel" 的条目
          var novelStations = [];
          data.stations.forEach(function(entry) {
            var cat = entry.category || '';
            var catKey = entry.category_key || '';
            if (cat.indexOf('小说') < 0 && catKey !== 'novel') return;
            (entry.audio_urls || []).forEach(function(item, i) {
              var url = typeof item === 'string' ? item : (item.url || '');
              if (!url) return;
              var label = (entry.audio_urls.length > 1) ? ' #' + (i + 1) : '';
              novelStations.push({
                id: 'novel_' + y + '_' + i,
                name: (entry.station_name || '小说广播') + label,
                stream_url: url,
                type: 'archive',
                source: 'r2_archive',
                category: '小说',
                era: String(y),
                verified: true,
                channel: 'novel'
              });
            });
          });

          if (novelStations.length > 0) {
            stations = novelStations;
          } else {
            stations = [{
              id: 'novel_placeholder_' + y,
              name: '小说广播制作中，敬请期待',
              type: 'placeholder',
              category: '小说',
              era: String(y),
              stream_url: null,
              verified: false,
              channel: 'novel'
            }];
          }
        } else {
          stations = [{
            id: 'novel_placeholder_' + y,
            name: '小说广播制作中，敬请期待',
            type: 'placeholder',
            category: '小说',
            era: String(y),
            stream_url: null,
            verified: false,
            channel: 'novel'
          }];
        }
        stationIdx = 0;
        bindTuningKnob();
        setStIdx(0);
        renderDial();
        renderChannelList();
        updateEraScroll();
        updateNowPlaying();
        // 同时获取 AI 文字内容
        fetchTextContent(y, 'novel');
      })
      .catch(function() {
        stations = [{
          id: 'novel_placeholder_' + y,
          name: '小说广播制作中，敬请期待',
          type: 'placeholder',
          category: '小说',
          era: String(y),
          stream_url: null,
          verified: false,
          channel: 'novel'
        }];
        stationIdx = 0;
        bindTuningKnob();
        setStIdx(0);
        renderDial();
        renderChannelList();
        updateEraScroll();
        updateNowPlaying();
      });
  }

  // ============ FM 实时电台获取 ============
  // v6.0: 三级策略 — localStorage缓存 → 浏览器直调 Radio Browser API → radio_sources.json 兜底
  var _liveFetchInFlight = false;

  function fetchLiveStations(category) {
    var CACHE_KEY = 'elder_radio_live_stations';
    var CACHE_TTL = 3600000; // 1 小时

    // Step 1: localStorage 缓存
    try {
      var cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (cached && cached.timestamp && Array.isArray(cached.stations) && cached.stations.length > 0) {
        if (Date.now() - cached.timestamp < CACHE_TTL) {
          liveStations = cached.stations;
          applyLiveStations();
          return;
        }
      }
    } catch(e) {}

    // Step 2: 浏览器直调 Radio Browser API（镜像切换）
    var MIRRORS = ['de1.api.radio-browser.info', 'de2.api.radio-browser.info'];

    function tryMirror(idx) {
      if (idx >= MIRRORS.length) {
        // 所有镜像失败 → 第三级：本地兜底
        fallbackToLocal();
        return;
      }
      var apiUrl = 'https://' + MIRRORS[idx] + '/json/stations/country/China';

      fetch(apiUrl).then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function(data) {
        if (!Array.isArray(data) || data.length === 0) {
          tryMirror(idx + 1);
          return;
        }

        var rbStations = [];
        var seenUrls = {};

        data.forEach(function(s) {
          // 过滤：必须有 url_resolved 且 codec 不为空
          if (!s.url_resolved || !s.codec) return;
          var sUrl = s.url_resolved;
          if (seenUrls[sUrl]) return;
          seenUrls[sUrl] = true;

          rbStations.push({
            id: s.stationuuid,
            name: s.name,
            stream_url: s.url_resolved,
            category: mapCategory(s.tags),
            source: 'RadioBrowser',
            favicon: s.favicon || '',
            bitrate: s.bitrate || 0,
            codec: s.codec,
            votes: s.votes || 0,
            type: 'live',
            verified: true
          });
        });

        // 按 votes 降序（热门优先）
        rbStations.sort(function(a, b) { return b.votes - a.votes; });

        if (rbStations.length > 0) {
          // 存入 localStorage
          try {
            localStorage.setItem(CACHE_KEY, JSON.stringify({
              timestamp: Date.now(),
              stations: rbStations
            }));
          } catch(e) {}

          liveStations = rbStations;
          applyLiveStations();
        } else {
          tryMirror(idx + 1);
        }
      }).catch(function() {
        tryMirror(idx + 1);
      });
    }

    function fallbackToLocal() {
      var localStations = [];
      var seenUrls = {};
      allStations.forEach(function(s) {
        if (s.type === 'live' && s.stream_url && s.source_dead !== true) {
          var sUrl = s.stream_url;
          if (!seenUrls[sUrl]) {
            seenUrls[sUrl] = true;
            localStations.push({
              id: s.id || s.name,
              name: s.name,
              stream_url: s.stream_url,
              type: 'live',
              category: s.category || '综合',
              source: s.source || 'local',
              favicon: s.favicon || '',
              verified: s.verified || false
            });
          }
        }
      });

      if (localStations.length === 0) {
        localStations = getHardcodedFallback();
      }

      liveStations = localStations;
      applyLiveStations();
    }

    // 分类映射：Radio Browser tags → 中文分类
    function mapCategory(tags) {
      if (!tags) return '综合';
      var t = tags.toLowerCase();
      if (/news|information|talk|public\s*radio/.test(t)) return '新闻';
      if (/sports/.test(t)) return '体育';
      if (/business|finance/.test(t)) return '财经';
      if (/music|pop|rock|classical|jazz|folk/.test(t)) return '音乐';
      return '综合';
    }

    // 终极兜底：8 个 CNR 官方直播流
    function getHardcodedFallback() {
      return [
        { id: 'cnr_1',  name: 'CNR-1 中国之声',       stream_url: 'http://ngcdn001.cnr.cn/live/zgzs/index.m3u8',    type: 'live', category: '新闻', source: 'cnr', verified: true },
        { id: 'cnr_2',  name: 'CNR-2 经济之声',       stream_url: 'http://ngcdn002.cnr.cn/live/jjzs/index.m3u8',    type: 'live', category: '财经', source: 'cnr', verified: true },
        { id: 'cnr_3',  name: 'CNR-3 音乐之声',       stream_url: 'http://ngcdn003.cnr.cn/live/yyzs/index.m3u8',    type: 'live', category: '音乐', source: 'cnr', verified: true },
        { id: 'cnr_5',  name: 'CNR-5 台海之声',       stream_url: 'http://ngcdn005.cnr.cn/live/twzs/index.m3u8',    type: 'live', category: '新闻', source: 'cnr', verified: true },
        { id: 'cnr_7',  name: 'CNR-7 中国交通广播',   stream_url: 'http://ngcdn007.cnr.cn/live/zgzb/index.m3u8',    type: 'live', category: '交通', source: 'cnr', verified: true },
        { id: 'cnr_9',  name: 'CNR-9 文艺之声',       stream_url: 'http://ngcdn009.cnr.cn/live/wyzs/index.m3u8',    type: 'live', category: '音乐', source: 'cnr', verified: true },
        { id: 'cnr_11', name: 'CNR-11 经典音乐广播',   stream_url: 'http://ngcdn011.cnr.cn/live/dszs/index.m3u8',    type: 'live', category: '音乐', source: 'cnr', verified: true },
        { id: 'cnr_8',  name: 'CNR-8 环球资讯广播',   stream_url: 'http://ngcdn008.cnr.cn/live/hqzx/index.m3u8',    type: 'live', category: '新闻', source: 'cnr', verified: true }
      ];
    }

    // 开始请求（从第一镜像）
    tryMirror(0);

    function applyLiveStations() {
      // 若有 category 参数，客户端过滤
      if (category && category !== '全部') {
        var filtered = liveStations.filter(function(s) {
          return s.category === category;
        });
        stations = filtered.length > 0 ? filtered : liveStations;
      } else {
        stations = liveStations;
      }

      if (stations.length === 0) {
        stationIdx = 0;
        renderDial();
        renderChannelList();
        renderCategoryTabs();
        document.getElementById('nowPlaying').textContent = '暂无可用直播源';
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

  // ============ AI 文字内容获取（news / novel 频道） ============
  function fetchTextContent(y, ch) {
    // 重置旧状态
    currentTextContent = null;
    textContentExpanded = false;

    fetch('/api/content/' + y + '/' + ch)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.success && data.text) {
          currentTextContent = { text: data.text, year: y, channel: ch, generated_at: data.generated_at || '' };
        } else {
          // 内容未生成，保留 null 用于占位提示
          currentTextContent = null;
        }
        renderContentPreview();
      })
      .catch(function() {
        currentTextContent = null;
        renderContentPreview();
      });
  }

  function renderContentPreview() {
    var previewEl = document.getElementById('contentPreview');
    var textEl = document.getElementById('contentPreviewText');
    var expandBtn = document.getElementById('contentExpandBtn');

    var isNewsNovel = (year >= 1949 && year <= 2019 && (currentChannel === 'news' || currentChannel === 'novel'));

    if (!currentTextContent || !currentTextContent.text) {
      if (isNewsNovel) {
        // 显示占位提示
        previewEl.style.display = 'block';
        textEl.textContent = 'AI 文字内容尚未生成，可先聆听语音广播';
        textEl.classList.remove('expanded');
        expandBtn.style.display = 'none';
      } else {
        previewEl.style.display = 'none';
      }
      return;
    }

    previewEl.style.display = 'block';
    var fullText = currentTextContent.text;
    var preview = fullText.length > 200 ? fullText.substring(0, 200) + '...' : fullText;
    textEl.textContent = preview;
    textEl.classList.remove('expanded');

    if (fullText.length > 200) {
      expandBtn.style.display = 'block';
      expandBtn.textContent = '展开全文 ▼';
    } else {
      expandBtn.style.display = 'none';
    }
  }

  // ============ "生成语音播放"按钮 ============
  function showTtsButton(station) {
    var ttsBtn = document.getElementById('ttsPlayBtn');
    var previewEl = document.getElementById('contentPreview');

    // 确保预览区域可见
    if (!previewEl || previewEl.style.display === 'none') {
      previewEl.style.display = 'block';
    }

    ttsBtn.style.display = 'block';
    ttsBtn.disabled = false;
    ttsBtn.textContent = '生成语音播放 ▶';

    // 移除旧的事件监听（克隆替换）
    var newBtn = ttsBtn.cloneNode(true);
    ttsBtn.parentNode.replaceChild(newBtn, ttsBtn);

    newBtn.addEventListener('click', function() {
      newBtn.disabled = true;
      newBtn.textContent = '正在生成语音...';
      ttsGenerate(station);
      // ttsGenerate 内部会调用 updateNowPlaying 处理后续状态
    });
  }

  // ============ AM 历史存档电台获取 ============
  function fetchHistoryStations(y) {
    // 音乐 / 小说频道走各自的异步获取逻辑
    if (currentChannel === 'music') {
      fetchMusicStations(y);
      return;
    }
    if (currentChannel === 'novel') {
      fetchNovelStations(y);
      return;
    }
    // 2020-2025 年份 archive 无数据，直接走 CNTV 云听回听
    if (y >= 2020 && y <= 2025) {
      generateDateBroadcast();
      return;
    }
    var url = '/api/broadcast/history/' + y;

    fetch(url).then(function(r) {
      if (!r.ok) throw new Error('API error');
      return r.json();
    }).then(function(data) {
      if (data.stations && data.stations.length > 0) {
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
          playCurrent();
          return;
        }
      }
      console.log('[AM] broadcasts/ 无数据，尝试 CNR 云听回听');
      generateDateBroadcast();
    }).catch(function() {
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
      } else if (stations.length > 0 && stations[0] && stations[0].source === 'archive.org') {
        el.textContent = year + '年 · Internet Archive · ' + stations.length + ' 个录音';
      } else if (year >= 1949 && year <= 2019 && currentChannel === 'music') {
        el.textContent = year + '年 · 金曲回响 · ' + stations.length + ' 首';
      } else if (year >= 1949 && year <= 2019 && currentChannel === 'novel') {
        el.textContent = year + '年 · 小说广播 · ' + stations.length + ' 篇';
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
      } else if (s.type === 'music_kuwo' || s.type === 'music_library') {
        label = '♪ ' + s.name.slice(0, 7);
      } else if (s.type === 'placeholder') {
        label = '— ' + s.name.slice(0, 7);
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
      } else if (s.type === 'music_kuwo') {
        el.textContent = '♪ ' + s.name + ' · 酷我音乐';
      } else if (s.type === 'music_library') {
        el.textContent = '♪ ' + s.name + ' · 经典金曲';
      } else if (s.type === 'placeholder') {
        el.textContent = s.name;
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

    fetch('/api/cntv/date/' + dateStr)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.programs && data.programs.length > 0) {
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
          playCurrent();
          return;
        }
        if (year <= 2019) {
          fetchArchiveBroadcasts(year);
          return;
        }
        _fallbackBroadcast(dateStr);
      })
      .catch(function() {
        if (year <= 2019) {
          fetchArchiveBroadcasts(year);
          return;
        }
        _fallbackBroadcast(dateStr);
      });
  }

  // ============ Archive 广播兜底 ============
  function fetchArchiveBroadcasts(y) {
    document.getElementById('nowPlaying').textContent = '搜索档案中... ' + y;
    console.log('[Archive] 搜索 Internet Archive:', y);

    fetch('/api/broadcast/archive/search?year=' + y)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.results && data.results.length > 0) {
          var archiveStations = data.results.map(function(item, i) {
            return {
              id: 'archive_' + y + '_' + i,
              name: item.title || ('Archive 广播 #' + (i + 1)),
              stream_url: null,
              archive_audio_url: item.audio_url,
              archive_identifier: item.identifier,
              type: 'archive',
              category: '历史',
              era: String(y),
              verified: true,
              source: 'archive.org'
            };
          });

          stations = archiveStations;
          historyStations = archiveStations;
          stationIdx = 0;
          bindTuningKnob();
          setStIdx(0);
          renderDial();
          renderChannelList();
          updateEraScroll();
          document.getElementById('nowPlaying').textContent =
            '[' + y + '] Internet Archive · ' + archiveStations.length + ' 个录音';
          playCurrent();
        } else {
          document.getElementById('nowPlaying').textContent =
            y + '年 — 无历史录音';
          stations = [];
          renderDial();
        }
      })
      .catch(function(err) {
        console.error('[Archive] 搜索失败:', err);
        document.getElementById('nowPlaying').textContent =
          y + '年 — 档案搜索失败';
      });
  }

  function _fallbackBroadcast(dateStr) {
    var channel = stations[stationIdx] ? (stations[stationIdx].category || 'news') : 'news';
    document.getElementById('nowPlaying').textContent = '生成中: ' + dateStr;

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
        aiGenerateDate(dateStr);
      });
  }

  function aiGenerateDate(dateStr) {
    var st = stations[stationIdx];
    fetch('/api/broadcast/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: st ? (st.channel || st.category || 'news') : 'news',
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
    if (s.type === 'placeholder') return;  // 占位卡片，不播放
    if (mode === 'MAYDAY') {
      playMaydaySong(s);
    } else if (s.type === 'music_kuwo') {
      playMusicStream(s);
    } else if (s.type === 'music_library') {
      // 音乐库中歌曲，stream_url 暂空（待 R2 上传完成后有 r2_url 再填入）
      ttsGenerate(s);
    } else if (s.type === 'ai_archive') {
      // 1949-2019 news/novel：不自动 TTS，显示"生成语音播放"按钮
      if (year >= 1949 && year <= 2019 && (currentChannel === 'news' || currentChannel === 'novel')) {
        showTtsButton(s);
      } else {
        ttsGenerate(s);
      }
    } else if (s.type === 'archive' && s.archive_identifier) {
      playArchive(s);
    } else if (s.stream_url) {
      playStream(s);
    } else {
      // 兜底：无 stream_url 时，1949-2019 news/novel 也走按钮
      if (year >= 1949 && year <= 2019 && (currentChannel === 'news' || currentChannel === 'novel')) {
        showTtsButton(s);
      } else {
        ttsGenerate(s);
      }
    }
  }

  // ============ 音乐频道播放（酷我流优先） ============
  function playMusicStream(station) {
    if (!station.stream_url) {
      // 酷我流不可用 → 尝试 R2 音乐缓存
      fetch('/api/broadcast/music/' + year)
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.audio_url) {
            prevStreamUrl = data.audio_url;
            AUDIO.src = data.audio_url;
            AUDIO.play().catch(function(e) { console.log('R2 music failed:', e.message); });
            document.getElementById('nowPlaying').textContent =
              '♪ [' + year + '] ' + station.name + ' · R2金曲';
          } else {
            // R2 无缓存 → AI 生成金曲介绍
            ttsGenerate(station);
          }
        })
        .catch(function() {
          ttsGenerate(station);
        });
      return;
    }

    prevStreamUrl = station.stream_url;
    AUDIO.src = station.stream_url;
    AUDIO.play().catch(function(e) {
      console.log('Kuwo stream failed:', e.message);
      // 酷我流失败 → 降级到 R2 → AI
      fetch('/api/broadcast/music/' + year)
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.audio_url) {
            prevStreamUrl = data.audio_url;
            AUDIO.src = data.audio_url;
            AUDIO.play().catch(function() {});
            document.getElementById('nowPlaying').textContent =
              '♪ [' + year + '] 金曲回响 · R2缓存';
          } else {
            ttsGenerate(station);
          }
        })
        .catch(function() { ttsGenerate(station); });
    });
    document.getElementById('nowPlaying').textContent = '♪ ' + station.name;
  }

  function playArchive(station) {
    document.getElementById('nowPlaying').textContent = '[' + year + '] ' + station.name + ' · 加载中...';

    fetch('/api/broadcast/archive/play/' + encodeURIComponent(station.archive_identifier))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.audio_url) {
          prevStreamUrl = data.audio_url;
          AUDIO.src = data.audio_url;
          AUDIO.play().catch(function(e) { console.log('Archive play failed:', e.message); });
          document.getElementById('nowPlaying').textContent =
            '[' + year + '] ' + station.name + ' · Archive(R2)';
        } else {
          throw new Error('No R2 cache');
        }
      })
      .catch(function() {
        if (station.archive_audio_url) {
          prevStreamUrl = station.archive_audio_url;
          AUDIO.src = station.archive_audio_url;
          AUDIO.play().catch(function(e) { console.log('Archive direct failed:', e.message); });
          document.getElementById('nowPlaying').textContent =
            '[' + year + '] ' + station.name + ' · Archive';
        }
      });
  }

  function playMaydaySong(station) {
    if (!station.stream_url) return;
    _destroyHls();
    prevStreamUrl = station.stream_url;
    AUDIO.src = station.stream_url;
    AUDIO.play().catch(function(e) { console.log('Mayday play failed:', e.message); });
  }

  function stopPlayback() {
    _destroyHls();
    AUDIO.pause();
    AUDIO.src = '';
    prevStreamUrl = '';
  }

  var hlsInstance = null;

  function _destroyHls() {
    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }
  }

  function playStream(station) {
    if (prevStreamUrl === station.stream_url && !AUDIO.paused) return;
    prevStreamUrl = station.stream_url;
    var url = station.stream_url;

    // HLS (.m3u8) 流 — 浏览器 <audio> 原生不支持，走 HLS.js
    var isHls = /\.m3u8(\?|$)/i.test(url);
    if (isHls && window.Hls && Hls.isSupported()) {
      _destroyHls();
      hlsInstance = new Hls({
        enableWorker: false,
        lowLatencyMode: false,
        backBufferLength: 30
      });
      hlsInstance.loadSource(url);
      hlsInstance.attachMedia(AUDIO);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, function() {
        _doPlay();
      });
      hlsInstance.on(Hls.Events.ERROR, function(event, data) {
        if (data.fatal) {
          console.log('HLS fatal error: ' + data.type);
          _destroyHls();
        }
      });
    } else {
      _destroyHls();
      AUDIO.src = url;
      _doPlay();
    }

    function _doPlay() {
      AUDIO.play().then(function() {
        if (audioMutedByPolicy) {
          updateNowPlaying();
        }
      }).catch(function(e) {
        if (e.name === 'NotAllowedError') {
          AUDIO.muted = true;
          audioMutedByPolicy = true;
          AUDIO.play().catch(function(e2) {
            console.log('Stream failed (muted):', e2.message);
          });
          document.getElementById('nowPlaying').textContent = '点击任意位置开始收听';
        } else {
          console.log('Stream failed:', e.message);
        }
      });
    }
  }

  function formatSource(src) {
    var labels = {
      'r2': 'R2缓存', 'api': '历史API', 'downloaded': '已下载',
      'ai': 'AI生成', 'live': '实时直播', 'kuwo': '酷我音乐'
    };
    return labels[src] || src || '未知';
  }

  function aiFallbackGenerate(station) {
    fetch('/api/broadcast/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: station.channel || station.category || 'news',
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

    var channel = station.channel || station.category || 'news';
    var apiUrl, fetchOptions;

    if (year === ERA_MAX) {
      apiUrl = '/api/broadcast/live?category=' + encodeURIComponent(channel);
      fetchOptions = { method: 'GET' };
    } else {
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

  // ============ URL 参数加载（v4.0 支持 channel/mode/station + 自动播放） ============
  function loadFromURL() {
    var params = new URLSearchParams(window.location.search);
    var urlYear = params.get('year');
    var urlMode = params.get('mode');
    var urlStation = params.get('station');
    var urlChannel = params.get('channel');
    var hasParams = !!(urlYear || urlMode || urlStation || urlChannel);

    if (hasParams) {
      // 明确 URL 参数 → 按参数初始化
      if (urlYear) {
        var y = parseInt(urlYear);
        if (y >= ERA_MIN && y <= ERA_MAX) {
          year = y;
          document.getElementById('nixieYear').textContent = year;
          setKnobRotation(document.getElementById('knobEra'), angleForValue(year, ERA_MIN, ERA_MAX));
        }
      }

      if (urlMode === 'fm') {
        setMode('FM');
        return;  // FM 切换会自动 fetchLiveStations
      }

      if (urlChannel === 'news' || urlChannel === 'music' || urlChannel === 'novel') {
        currentChannel = urlChannel;
      }

      // AM 模式处理
      if (year && !urlMode) setMode('AM');
      renderChannelTabs();
      filterStations();

      // URL station 参数：按索引选中
      if (urlStation && stations.length > 0) {
        var sIdx = parseInt(urlStation);
        if (sIdx >= 0 && sIdx < stations.length) {
          setStIdx(sIdx);
          onTuneChange();
        }
      }
    } else {
      // 无 URL 参数 → 自动播放当天广播
      autoPlayToday();
    }
  }

  // ============ 自动播放：根据当前日期选择模式/年份/频道 ============
  function autoPlayToday() {
    var now = new Date();
    var todayYear = now.getFullYear();
    var todayMonth = now.getMonth() + 1;  // 1-12
    var todayDay = now.getDate();

    selectedMonth = todayMonth;
    selectedDay = todayDay;

    // 设置日期选择器
    document.getElementById('selMonth').value = todayMonth;
    populateDayOptions();
    document.getElementById('selDay').value = todayDay;

    if (todayYear === 2026) {
      // 2026：FM 直播模式
      year = todayYear;
      document.getElementById('nixieYear').textContent = year;
      setKnobRotation(document.getElementById('knobEra'), angleForValue(year, ERA_MIN, ERA_MAX));
      setMode('FM');
    } else if (todayYear >= 2020 && todayYear <= 2025) {
      // 2020-2025：AM 历史广播，搜索当天
      year = todayYear;
      document.getElementById('nixieYear').textContent = year;
      setKnobRotation(document.getElementById('knobEra'), angleForValue(year, ERA_MIN, ERA_MAX));
      setMode('AM');
      // 触发当天的 CNR 回听
      generateDateBroadcast();
    } else {
      // 1949-2019：AM 模式 + 新闻频道，AI 生成"历史上的今天"
      year = todayYear;
      currentChannel = 'news';
      document.getElementById('nixieYear').textContent = year;
      setKnobRotation(document.getElementById('knobEra'), angleForValue(year, ERA_MIN, ERA_MAX));
      setMode('AM');
      renderChannelTabs();
      filterStations();
      if (stations.length > 0) {
        stationIdx = 0;
        setStIdx(0);
        bindTuningKnob();
        renderDial();
        renderChannelList();
        updateEraScroll();
        updateNowPlaying();
        playCurrent();
      }
    }
  }

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

    // 根据模式设置列表标题
    var labelEl = el.querySelector('.channel-list-label');
    if (mode === 'AM' && year >= 1949 && year <= 2019) {
      var chLabel = currentChannel === 'music' ? '🎵 音乐' : (currentChannel === 'novel' ? '📖 小说' : '📰 新闻');
      labelEl.textContent = year + '年 · ' + chLabel + ' · ' + list.length + ' 个频道';
    } else {
      labelEl.textContent = '频道列表';
    }

    scroll.innerHTML = list.map(function(s, i) {
      var cls = 'channel-chip';
      var realIdx = stations.indexOf(s);
      if (realIdx === stationIdx) cls += ' current';
      if (s.verified) cls += ' verified';
      if (s.type === 'ai_archive') cls += ' ai';
      if (s.type === 'cntv') cls += ' cntv';
      if (s.type === 'music_kuwo') cls += ' verified';
      if (s.type === 'music_library') cls += ' verified';
      if (s.type === 'placeholder') cls += ' ai';
      var label;
      if (s.type === 'cntv' && s.start) {
        label = s.start + ' ' + (s.name.length > 12 ? s.name.slice(0, 12) + '…' : s.name);
      } else if (s.type === 'music_kuwo' || s.type === 'music_library') {
        label = '♪ ' + (s.name.length > 20 ? s.name.slice(0, 20) + '…' : s.name);
      } else {
        label = s.name.length > 18 ? s.name.slice(0, 18) + '…' : s.name;
      }
      var sourceBadge = '';
      if (s.source && s.source === 'ytapi.radio.cn') {
        sourceBadge = ' <span style="opacity:0.5;font-size:7px;">云听</span>';
      } else if (s.source && s.source === 'kuwo') {
        sourceBadge = ' <span style="opacity:0.5;font-size:7px;">酷我</span>';
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

    if (mode !== 'FM') {
      el.style.display = 'none';
      return;
    }

    var cats = {};
    liveStations.forEach(function(s) {
      if (s.category) cats[s.category] = (cats[s.category] || 0) + 1;
    });

    var catNames = Object.keys(cats).sort(function(a, b) {
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
    bindChannelTabs();

    Promise.all([
      fetch('/radio_sources.json').then(function(r) { return r.json(); }),
      fetch('/broadcast_data.json').then(function(r) { return r.json(); }).catch(function() { return {}; }),
      fetch('/singer_data.json').then(function(r) { return r.json(); }).catch(function() { return { singers: [] }; })
    ]).then(function(results) {
      allStations = results[0].stations || [];
      broadcastData = results[1];
      singerData = results[2];

      setStIdx(0);
      setVol(0.7);
      loadFromURL();
      renderDial();
      renderChannelTabs();
      updateEraScroll();

      // 预加载 CNR 年份列表
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
