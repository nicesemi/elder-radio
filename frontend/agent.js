/**
 * 业务员对讲机 - agent.js
 * 模拟小店业务员端：接收转接、接听对讲、回复客户
 */

// ==================== 状态 ====================
var AGENT_ID = 'agent_' + Math.random().toString(36).slice(2, 8);
var AGENT_NAME = '小店业务员';
var AGENT_SHOP = '便利店 · 南山店';
var AGENT_CHANNEL = 1001;  // 业务员监听频道（= 用户频道 + 1000）
var USER_CHANNEL = 1;       // 当前通话的客户频道
var onlineStatus = 'online'; // online | busy | offline
var activeTransfer = null;   // 当前正在处理的转接
var pendingTransfers = [];   // 待接转接列表
var chatMessages = [];
var pollTimer = null;
var isRecording = false;
var mediaRecorder = null;
var recordedChunks = [];
var currentTab = 'pending';

console.log('[Agent] Script loaded, AGENT_ID:', AGENT_ID, 'AGENT_CHANNEL:', AGENT_CHANNEL);

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', function() {
  console.log('[Agent] DOM ready, starting poll...');
  document.getElementById('shopInfo').textContent = AGENT_SHOP;
  loadAgentInfo();
  startPoll();
});

function loadAgentInfo() {
  var saved = localStorage.getItem('agent_info');
  if (saved) {
    try {
      var info = JSON.parse(saved);
      if (info.name) AGENT_NAME = info.name;
      if (info.shop) AGENT_SHOP = info.shop;
      if (info.channel) AGENT_CHANNEL = parseInt(info.channel);
    } catch(e) {}
  }
  document.getElementById('shopInfo').textContent = AGENT_SHOP;
}

// ==================== 轮询转接 ====================
function startPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollTransfers, 2000);
  pollTransfers();
}

function pollTransfers() {
  var url = '/api/agent/transfers?agent_id=' + AGENT_ID + '&channel=' + AGENT_CHANNEL;
  var controller = new AbortController();
  var timeoutId = setTimeout(function() { controller.abort(); }, 5000);

  fetch(url, { signal: controller.signal })
    .then(function(r) {
      clearTimeout(timeoutId);
      console.log('[Agent] Poll HTTP:', r.status);
      if (!r.ok) {
        return r.text().then(function(t) { throw new Error('HTTP ' + r.status + ': ' + t.slice(0, 200)); });
      }
      return r.json();
    })
    .then(function(data) {
      console.log('[Agent] Poll response:', data);
      if (data.active_call && !activeTransfer) {
        restoreActiveCall(data.active_call);
      }
      if (data.transfers && data.transfers.length > 0) {
        updateTransfers(data.transfers);
      }
    })
    .catch(function(e) {
      clearTimeout(timeoutId);
      console.log('[Agent] Poll error:', e.message || e);
    });
}

function restoreActiveCall(call) {
  activeTransfer = {
    id: call.transfer_id,
    user_channel: call.user_channel,
    intent: call.intent,
    summary: call.summary,
    text: call.text,
    time: call.time
  };
  USER_CHANNEL = call.user_channel;
  updateStatus('busy', '通话中 · 频道 ' + USER_CHANNEL);
  document.getElementById('btnPTT').classList.remove('disabled');
  document.getElementById('chatArea').classList.add('active');
  document.getElementById('transferList').style.display = 'none';
  addChatMsg('system', '已恢复通话（频道 ' + USER_CHANNEL + '），可以继续对话');
  switchTab('active');
  showToast('已恢复频道 ' + USER_CHANNEL + ' 的通话');
}

function updateTransfers(transfers) {
  var newOnes = transfers.filter(function(t) {
    return !pendingTransfers.some(function(p) { return p.id === t.id; }) &&
           t.id !== (activeTransfer && activeTransfer.id);
  });

  pendingTransfers = transfers.filter(function(t) {
    return t.id !== (activeTransfer && activeTransfer.id);
  });

  // 新转接通知
  newOnes.forEach(function(t) {
    showToast('新转接: ' + (t.summary || t.text || '客户请求'));
  });

  updateBadge();
  renderTransferList();
}

function updateBadge() {
  var badge = document.getElementById('queueBadge');
  var count = pendingTransfers.length;
  badge.textContent = count;
  if (count > 0) {
    badge.classList.add('show');
  } else {
    badge.classList.remove('show');
  }
}

