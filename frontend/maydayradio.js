/* =============================================
   maydayradio.js — 五月天胡萝卜收音机 v4
   ============================================= */

(function() {
  'use strict';

  const AUDIO = document.getElementById('audioPlayer');
  const ERA_MIN = 1999, ERA_MAX = 2021;

  let allSongs = [];
  let songs = [];
  let songIdx = 0;
  let year = 2000;
  let volume = 0.7;
  let isPlaying = false;
  let userInteracted = false;

  AUDIO.volume = volume;

  // ============ 旋钮系统 ============
  function angleForValue(val, min, max) {
    return ((val - min) / (max - min)) * 270;
  }

  function makeKnobDraggable(el, getVal, setVal, opts) {
    const { min, max, step, onChange } = opts;
    let dragging = false, startY, startVal;

    el.addEventListener('mousedown', function(e) {
      e.preventDefault();
      dragging = true;
      startY = e.clientY;
      startVal = getVal();
      el.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', function(e) {
      if (!dragging) return;
      const dy = startY - e.clientY;
      const sens = (max - min) / 200;
      let newVal = startVal + dy * sens;
      if (step) newVal = Math.round(newVal / step) * step;
      newVal = Math.max(min, Math.min(max, newVal));
      setVal(newVal);
      if (onChange) onChange(newVal);
    });

    window.addEventListener('mouseup', function() {
      if (dragging) { dragging = false; el.style.cursor = 'grab'; }
    });

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

  // ============ 年代旋钮 ============
  function getYear() { return year; }
  function setYear(y) {
    var prevYear = year;
    year = Math.max(ERA_MIN, Math.min(ERA_MAX, y));
    document.getElementById('nixieYear').textContent = year;
    setKnobRotation(document.getElementById('knobEra'), angleForValue(year, ERA_MIN, ERA_MAX));
    filterSongs();
    updateEraScroll();
    // 年代切换时，如果正在对讲中，自动切换到新房间
    if (isConnected && year !== prevYear) {
      disconnectJitsi();
      setTimeout(function() { connectJitsi(); }, 600);
    }
  }

  makeKnobDraggable(
    document.getElementById('knobEra'),
    getYear, setYear,
    { min: ERA_MIN, max: ERA_MAX, step: 1 }
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
    { min: 0, max: 1, step: 0.01 }
  );

  // ============ 歌曲过滤 ============
  function filterSongs() {
    songs = allSongs.filter(function(s) {
      return parseInt(s.year) === year;
    });
    if (songs.length === 0) {
      songIdx = 0;
      renderDial();
      updateNowPlaying();
      stopPlayback();
      return;
    }
    if (songIdx >= songs.length) songIdx = 0;
    renderDial();
    updateNowPlaying();
    startPlayback();
  }

  function updateEraScroll() {
    var el = document.getElementById('eraScroll');
    var count = songs.length;
    var hasStream = songs.filter(function(s) { return s.stream_url; }).length;
    el.textContent = year + '年 · ' + count + '首（' + (hasStream || count) + '首可播）';
  }

  // ============ 刻度盘 ============
  function renderDial() {
    var c = document.getElementById('dialTicks');
    var total = songs.length;
    if (total === 0) {
      c.innerHTML = '<span style="color:#555;font-size:9px;align-self:center;">该年无歌曲</span>';
      return;
    }
    var range = 3;
    var start = Math.max(0, songIdx - range);
    var end = Math.min(total - 1, songIdx + range);
    while (end - start < range * 2 && (start > 0 || end < total - 1)) {
      if (start > 0) start--;
      if (end < total - 1) end++;
    }
    var visible = songs.slice(start, end + 1);
    c.innerHTML = visible.map(function(s, i) {
      var realIdx = start + i;
      var cls = realIdx === songIdx ? ' current' : '';
      if (s.stream_url) cls += ' has-stream';
      var label = s.title.slice(0, 8);
      return '<div class="dial-tick' + cls + '" data-idx="' + realIdx + '">' +
        '<div class="tick-line"></div>' +
        '<span class="tick-name">' + label + '</span></div>';
    }).join('');

    var ticks = c.querySelectorAll('.dial-tick');
    for (var j = 0; j < ticks.length; j++) {
      ticks[j].addEventListener('click', function() {
        songIdx = parseInt(this.dataset.idx);
        renderDial();
        updateNowPlaying();
        startPlayback();
      });
    }
  }

  // ============ Now Playing ============
  function updateNowPlaying() {
    var el = document.getElementById('nowPlaying');
    if (songs[songIdx]) {
      var s = songs[songIdx];
      var icon = s.stream_url ? '\u{1F3B5}' : '\u{1F4FB}';
      el.textContent = icon + ' [' + year + '] ' + s.title;
    } else {
      el.textContent = '等待信号...';
    }
  }

  // ============ 播放控制 ============
  var fetchingStream = {};

  function fetchStreamUrl(song, callback) {
    var key = song.title;
    if (fetchingStream[key]) return;
    fetchingStream[key] = true;

    var url = '/api/stream?name=' + encodeURIComponent(song.title) + '&artist=%E4%BA%94%E6%9C%88%E5%A4%A9';
    fetch(url)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.success && data.url) {
          song.stream_url = data.url;
          song.stream_fresh = Date.now();
          callback(data.url);
        } else {
          callback(null);
        }
      })
      .catch(function() {
        callback(null);
      })
      .finally(function() {
        fetchingStream[key] = false;
      });
  }

  function doPlay(url) {
    AUDIO.src = url;
    AUDIO.load();
    var playPromise = AUDIO.play();
    if (playPromise !== undefined) {
      playPromise.then(function() {
        isPlaying = true;
        updatePlayUI(true);
        saveRecent();
      }).catch(function(e) {
        console.log('Play failed:', e.message);
        isPlaying = false;
        updatePlayUI(false);
        showToast('播放失败，请重试', 'error');
      });
    }
  }

  function startPlayback() {
    var s = songs[songIdx];
    if (!s) return;
    userInteracted = true;

    if (s.stream_url) {
      doPlay(s.stream_url);
      return;
    }

    showToast('正在获取音频源...', '');
    fetchStreamUrl(s, function(url) {
      if (url) {
        doPlay(url);
      } else {
        updatePlayUI(false);
        showToast('获取音频源失败，请稍后重试', 'error');
      }
    });
  }

  function stopPlayback() {
    AUDIO.pause();
    AUDIO.src = '';
    isPlaying = false;
    updatePlayUI(false);
  }

  function updatePlayUI(playing) {
    var overlay = document.getElementById('playOverlay');
    var led = document.getElementById('playLed');
    if (playing) {
      overlay.classList.add('hidden');
      led.classList.remove('off');
    } else {
      overlay.classList.remove('hidden');
      led.classList.add('off');
    }
  }

  document.getElementById('playOverlay').addEventListener('click', function(e) {
    e.stopPropagation();
    startPlayback();
  });

  document.querySelector('.carrot-character').addEventListener('click', function(e) {
    e.stopPropagation();
    if (isPlaying) { stopPlayback(); } else { startPlayback(); }
  });
  document.querySelector('.carrot-character').style.pointerEvents = 'auto';
  document.querySelector('.carrot-character').style.cursor = 'pointer';

  AUDIO.addEventListener('ended', function() {
    isPlaying = false;
    updatePlayUI(false);
  });

  AUDIO.addEventListener('error', function() {
    console.log('Audio error:', AUDIO.error);
    isPlaying = false;
    updatePlayUI(false);
    showToast('音频源不可用，请切换其他歌曲', 'error');
  });

  AUDIO.addEventListener('playing', function() {
    isPlaying = true;
    updatePlayUI(true);
  });

  AUDIO.addEventListener('pause', function() {
    if (AUDIO.src && !AUDIO.ended) {
      isPlaying = false;
      updatePlayUI(false);
    }
  });

  // ============ 保存最近收听 ============
  function saveRecent() {
    var s = songs[songIdx];
    if (!s) return;
    var recents = [];
    try { recents = JSON.parse(localStorage.getItem('maydayradio_recents') || '[]'); } catch(e) {}
    recents = recents.filter(function(r) { return r.title !== s.title; });
    recents.unshift({ title: s.title, year: year });
    recents = recents.slice(0, 15);
    localStorage.setItem('maydayradio_recents', JSON.stringify(recents));
  }

  // ============ Toast ============
  function showToast(msg, type) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast ' + (type === 'error' ? 'error' : '');
    t.classList.add('show');
    setTimeout(function() { t.classList.remove('show'); }, 2800);
  }

  // ============ 键盘控制 ============
  document.addEventListener('keydown', function(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowRight') { songIdx = Math.min(songIdx + 1, songs.length - 1); renderDial(); updateNowPlaying(); startPlayback(); }
    if (e.key === 'ArrowLeft')  { songIdx = Math.max(songIdx - 1, 0); renderDial(); updateNowPlaying(); startPlayback(); }
    if (e.key === 'ArrowUp')    { setVol(volume + 0.05); }
    if (e.key === 'ArrowDown')  { setVol(volume - 0.05); }
    if (e.key === ' ')          { e.preventDefault(); if (isPlaying) stopPlayback(); else startPlayback(); }
  });

  // ============ URL 参数 ============
  function loadFromURL() {
    var params = new URLSearchParams(window.location.search);

    var yParam = params.get('year');
    if (yParam) {
      var y = parseInt(yParam);
      if (y >= ERA_MIN && y <= ERA_MAX) {
        year = y;
        document.getElementById('nixieYear').textContent = year;
        setKnobRotation(document.getElementById('knobEra'), angleForValue(year, ERA_MIN, ERA_MAX));
      }
    }
  }

  // ============ 对讲系统 (PTT) ============
  var jitsiApi = null;
  var jitsiLoaded = false;
  var isConnected = false;
  var pttActive = false;

  function loadJitsiAPI(callback) {
    if (jitsiLoaded) { callback(); return; }
    if (window.JitsiMeetExternalAPI) { jitsiLoaded = true; callback(); return; }
    var s = document.createElement('script');
    s.src = 'https://meet.jit.si/libs/external_api.min.js';
    s.onload = function() { jitsiLoaded = true; callback(); };
    s.onerror = function() { showToast('对讲服务加载失败', 'error'); };
    document.head.appendChild(s);
  }

  function connectJitsi() {
    if (isConnected) return;
    loadJitsiAPI(function() {
      var room = 'mayday-' + year + 'era';
      var meet = document.getElementById('jitsiMeet');
      meet.innerHTML = '';
      var opts = {
        roomName: room,
        width: '100%',
        height: '100%',
        parentNode: meet,
        configOverwrite: {
          prejoinPageEnabled: false,
          startWithVideoMuted: true,
          startWithAudioMuted: true,
          disableDeepLinking: true
        },
        interfaceConfigOverwrite: {
          TOOLBAR_BUTTONS: [],
          SHOW_PROMOTIONAL_CLOSE_PAGE: false,
          SHOW_JITSI_WATERMARK: false,
          SHOW_WATERMARK_FOR_GUESTS: false,
          DISABLE_JOIN_LEAVE_NOTIFICATIONS: true,
          FILM_STRIP_MAX_HEIGHT: 0,
          VIDEO_LAYOUT_FIT: 'both'
        }
      };
      jitsiApi = new window.JitsiMeetExternalAPI('meet.jit.si', opts);
      jitsiApi.addEventListeners({
        videoConferenceJoined: function() {
          isConnected = true;
          updatePTTUI(true);
        },
        videoConferenceLeft: function() {
          isConnected = false;
          pttActive = false;
          updatePTTUI(false);
        },
        readyToClose: function() {
          disconnectJitsi();
        }
      });
    });
  }

  function disconnectJitsi() {
    if (jitsiApi) {
      jitsiApi.dispose();
      jitsiApi = null;
    }
    isConnected = false;
    pttActive = false;
    updatePTTUI(false);
  }

  function updatePTTUI(connected) {
    var pttArea = document.getElementById('pttArea');
    var btn = document.getElementById('intercomBtn');
    if (connected) {
      pttArea.style.display = 'block';
      btn.textContent = '挂断';
      btn.className = 'intercom-btn connected';
      document.getElementById('pttLabel').textContent = '按住说话';
      document.getElementById('pttButton').classList.remove('pressed');
    } else {
      pttArea.style.display = 'none';
      btn.textContent = '对讲';
      btn.className = 'intercom-btn';
    }
  }

  // ============ PTT 按钮交互 ============
  function pttStart() {
    if (!isConnected || !jitsiApi) return;
    if (pttActive) return;
    pttActive = true;
    jitsiApi.executeCommand('toggleAudio');
    var btn = document.getElementById('pttButton');
    btn.classList.add('pressed');
    document.getElementById('pttLabel').textContent = '正在发言...';
  }

  function pttStop() {
    if (!isConnected || !jitsiApi) return;
    if (!pttActive) return;
    pttActive = false;
    jitsiApi.executeCommand('toggleAudio');
    var btn = document.getElementById('pttButton');
    btn.classList.remove('pressed');
    document.getElementById('pttLabel').textContent = '按住说话';
  }

  document.getElementById('pttButton').addEventListener('mousedown', function(e) {
    e.preventDefault();
    pttStart();
  });
  document.getElementById('pttButton').addEventListener('mouseup', function(e) {
    e.preventDefault();
    pttStop();
  });
  document.getElementById('pttButton').addEventListener('mouseleave', function(e) {
    if (pttActive) pttStop();
  });
  document.getElementById('pttButton').addEventListener('touchstart', function(e) {
    e.preventDefault();
    pttStart();
  });
  document.getElementById('pttButton').addEventListener('touchend', function(e) {
    e.preventDefault();
    pttStop();
  });
  document.getElementById('pttButton').addEventListener('touchcancel', function(e) {
    pttStop();
  });

  document.getElementById('pttDisconnectBtn').addEventListener('click', function() {
    disconnectJitsi();
  });

  // 点击按钮 → 连接/断开 Jitsi（默认静音，显示 PTT）
  document.getElementById('intercomBtn').addEventListener('click', function() {
    if (isConnected) { disconnectJitsi(); } else { connectJitsi(); }
  });

  // ============ 初始化 ============
  function init() {
    fetch('/frontend/singer_data.json')
      .then(function(r) {
        if (!r.ok) throw new Error('Failed to load data ' + r.status);
        return r.json();
      })
      .then(function(data) {
        var mayday = null;
        for (var i = 0; i < data.singers.length; i++) {
          if (data.singers[i].name === '\u4E94\u6708\u5929') { mayday = data.singers[i]; break; }
        }
        if (!mayday) {
          document.getElementById('nowPlaying').textContent = '\u274C \u4E94\u6708\u5929\u6570\u636E\u672A\u627E\u5230';
          return;
        }

        var songsByYear = mayday.songs_by_year || {};
        for (var y in songsByYear) {
          var songList = songsByYear[y];
          for (var j = 0; j < songList.length; j++) {
            var s = songList[j];
            allSongs.push({
              title: s.title,
              year: parseInt(y),
              album: s.album || '',
              stream_url: s.stream_url || '',
              has_stream: s.has_stream || false
            });
          }
        }

        loadFromURL();
        filterSongs();
        renderDial();
        updateEraScroll();
        updatePlayUI(false);

        document.getElementById('nowPlaying').textContent =
          '\u{1F3B5} \u4E94\u6708\u5929 \u00B7 ' + allSongs.length + '\u9996 \u00B7 \u70B9\u51FB\u841D\u535C\u64AD\u653E';
      })
      .catch(function(e) {
        console.error('Init failed:', e);
        document.getElementById('nowPlaying').textContent = '\u274C \u52A0\u8F7D\u5931\u8D25: ' + e.message;
      });
  }

  init();
})();
