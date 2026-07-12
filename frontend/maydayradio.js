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
    let lastTouchTime = 0;

    // --- 拖拽值计算 ---
    function handleMove(clientY) {
      if (!dragging) return;
      const dy = startY - clientY;
      const sens = (max - min) / 200;
      let newVal = startVal + dy * sens;
      if (step) newVal = Math.round(newVal / step) * step;
      newVal = Math.max(min, Math.min(max, newVal));
      setVal(newVal);
      if (onChange) onChange(newVal);
    }

    function handleEnd() {
      if (dragging) { dragging = false; el.style.cursor = 'grab'; }
    }

    // --- 鼠标事件（桌面端） ---
    el.addEventListener('mousedown', function(e) {
      if (Date.now() - lastTouchTime < 500) return; // 跳过触摸触发的合成 mousedown
      e.preventDefault();
      dragging = true;
      startY = e.clientY;
      startVal = getVal();
      el.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', function(e) {
      handleMove(e.clientY);
    });

    window.addEventListener('mouseup', function() {
      handleEnd();
    });

    // --- 触摸事件（移动端） ---
    el.addEventListener('touchstart', function(e) {
      e.preventDefault();
      lastTouchTime = Date.now();
      dragging = true;
      startY = e.touches[0].clientY;
      startVal = getVal();
    }, { passive: false });

    window.addEventListener('touchmove', function(e) {
      if (!dragging) return;
      e.preventDefault();
      handleMove(e.touches[0].clientY);
    }, { passive: false });

    window.addEventListener('touchend', function() {
      lastTouchTime = Date.now();
      handleEnd();
    });

    window.addEventListener('touchcancel', function() {
      lastTouchTime = Date.now();
      handleEnd();
    });

    // --- 滚轮事件（桌面端微调） ---
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
  var pttConnecting = false;
  var lastTouchTime = 0;

  function loadJitsiAPI(callback) {
    if (jitsiLoaded) { callback(); return; }
    if (window.JitsiMeetExternalAPI) { jitsiLoaded = true; callback(); return; }
    var s = document.createElement('script');
    s.src = 'https://meet.jit.si/libs/external_api.min.js';
    s.onload = function() { jitsiLoaded = true; callback(); };
    s.onerror = function() {
      pttConnecting = false;  // 复位死锁锁
      showToast('对讲服务加载失败', 'error');
    };
    document.head.appendChild(s);
  }

  var pttConnectTimeout = null;  // 连接超时定时器

  function connectJitsi() {
    if (isConnected || pttConnecting) return;
    pttConnecting = true;
    // 15 秒连接超时，防止 Jitsi 无响应导致按钮永久死锁
    clearTimeout(pttConnectTimeout);
    pttConnectTimeout = setTimeout(function() {
      if (pttConnecting && !isConnected) {
        pttConnecting = false;
        showToast('连接超时，请重试', 'error');
      }
    }, 15000);
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
          clearTimeout(pttConnectTimeout);
          pttConnecting = false;
          isConnected = true;
          updatePTTUI(true);
          AgnesRobot.updateContext();
        },
        videoConferenceLeft: function() {
          clearTimeout(pttConnectTimeout);
          pttConnecting = false;
          isConnected = false;
          pttActive = false;
          updatePTTUI(false);
          AgnesRobot.cancel();
        },
        // 远程参与者音频状态变化 → 有人说话则取消倒计时
        audioMuteStatusChanged: function(info) {
          // info.muted === false 表示有人取消静音（准备说话）
          if (info && !info.muted) {
            AgnesRobot.onRemoteAudio();
          }
        },
        readyToClose: function() {
          disconnectJitsi();
        }
      });
    });
  }

  function disconnectJitsi() {
    clearTimeout(pttConnectTimeout);
    pttConnecting = false;
    AgnesRobot.cancel();
    if (jitsiApi) {
      jitsiApi.dispose();
      jitsiApi = null;
    }
    isConnected = false;
    pttActive = false;
    updatePTTUI(false);
  }

  function updatePTTUI(connected) {
    var btn = document.getElementById('pttButton');
    var label = document.getElementById('pttLabel');
    if (connected) {
      btn.className = 'ptt-button connected';
      label.textContent = '按住说话';
      btn.classList.remove('pressed');
    } else {
      btn.className = 'ptt-button';
      label.textContent = '连接对讲';
      btn.classList.remove('pressed');
    }
  }

  // PTT 按钮：同时处理连接/断开和按住说话
  function pttStart() {
    if (!isConnected || !jitsiApi) return;
    if (pttActive) return;
    AgnesRobot.cancel();  // 用户再次讲话，取消 Agnes 倒计时
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
    // 松手后启动 Agnes 等待倒计时
    AgnesRobot.startCountdown();
  }

  var pttBtn = document.getElementById('pttButton');
  pttBtn.addEventListener('click', function(e) {
    // 忽略触摸释放后 500ms 内的合成 click，避免刚连上就断开
    if (Date.now() - lastTouchTime < 500) return;
    // 短点击 → 断开（仅已连接时生效）
    if (isConnected) { disconnectJitsi(); }
  });
  pttBtn.addEventListener('mousedown', function(e) {
    // 忽略触摸触发的合成 mousedown，避免重复连接
    if (Date.now() - lastTouchTime < 500) return;
    e.preventDefault();
    if (!isConnected) { connectJitsi(); return; }
    pttStart();
  });
  pttBtn.addEventListener('mouseup', function(e) {
    e.preventDefault();
    if (pttActive) pttStop();
  });
  pttBtn.addEventListener('mouseleave', function(e) {
    if (pttActive) pttStop();
  });
  pttBtn.addEventListener('touchstart', function(e) {
    e.preventDefault();
    lastTouchTime = Date.now();
    if (!isConnected) { connectJitsi(); return; }
    pttStart();
  }, { passive: false });
  pttBtn.addEventListener('touchend', function(e) {
    e.preventDefault();
    lastTouchTime = Date.now();
    if (pttActive) pttStop();
  }, { passive: false });
  pttBtn.addEventListener('touchcancel', function(e) {
    lastTouchTime = Date.now();
    pttStop();
  });

  // ============ Agnes AI 机器人自动回应 ============
  var AgnesRobot = {
    // 状态管理
    _state: 'idle',             // idle | countdown | listening | replying
    _countdownTimer: null,
    _countdownStart: 0,
    _countdownDuration: 10000,  // 10 秒
    _recognition: null,
    _synth: window.speechSynthesis,
    _remoteAudioActive: false,
    _channelContext: '',         // 频道上下文，随年份变化

    // --- 状态指示器 ---
    _indicatorEl: document.getElementById('agnesIndicator'),
    _statusTextEl: document.getElementById('agnesStatusText'),

    _setIndicator: function(state, text) {
      this._state = state;
      var el = this._indicatorEl;
      var cls = 'agnes-indicator visible';
      if (state === 'countdown') cls += ' countdown';
      else if (state === 'listening') cls += ' listening';
      else if (state === 'replying') cls += ' replying';
      el.className = cls;
      this._statusTextEl.textContent = text || '';
    },

    _hideIndicator: function() {
      this._state = 'idle';
      this._indicatorEl.className = 'agnes-indicator';
      this._statusTextEl.textContent = '';
    },

    // --- 初始化语音识别 ---
    _initRecognition: function() {
      var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        console.log('[Agnes] SpeechRecognition 不可用');
        return null;
      }
      var rec = new SpeechRecognition();
      rec.lang = 'zh-CN';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.continuous = false;
      return rec;
    },

    // --- 开始 10 秒倒计时 ---
    startCountdown: function() {
      if (!isConnected) return;  // 未连接对讲，不启动
      this.cancel();              // 清除之前的

      var self = this;
      var remaining = Math.ceil(this._countdownDuration / 1000);
      this._setIndicator('countdown', 'Agnes 等待回应... ' + remaining + 's');
      this._countdownStart = Date.now();

      // 每秒更新倒计时
      var tickInterval = setInterval(function() {
        if (self._state !== 'countdown') { clearInterval(tickInterval); return; }
        var elapsed = Date.now() - self._countdownStart;
        var left = Math.max(0, Math.ceil((self._countdownDuration - elapsed) / 1000));
        self._statusTextEl.textContent = 'Agnes 等待回应... ' + left + 's';
        if (left <= 0) { clearInterval(tickInterval); }
      }, 500);

      this._countdownTimer = setTimeout(function() {
        clearInterval(tickInterval);
        self._onTimeout();
      }, this._countdownDuration);
    },

    // --- 超时 → 开始监听 + 转写 ---
    _onTimeout: function() {
      if (this._state !== 'countdown') return;
      this._setIndicator('listening', 'Agnes 正在听...');
      this._startListening();
    },

    // --- 启动语音识别，捕获用户刚说的话 ---
    _startListening: function() {
      var rec = this._initRecognition();
      if (!rec) {
        // 无 SpeechRecognition，降级：直接发空消息
        console.log('[Agnes] 无语音识别，发送默认问候');
        this._sendToAgnes('喂，有人在吗？');
        return;
      }

      var self = this;
      this._recognition = rec;

      rec.onresult = function(event) {
        var transcript = '';
        for (var i = event.resultIndex; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
        }
        transcript = transcript.trim();
        if (transcript) {
          self._sendToAgnes(transcript);
        } else {
          // 没识别到内容，发默认提示
          self._sendToAgnes('喂？有人在吗？');
        }
      };

      rec.onerror = function(event) {
        console.log('[Agnes] 语音识别错误:', event.error);
        if (event.error === 'no-speech' || event.error === 'aborted') {
          // 没检测到语音，用默认消息
          self._sendToAgnes('你好，有人回应吗？');
        } else {
          self._hideIndicator();
        }
      };

      rec.onend = function() {
        self._recognition = null;
      };

      try {
        rec.start();
      } catch (e) {
        console.log('[Agnes] 启动语音识别失败:', e);
        this._sendToAgnes('有人在吗？');
      }
    },

    // --- 发送文字到 Agnes API ---
    _sendToAgnes: function(text) {
      var self = this;
      this._setIndicator('replying', 'Agnes 回复中...');

      fetch('/api/agnes/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text,
          context: '五月天 ' + year + ' 年代对讲频道'
        })
      })
      .then(function(r) {
        if (!r.ok) {
          throw new Error('Agnes API 返回 ' + r.status);
        }
        return r.json();
      })
      .then(function(data) {
        if (data.success && data.reply) {
          self._speak(data.reply);
        } else {
          throw new Error('Agnes API 返回异常: ' + JSON.stringify(data));
        }
      })
      .catch(function(e) {
        console.log('[Agnes] 请求失败:', e.message || e);
        self._hideIndicator();
        showToast('Agnes 暂时无法回应，请稍后再试', 'error');
      });
    },

    // --- TTS 朗读 ---
    _speak: function(text) {
      var self = this;
      if (!this._synth) {
        console.log('[Agnes] SpeechSynthesis 不可用');
        this._hideIndicator();
        return;
      }

      // 取消之前正在播放的语音
      this._synth.cancel();

      var utter = new SpeechSynthesisUtterance(text);
      utter.lang = 'zh-CN';
      utter.rate = 0.95;
      utter.pitch = 1.1;
      utter.volume = 0.9;

      // 尝试选择女性中文语音
      var voices = this._synth.getVoices();
      var preferred = voices.find(function(v) {
        return v.lang === 'zh-CN' && v.name.indexOf('Female') !== -1;
      }) || voices.find(function(v) {
        return v.lang.startsWith('zh');
      });
      if (preferred) utter.voice = preferred;

      utter.onstart = function() {
        self._setIndicator('replying', 'Agnes: ' + text.substring(0, 20) + '...');
      };

      utter.onend = function() {
        self._hideIndicator();
      };

      utter.onerror = function(e) {
        console.log('[Agnes] TTS 错误:', e);
        self._hideIndicator();
      };

      this._synth.speak(utter);
    },

    // --- 取消（用户再次 PTT / 远程音频 / 断开连接） ---
    cancel: function() {
      if (this._countdownTimer) {
        clearTimeout(this._countdownTimer);
        this._countdownTimer = null;
      }
      if (this._recognition) {
        try { this._recognition.abort(); } catch(e) {}
        this._recognition = null;
      }
      if (this._synth) {
        this._synth.cancel();
      }
      this._hideIndicator();
    },

    // --- Jitsi 远程音频活动通知 ---
    onRemoteAudio: function() {
      if (this._state === 'countdown') {
        console.log('[Agnes] 检测到远程音频 → 取消倒计时');
        this.cancel();
      }
    },

    // --- 更新频道上下文 ---
    updateContext: function(ctx) {
      this._channelContext = ctx || ('五月天 ' + year + ' 年代对讲频道');
    }
  };

  // 预加载 voices 列表（异步）
  if (window.speechSynthesis) {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.onvoiceschanged = function() {
      window.speechSynthesis.getVoices();
    };
  }

  // Agnes API 健康检查（启动时静默探测，失败仅 console 记录）
  (function() {
    fetch('/api/agnes/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '__health_check__' })
    }).then(function(r) {
      if (!r.ok) console.warn('[Agnes] 启动健康检查失败 (HTTP ' + r.status + ')，对讲自动回应功能可能不可用');
    }).catch(function(e) {
      console.warn('[Agnes] 启动健康检查网络失败:', e.message || e);
    });
  })();

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