// ==================== 渲染转接列表 ====================
function renderTransferList() {
  var list = document.getElementById('transferList');
  if (currentTab !== 'pending') {
    list.style.display = 'none';
    return;
  }
  list.style.display = 'block';

  if (pendingTransfers.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="icon">📻</div>暂无转接请求<br>等待客户发起对讲...</div>';
    document.getElementById('btnAccept').disabled = true;
    return;
  }

  document.getElementById('btnAccept').disabled = !!activeTransfer;
  list.innerHTML = pendingTransfers.map(function(t, i) {
    return '<div class="transfer-item" onclick="acceptTransfer(\'' + t.id + '\')">' +
      '<div class="t-header">' +
        '<span class="t-chan">频道 ' + (t.user_channel || '?') + '</span>' +
        '<span class="t-time">' + (t.time || '') + '</span>' +
      '</div>' +
      '<div class="t-msg">' + escapeHtml(t.text || t.summary || '客户请求服务') + '</div>' +
      (t.intent ? '<span class="t-tag">' + escapeHtml(t.intent) + '</span>' : '') +
    '</div>';
  }).join('');
}

function escapeHtml(text) {
  var div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ==================== 接听 ====================
function acceptLatest() {
  if (pendingTransfers.length === 0) return;
  acceptTransfer(pendingTransfers[0].id);
}

function acceptTransfer(transferId) {
  var transfer = pendingTransfers.find(function(t) { return t.id === transferId; });
  if (!transfer) return;

  activeTransfer = transfer;
  USER_CHANNEL = transfer.user_channel || 1;
  pendingTransfers = pendingTransfers.filter(function(t) { return t.id !== transferId; });

  showToast('已接听频道 ' + USER_CHANNEL);
  updateStatus('busy', '通话中 · 频道 ' + USER_CHANNEL);
  document.getElementById('btnPTT').classList.remove('disabled');
  document.getElementById('btnAccept').disabled = true;

  // 显示聊天区
  document.getElementById('chatArea').classList.add('active');
  addChatMsg('system', '已接通客户（频道 ' + USER_CHANNEL + '），可以开始对话');

  // 通知后端已接听
  fetch('/api/agent/accept', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      agent_id: AGENT_ID,
      transfer_id: transferId,
      agent_channel: AGENT_CHANNEL
    })
  }).catch(function(e) {});

  updateBadge();
  renderTransferList();

  // 切换到通话标签
  switchTab('active');
}

// ==================== 发送消息 ====================
function sendText() {
  var input = document.getElementById('textInput');
  var text = input.value.trim();
  if (!text || !activeTransfer) return;
  input.value = '';

  addChatMsg('agent', text);
  sendAgentMessage(text);
}

function sendAgentMessage(text) {
  fetch('/api/agent/reply', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      agent_id: AGENT_ID,
      agent_name: AGENT_NAME,
      user_channel: USER_CHANNEL,
      text: text
    })
  }).catch(function(e) { console.log('Reply error:', e); });
}

function addChatMsg(type, text) {
  chatMessages.push({type: type, text: text, time: new Date().toLocaleTimeString()});
  var area = document.getElementById('chatArea');
  var cls = type === 'agent' ? 'agent' : type === 'customer' ? 'customer' : 'system';
  var prefix = type === 'agent' ? AGENT_NAME + ': ' : type === 'customer' ? '客户: ' : '';
  area.innerHTML += '<div class="chat-msg ' + cls + '">' + prefix + escapeHtml(text) + '</div>';
  area.scrollTop = area.scrollHeight;
}

// ==================== PTT 录音 ====================
function startPTT() {
  console.log('[Agent] PTT start, activeTransfer:', !!activeTransfer, 'isRecording:', isRecording);
  if (!activeTransfer) {
    console.log('[Agent] PTT blocked: no active transfer');
    return;
  }
  if (isRecording) {
    console.log('[Agent] PTT blocked: already recording');
    return;
  }
  // Fix race condition: set isRecording BEFORE any async call
  isRecording = true;
  document.getElementById('btnPTT').classList.add('recording');
  startFallbackRecording();
}

function stopPTT() {
  console.log('[Agent] PTT stop, isRecording:', isRecording);
  if (!isRecording) return;
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  } else {
    // MediaRecorder not yet started (getUserMedia still pending), clean up state
    console.log('[Agent] PTT stop: MediaRecorder not recording, resetting');
    isRecording = false;
    document.getElementById('btnPTT').classList.remove('recording');
  }
}

