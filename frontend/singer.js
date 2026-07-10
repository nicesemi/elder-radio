/* =============================================
   singer.js — 歌手频道逻辑
   数据源：singer_data.json
   ============================================= */

(function() {
  'use strict';

  let singerData = [];
  let currentSinger = null;
  const audioPlayer = document.getElementById('audioPlayer');

  // ============ 渲染歌手列表 ============
  function renderSingerList() {
    const grid = document.getElementById('singerGrid');
    if (singerData.length === 0) {
      grid.innerHTML = '<div class="empty-state"><div class="empty-icon">🎵</div><p>暂无歌手数据</p></div>';
      return;
    }

    grid.innerHTML = singerData.map(s => {
      const imgClass = s.name_en ? s.name_en.toLowerCase().replace(/[^a-z]/g, '') : '';
      const streamCount = s.songs.filter(sg => sg.has_stream).length;
      const aiCount = s.songs.filter(sg => !sg.has_stream).length;

      return `<div class="singer-hero-card" onclick="showSingerDetail('${s.name}')">
        <div class="singer-hero-img ${imgClass}">
          <span style="font-size:4rem;position:relative;z-index:1;">🎸</span>
        </div>
        <div class="singer-hero-body">
          <h3>${s.name}</h3>
          <div class="singer-ename">${s.name_en} · ${s.active_years}</div>
          <div class="singer-meta">
            <span class="badge badge-arts">${s.genre}</span>
          </div>
          <div class="singer-desc">${s.description}</div>
          <div class="singer-stats">
            <span>共 <strong>${s.songs.length}</strong> 首</span>
            <span>原版 <strong>${streamCount}</strong></span>
            <span>AI翻唱 <strong>${aiCount}</strong></span>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  window.showSingerDetail = function(name) {
    currentSinger = singerData.find(s => s.name === name);
    if (!currentSinger) return;

    document.getElementById('listPage').classList.remove('active');
    document.getElementById('detailPage').classList.add('active');

    document.getElementById('detailName').textContent = currentSinger.name;
    document.getElementById('detailDesc').textContent = currentSinger.description;
    document.getElementById('detailMembers').textContent =
      '成员：' + (currentSinger.members || []).join(' / ');

    renderSongGroups();
  };

  window.goBack = function() {
    audioPlayer.pause();
    audioPlayer.src = '';
    currentSinger = null;
    document.getElementById('detailPage').classList.remove('active');
    document.getElementById('listPage').classList.add('active');
  };

  // ============ 按年份渲染歌曲 ============
  function renderSongGroups() {
    if (!currentSinger || !currentSinger.songs) return;

    const container = document.getElementById('songGroups');
    // 按年份分组
    const groups = {};
    currentSinger.songs.forEach(song => {
      const y = song.year;
      if (!groups[y]) groups[y] = [];
      groups[y].push(song);
    });

    const years = Object.keys(groups).sort((a,b) => Number(a) - Number(b));
    let html = '';

    years.forEach(year => {
      const songs = groups[year];
      html += `<div class="song-year-group">
        <div class="song-year-title">
          ${year} 年 <span class="song-count">${songs.length} 首</span>
        </div>
        <div class="song-list">`;

      songs.forEach((song, idx) => {
        const hasStream = song.has_stream && song.stream_url;
        html += `<div class="song-item" data-song='${JSON.stringify(song).replace(/'/g, "&#39;")}'>
          <div class="song-info">
            <div class="song-index">${idx + 1}</div>
            <div>
              <span class="song-title">${song.title}</span>
              ${song.album ? `<span class="song-album">《${song.album}》</span>` : ''}
              ${hasStream ? '<span class="stream-badge">原版</span>' : '<span class="no-stream-badge">待翻唱</span>'}
            </div>
          </div>
          <div class="song-actions">
            ${hasStream
              ? `<button class="play-btn" onclick="event.stopPropagation(); playSong('${song.stream_url}', '${song.title}')">▶ 播放</button>`
              : `<button class="ai-btn" id="aiBtn_${year}_${idx}" onclick="event.stopPropagation(); generateCover(${year}, ${idx}, this)">🎙 AI翻唱</button>`
            }
          </div>
        </div>`;
      });

      html += `</div></div>`;
    });

    container.innerHTML = html;
  }

  // ============ 播放 ============
  window.playSong = function(url, title) {
    audioPlayer.src = url;
    audioPlayer.play().catch(e => {
      console.log('播放失败:', e.message);
      showToast('播放失败，请检查音频源');
    });
    showToast(`正在播放：${title}`);
  };

  // ============ AI 翻唱生成 ============
  window.generateCover = function(year, idx, btn) {
    if (!currentSinger) return;
    const songs = currentSinger.songs.filter(s => s.year === year);
    const song = songs[idx];
    if (!song) return;

    btn.disabled = true;
    btn.textContent = '⏳ 生成中...';
    btn.classList.add('generating');

    fetch('/api/singer/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        singer: currentSinger.name,
        title: song.title,
        year: song.year,
        voice: 'Agnes',
        style: currentSinger.genre || '流行'
      })
    }).then(r => r.json()).then(data => {
      if (data.status === 'generating') {
        // 轮询状态
        pollGeneration(data.job_id, btn, song);
      } else if (data.status === 'completed' && data.audio_url) {
        btn.textContent = '▶ 播放';
        btn.classList.remove('generating');
        btn.classList.add('completed');
        btn.disabled = false;
        btn.onclick = function(e) { e.stopPropagation(); window.playSong(data.audio_url, song.title); };
      }
    }).catch(err => {
      console.log('AI翻唱生成失败:', err);
      btn.textContent = '🎙 重试';
      btn.classList.remove('generating');
      btn.disabled = false;
      showToast('生成失败，请稍后重试');
    });
  };

  function pollGeneration(jobId, btn, song) {
    let tries = 0;
    const maxTries = 30;
    const interval = setInterval(() => {
      fetch(`/api/singer/generate/status/${jobId}`)
        .then(r => r.json())
        .then(data => {
          tries++;
          if (data.status === 'completed' && data.audio_url) {
            clearInterval(interval);
            btn.textContent = '▶ 播放';
            btn.classList.remove('generating');
            btn.classList.add('completed');
            btn.disabled = false;
            btn.onclick = function(e) { e.stopPropagation(); window.playSong(data.audio_url, song.title); };
            showToast(`AI翻唱完成：${song.title}`);
          } else if (tries >= maxTries) {
            clearInterval(interval);
            btn.textContent = '🎙 超时';
            btn.classList.remove('generating');
            btn.disabled = false;
          } else {
            btn.textContent = `⏳ ${tries}/${maxTries}`;
          }
        }).catch(() => {
          if (tries >= maxTries) {
            clearInterval(interval);
            btn.textContent = '🎙 重试';
            btn.classList.remove('generating');
            btn.disabled = false;
          }
        });
    }, 2000);
  }

  // ============ Toast ============
  function showToast(msg) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  // ============ 键盘控制 ============
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && currentSinger) {
      goBack();
    }
  });

  // ============ 初始化 ============
  fetch('/singer_data.json')
    .then(r => r.json())
    .then(data => {
      singerData = data.singers || [];
      renderSingerList();
    })
    .catch(err => {
      document.getElementById('singerGrid').innerHTML =
        `<div class="empty-state"><div class="empty-icon">❌</div><p>加载歌手数据失败：${err.message}</p></div>`;
    });
})();
