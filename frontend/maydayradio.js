/* =============================================
   maydayradio.js — 五月天胡萝卜收音机 v2
   修复：浏览器自动播放策略 → 点击播放大按钮
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
  let isConnected = false;
  let connectionTimer = null;
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
    year = Math.max(ERA_MIN, Math.min(ERA_MAX, y));
    document.getElementById('nixieYear').textContent = year;
    setKnobRotation(document.getElementById('knobEra'), angleForValue(year, ERA_MIN, ERA_MAX));
    filterSongs();
    updateEraScroll();
    updateWalkieYear();
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
      var icon = s.stream_url ? '🎵' : '📻';
      el.textContent = icon + ' [' + year + '] ' + s.title;
    } else {
      el.textContent = '等待信号...';
    }
  }

  // ============ 播放控制 ============

  var fetchingStream = {};  // 防并发

  function fetchStreamUrl(song, callback) {
    var key = song.title;
    if (fetchingStream[key]) return;  // 正在获取中
    fetchingStream[key] = true;

    var url = '/api/stream?name=' + encodeURIComponent(song.title) + '&artist=五月天';
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
        console.log('播放失败:', e.message);
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

    // 有缓存流链接 → 直接播放
    if (s.stream_url) {
      doPlay(s.stream_url);
      return;
    }

    // 无链接 → 实时获取
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

  // 播放按钮点击
  document.getElementById('playOverlay').addEventListener('click', function(e) {
    e.stopPropagation();
    startPlayback();
  });

  // 点击萝卜身体也可以播放/暂停
  document.querySelector('.carrot-character').addEventListener('click', function(e) {
    e.stopPropagation();
    if (isPlaying) {
      stopPlayback();
    } else {
      startPlayback();
    }
  });
  // 让萝卜可点击
  document.querySelector('.carrot-character').style.pointerEvents = 'auto';
  document.querySelector('.carrot-character').style.cursor = 'pointer';

  // 音频事件
  AUDIO.addEventListener('ended', function() {
    isPlaying = false;
    updatePlayUI(false);
  });

  AUDIO.addEventListener('error', function() {
    console.log('音频加载错误:', AUDIO.error);
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

  // ============ 对讲机 ============
  var walkieOverlay = document.getElementById('walkieOverlay');
  var btnWalkie = document.getElementById('btnWalkie');

  btnWalkie.addEventListener('click', function() {
    walkieOverlay.classList.add('show');
    btnWalkie.classList.add('active');
    updateWalkieYear();
    renderGroupList();
  });

  document.getElementById('btnWalkieClose').addEventListener('click', function() {
    walkieOverlay.classList.remove('show');
    btnWalkie.classList.remove('active');
  });

  walkieOverlay.addEventListener('click', function(e) {
    if (e.target === walkieOverlay) {
      walkieOverlay.classList.remove('show');
      btnWalkie.classList.remove('active');
    }
  });

  function updateWalkieYear() {
    document.getElementById('connectYear').textContent = year;
    document.getElementById('connectStatus').textContent = isConnected ? '已连接 · 在线' : '未连接';
  }

  document.getElementById('btnConnectFans').addEventListener('click', function() {
    var btn = this;
    if (isConnected) {
      isConnected = false;
      btn.textContent = '连接「' + year + '年代」聊天室';
      document.getElementById('connectStatus').textContent = '未连接';
      if (connectionTimer) { clearInterval(connectionTimer); connectionTimer = null; }
      showToast('已断开连接');
    } else {
      isConnected = true;
      btn.textContent = '已连接 · 点击断开';
      document.getElementById('connectStatus').textContent = '已连接 · 在线 · ' + year + '年代';
      showToast('已连接「' + year + '年代」聊天室');

      connectionTimer = setInterval(function() {
        var count = Math.floor(Math.random() * 50) + 10;
        document.getElementById('connectStatus').textContent = '已连接 · 在线 ' + count + ' 人 · ' + year + '年代';
      }, 10000);
    }
  });

  document.getElementById('btnCreateGroup').addEventListener('click', function() {
    var nameInput = document.getElementById('groupNameInput');
    var name = nameInput.value.trim();
    if (!name) {
      name = year + '年代五迷群';
      nameInput.value = name;
    }

    var groups = [];
    try { groups = JSON.parse(localStorage.getItem('maydayradio_groups') || '[]'); } catch(e) {}

    var groupId = 'MD' + Date.now().toString(36).toUpperCase();
    var group = {
      id: groupId,
      name: name,
      year: year,
      created: new Date().toISOString(),
      members: 1
    };

    groups.unshift(group);
    localStorage.setItem('maydayradio_groups', JSON.stringify(groups));

    var shareLink = window.location.origin + '/maydayradio?join=' + groupId;
    var resultDiv = document.getElementById('groupCreateResult');
    resultDiv.innerHTML =
      '<div style="background:rgba(76,175,80,0.1);border-radius:8px;padding:12px;text-align:center;">' +
      '<p style="color:#4CAF50;font-size:12px;margin:0 0 8px;">群组「' + name + '」已创建</p>' +
      '<p style="color:#666;font-size:10px;margin:8px 0 0;">分享码: <b style="color:#4CAF50;">' + groupId + '</b></p>' +
      '<p style="color:#888;font-size:9px;margin:4px 0 0;">在手机上打开链接或输入分享码加入群组</p>' +
      '</div>';

    renderGroupList();
    showToast('群组「' + name + '」创建成功');
  });

  function renderGroupList() {
    var groups = [];
    try { groups = JSON.parse(localStorage.getItem('maydayradio_groups') || '[]'); } catch(e) {}

    var listEl = document.getElementById('groupList');
    if (groups.length === 0) {
      listEl.innerHTML = '<p style="color:#555;font-size:11px;">暂无群组</p>';
      return;
    }

    listEl.innerHTML = groups.map(function(g) {
      return '<div class="group-item">' +
        '<div><b>' + g.name + '</b><br><span style="color:#888;font-size:9px;">' + g.id + ' · ' + g.members + '人</span></div>' +
        '<button class="join-btn" data-gid="' + g.id + '">加入</button>' +
        '</div>';
    }).join('');

    listEl.querySelectorAll('.join-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var gid = this.dataset.gid;
        var g = groups.find(function(x) { return x.id === gid; });
        if (g) {
          g.members = (g.members || 1) + 1;
          localStorage.setItem('maydayradio_groups', JSON.stringify(groups));
          renderGroupList();
          showToast('已加入「' + g.name + '」');
        }
      });
    });
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

    var joinId = params.get('join');
    if (joinId) {
      setTimeout(function() {
        walkieOverlay.classList.add('show');
        btnWalkie.classList.add('active');
        var groups = JSON.parse(localStorage.getItem('maydayradio_groups') || '[]');
        var g = groups.find(function(x) { return x.id === joinId; });
        if (g) {
          g.members = (g.members || 1) + 1;
          localStorage.setItem('maydayradio_groups', JSON.stringify(groups));
          showToast('欢迎加入「' + g.name + '」！');
        }
        renderGroupList();
      }, 500);
    }
  }

  // ============ 初始化 ============
  function init() {
    fetch('/frontend/singer_data.json')
      .then(function(r) {
        if (!r.ok) throw new Error('数据加载失败 ' + r.status);
        return r.json();
      })
      .then(function(data) {
        var mayday = null;
        for (var i = 0; i < data.singers.length; i++) {
          if (data.singers[i].name === '五月天') { mayday = data.singers[i]; break; }
        }
        if (!mayday) {
          document.getElementById('nowPlaying').textContent = '❌ 五月天数据未找到';
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

        // 显示总览
        document.getElementById('nowPlaying').textContent =
          '🎵 五月天 · ' + allSongs.length + '首 · 点击萝卜播放';
      })
      .catch(function(e) {
        console.error('初始化失败:', e);
        document.getElementById('nowPlaying').textContent = '❌ 加载失败: ' + e.message;
      });
  }

  init();
})();
