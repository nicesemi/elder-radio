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
  let currentChannel = 'news';         // 'news' | 'music'（仅 1949-2019 AM 模式生效）
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
    year = Math.max(ERA_MIN, Math.min(ERA_MAX, Math.round(y)));
    document.getElementById('nixieYear').textContent = year;
    setKnobRotation(document.getElementById('knobEra'), angleForValue(year, ERA_MIN, ERA_MAX));
    renderChannelTabs();
    filterStations();
    if (cntrYearSet.has(String(year))) {
      selectedMonth = 1;
      selectedDay = 1;
      document.getElementById('selMonth').value = 1;
      populateDayOptions();
      document.getElementById('selDay').value = 1;
    }
    fetchHistoryStations(year);
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
        stopNovelPlayback();
        stopMusicPlayback();
        AUDIO.pause();
        AUDIO.src = '';
        currentChannel = ch;
        renderChannelTabs();
        filterStations();
        if (stations.length > 0 && ch !== 'novel' && ch !== 'music') {
          stationIdx = 0;
          setStIdx(0);
          bindTuningKnob();
          renderDial();
          renderChannelList();
          updateNowPlaying();
          playCurrent();
        } else if (stations.length > 0) {
          stationIdx = 0;
          setStIdx(0);
          bindTuningKnob();
          renderDial();
          renderChannelList();
          updateNowPlaying();
        }
        updateEraScroll();
        // 切换频道后自动朗读广播稿
        speakContentForYearCategory(year, ch);
      }
    });
  }

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

    renderChannelTabs();

    if (m === 'FM') {
      document.getElementById('dialRange').textContent = '88-108 MHz';
      document.getElementById('channelList').style.display = '';
      document.getElementById('categoryTabs').style.display = '';
      currentCategory = '';
      fetchLiveStations();
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
        } else if (currentChannel === 'music') {
          // 音乐频道：从 singer_data.json 获取该年金曲
          filtered = getMusicStationsForYear(year);
        } else if (currentChannel === 'novel') {
          // 小说频道：生成 AI 虚拟朗读
          filtered.push({
            id: 'novel_' + year,
            name: year + '年 小说代表作',
            type: 'ai_archive',
            category: '小说',
            era: String(year),
            stream_url: null,
            verified: false,
            channel: 'novel'
          });
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

  // ============ 音乐频道：从 singer_data.json 获取金曲 ============
  function getMusicStationsForYear(y) {
    var result = [];
    var singers = singerData.singers || [];

    for (var i = 0; i < singers.length; i++) {
      var s = singers[i];
      var songsByYear = s.songs_by_year || {};
      var yearSongs = songsByYear[String(y)];
      if (!yearSongs) continue;

      for (var j = 0; j < yearSongs.length; j++) {
        var song = yearSongs[j];
        // 优先有酷我流的歌曲
        if (song.stream_url && song.has_stream) {
          result.push({
            id: 'music_' + y + '_' + s.name + '_' + j,
            name: s.name_cn + ' - ' + song.title,
            stream_url: song.stream_url,
            type: 'music_kuwo',
            category: '音乐',
            era: String(y),
            verified: true,
            source: 'kuwo',
            channel: 'music',
            singer: s.name_cn,
            album: song.album || ''
          });
        }
      }
    }

    // 无酷我流金曲 → AI 兜底"经典金曲"虚拟频道
    if (result.length === 0) {
      result.push({
        id: 'ai_music_' + y,
        name: y + '年 经典金曲',
        type: 'ai_archive',
        category: '音乐',
        era: String(y),
        stream_url: null,
        verified: false,
        channel: 'music'
      });
    }

    return result;
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
      var apiUrl = 'https://' + MIRRORS[idx] + '/json/stations/bycountry/China';

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

  // ============ AM 历史存档电台获取 ============
  function fetchHistoryStations(y) {
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
        el.textContent = year + '年 · 小说代表作 · TTS 朗读中';
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
      } else if (s.type === 'music_kuwo') {
        label = '♪ ' + s.name.slice(0, 7);
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
    // Stop any playlist playback when manually switching stations
    stopNovelPlayback();
    stopMusicPlayback();
    if (s.type === 'music_kuwo') {
      playMusicStream(s);
    } else if (s.type === 'ai_archive') {
      ttsGenerate(s);
    } else if (s.type === 'archive' && s.archive_identifier) {
      playArchive(s);
    } else if (s.stream_url) {
      playStream(s);
    } else {
      ttsGenerate(s);
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
    // 页面 HTTPS 时强制升级 HTTP 流为 HTTPS，避免 Mixed Content 拦截
    if (window.location.protocol === 'https:' && url.indexOf('http://') === 0) {
      url = url.replace('http://', 'https://');
    }

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

  // ============ 对讲系统 (Intercom) ============
  var intercomChannel = 1;
  var intercomUserId = 'user_' + Math.random().toString(36).slice(2, 10);
  var intercomJoined = false;
  var intercomLastMsgIdx = 0;
  var intercomPeerId = null;
  var intercomUserCount = 0;
  var intercomPollTimer = null;
  var intercomPlayer = document.getElementById('intercomPlayer');
  var intercomLabel = document.getElementById('intercomLabel');
  var intercomZone = document.querySelector('.intercom-zone');
  var chDisplay = document.getElementById('chDisplay');

  function updateIntercomUI() {
    chDisplay.textContent = String(intercomChannel).padStart(2, '0');
    if (intercomJoined) {
      intercomZone.classList.add('joined');
      var label = intercomUserCount >= 2 ? '对讲(' + intercomUserCount + '人)' : 'AI客服';
      intercomLabel.textContent = label;
    } else {
      intercomZone.classList.remove('joined');
      intercomLabel.textContent = '对讲';
    }
  }

  // 频道选择
  document.getElementById('chUp').addEventListener('click', function() {
    if (intercomJoined) return;
    intercomChannel = intercomChannel >= 99 ? 1 : intercomChannel + 1;
    updateIntercomUI();
  });
  document.getElementById('chDown').addEventListener('click', function() {
    if (intercomJoined) return;
    intercomChannel = intercomChannel <= 1 ? 99 : intercomChannel - 1;
    updateIntercomUI();
  });

  // 加入频道
  function joinIntercom() {
    fetch('/api/intercom/join', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({channel: intercomChannel, user_id: intercomUserId})
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) {
        console.log('Join error:', data.error);
        if (data.error.indexOf('已满') >= 0) {
          // 频道满：强制离开清僵尸用户，1s 后重试
          fetch('/api/intercom/leave', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({channel: intercomChannel, user_id: intercomUserId})
          }).then(function() {
            setTimeout(function() { joinIntercom(); }, 1000);
          });
        }
        return;
      }
      intercomJoined = true;
      intercomLastMsgIdx = data.last_msg_idx || 0;
      intercomPeerId = data.peer_id;
      intercomUserCount = data.user_count;
      updateIntercomUI();
      startPolling();
    });
  }

  // 离开频道
  function leaveIntercom() {
    if (!intercomJoined) return;
    fetch('/api/intercom/leave', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({channel: intercomChannel, user_id: intercomUserId})
    }).catch(function(){});
    intercomJoined = false;
    intercomPeerId = null;
    intercomUserCount = 0;
    stopPolling();
    updateIntercomUI();
  }

  // 轮询新消息
  function startPolling() {
    stopPolling();
    intercomPollTimer = setInterval(function() {
      if (!intercomJoined) { stopPolling(); return; }
      fetch('/api/intercom/poll', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          channel: intercomChannel,
          user_id: intercomUserId,
          last_idx: intercomLastMsgIdx
        })
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        // 更新用户数
        if (data.user_count !== intercomUserCount) {
          intercomUserCount = data.user_count;
          updateIntercomUI();
        }
        // 播放新消息
        if (data.messages && data.messages.length > 0) {
          data.messages.forEach(function(msg) {
            if (msg.from !== intercomUserId && msg.r2_key) {
              intercomPlayer.src = msg.r2_key;
              intercomPlayer.volume = volume;
              intercomPlayer.load();
              intercomPlayer.play().catch(function(e) {
                console.log('[Intercom] Poll audio play failed:', e.name, e.message);
              });
            }
          });
          intercomLastMsgIdx = data.total;
        }
      })
      .catch(function(){});
    }, 1500);
  }

  function stopPolling() {
    if (intercomPollTimer) { clearInterval(intercomPollTimer); intercomPollTimer = null; }
  }

  // PTT 录音
  var pttBtn = document.getElementById('knobPTT');

  pttBtn.addEventListener('mousedown', function(e) { e.preventDefault(); startPTT(); });
  pttBtn.addEventListener('mouseup', stopPTT);
  pttBtn.addEventListener('mouseleave', stopPTT);
  pttBtn.addEventListener('touchstart', function(e) { e.preventDefault(); startPTT(); });
  pttBtn.addEventListener('touchend', stopPTT);

  var speechRecognition = null;
  var finalTranscript = '';

  function startPTT() {
    if (isRecording) return;

    // 解锁 Audio 元素（浏览器自动播放策略要求先有用户手势）
    intercomPlayer.load();
    intercomPlayer.play().then(function() { intercomPlayer.pause(); }).catch(function(){});

    // 自动加入频道
    if (!intercomJoined) joinIntercom();

    // 如果频道有其他人 → Relay 模式（录音传音频）
    // 如果频道只有自己 → AI 客服模式（语音转文字）
    if (intercomUserCount >= 2) {
      startRelayRecording();
    } else {
      startAIRecording();
    }
  }

  function stopPTT() {
    if (!isRecording) return;
    isRecording = false;
    pttBtn.classList.remove('recording');
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
      mediaRecorder.stream.getTracks().forEach(function(t) { t.stop(); });
    }
    if (speechRecognition) {
      speechRecognition.stop();
    }
  }

  // Relay 模式：录制并上传音频
  function startRelayRecording() {
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
      mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      recordedChunks = [];
      mediaRecorder.ondataavailable = function(e) { if (e.data.size > 0) recordedChunks.push(e.data); };
      mediaRecorder.onstop = sendRelay;
      mediaRecorder.start();
      isRecording = true;
      pttBtn.classList.add('recording');
      AUDIO.pause();
    }).catch(function(e) { console.log('Mic denied:', e); });
  }

  function sendRelay() {
    if (recordedChunks.length === 0) return;
    var blob = new Blob(recordedChunks, { type: 'audio/webm' });
    var fd = new FormData();
    fd.append('audio', blob, 'ptt.webm');
    fd.append('channel', String(intercomChannel));
    fd.append('user_id', intercomUserId);

    fetch('/api/intercom/relay', { method: 'POST', body: fd })
      .then(function(r) { return r.json(); })
      .catch(function(e) { console.log('Relay error:', e); });
  }

  // AI 客服模式：语音转文字 → AI 回复 → TTS 播放
  function startAIRecording() {
    // 尝试使用 Web Speech API 进行语音识别
    var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      speechRecognition = new SpeechRecognition();
      speechRecognition.lang = 'zh-CN';
      speechRecognition.interimResults = false;
      speechRecognition.continuous = false;
      finalTranscript = '';

      speechRecognition.onresult = function(event) {
        finalTranscript = event.results[0][0].transcript.trim();
      };

      speechRecognition.onend = function() {
        if (finalTranscript) {
          sendAIChat(finalTranscript);
        }
      };

      speechRecognition.onerror = function(e) {
        console.log('[Intercom] SpeechRecognition error:', e.error);
        // 降级：切换到手动文字输入
        showIntercomTextInput();
      };

      speechRecognition.start();
      isRecording = true;
      pttBtn.classList.add('recording');
      AUDIO.pause();
    } else {
      // 不支持语音识别，降级为直接录音上传
      startFallbackAIRecording();
    }
  }

  function startFallbackAIRecording() {
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
      mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      recordedChunks = [];
      mediaRecorder.ondataavailable = function(e) { if (e.data.size > 0) recordedChunks.push(e.data); };
      mediaRecorder.onstop = sendFallbackAI;
      mediaRecorder.start();
      isRecording = true;
      pttBtn.classList.add('recording');
      AUDIO.pause();
    }).catch(function(e) { console.log('Mic denied:', e); });
  }

  function sendFallbackAI() {
    if (recordedChunks.length === 0) return;
    var blob = new Blob(recordedChunks, { type: 'audio/webm' });
    // 降级模式：先用 relay 上传，提示用户使用文字
    var fd = new FormData();
    fd.append('audio', blob, 'ptt.webm');
    fd.append('channel', String(intercomChannel));
    fd.append('user_id', intercomUserId);
    fetch('/api/intercom/relay', { method: 'POST', body: fd })
      .catch(function(e) { console.log('Fallback error:', e); });
  }

  function sendAIChat(text) {
    console.log('[Intercom] Sending AI chat:', text);
    fetch('/api/intercom/ai-chat', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        channel: intercomChannel,
        user_id: intercomUserId,
        text: text
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      console.log('[Intercom] AI response:', data.text, 'audio:', data.audio_url ? 'YES' : 'NONE');
      if (data.audio_url) {
        intercomPlayer.src = data.audio_url;
        intercomPlayer.volume = volume;
        intercomPlayer.load();
        intercomPlayer.play().catch(function(e) {
          console.log('[Intercom] AI audio play failed:', e.name, e.message);
        });
      }
    })
    .catch(function(e) { console.log('AI chat error:', e); });
  }

  // 手动文字输入（语音识别失败时的降级方案）
  var intercomTextInput = document.getElementById('intercomTextInput');
  var intercomTextSend = document.getElementById('intercomTextSend');

  function showIntercomTextInput() {
    intercomTextInput.style.display = 'inline-block';
    intercomTextSend.style.display = 'inline-block';
    intercomTextInput.focus();
  }

  function hideIntercomTextInput() {
    intercomTextInput.style.display = 'none';
    intercomTextSend.style.display = 'none';
    intercomTextInput.value = '';
  }

  intercomTextSend.addEventListener('click', function() {
    var text = intercomTextInput.value.trim();
    if (!text) return;
    if (!intercomJoined) joinIntercom();
    hideIntercomTextInput();
    sendAIChat(text);
  });

  intercomTextInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      intercomTextSend.click();
    }
  });

  // 页面关闭时离开频道
  window.addEventListener('beforeunload', function() { leaveIntercom(); });

  updateIntercomUI();

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

      if (urlChannel === 'news' || urlChannel === 'music') {
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
      var chLabel = currentChannel === 'music' ? '🎵 音乐' : currentChannel === 'novel' ? '📖 小说' : '📰 新闻';
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
      var label;
      if (s.type === 'cntv' && s.start) {
        label = s.start + ' ' + (s.name.length > 12 ? s.name.slice(0, 12) + '…' : s.name);
      } else if (s.type === 'music_kuwo') {
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

  // ============ 浏览器 TTS 朗读 ============
  function speakWithBrowserTTS(text) {
    if (!text || text.length < 10) return;
    window.speechSynthesis.cancel(); // 停止当前朗读
    var utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 0.9;  // 稍慢，模拟播音风格
    utterance.pitch = 1.0;
    utterance.onerror = function(e) { console.log('TTS error:', e); };
    window.speechSynthesis.speak(utterance);
  }

  // Track playlist state for sequential playback
  var novelPlaylist = [];
  var novelPlaylistIndex = -1;
  var musicPlaylist = [];
  var musicPlaylistIndex = -1;

  function speakContentForYearCategory(y, cat) {
    // Stop any current audio before starting new playback
    AUDIO.pause();
    AUDIO.src = '';
    stopNovelPlayback();
    stopMusicPlayback();
    window.speechSynthesis && window.speechSynthesis.cancel();

    // If novel channel, use album track playback instead of TTS
    if (cat === 'novel') {
        fetch('/api/broadcast/novel-tracks/' + y)
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (data.success && data.tracks && data.tracks.length > 0) {
                    novelPlaylist = data.tracks;
                    novelPlaylistIndex = 0;
                    playNovelTrack(0);
                } else {
                    showNowPlaying('暂无小说音频');
                }
            })
            .catch(function(e) {
                console.log('Novel tracks fetch failed:', e);
                showNowPlaying('小说音频加载失败');
            });
        return;
    }

    // If music channel, use music track playlist playback
    if (cat === 'music') {
        fetch('/api/broadcast/music-tracks/' + y)
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (data.success && data.tracks && data.tracks.length > 0) {
                    musicPlaylist = data.tracks;
                    musicPlaylistIndex = 0;
                    playMusicTrack(0);
                } else {
                    showNowPlaying('暂无音乐歌曲');
                }
            })
            .catch(function(e) {
                console.log('Music tracks fetch failed:', e);
                showNowPlaying('音乐加载失败');
            });
        return;
    }

    // Original TTS logic for other categories
    fetch('/api/broadcast/text/' + y + '?category=' + encodeURIComponent(cat))
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (data.text) {
                speakWithBrowserTTS(data.text);
            }
            var linkEl = document.getElementById('externalLink');
            linkEl.style.display = 'none';
        })
        .catch(function(e) { console.log('Text fetch failed:', e); });
  }

  function playNovelTrack(index) {
    if (index < 0 || index >= novelPlaylist.length) {
        novelPlaylist = [];
        novelPlaylistIndex = -1;
        showNowPlaying('专辑播放完毕');
        return;
    }

    var track = novelPlaylist[index];
    var audio = document.getElementById('audioPlayer');
    var nowPlayingEl = document.getElementById('nowPlaying');

    // Set audio source
    audio.src = track.playUrl64;
    audio.load();

    // Update display
    var totalMin = Math.floor(track.duration / 60);
    var totalSec = track.duration % 60;
    var durStr = totalMin + '分' + totalSec + '秒';
    nowPlayingEl.textContent = '📖 正在播放: ' + track.title + '（' + (index + 1) + '/' + novelPlaylist.length + '）' + durStr;
    nowPlayingEl.classList.remove('hidden');
    document.getElementById('eraScroll').classList.add('hidden');

    // When track ends, play next
    audio.onended = function() {
        novelPlaylistIndex++;
        playNovelTrack(novelPlaylistIndex);
    };

    // Play
    audio.play().catch(function(e) {
        console.log('Audio play failed:', e);
        nowPlayingEl.textContent = '⚠️ 音频播放失败，尝试下一首...';
        setTimeout(function() {
            novelPlaylistIndex++;
            playNovelTrack(novelPlaylistIndex);
        }, 2000);
    });
  }

  function stopNovelPlayback() {
    var audio = document.getElementById('audioPlayer');
    audio.pause();
    audio.src = '';
    audio.onended = null;
    novelPlaylist = [];
    novelPlaylistIndex = -1;
  }

  function playMusicTrack(index) {
    if (index < 0 || index >= musicPlaylist.length) {
        // 循环播放
        musicPlaylistIndex = 0;
        playMusicTrack(0);
        return;
    }

    musicPlaylistIndex = index;
    var track = musicPlaylist[index];
    var audio = document.getElementById('audioPlayer');
    var nowPlayingEl = document.getElementById('nowPlaying');

    audio.src = track.playUrl64;
    audio.load();

    nowPlayingEl.textContent = '🎵 ' + track.title + '（' + (index + 1) + '/' + musicPlaylist.length + '）';
    nowPlayingEl.classList.remove('hidden');
    document.getElementById('eraScroll').classList.add('hidden');

    audio.onended = function() {
        musicPlaylistIndex++;
        playMusicTrack(musicPlaylistIndex);
    };

    audio.play().catch(function(e) {
        console.log('Music play failed:', e);
        nowPlayingEl.textContent = '⚠️ 播放失败，尝试下一首...';
        setTimeout(function() {
            musicPlaylistIndex++;
            playMusicTrack(musicPlaylistIndex);
        }, 2000);
    });
  }

  function stopMusicPlayback() {
    var audio = document.getElementById('audioPlayer');
    audio.pause();
    audio.src = '';
    audio.onended = null;
    musicPlaylist = [];
    musicPlaylistIndex = -1;
  }

  init();
})();
