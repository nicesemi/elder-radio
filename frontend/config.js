/* =============================================
   config.js - 收音机配置页逻辑
   API 路径声明（前端调用预留）：
     GET  /api/config/qrcode?device_id=  → 获取绑定二维码
     POST /api/config/bind                → 设备绑定
     POST /api/config/voice/preview       → 语音包试听合成
     GET  /api/config/voices              → 语音包/音色列表
     POST /api/payment/create             → 创建支付订单
     GET  /api/payment/status?order_id=   → 查询支付状态
   ============================================= */

(function() {
  'use strict';

  // ---- Preset voice packs (fallback when API unavailable) ----
  const presetVoices = [
    { id: 'v1', name: '经典女声·标准', desc: '温柔亲和的女播音员', price: 0, free: true, preview_url: null, category: '预设' },
    { id: 'v2', name: '经典男声·标准', desc: '沉稳庄重的男播音员', price: 0, free: true, preview_url: null, category: '预设' },
    { id: 'v3', name: '粤语女声·港台', desc: '地道粤语广播腔', price: 0, free: true, preview_url: null, category: '方言' },
    { id: 'v4', name: '四川话男声', desc: '亲切的四川话播报', price: 0, free: true, preview_url: null, category: '方言' },
    { id: 'v5', name: '激情体育解说', desc: '热血澎湃的体育播报', price: 5.99, free: false, preview_url: null, category: '场景' },
    { id: 'v6', name: '深夜电台·暖男', desc: '温暖治愈的深夜男声', price: 5.99, free: false, preview_url: null, category: '场景' },
    { id: 'v7', name: '闽南语·台海之声', desc: '闽南语广播专属', price: 3.99, free: false, preview_url: null, category: '方言' },
    { id: 'v8', name: '儿童故事·叔叔', desc: '生动有趣的儿童故事声', price: 3.99, free: false, preview_url: null, category: '场景' },
    { id: 'v9', name: 'Mr. Agnes·English', desc: 'English broadcast voice', price: 8.99, free: false, preview_url: null, category: '国际' },
    { id: 'v10', name: '定制克隆·你的声音', desc: '上传声音样本，克隆专属音色', price: 29.99, free: false, preview_url: null, category: '定制' },
    { id: 'v11', name: '戏曲唱腔·京剧', desc: '戏曲广播专属唱腔', price: 9.99, free: false, preview_url: null, category: '艺术' }
  ];

  let voicePacks = [];

  // ---- Load Voice Packs ----
  function loadVoices() {
    apiFetch('/api/config/voices').then(data => {
      voicePacks = data.voices || presetVoices;
      renderVoiceCards();
      populateVoiceSelect();
    }).catch(() => {
      voicePacks = presetVoices;
      renderVoiceCards();
      populateVoiceSelect();
    });
  }

  function renderVoiceCards() {
    const grid = document.getElementById('voiceGrid');
    grid.innerHTML = voicePacks.map(v => `
      <div class="voice-card${v.free ? '' : ' premium'}">
        <div class="vc-name">${v.name}</div>
        <div class="vc-desc">${v.desc}</div>
        <span style="font-size:0.7rem;color:var(--text-muted);">${v.category || ''}</span>
        <div class="vc-meta">
          <span class="${v.free ? 'vc-free' : 'vc-price'}">${v.free ? '免费' : '¥' + v.price}</span>
          <div class="vc-actions">
            ${v.preview_url ? `<button class="btn btn-sm preview-btn" data-url="${v.preview_url}">试听</button>` : ''}
            ${!v.free ? `<button class="btn btn-accent btn-sm buy-btn" data-id="${v.id}" data-name="${v.name}" data-price="${v.price}">购买</button>` : ''}
          </div>
        </div>
      </div>
    `).join('');

    // Preview buttons
    grid.querySelectorAll('.preview-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const audio = new Audio(btn.dataset.url);
        audio.play().catch(() => showToast('试听音频加载失败'));
      });
    });

    // Buy buttons
    grid.querySelectorAll('.buy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        showPayModal(btn.dataset.name, parseFloat(btn.dataset.price), 'voice_pack');
      });
    });
  }

  function populateVoiceSelect() {
    const sel = document.getElementById('customVoice');
    sel.innerHTML = voicePacks.map(v =>
      `<option value="${v.id}">${v.name} ${v.free ? '(免费)' : '¥'+v.price}</option>`
    ).join('');
  }

  // ---- Payment Modal ----
  function showPayModal(productName, price, type) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal pay-modal-content">
        <h3 style="margin-bottom:12px;">购买 - ${productName}</h3>
        <div class="pay-qrcode">
          <div style="text-align:center;">
            <div style="font-size:3rem;">💳</div>
            <div>支付宝支付</div>
            <div style="font-size:0.85rem;margin-top:8px;">扫码支付 ¥${price.toFixed(2)}</div>
            <div style="font-size:0.7rem;color:#999;">（演示模式 — 实际支付需接入支付宝 H5 SDK）</div>
          </div>
        </div>
        <div style="display:flex;gap:10px;justify-content:center;">
          <button class="btn btn-sm" id="payCancel">取消</button>
          <button class="btn btn-accent btn-sm" id="paySimulate">模拟支付成功</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('#payCancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#paySimulate').addEventListener('click', () => {
      overlay.remove();
      // Create order via API
      apiFetch('/api/payment/create', {
        method: 'POST',
        body: JSON.stringify({ product_name: productName, price: price, type: type, method: 'alipay' })
      }).then(() => {
        showToast('支付成功！已解锁语音包');
      }).catch(() => {
        showToast('模拟支付成功！（API 未就绪）');
      });
    });
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  }

  // ---- QR Code ----
  function loadQRCode() {
    const deviceId = localStorage.getItem('keyclaw_device_id') || ('dev_' + Math.random().toString(36).slice(2, 10));
    localStorage.setItem('keyclaw_device_id', deviceId);

    apiFetch('/api/config/qrcode?device_id=' + deviceId).then(data => {
      if (data.qrcode_url) {
        document.getElementById('qrcodeDisplay').innerHTML =
          `<img src="${data.qrcode_url}" alt="设备绑定二维码" style="width:160px;height:160px;">`;
      } else {
        document.getElementById('qrcodeDisplay').innerHTML = '<span>二维码<br>（API 未就绪）</span>';
      }
    }).catch(() => {
      document.getElementById('qrcodeDisplay').innerHTML =
        `<div style="text-align:center;">
          <div style="font-size:2.5rem;">📱</div>
          <div style="font-size:0.75rem;">设备 ID: ${deviceId.slice(0, 12)}...</div>
          <div style="font-size:0.7rem;color:var(--text-muted);">等待 API 就绪后生成二维码</div>
        </div>`;
    });
  }

  // ---- Custom Voice Controls ----
  function initCustomControls() {
    const speedSlider = document.getElementById('customSpeed');
    const speedValue = document.getElementById('speedValue');
    const pitchSlider = document.getElementById('customPitch');
    const pitchValue = document.getElementById('pitchValue');

    speedSlider.addEventListener('input', () => {
      speedValue.textContent = (parseInt(speedSlider.value) / 100).toFixed(1) + 'x';
    });
    pitchSlider.addEventListener('input', () => {
      pitchValue.textContent = pitchSlider.value;
    });

    // Preview button
    document.getElementById('btnPreview').addEventListener('click', () => {
      const voiceId = document.getElementById('customVoice').value;
      const speed = parseInt(speedSlider.value) / 100;
      const pitch = parseInt(pitchSlider.value);

      apiFetch('/api/config/voice/preview', {
        method: 'POST',
        body: JSON.stringify({ voice_id: voiceId, speed: speed, pitch: pitch })
      }).then(data => {
        if (data.audio_url) {
          const audio = new Audio(data.audio_url);
          audio.play().catch(() => showToast('音频播放失败'));
        }
      }).catch(() => {
        showToast('试听合成 API 未就绪');
      });
    });

    // Buy custom button
    document.getElementById('btnBuyCustom').addEventListener('click', () => {
      const voiceName = document.getElementById('customVoice').selectedOptions[0]?.textContent || '自定义语音包';
      const price = parseFloat(document.getElementById('customPrice').textContent);
      showPayModal(voiceName, price, 'custom_voice');
    });
  }

  // ---- QR Refresh ----
  document.getElementById('btnRefreshQR')?.addEventListener('click', loadQRCode);

  // ---- Init ----
  loadVoices();
  loadQRCode();
  initCustomControls();
})();