function startFallbackRecording() {
  console.log('[Agent] Requesting microphone...');
  navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
    console.log('[Agent] Microphone granted, starting MediaRecorder');
    // If user already released PTT while waiting for permission, abort
    if (!isRecording) {
      console.log('[Agent] Recording aborted: PTT released during permission wait');
      stream.getTracks().forEach(function(t) { t.stop(); });
      return;
    }
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    recordedChunks = [];
    mediaRecorder.ondataavailable = function(e) { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = function() {
      console.log('[Agent] MediaRecorder stopped, chunks:', recordedChunks.length);
      sendAgentVoice();
      // Release mic
      stream.getTracks().forEach(function(t) { t.stop(); });
    };
    mediaRecorder.start();
    console.log('[Agent] MediaRecorder started');
  }).catch(function(e) {
    console.log('[Agent] Mic denied:', e);
    isRecording = false;
    document.getElementById('btnPTT').classList.remove('recording');
    showToast('麦克风权限未开启');
  });
}

function sendAgentVoice() {
  console.log('[Agent] sendAgentVoice, chunks:', recordedChunks.length);
  // Clean up recording state
  isRecording = false;
  document.getElementById('btnPTT').classList.remove('recording');

  if (recordedChunks.length === 0) {
    console.log('[Agent] No audio data, skipping upload');
    return;
  }
  var blob = new Blob(recordedChunks, { type: 'audio/webm' });
  var fd = new FormData();
  fd.append('audio', blob, 'ptt.webm');
  fd.append('agent_id', AGENT_ID);
  fd.append('user_channel', String(USER_CHANNEL));
  fd.append('agent_name', AGENT_NAME);

  console.log('[Agent] Uploading voice, size:', blob.size);
  fetch('/api/agent/voice-reply', { method: 'POST', body: fd })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      console.log('[Agent] Voice reply response:', data);
      if (data.success) {
        addChatMsg('agent', '[语音消息]');
      }
    })
    .catch(function(e) { console.log('[Agent] Voice reply error:', e); });
}

// ==================== 挂断 ====================
function hangUp() {
  if (!activeTransfer) return;

  fetch('/api/agent/hangup', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      agent_id: AGENT_ID,
      transfer_id: activeTransfer.id,
      user_channel: USER_CHANNEL
    })
  }).catch(function(e) {});

  addChatMsg('system', '通话已结束');
  activeTransfer = null;
  updateStatus('online', '在线待机');
  document.getElementById('btnPTT').classList.add('disabled');
  document.getElementById('chatArea').classList.remove('active');
}

// ==================== 状态更新 ====================
function updateStatus(status, label) {
  onlineStatus = status;
  var dot = document.getElementById('statusDot');
  dot.className = 'status-dot ' + status;
  if (status === 'busy') dot.className = 'status-dot busy';
  if (status === 'online') dot.className = 'status-dot online';

  var lbl = document.getElementById('statusLabel');
  lbl.innerHTML = label + '<small>' + AGENT_SHOP + '</small>';
}

// ==================== 标签切换 ====================
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.nav-btn').forEach(function(b) { b.classList.remove('active'); });
  event.target.closest('.nav-btn').classList.add('active');

  var list = document.getElementById('transferList');
  var chat = document.getElementById('chatArea');

  if (tab === 'pending') {
    list.style.display = 'block';
    chat.classList.remove('active');
    renderTransferList();
  } else if (tab === 'active') {
    list.style.display = 'none';
    if (activeTransfer) {
      chat.classList.add('active');
    } else {
      chat.classList.remove('active');
    }
  } else if (tab === 'history') {
    list.style.display = 'none';
    chat.classList.remove('active');
  }
}

// ==================== Toast ====================
function showToast(msg) {
  var toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(function() { toast.classList.remove('show'); }, 2500);
}

// ==================== 接收客户消息（轮询聊天） ====================
setInterval(function() {
  if (!activeTransfer) return;
  fetch('/api/agent/messages?agent_id=' + AGENT_ID + '&user_channel=' + USER_CHANNEL)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.messages) {
        data.messages.forEach(function(msg) {
          // 避免重复
          var exists = chatMessages.some(function(m) {
            return m.text === msg.text && m.time === msg.time;
          });
          if (!exists) {
            addChatMsg('customer', msg.text);
          }
        });
      }
    })
    .catch(function(e) {});
}, 3000);
